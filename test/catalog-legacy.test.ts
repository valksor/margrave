import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import nativeFs, { mkdirSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { READ_TIMEOUT_MS, SCHEMA_VERSION, SQLITE_READONLY_ROLLBACK, WRITE_TIMEOUT_MS, unfinishedWriteMessage } from "../src/catalog.ts";
import {
  checkLegacyJournalMode,
  copyLegacyCatalog,
  lockLegacyCatalog,
  openLegacyCatalog,
  probeMigrationCatalog,
} from "../src/catalog-legacy.ts";
import { MargraveError } from "../src/store-files.ts";
import {
  CLI,
  copyLegacyStoreFixture,
  catalogRecords,
  fakeRipwire,
  indexRows,
  makeRepo,
  runCli,
  stdioTestEnv,
  tmp,
  useHome,
} from "./helpers.ts";

async function directHome(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
  const parent = await tmp();
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  useHome(t, home);
  return home;
}

test("catalog legacy direct opens and probes missing, legacy, current and journal catalogs", async (t) => {
  const home = await directHome(t);
  assert.equal(await openLegacyCatalog(), null);
  assert.equal(await probeMigrationCatalog(), "missing");
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const setup = new DatabaseSync(file);
  setup.exec("CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL); PRAGMA user_version = 3");
  setup.close();
  const opened = await openLegacyCatalog();
  assert.ok(opened);
  try {
    assert.equal(opened.version, 3);
    assert.equal(opened.db.prepare("PRAGMA busy_timeout").get()?.["timeout"], READ_TIMEOUT_MS);
    assert.throws(() => opened.db.exec("CREATE TABLE direct_write_test(n INTEGER)"));
  } finally {
    opened.db.close();
  }
  const close = t.mock.method(DatabaseSync.prototype, "close");
  const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
  const execDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  assert.ok(prepareDescriptor?.value);
  assert.ok(execDescriptor?.value);
  let probes = 0;
  const probe = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (this.location("main") === file && sql.startsWith("SELECT (SELECT user_version")) {
      probes++;
      assert.throws(
        () => (execDescriptor.value as typeof DatabaseSync.prototype.exec).call(this, "CREATE TABLE direct_write_test(n INTEGER)"),
        {
          code: "ERR_SQLITE_ERROR",
          errcode: 8,
        },
      );
    }
    return (prepareDescriptor.value as typeof DatabaseSync.prototype.prepare).call(this, sql);
  });
  assert.equal(await probeMigrationCatalog(), "legacy");
  assert.equal(probes, 1);
  assert.equal(close.mock.callCount(), 1);
  probe.mock.restore();
  close.mock.restore();
  const current = new DatabaseSync(file);
  current.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  current.close();
  const currentOpen = await openLegacyCatalog();
  assert.ok(currentOpen);
  assert.equal(currentOpen.version, SCHEMA_VERSION);
  currentOpen.db.close();
  assert.equal(await probeMigrationCatalog(), "current");
  await writeFile(`${file}-journal`, "journal");
  const prepare = t.mock.method(DatabaseSync.prototype, "prepare");
  await assert.rejects(openLegacyCatalog(), {
    message: `${file} has an unfinished v0.2.1 write. Restore a complete backup before migrating`,
  });
  assert.equal(prepare.mock.callCount(), 0);
  prepare.mock.restore();
  const legacy = new DatabaseSync(file);
  legacy.exec("PRAGMA user_version = 3");
  legacy.close();
  await writeFile(`${file}-journal`, Buffer.alloc(512));
  assert.equal(await probeMigrationCatalog(), "journal");
});

