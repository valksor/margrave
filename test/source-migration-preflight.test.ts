import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock, type TestContext } from "node:test";
import { migrateStore } from "../src/source-migration.ts";
import { assertWriterAvailable, copyLegacyStoreFixture, realClose, realExec, tmp, useHome } from "./helpers.ts";

const nativeLstat = fs.lstat;
const nativeReadFile = fs.readFile;
const nativeRealpath = fs.realpath;
const nativePrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as DatabaseSync["prepare"];

async function fixture(t: TestContext): Promise<{ home: string; index: string; source: string }> {
  const root = await tmp("mg-preflight-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "store");
  await copyLegacyStoreFixture(home);
  useHome(t, home);
  return { home, index: path.join(home, "index.db"), source: path.join(home, "sources.json") };
}

function restore(): void {
  mock.restoreAll();
  syncBuiltinESMExports();
}

function databaseFile(db: DatabaseSync): string {
  return String(nativePrepare.call(db, "PRAGMA database_list").get()!["file"]);
}

function missing(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

test("source migration preflight direct detects an index missing at the legacy lookup", async (t) => {
  const { home, index, source } = await fixture(t);
  const before = await nativeReadFile(index);
  const sourceBefore = await nativeReadFile(source);
  let indexes = 0;
  mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
    const [file] = args;
    if (file === index && ++indexes === 3) throw missing();
    return nativeLstat(...args);
  }) as typeof fs.lstat);
  syncBuiltinESMExports();
  try {
    await assert.rejects(migrateStore(), {
      message: `cannot upgrade the store because ${index} is missing. Restore the complete v0.2.1 backup`,
    });
    assert.equal(indexes, 3);
  } finally {
    restore();
  }
  assert.deepEqual(await nativeReadFile(index), before);
  assert.deepEqual(await nativeReadFile(source), sourceBefore);
  assertWriterAvailable(home);
});

test("source migration preflight direct propagates the legacy journal lookup error when the fallback is missing", async (t) => {
  const { home, index, source } = await fixture(t);
  const before = await nativeReadFile(index);
  const sourceBefore = await nativeReadFile(source);
  const journal = `${index}-journal`;
  const denied = Object.assign(new Error("journal denied"), { code: "EACCES" });
  let journals = 0;
  const begins = new Set<DatabaseSync>();
  mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
    const [file] = args;
    if (file === journal && ++journals === 3) throw denied;
    return nativeLstat(...args);
  }) as typeof fs.lstat);
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") begins.add(this);
    return realExec.call(this, sql);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(migrateStore(), { message: `cannot read ${journal}: journal denied` });
    assert.equal(journals, 4);
    assert.equal(begins.size, 1);
    for (const db of begins) assert.equal(db.isOpen, false);
  } finally {
    restore();
    for (const db of begins) if (db.isOpen) realClose.call(db);
  }
  assert.deepEqual(await nativeReadFile(index), before);
  assert.deepEqual(await nativeReadFile(source), sourceBefore);
  assertWriterAvailable(home);
});

for (const operation of ["missing", "denied", "read"] as const) {
  test(`source migration preflight direct preserves v2 bytes after late source ${operation}`, async (t) => {
    const { home, index, source } = await fixture(t);
    const before = await nativeReadFile(index);
    const sourceBefore = await nativeReadFile(source);
    const denied = Object.assign(new Error("late metadata denied"), { code: "EACCES" });
    let stats = 0;
    let reads = 0;
    let sourceMoved = false;
    mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const [file] = args;
      if (file === source && ++stats === 2) {
        if (operation === "missing") {
          await fs.rename(source, `${source}.saved`);
          sourceMoved = true;
        }
        if (operation === "denied") throw denied;
      }
      return nativeLstat(...args);
    }) as typeof fs.lstat);
    mock.method(fs, "readFile", (async (...args: Parameters<typeof fs.readFile>) => {
      const [file] = args;
      if (file === source && ++reads === 2 && operation === "read") return Promise.reject("late source read failed");
      return nativeReadFile(...args);
    }) as typeof fs.readFile);
    syncBuiltinESMExports();
    try {
      if (operation === "denied") await assert.rejects(migrateStore(), (err) => err === denied);
      else
        await assert.rejects(migrateStore(), {
          message:
            operation === "missing"
              ? `cannot upgrade the store because ${source} is missing. Restore the complete v0.2.1 backup`
              : "cannot upgrade the v0.2.1 catalog: late source read failed",
        });
      assert.equal(stats, 2);
      if (operation === "read") assert.equal(reads, 2);
    } finally {
      try {
        restore();
      } finally {
        if (sourceMoved) await fs.rename(`${source}.saved`, source);
      }
    }
    assert.deepEqual(await nativeReadFile(index), before);
    assert.deepEqual(await nativeReadFile(source), sourceBefore);
    assertWriterAvailable(home);
  });
}

