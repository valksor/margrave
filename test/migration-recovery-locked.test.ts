import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fsSync, { writeFileSync } from "node:fs";
import fs, { readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import type { TestContext } from "node:test";
import { WRITE_TIMEOUT_MS } from "../src/catalog.ts";
import { backupMigrationStore, writeMigrationRecord } from "../src/migration-backup.ts";
import { recoverMigrationRecord } from "../src/migration-recovery.ts";
import { MargraveError, readLegacySources } from "../src/store-files.ts";
import { assertDatabaseWriterAvailable, copyLegacyStoreFixture, hostedUseHome, leaveHotJournal, realClose, realExec } from "./helpers.ts";

const nativeLstat = fs.lstat;
const nativeOpen = fs.open;
const nativeSpawn = childProcess.spawn;
const nativePrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as typeof DatabaseSync.prototype.prepare;
const nativeReadStream = fsSync.createReadStream;
const probe =
  "SELECT (SELECT user_version FROM pragma_user_version) AS user_version, count(*) AS total, count(CASE WHEN type = 'index' AND tbl_name = 'skills' AND name IN ('skills_name_lc','skills_id_lc','skills_source') THEN 1 END) AS indexes, (SELECT count(*) FROM pragma_table_info('skills') WHERE name IN ('rowid','id','id_lc','name','name_lc','description','source','dir','hash')) AS base_columns, (SELECT count(*) FROM pragma_table_info('skills') WHERE name IN ('manifest','frontmatter')) AS extra_columns, (SELECT count(*) FROM pragma_table_info('fts') WHERE name IN ('name','description','headings','body')) AS fts_columns, count(CASE WHEN type = 'table' AND name = 'fts' AND lower(sql) LIKE '%using fts5%' THEN 1 END) AS fts FROM sqlite_master";

async function fixture(t: TestContext) {
  const parent = await hostedUseHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const store = path.join(parent, "store");
  await copyLegacyStoreFixture(store);
  process.env["MARGRAVE_HOME"] = store;
  const index = path.join(store, "index.db");
  const journal = `${index}-journal`;
  const sources = await readFile(path.join(store, "sources.json"), "utf8");
  const bytes = await readFile(index);
  const backup = await backupMigrationStore(2, await readLegacySources());
  await writeMigrationRecord(backup);
  const journalError = {
    name: "Error",
    message: `cannot verify the Margrave upgrade journal at ${journal}. Restore a complete backup. See Upgrading in the README.`,
  };
  return { parent, index, journal, sources, bytes, backup, journalError };
}

function restoreMocks() {
  mock.restoreAll();
  syncBuiltinESMExports();
}

test("migration recovery locked direct returns a configured holder and releases it on close", async (t) => {
  const f = await fixture(t);
  await leaveHotJournal(f.index);
  let holder: DatabaseSync | undefined;
  try {
    const result = await recoverMigrationRecord();
    assert.ok(result?.db);
    holder = result.db;
    assert.deepEqual({ backup: result.backup, sources: result.sources }, { backup: f.backup, sources: f.sources });
    assert.equal(typeof holder.prepare("SELECT 1 AS value").get()!["value"], "bigint");
    assert.equal(holder.prepare("PRAGMA busy_timeout").get()!["timeout"], BigInt(WRITE_TIMEOUT_MS));
    assert.deepEqual(await readFile(f.index), f.bytes);
    const contender = new DatabaseSync(f.index, { timeout: 0 });
    try {
      assert.throws(() => realExec.call(contender, "BEGIN IMMEDIATE"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    } finally {
      realClose.call(contender);
    }
    realClose.call(holder);
    assert.equal(holder.isOpen, false);
    assertDatabaseWriterAvailable(f.index);
  } finally {
    if (holder?.isOpen) realClose.call(holder);
  }
});

test("migration recovery locked direct rejects each locked verification failure and propagates a non-busy error", async (t) => {
  for (const mode of ["device", "inode", "digest", "version", "begin"] as const) {
    await t.test(mode, async (subtest) => {
      const f = await fixture(subtest);
      await leaveHotJournal(f.index);
      const wrong = path.join(f.parent, "wrong-bytes");
      await writeFile(wrong, "wrong catalog bytes");
      const injected = new MargraveError("exclusive lock injection");
      const holders = new Map<string, DatabaseSync>();
      let locked = false;
      let applied = false;
      try {
        mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
          if (sql === "BEGIN EXCLUSIVE" && this.location() === f.index) {
            holders.set(f.index, this);
            if (mode === "begin") {
              applied = true;
              throw injected;
            }
            const result = realExec.call(this, sql);
            locked = true;
            return result;
          }
          return realExec.call(this, sql);
        });
        mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
          const stat = await nativeLstat(...args);
          if (locked && args[0] === f.index && typeof stat.dev === "bigint" && (mode === "device" || mode === "inode")) {
            const field = mode === "device" ? "dev" : "ino";
            Object.defineProperty(stat, field, { value: BigInt(stat[field]) + 1n });
            applied = true;
          }
          return stat;
        }) as typeof fs.lstat);
        mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
          if (
            locked &&
            mode === "digest" &&
            args[0] === "/bin/cat" &&
            Array.isArray(args[1]) &&
            args[1].length === 1 &&
            args[1][0] === f.index
          ) {
            applied = true;
            return nativeSpawn(args[0], [wrong], args[2]);
          }
          return nativeSpawn(...args);
        }) as typeof childProcess.spawn);
        mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
          const statement = nativePrepare.call(this, sql);
          if (locked && this === holders.get(f.index) && mode === "version" && sql === probe) {
            const get = statement.get.bind(statement);
            mock.method(statement, "get", (...args: Parameters<typeof statement.get>) => {
              applied = true;
              return { ...get(...args), user_version: 0n, total: 0n };
            });
          }
          return statement;
        });
        syncBuiltinESMExports();
        await assert.rejects(recoverMigrationRecord(), mode === "begin" ? (err: unknown) => err === injected : f.journalError);
        assert.equal(applied, true);
        const holder = holders.get(f.index);
        assert.ok(holder);
        assert.equal(holder.isOpen, false);
        assertDatabaseWriterAvailable(f.index);
      } finally {
        restoreMocks();
        const holder = holders.get(f.index);
        if (holder?.isOpen) realClose.call(holder);
      }
    });
  }
});