test("catalog legacy direct checks delete mode and sidecars", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const db = new DatabaseSync(file, { readOnly: true });
  t.after(() => db.close());
  await checkLegacyJournalMode(db);
  for (const suffix of ["-wal", "-shm"]) {
    await writeFile(`${file}${suffix}`, "sidecar");
    await assert.rejects(checkLegacyJournalMode(db), { message: unfinishedWriteMessage(file) });
    await rm(`${file}${suffix}`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
  assert.ok(descriptor?.value);
  const mock = t.mock.method(db, "prepare", (sql: string) => {
    const prepare = descriptor.value as typeof DatabaseSync.prototype.prepare;
    if (sql === "PRAGMA journal_mode") return prepare.call(db, "SELECT 'wal' AS journal_mode");
    return prepare.call(db, sql);
  });
  await assert.rejects(checkLegacyJournalMode(db), { message: unfinishedWriteMessage(file) });
  mock.mock.restore();
});

test("catalog legacy direct locks a read-only reader and returns a writer transaction", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  assert.ok(descriptor?.value);
  const readers = new Set<DatabaseSync>();
  const begin = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    const exec = descriptor.value as typeof DatabaseSync.prototype.exec;
    if (sql === "BEGIN" && this.location("main") === file) {
      readers.add(this);
      assert.throws(() => exec.call(this, "CREATE TABLE direct_write_test(n INTEGER)"));
    }
    return exec.call(this, sql);
  });
  const close = t.mock.method(DatabaseSync.prototype, "close");
  const locked = await lockLegacyCatalog();
  try {
    assert.equal(locked.version, 2);
    assert.equal(locked.db.isTransaction, true);
    assert.equal(typeof locked.db.prepare("PRAGMA user_version").get()?.["user_version"], "bigint");
    assert.equal(locked.db.prepare("PRAGMA busy_timeout").get()?.["timeout"], BigInt(WRITE_TIMEOUT_MS));
    assert.equal(readers.size, 1);
    assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && readers.has(call.this)).length, 1);
  } finally {
    locked.db.close();
    close.mock.restore();
    begin.mock.restore();
  }
});

test("catalog legacy direct copies bytes and metadata into an owned catalog", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const before = await readFile(file);
  const original = await lstat(file);
  const copy = await copyLegacyCatalog();
  try {
    assert.deepEqual(await readFile(copy.file), before);
    const copied = await lstat(copy.file);
    assert.equal(copied.uid, original.uid);
    assert.equal(copied.gid, original.gid);
    assert.equal(copied.mode, original.mode);
    assert.equal(copy.db.prepare("PRAGMA user_version").get()?.["user_version"], 2n);
    assert.equal(copy.db.prepare("PRAGMA busy_timeout").get()?.["timeout"], BigInt(READ_TIMEOUT_MS));
    assert.equal(copy.db.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "delete");
    assert.equal(await readFile(`${copy.file}.owner`, "utf8"), "margrave-catalog-v1\n");
  } finally {
    copy.db.close();
    await rm(copy.file, { force: true });
    await rm(`${copy.file}.owner`, { force: true });
  }
});

test("catalog legacy direct probe preserves errors and closes acquired handles", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
  assert.ok(descriptor?.value);
  const close = t.mock.method(DatabaseSync.prototype, "close");
  const specific = new MargraveError("specific probe failure");
  let failure: Error = specific;
  const handles = new Set<DatabaseSync>();
  let createJournal = false;
  let removeJournal = false;
  const prepare = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (this.location("main") === file && sql.startsWith("SELECT (SELECT user_version")) {
      handles.add(this);
      if (createJournal) writeFileSync(`${file}-journal`, "journal");
      if (removeJournal) rmSync(`${file}-journal`);
      throw failure;
    }
    return (descriptor.value as typeof DatabaseSync.prototype.prepare).call(this, sql);
  });
  await assert.rejects(probeMigrationCatalog(), (err) => err === specific);
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && handles.has(call.this)).length, 1);
  handles.clear();
  failure = new Error("plain probe failure");
  await assert.rejects(probeMigrationCatalog(), { message: `cannot open ${file}: plain probe failure` });
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && handles.has(call.this)).length, 1);
  handles.clear();
  await writeFile(`${file}-journal`, "journal");
  assert.equal(await probeMigrationCatalog(), "journal");
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && handles.has(call.this)).length, 1);
  handles.clear();
  await rm(`${file}-journal`);
  await writeFile(`${file}-journal`, Buffer.alloc(512));
  removeJournal = true;
  assert.equal(await probeMigrationCatalog(), "journal");
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && handles.has(call.this)).length, 1);
  handles.clear();
  removeJournal = false;
  createJournal = true;
  assert.equal(await probeMigrationCatalog(), "journal");
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && handles.has(call.this)).length, 1);
  prepare.mock.restore();
  close.mock.restore();
});