test("source migration preflight direct closes a v3 reader when its source query fails", async (t) => {
  const { home, index, source } = await fixture(t);
  const setup = new DatabaseSync(index);
  realExec.call(
    setup,
    "CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL); PRAGMA user_version = 3",
  );
  realClose.call(setup);
  const before = await nativeReadFile(index);
  const sourceBefore = await nativeReadFile(source);
  const failure = new Error("source query failed");
  const readers = new Set<DatabaseSync>();
  const closes = new Map<DatabaseSync, number>();
  const begins = new Set<DatabaseSync>();
  mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("SELECT (SELECT user_version FROM pragma_user_version)")) readers.add(this);
    if (sql === "SELECT id, record FROM sources") throw failure;
    return nativePrepare.call(this, sql);
  });
  mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closes.set(this, (closes.get(this) ?? 0) + 1);
    return realClose.call(this);
  });
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") begins.add(this);
    return realExec.call(this, sql);
  });
  try {
    await assert.rejects(migrateStore(), (err) => err === failure);
    assert.equal(readers.size, 3);
    for (const db of readers) assert.equal(closes.get(db), 1);
    assert.equal(begins.size, 1);
  } finally {
    restore();
    for (const db of [...readers, ...begins]) if (db.isOpen) realClose.call(db);
  }
  assert.deepEqual(await nativeReadFile(index), before);
  assert.deepEqual(await nativeReadFile(source), sourceBefore);
  assertWriterAvailable(home);
});

for (const initial of [false, true]) {
  test(`source migration preflight direct rejects a ${initial ? "preexisting" : "late"} journal under the live lock`, async (t) => {
    const { home, index, source } = await fixture(t);
    const before = await nativeReadFile(index);
    const sourceBefore = await nativeReadFile(source);
    const journal = `${index}-journal`;
    const bytes = Buffer.alloc(512);
    if (initial) await fs.writeFile(journal, bytes);
    let journals = 0;
    let indexes = 0;
    const begins = new Map<DatabaseSync, string>();
    const readers = new Set<DatabaseSync>();
    mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const [file] = args;
      if (file === index) indexes++;
      if (file === journal && ++journals === 3 && !initial) {
        await fs.writeFile(journal, bytes);
        throw Object.assign(new Error("journal appeared"), { code: "EACCES" });
      }
      return nativeLstat(...args);
    }) as typeof fs.lstat);
    mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("SELECT (SELECT user_version FROM pragma_user_version)")) readers.add(this);
      return nativePrepare.call(this, sql);
    });
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") begins.set(this, databaseFile(this));
      return realExec.call(this, sql);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(migrateStore(), {
        message: `${index} has an unfinished v0.2.1 write. Restore a complete backup before migrating`,
      });
      assert.equal([...begins.values()].filter((file) => file === index).length, 1);
      assert.equal(begins.size, 2);
      for (const db of begins.keys()) assert.equal(db.isOpen, false);
      assert.equal(indexes, initial ? 3 : 4);
      assert.equal(readers.size, 2);
      assert.ok(journals >= 3);
    } finally {
      restore();
      for (const db of [...begins.keys(), ...readers]) if (db.isOpen) realClose.call(db);
    }
    assert.deepEqual(await nativeReadFile(index), before);
    assert.deepEqual(await nativeReadFile(source), sourceBefore);
    assert.deepEqual(await nativeReadFile(journal), bytes);
    assert.equal((await nativeLstat(journal)).uid, (await nativeLstat(index)).uid);
    assertWriterAvailable(home);
  });
}