test("migration recovery locked direct verifies a journal introduced after the lock", async (t) => {
  for (const mode of ["backup-owner", "catalog-owner", "changed", "non-file", "wrong-owner"] as const) {
    await t.test(mode, async (subtest) => {
      const f = await fixture(subtest);
      await leaveHotJournal(f.index);
      const journalBytes = await readFile(f.journal);
      const holders = new Map<string, DatabaseSync>();
      const backupOwner = (await nativeLstat(f.backup)).uid;
      const catalogOwner = backupOwner + 1;
      let locked = false;
      let inspected = false;
      let catalogCaptured = false;
      try {
        mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
          const result = realExec.call(this, sql);
          if (sql === "BEGIN EXCLUSIVE" && this.location() === f.index) {
            holders.set(f.index, this);
            locked = true;
            writeFileSync(f.journal, mode === "changed" ? Buffer.concat([journalBytes, Buffer.from([1])]) : journalBytes);
          }
          return result;
        });
        mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
          const stat = await nativeLstat(...args);
          if ((mode === "backup-owner" || mode === "catalog-owner") && args[0] === f.index && typeof stat.uid === "bigint") {
            if (!locked) catalogCaptured = true;
            Object.defineProperty(stat, "uid", { value: BigInt(catalogOwner) });
          }
          if (locked && args[0] === f.journal && typeof stat.uid === "number") {
            inspected = true;
            if (mode === "non-file") Object.defineProperty(stat, "isFile", { value: () => false });
            if (mode === "backup-owner" || mode === "catalog-owner")
              Object.defineProperty(stat, "uid", { value: mode === "backup-owner" ? backupOwner : catalogOwner });
            if (mode === "wrong-owner") Object.defineProperty(stat, "uid", { value: stat.uid + 1 });
          }
          return stat;
        }) as typeof fs.lstat);
        syncBuiltinESMExports();
        if (mode === "backup-owner" || mode === "catalog-owner") {
          const result = await recoverMigrationRecord();
          assert.ok(result?.db);
          assert.equal(result.db, holders.get(f.index));
          assert.equal(catalogCaptured, true);
          assert.deepEqual(await readFile(f.journal), journalBytes);
          realClose.call(result.db);
        } else {
          await assert.rejects(recoverMigrationRecord(), f.journalError);
        }
        assert.equal(inspected, true);
        const holder = holders.get(f.index);
        assert.ok(holder);
        assert.equal(holder.isOpen, false);
        await rm(f.journal, { force: true });
        assertDatabaseWriterAvailable(f.index);
      } finally {
        restoreMocks();
        const holder = holders.get(f.index);
        if (holder?.isOpen) realClose.call(holder);
      }
    });
  }
});

test("migration recovery locked direct rejects a new journal when its earlier hash is unknown", async (t) => {
  const f = await fixture(t);
  const journalBytes = Buffer.alloc(512);
  await writeFile(f.journal, journalBytes);
  const holders = new Map<string, DatabaseSync>();
  let locked = false;
  let disappeared = false;
  let journalHashReads = 0;
  try {
    mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === f.journal && !disappeared) {
        disappeared = true;
        await rm(f.journal);
      }
      return nativeOpen(...args);
    }) as typeof fs.open);
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      const result = realExec.call(this, sql);
      if (sql === "BEGIN EXCLUSIVE" && this.location() === f.index) {
        holders.set(f.index, this);
        locked = true;
        writeFileSync(f.journal, journalBytes);
      }
      return result;
    });
    mock.method(fsSync, "createReadStream", ((...args: Parameters<typeof fsSync.createReadStream>) => {
      if (locked && args[0] === f.journal) journalHashReads++;
      return nativeReadStream(...args);
    }) as typeof fsSync.createReadStream);
    syncBuiltinESMExports();
    await assert.rejects(recoverMigrationRecord(), f.journalError);
    assert.equal(disappeared, true);
    assert.equal(locked, true);
    assert.equal(journalHashReads, 0);
    const holder = holders.get(f.index);
    assert.ok(holder);
    assert.equal(holder.isOpen, false);
    await rm(f.journal, { force: true });
    assertDatabaseWriterAvailable(f.index);
  } finally {
    restoreMocks();
    const holder = holders.get(f.index);
    if (holder?.isOpen) realClose.call(holder);
  }
});