test("catalog legacy direct lock closes handles on injected failures", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  assert.ok(descriptor?.value);
  const close = t.mock.method(DatabaseSync.prototype, "close");
  const readers = new Set<DatabaseSync>();
  const writers = new Set<DatabaseSync>();
  let now = 0;
  const clock = t.mock.method(Date, "now", () => (now += WRITE_TIMEOUT_MS));
  let target = "BEGIN IMMEDIATE";
  let failure = new Error("injected lock failure");
  const mock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (this.location("main") === file) {
      if (sql === "BEGIN") readers.add(this);
      if (sql === "BEGIN IMMEDIATE") writers.add(this);
      if (sql === target) throw failure;
    }
    return (descriptor.value as typeof DatabaseSync.prototype.exec).call(this, sql);
  });
  await assert.rejects(lockLegacyCatalog(), (err) => err === failure);
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && readers.has(call.this)).length, 1);
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && writers.has(call.this)).length, 1);
  readers.clear();
  writers.clear();
  target = `PRAGMA busy_timeout = ${WRITE_TIMEOUT_MS}`;
  failure = new Error("injected timeout setup failure");
  await assert.rejects(lockLegacyCatalog(), (err) => err === failure);
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && readers.has(call.this)).length, 1);
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && writers.has(call.this)).length, 1);
  target = "BEGIN";
  failure = Object.assign(new Error("rollback"), { errcode: SQLITE_READONLY_ROLLBACK });
  await assert.rejects(lockLegacyCatalog(), { message: unfinishedWriteMessage(file) });
  clock.mock.restore();
  mock.mock.restore();
  close.mock.restore();
});

test("catalog legacy direct lock closes no handle when reader opening fails", async (t) => {
  let now = 0;
  const clock = t.mock.method(Date, "now", () => (now += WRITE_TIMEOUT_MS));
  t.after(() => clock.mock.restore());
  const home = await directHome(t);
  await mkdir(home, { recursive: true });
  const file = path.join(home, "index.db");
  const close = t.mock.method(DatabaseSync.prototype, "close");
  try {
    await assert.rejects(lockLegacyCatalog(), { code: "ERR_SQLITE_ERROR", errcode: 14 });
    assert.equal(close.mock.callCount(), 0);
    await assert.rejects(lstat(file), { code: "ENOENT" });
  } finally {
    close.mock.restore();
  }
});

test("catalog legacy direct retries busy before deadline and stops at deadline", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  assert.ok(descriptor?.value);
  let attempts = 0;
  let failCount = 1;
  const mock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && this.location("main") === file) {
      attempts++;
      if (attempts > 3) throw new Error("unexpected repeated attempt");
      if (attempts <= failCount) throw Object.assign(new Error("busy"), { errcode: 5 });
    }
    return (descriptor.value as typeof DatabaseSync.prototype.exec).call(this, sql);
  });
  const now = 1000;
  const clock = t.mock.method(Date, "now", () => now);
  try {
    const locked = await lockLegacyCatalog();
    assert.equal(attempts, 2);
    assert.equal(locked.db.isTransaction, true);
    locked.db.close();
    attempts = 0;
    failCount = 3;
    let calls = 0;
    clock.mock.mockImplementation(() => (calls++ === 0 ? now : now + WRITE_TIMEOUT_MS));
    await assert.rejects(lockLegacyCatalog(), { message: "another Margrave writer holds the legacy catalog lock. Try the command again" });
    assert.equal(attempts, 1);
    attempts = 0;
    failCount = 1;
    calls = 0;
    clock.mock.mockImplementation(() => (calls++ === 0 ? now : now + WRITE_TIMEOUT_MS - 1));
    const beforeDeadline = await lockLegacyCatalog();
    assert.equal(attempts, 2);
    assert.equal(beforeDeadline.db.isTransaction, true);
    beforeDeadline.db.close();
  } finally {
    clock.mock.restore();
    mock.mock.restore();
  }
});

test("catalog legacy direct copy rejects changed metadata and cleans up", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const before = await readFile(file);
  const descriptor = Object.getOwnPropertyDescriptor(fs, "lstat");
  assert.ok(descriptor?.value);
  for (const field of ["type", "uid", "gid", "mode"] as const) {
    const mock = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await (descriptor.value as typeof fs.lstat)(...args);
      if (typeof args[0] !== "string" || !args[0].startsWith(path.join(home, ".catalog-")) || !args[0].endsWith(".tmp")) return stat;
      return new Proxy(stat, {
        get(target, key, receiver) {
          if (field === "type" && key === "isFile") return () => false;
          if (key === field) return Number(Reflect.get(target, key, receiver)) + 1;
          return Reflect.get(target, key, receiver);
        },
      });
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(copyLegacyCatalog(), { message: "catalog copy did not preserve access metadata" });
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await readFile(file), before);
    assert.equal(
      (await readdir(home)).some((name) => name.startsWith(".catalog-")),
      false,
    );
  }
});