for (const change of ["current", "missing with sources", "missing without sources"] as const) {
  test(`source migration preflight direct handles ${change} after the writer lock`, async (t) => {
    const { home, index, source } = await fixture(t);
    const before = await nativeReadFile(index);
    const sourceBefore = await nativeReadFile(source);
    const records = JSON.parse(sourceBefore.toString()) as { id: string }[];
    let locked = false;
    let indexes = 0;
    let markerChecks = 0;
    const begins = new Set<DatabaseSync>();
    let output = "";
    mock.method(process.stderr, "write", ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && databaseFile(this) === path.join(home, "writer-lock.db")) {
        begins.add(this);
        if (change === "current") {
          const db = new DatabaseSync(index);
          try {
            realExec.call(
              db,
              "CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL); UPDATE skills SET dir = 'release-upgrade'; PRAGMA user_version = 4",
            );
            nativePrepare
              .call(db, "INSERT INTO sources(id, record, position) VALUES (?, ?, 0)")
              .run(records[0]!.id, JSON.stringify(records[0]));
          } finally {
            realClose.call(db);
          }
        }
        locked = true;
      }
      return realExec.call(this, sql);
    });
    mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const [file] = args;
      if (file === index) {
        indexes++;
        if (locked && change !== "current") throw missing();
      }
      if (file === source && locked && change === "missing without sources") throw missing();
      if (file === path.join(home, "catalog-published")) {
        assert.ok(indexes >= 2);
        markerChecks++;
      }
      return nativeLstat(...args);
    }) as typeof fs.lstat);
    syncBuiltinESMExports();
    try {
      if (change === "missing with sources")
        await assert.rejects(migrateStore(), {
          message: `cannot upgrade the store because ${index} is missing. Restore the complete v0.2.1 backup`,
        });
      else assert.equal(await migrateStore(), false);
      assert.equal(begins.size, 1);
      for (const db of begins) assert.equal(db.isOpen, false);
      assert.equal(output, "");
      assert.equal(markerChecks, change === "missing without sources" ? 1 : 0);
      if (change === "current") assert.equal(indexes, 2);
    } finally {
      restore();
      for (const db of begins) if (db.isOpen) realClose.call(db);
    }
    if (change !== "current") assert.deepEqual(await nativeReadFile(index), before);
    assert.deepEqual(await nativeReadFile(source), sourceBefore);
    assertWriterAvailable(home);
  });
}

test("source migration preflight direct rejects an empty SQLite catalog", async (t) => {
  const { home, index, source } = await fixture(t);
  await fs.rm(index);
  const db = new DatabaseSync(index);
  realExec.call(db, "PRAGMA user_version = 0");
  realClose.call(db);
  const before = await nativeReadFile(index);
  const sourceBefore = await nativeReadFile(source);
  await assert.rejects(migrateStore(), { message: `${index} is not a supported margrave catalog` });
  assert.deepEqual(await nativeReadFile(index), before);
  assert.deepEqual(await nativeReadFile(source), sourceBefore);
  assertWriterAvailable(home);
});

test("source migration preflight direct closes the v2 reader before taking the live lock", async (t) => {
  const { home, index, source } = await fixture(t);
  const before = await nativeReadFile(index);
  const sourceBefore = await nativeReadFile(source);
  const readers = new Set<DatabaseSync>();
  const begins = new Set<DatabaseSync>();
  const stop = new Error("stop after live lock");
  mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("SELECT (SELECT user_version FROM pragma_user_version)")) readers.add(this);
    return nativePrepare.call(this, sql);
  });
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") {
      begins.add(this);
      if (databaseFile(this) === index) {
        assert.equal(readers.size, 3);
        for (const reader of readers) assert.equal(reader.isOpen, false);
        realExec.call(this, sql);
        throw stop;
      }
    }
    return realExec.call(this, sql);
  });
  try {
    await assert.rejects(migrateStore(), (err) => err === stop);
    assert.equal(begins.size, 2);
    for (const db of begins) assert.equal(db.isOpen, false);
  } finally {
    restore();
    for (const db of [...begins, ...readers]) if (db.isOpen) realClose.call(db);
  }
  assert.deepEqual(await nativeReadFile(index), before);
  assert.deepEqual(await nativeReadFile(source), sourceBefore);
  assertWriterAvailable(home);
});

test("source migration preflight direct closes a successful v3 reader before backup", async (t) => {
  const { home, index, source } = await fixture(t);
  const db = new DatabaseSync(index);
  realExec.call(
    db,
    "CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL); DELETE FROM skills; PRAGMA user_version = 3",
  );
  realClose.call(db);
  const before = await nativeReadFile(index);
  const sourceBefore = await nativeReadFile(source);
  const readers = new Set<DatabaseSync>();
  const closes = new Map<DatabaseSync, number>();
  const begins = new Map<DatabaseSync, string>();
  let sourceStats = 0;
  let reachedBackup = false;
  mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("SELECT (SELECT user_version FROM pragma_user_version)")) readers.add(this);
    return nativePrepare.call(this, sql);
  });
  mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closes.set(this, (closes.get(this) ?? 0) + 1);
    return realClose.call(this);
  });
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") begins.set(this, databaseFile(this));
    return realExec.call(this, sql);
  });
  mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
    const [file] = args;
    if (file === source) sourceStats++;
    return nativeLstat(...args);
  }) as typeof fs.lstat);
  mock.method(fs, "realpath", (async (...args: Parameters<typeof fs.realpath>) => {
    const [file] = args;
    if (file === home && readers.size === 3 && [...readers].every((reader) => closes.get(reader) === 1)) {
      reachedBackup = true;
      assert.equal(sourceStats, 1);
      throw new Error("stop at backup");
    }
    return nativeRealpath(...args);
  }) as typeof fs.realpath);
  syncBuiltinESMExports();
  try {
    await assert.rejects(migrateStore(), { message: "stop at backup" });
    assert.equal(reachedBackup, true);
    assert.equal([...begins.values()].filter((file) => file === index).length, 0);
    for (const handle of begins.keys()) assert.equal(handle.isOpen, false);
  } finally {
    restore();
    for (const handle of [...readers, ...begins.keys()]) if (handle.isOpen) realClose.call(handle);
  }
  assert.deepEqual(await nativeReadFile(index), before);
  assert.deepEqual(await nativeReadFile(source), sourceBefore);
  assertWriterAvailable(home);
});

test("source migration preflight direct closes the current reader after the second probe", async (t) => {
  const { home, index, source } = await fixture(t);
  const sourceBefore = await nativeReadFile(source);
  const records = JSON.parse(sourceBefore.toString()) as { id: string }[];
  const current = path.join(path.dirname(home), "current.db");
  await fs.copyFile(index, current);
  const db = new DatabaseSync(current);
  realExec.call(
    db,
    "CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL); UPDATE skills SET dir = 'release-upgrade'; PRAGMA user_version = 4",
  );
  nativePrepare.call(db, "INSERT INTO sources(id, record, position) VALUES (?, ?, 0)").run(records[0]!.id, JSON.stringify(records[0]));
  realClose.call(db);
  const expected = await nativeReadFile(current);
  const beforeNames = await fs.readdir(path.dirname(home));
  const readers = new Set<DatabaseSync>();
  const closes = new Map<DatabaseSync, number>();
  const begins = new Map<DatabaseSync, string>();
  let indexes = 0;
  let output = "";
  mock.method(process.stderr, "write", ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("SELECT (SELECT user_version FROM pragma_user_version)")) readers.add(this);
    return nativePrepare.call(this, sql);
  });
  mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closes.set(this, (closes.get(this) ?? 0) + 1);
    return realClose.call(this);
  });
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") begins.set(this, databaseFile(this));
    return realExec.call(this, sql);
  });
  mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
    const [file] = args;
    if (file === index && ++indexes === 3) {
      assert.equal(readers.size, 2);
      for (const reader of readers) assert.equal(closes.get(reader), 1);
      await fs.copyFile(current, index);
    }
    return nativeLstat(...args);
  }) as typeof fs.lstat);
  syncBuiltinESMExports();
  try {
    assert.equal(await migrateStore(), false);
    assert.equal(indexes, 3);
    assert.equal(readers.size, 3);
    for (const reader of readers) assert.equal(closes.get(reader), 1);
    assert.equal([...begins.values()].filter((file) => file === index).length, 0);
    for (const handle of begins.keys()) assert.equal(handle.isOpen, false);
    assert.equal(output, "");
  } finally {
    restore();
    for (const handle of [...readers, ...begins.keys()]) if (handle.isOpen) realClose.call(handle);
  }
  assert.deepEqual(await nativeReadFile(index), expected);
  assert.deepEqual(await nativeReadFile(source), sourceBefore);
  assert.deepEqual(await fs.readdir(path.dirname(home)), beforeNames);
  assertWriterAvailable(home);
});