test("catalog legacy direct validates journals before and after the writer lock", async (t) => {
  let now = 0;
  const clock = t.mock.method(Date, "now", () => (now += WRITE_TIMEOUT_MS));
  t.after(() => clock.mock.restore());
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const journal = `${file}-journal`;
  const content = Buffer.alloc(512);
  const hash = createHash("sha256").update(content).digest("hex");
  const statDescriptor = Object.getOwnPropertyDescriptor(fs, "lstat");
  assert.ok(statDescriptor?.value);
  let journalStats = 0;
  const execDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  assert.ok(execDescriptor?.value);
  let writerAttempts = 0;
  const earlyExec = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && this.location("main") === file) writerAttempts++;
    return (execDescriptor.value as typeof DatabaseSync.prototype.exec).call(this, sql);
  });
  const stat = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === journal && journalStats++ === 0) return (statDescriptor.value as typeof fs.lstat)(home, args[1]);
    return (statDescriptor.value as typeof fs.lstat)(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(lockLegacyCatalog(hash), { message: unfinishedWriteMessage(file) });
    assert.equal(writerAttempts, 0);
  } finally {
    earlyExec.mock.restore();
    stat.mock.restore();
    syncBuiltinESMExports();
  }
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  assert.ok(descriptor?.value);
  let late: "file" | "directory" = "file";
  const begin = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    const result = (descriptor.value as typeof DatabaseSync.prototype.exec).call(this, sql);
    if (sql === "BEGIN IMMEDIATE" && this.location("main") === file) {
      if (late === "directory") mkdirSync(journal);
      else writeFileSync(journal, content);
    }
    return result;
  });
  late = "directory";
  await assert.rejects(lockLegacyCatalog(hash), { message: unfinishedWriteMessage(file) });
  await rm(journal, { recursive: true });
  late = "file";
  const streamDescriptor = Object.getOwnPropertyDescriptor(nativeFs, "createReadStream");
  assert.ok(streamDescriptor?.value);
  let journalReads = 0;
  const stream = t.mock.method(nativeFs, "createReadStream", (...args: Parameters<typeof nativeFs.createReadStream>) => {
    if (args[0] === journal) journalReads++;
    return (streamDescriptor.value as typeof nativeFs.createReadStream)(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(lockLegacyCatalog(), { message: unfinishedWriteMessage(file) });
    assert.equal(journalReads, 0);
  } finally {
    stream.mock.restore();
    syncBuiltinESMExports();
  }
  await rm(journal);
  await assert.rejects(lockLegacyCatalog("wrong hash"), { message: unfinishedWriteMessage(file) });
  await rm(journal);
  const accepted = await lockLegacyCatalog(hash);
  assert.equal(accepted.db.isTransaction, true);
  accepted.db.close();
  await rm(journal, { force: true });
  begin.mock.restore();
  await writeFile(journal, content);
  const beforeWriter = await lockLegacyCatalog(hash);
  assert.equal(beforeWriter.db.isTransaction, true);
  beforeWriter.db.close();
  await rm(journal, { force: true });
});

test("catalog legacy direct closes the copy when SQLite setup fails", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const before = await readFile(file);
  const failure = new Error("copy setup failure");
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  assert.ok(descriptor?.value);
  const copies = new Set<DatabaseSync>();
  const close = t.mock.method(DatabaseSync.prototype, "close");
  const mock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA journal_mode = DELETE" && this.location("main")?.startsWith(path.join(home, ".catalog-"))) {
      copies.add(this);
      throw failure;
    }
    return (descriptor.value as typeof DatabaseSync.prototype.exec).call(this, sql);
  });
  await assert.rejects(copyLegacyCatalog(), (err) => err === failure);
  assert.equal(copies.size, 1);
  assert.equal(close.mock.calls.filter((call) => call.this instanceof DatabaseSync && copies.has(call.this)).length, 1);
  assert.deepEqual(await readFile(file), before);
  assert.equal(
    (await readdir(home)).some((name) => name.startsWith(".catalog-")),
    false,
  );
  mock.mock.restore();
  close.mock.restore();
});

test("catalog legacy direct probe closes no handle when opening fails", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const saved = `${file}.saved`;
  const descriptor = Object.getOwnPropertyDescriptor(fs, "lstat");
  assert.ok(descriptor?.value);
  let replaced = false;
  const close = t.mock.method(DatabaseSync.prototype, "close");
  const stat = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === `${file}-journal` && !replaced) {
      replaced = true;
      await rename(file, saved);
      await mkdir(file);
    }
    return (descriptor.value as typeof fs.lstat)(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(probeMigrationCatalog(), { message: /^cannot open .*index\.db:/u });
    assert.equal(close.mock.callCount(), 0);
  } finally {
    stat.mock.restore();
    syncBuiltinESMExports();
    close.mock.restore();
    if (replaced) {
      await rm(file, { recursive: true });
      await rename(saved, file);
    }
  }
});

test("catalog legacy direct refuses a sidecar appearing after the writer begins", async (t) => {
  let now = 0;
  const clock = t.mock.method(Date, "now", () => (now += WRITE_TIMEOUT_MS));
  t.after(() => clock.mock.restore());
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  assert.ok(descriptor?.value);
  const exec = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    const result = (descriptor.value as typeof DatabaseSync.prototype.exec).call(this, sql);
    if (sql === "BEGIN IMMEDIATE" && this.location("main") === file) writeFileSync(`${file}-shm`, "late sidecar");
    return result;
  });
  try {
    await assert.rejects(lockLegacyCatalog(), { message: unfinishedWriteMessage(file) });
  } finally {
    exec.mock.restore();
    await rm(`${file}-shm`, { force: true });
  }
});

test("catalog legacy direct validates journal owners with and without getuid", async (t) => {
  let now = 0;
  const clock = t.mock.method(Date, "now", () => (now += WRITE_TIMEOUT_MS));
  t.after(() => clock.mock.restore());
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const journal = `${file}-journal`;
  const content = "owner test journal";
  const hash = createHash("sha256").update(content).digest("hex");
  const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  const ownUid = process.getuid?.();
  const catalogUid = (ownUid ?? (await lstat(file)).uid) + 10001;
  const unknownUid = Math.max(catalogUid, ownUid ?? catalogUid) + 1;
  assert.notEqual(unknownUid, ownUid);
  assert.notEqual(unknownUid, catalogUid);
  let journalUid = catalogUid;
  const execDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
  const statDescriptor = Object.getOwnPropertyDescriptor(fs, "lstat");
  assert.ok(execDescriptor?.value);
  assert.ok(statDescriptor?.value);
  const exec = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    const result = (execDescriptor.value as typeof DatabaseSync.prototype.exec).call(this, sql);
    if (sql === "BEGIN IMMEDIATE" && this.location("main") === file) writeFileSync(journal, content);
    return result;
  });
  const stat = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const result = await (statDescriptor.value as typeof fs.lstat)(...args);
    if (args[0] !== file && args[0] !== journal) return result;
    return new Proxy(result, {
      get(target, key, receiver) {
        if (key === "uid") return args[0] === file ? catalogUid : journalUid;
        return Reflect.get(target, key, receiver);
      },
    });
  });
  syncBuiltinESMExports();
  try {
    const accepted = await lockLegacyCatalog(hash);
    assert.equal(accepted.db.isTransaction, true);
    accepted.db.close();
    await rm(journal, { force: true });
    assert.ok(ownUid !== undefined);
    journalUid = ownUid;
    const processOwned = await lockLegacyCatalog(hash);
    assert.equal(processOwned.db.isTransaction, true);
    processOwned.db.close();
    await rm(journal, { force: true });
    journalUid = unknownUid;
    await assert.rejects(lockLegacyCatalog(hash), { message: unfinishedWriteMessage(file) });
    await rm(journal, { force: true });
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    journalUid = catalogUid;
    const withoutGetuid = await lockLegacyCatalog(hash);
    assert.equal(withoutGetuid.db.isTransaction, true);
    withoutGetuid.db.close();
    await rm(journal, { force: true });
    journalUid = unknownUid;
    await assert.rejects(lockLegacyCatalog(hash), { message: unfinishedWriteMessage(file) });
  } finally {
    if (getuidDescriptor === undefined) Reflect.deleteProperty(process, "getuid");
    else Object.defineProperty(process, "getuid", getuidDescriptor);
    stat.mock.restore();
    syncBuiltinESMExports();
    exec.mock.restore();
    await rm(journal, { force: true });
  }
});

test("catalog legacy direct copy preserves failure when source or cleanup files disappear", async (t) => {
  const home = await directHome(t);
  await copyLegacyStoreFixture(home);
  const file = path.join(home, "index.db");
  const saved = `${file}.saved`;
  const before = await readFile(file);
  const descriptor = Object.getOwnPropertyDescriptor(fs, "lstat");
  assert.ok(descriptor?.value);
  let removeSource = true;
  const failure = new Error("copy disappeared");
  const stat = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const result = await (descriptor.value as typeof fs.lstat)(...args);
    if (args[0] === file && removeSource) {
      removeSource = false;
      await rename(file, saved);
    } else if (typeof args[0] === "string" && args[0].startsWith(path.join(home, ".catalog-")) && args[0].endsWith(".tmp")) {
      await rm(args[0]);
      await rm(`${args[0]}.owner`);
      throw failure;
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(copyLegacyCatalog(), /cp/u);
    await rename(saved, file);
    await assert.rejects(copyLegacyCatalog(), (err) => err === failure);
    assert.deepEqual(await readFile(file), before);
    assert.equal(
      (await readdir(home)).some((name) => name.startsWith(".catalog-")),
      false,
    );
  } finally {
    stat.mock.restore();
    syncBuiltinESMExports();
  }
});

test("schema 3 catalog setup failure keeps the original for retry", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  const repo = await makeRepo();
  const fakeBin = await fakeRipwire();
  assert.equal((await runCli(["install", repo.url], { home, fakeBin })).code, 0);
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("PRAGMA user_version = 3");
  db.close();
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(parent, "failure.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "PRAGMA journal_mode = DELETE") throw new Error("catalog setup failed"); return exec.call(this, sql); };\n`,
  );
  const failed = await runCli(["find", "--category", "general", "react-perf"], { home, fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /catalog setup failed/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  const retry = await runCli(["find", "--category", "general", "react-perf"], { home, fakeBin });
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /react-perf/u);
  assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v3-")).length, 1);
});

test("schema 3 refuses changed catalog copy permissions and retries", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  const repo = await makeRepo();
  const fakeBin = await fakeRipwire();
  assert.equal((await runCli(["install", repo.url], { home, fakeBin })).code, 0);
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("PRAGMA user_version = 3");
  db.close();
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(parent, "copy-mode.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstat;
fs.lstat = async function(file, ...args) { if (String(file).includes("/.catalog-") && String(file).endsWith(".tmp")) await fs.chmod(file, 0); return lstat.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["find", "--category", "general", "react-perf"], { home, fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /catalog copy did not preserve access metadata/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  assert.ok(!(await readdir(home)).some((name) => name.startsWith(".catalog-")));
  const retry = await runCli(["find", "--category", "general", "react-perf"], { home, fakeBin });
  assert.equal(retry.code, 0, retry.stderr);
});

test("legacy writers are fenced by the catalog transaction", async (t) => {
  for (const mode of ["active", "opened"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const original = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { id: string; snapshot: string }[];
    const source = original[0]!;
    const linkPath = path.join(home, "sources", source.id);
    const skillPath = path.join(home, "snapshots", source.id, source.snapshot, "release-upgrade", "SKILL.md");
    const linkBefore = await readlink(linkPath);
    const skillBefore = await readFile(skillPath);
    const writerScript = `
import { DatabaseSync } from "node:sqlite";
import { readFile, rename, writeFile } from "node:fs/promises";
const home = ${JSON.stringify(home)};
const mode = ${JSON.stringify(mode)};
const db = new DatabaseSync(home + "/index.db", { timeout: 10000 });
if (mode === "active") {
  db.exec("BEGIN IMMEDIATE");
  const records = JSON.parse(await readFile(home + "/sources.json", "utf8"));
  records[0].installedAt = "writer-finished";
  await writeFile(home + "/sources.json.old-writer-tmp", JSON.stringify(records));
  await rename(home + "/sources.json.old-writer-tmp", home + "/sources.json");
  db.exec("UPDATE skills SET hash = hash");
}
process.send("ready");
await new Promise(resolve => process.once("message", resolve));
try {
  if (mode === "opened") {
    db.exec("BEGIN IMMEDIATE");
    const records = JSON.parse(await readFile(home + "/sources.json", "utf8"));
    if (!Array.isArray(records)) throw new Error("malformed source list");
    await writeFile(${JSON.stringify(skillPath)}, "stale writer changed this");
    await rename(${JSON.stringify(linkPath)}, ${JSON.stringify(`${linkPath}.stale`)});
    db.exec("DELETE FROM skills");
  }
  db.exec("COMMIT");
  process.send("committed");
} catch {
  if (db.isTransaction) db.exec("ROLLBACK");
  process.send("rejected");
}
db.close();
process.disconnect();\n`;
    const writer = spawn(process.execPath, ["--input-type=module", "-e", writerScript], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const writerExit = once(writer, "close");
    t.after(async () => {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill();
      await writerExit;
    });
    assert.equal(
      await Promise.race([once(writer, "message").then(([message]) => message), writerExit.then(() => "writer exited")]),
      "ready",
    );
    if (mode === "active") {
      const preload = path.join(parent, "barrier.mjs");
      await writeFile(
        preload,
        `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { try { return exec.call(this, sql); } catch (err) { if (sql === "BEGIN IMMEDIATE" && this.location("main") === ${JSON.stringify(path.join(home, "index.db"))} && err.errcode === 5) process.send("busy"); throw err; } };\n`,
      );
      const migration = spawn(process.execPath, ["--import", preload, CLI, "migrate"], {
        env: stdioTestEnv({ ...process.env, MARGRAVE_HOME: home }),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stderr = "";
      migration.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exit = once(migration, "close");
      t.after(async () => {
        if (migration.exitCode === null && migration.signalCode === null) migration.kill();
        await exit;
      });
      assert.equal(
        await Promise.race([once(migration, "message").then(([message]) => message), exit.then(() => "migration exited")]),
        "busy",
      );
      writer.send("continue");
      assert.equal((await once(writer, "message"))[0], "committed");
      assert.equal((await exit)[0], 0, stderr);
      assert.equal(catalogRecords(home)[0]?.installedAt, "writer-finished");
      const backupName = (JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { backup: string }).backup;
      const archived = execFileSync("/usr/bin/tar", ["-xOf", path.join(parent, backupName, "store.tar"), "./sources.json"], {
        encoding: "utf8",
      });
      assert.equal(JSON.parse(archived)[0].installedAt, "writer-finished");
    } else {
      const migrated = await runCli(["migrate"], { home });
      assert.equal(migrated.code, 0, migrated.stderr);
      const before = await readFile(path.join(home, "index.db"));
      const sourceBefore = await readFile(path.join(home, "sources.json"));
      writer.send("continue");
      assert.equal((await once(writer, "message"))[0], "rejected");
      assert.deepEqual(await readFile(path.join(home, "index.db")), before);
      assert.deepEqual(await readFile(path.join(home, "sources.json")), sourceBefore);
    }
    assert.equal(await readlink(linkPath), linkBefore);
    assert.deepEqual(await readFile(skillPath), skillBefore);
  }
});

test("migration retains the SQLite lock while preparing the source record", async (t) => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const records = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { id: string; snapshot: string }[];
  const source = records[0]!;
  const aliasPath = path.join(home, "sources", source.id);
  const originalLink = await readlink(aliasPath);
  const skill = path.join(home, "snapshots", source.id, source.snapshot, "release-upgrade", "SKILL.md");
  const originalSkill = await readFile(skill);
  const preload = path.join(parent, "barrier.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = async function(from, to) { if (to === ${JSON.stringify(path.join(home, "sources.json"))}) { process.send("before-record"); await new Promise(resolve => process.once("message", resolve)); } return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  const migration = spawn(process.execPath, ["--import", preload, CLI, "migrate"], {
    env: stdioTestEnv({ ...process.env, MARGRAVE_HOME: home }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  migration.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(migration, "close");
  t.after(async () => {
    if (migration.exitCode === null && migration.signalCode === null) migration.kill();
    await exited;
  });
  assert.equal(
    await Promise.race([once(migration, "message").then(([message]) => message), exited.then(() => `exited: ${stderr}`)]),
    "before-record",
  );
  const attempt = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(path.join(home, "index.db"))}, { timeout: 0 });
try { db.exec("BEGIN IMMEDIATE"); process.exitCode = 2; } catch (err) { process.exitCode = err.errcode === 5 ? 0 : 3; } finally { db.close(); }`,
    ],
    { stdio: "ignore" },
  );
  assert.equal((await once(attempt, "close"))[0], 0, "the legacy writer must see SQLITE_BUSY");
  migration.send("continue");
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(catalogRecords(home)[0]?.id, source.id);
  assert.equal(indexRows(home).length, 1);
  assert.deepEqual(await readFile(skill), originalSkill);
  assert.equal(await readlink(aliasPath), originalLink);
});

test("migration waits for a shared reader at commit", async (t) => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const script = `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(path.join(home, "index.db"))}, { readOnly: true });
db.exec("BEGIN"); db.prepare("SELECT count(*) FROM skills").get(); process.send("ready");
await new Promise(resolve => process.once("message", resolve)); db.exec("COMMIT"); db.close(); process.disconnect();\n`;
  const reader = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const readerExit = once(reader, "close");
  t.after(async () => {
    if (reader.exitCode === null && reader.signalCode === null) reader.kill();
    await readerExit;
  });
  assert.equal(await Promise.race([once(reader, "message").then(([message]) => message), readerExit.then(() => "reader exited")]), "ready");
  const preload = path.join(parent, "commit.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "PRAGMA user_version = 4; COMMIT") process.send({ phase: "commit", timeout: Number(this.prepare("PRAGMA busy_timeout").get().timeout) }); return exec.call(this, sql); };\n`,
  );
  const migration = spawn(process.execPath, ["--import", preload, CLI, "migrate"], {
    env: stdioTestEnv({ ...process.env, MARGRAVE_HOME: home }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  migration.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(migration, "close");
  t.after(async () => {
    if (migration.exitCode === null && migration.signalCode === null) migration.kill();
    await exited;
  });
  assert.deepEqual(await Promise.race([once(migration, "message").then(([message]) => message), exited.then(() => `exited: ${stderr}`)]), {
    phase: "commit",
    timeout: 30000,
  });
  reader.send("release");
  assert.equal((await readerExit)[0], 0);
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(indexRows(home).length, 1);
});

test("legacy writer lock timeout preserves the store for retry", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const index = path.join(home, "index.db");
  const before = await readFile(index);
  const sources = await readFile(path.join(home, "sources.json"));
  const preload = path.join(parent, "timeout.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
let now = 0; Date.now = () => (now += 40000);
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "BEGIN IMMEDIATE" && this.location("main") === ${JSON.stringify(index)}) throw Object.assign(new Error("busy"), { errcode: 5 }); return exec.call(this, sql); };\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /another Margrave writer holds the legacy catalog lock/u);
  assert.deepEqual(await readFile(index), before);
  assert.deepEqual(await readFile(path.join(home, "sources.json")), sources);
  assert.equal((await runCli(["migrate"], { home })).code, 0);
});

test("legacy migration refuses WAL sidecars and non-file journals", async () => {
  for (const sidecar of ["index.db-wal", "index.db-shm", "index.db-journal"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const before = await readFile(path.join(home, "index.db"));
    if (sidecar === "index.db-journal") await mkdir(path.join(home, sidecar));
    else await writeFile(path.join(home, sidecar), "unrelated");
    const result = await runCli(["migrate"], { home });
    assert.equal(result.code, 1, sidecar);
    assert.deepEqual(await readFile(path.join(home, "index.db")), before);
    assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-")).length, 0);
  }
});

test("migration refuses catalog probe and journal races before writing", async () => {
  for (const failure of ["probe", "open", "journal-directory"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const index = path.join(home, "index.db");
    const before = await readFile(index);
    const source = await readFile(path.join(home, "sources.json"));
    const preload = path.join(parent, "race.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
const failure = ${JSON.stringify(failure)}; const prepare = DatabaseSync.prototype.prepare; const exec = DatabaseSync.prototype.exec;
let reader = false;
DatabaseSync.prototype.prepare = function(sql) { if (failure === "probe" && sql.startsWith("SELECT (SELECT user_version")) throw new Error("probe denied"); return prepare.call(this, sql); };
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (sql === "BEGIN") reader = true; return result; };
const lstat = fs.lstat;
let replaced = false;
fs.lstat = async function(file, ...args) { if (failure === "open" && !replaced && file === ${JSON.stringify(`${index}-journal`)}) { replaced = true; await fs.rename(${JSON.stringify(index)}, ${JSON.stringify(`${index}.saved`)}); await fs.mkdir(${JSON.stringify(index)}); } if (failure === "journal-directory" && reader && file === ${JSON.stringify(`${index}-journal`)}) { reader = false; await fs.mkdir(file); } return lstat.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
    );
    const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(failed.code, 1, failure);
    assert.match(failed.stderr, failure === "probe" ? /probe denied/u : failure === "open" ? /cannot open/u : /unfinished v0\.2\.1 write/u);
    if (failure === "open") {
      await rm(index, { recursive: true });
      await rename(`${index}.saved`, index);
    }
    assert.deepEqual(await readFile(index), before);
    assert.deepEqual(await readFile(path.join(home, "sources.json")), source);
    if (failure === "journal-directory") await rm(`${index}-journal`, { recursive: true });
    assert.equal((await runCli(["migrate"], { home })).code, 0);
  }
});
