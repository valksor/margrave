import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs, { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import type { TestContext } from "node:test";
import { MIGRATION_COMMIT_SQL, MIGRATION_FTS_SQL, SCHEMA_VERSION } from "../src/catalog.ts";
import { backupMigrationStore, writeMigrationRecord } from "../src/migration-backup.ts";
import { scanInstalledSource } from "../src/source-files.ts";
import { migrateStore } from "../src/source-migration.ts";
import { readLegacySources } from "../src/store-files.ts";
import type { SourceRecord } from "../src/store.ts";
import {
  assertDatabaseWriterAvailable,
  assertWriterAvailable,
  catalogRecords,
  copyLegacyStoreFixture,
  leaveHotJournal,
  realClose,
  realExec,
  seedIndex,
  tmp,
  useHome,
  writeIndexRows,
  writeSkill,
} from "./helpers.ts";

const nativePrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as typeof DatabaseSync.prototype.prepare;
const nativeRename = fs.rename;
const nativeRm = fs.rm;
const nativeReaddir = fs.readdir;

async function fixture(t: TestContext, version: 2 | 3) {
  const parent = await tmp("mg-publication-direct-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  if (version === 2) await copyLegacyStoreFixture(home);
  else await mkdir(home);
  useHome(t, home);
  if (version === 3) {
    const local = path.join(parent, "local");
    await mkdir(local);
    await writeSkill(local, "alpha", "Stable orchard description", "# Heading\n\nFresh tangerine tokens.\n");
    const source: SourceRecord = {
      id: "local__alpha-123456",
      kind: "local",
      spec: local,
      path: local,
      subpath: "",
      ref: null,
      commit: null,
      installedAt: "2026-01-01T00:00:00.000Z",
    };
    const entries = await scanInstalledSource(source, { log: () => {} });
    await seedIndex(entries, [source]);
    writeIndexRows(home, (db) =>
      db.exec(
        "DROP TABLE fts; CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='unicode61'); PRAGMA user_version = 3",
      ),
    );
  }
  return { parent, home, index: path.join(home, "index.db"), sources: path.join(home, "sources.json") };
}

function rows(index: string) {
  const db = new DatabaseSync(index, { readOnly: true, timeout: 0 });
  try {
    return db
      .prepare("SELECT id, name, description, source, dir, hash, manifest, frontmatter FROM skills ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    realClose.call(db);
  }
}

function restore(handles: Set<DatabaseSync>) {
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const db of handles) if (db.isOpen) realClose.call(db);
}

test("source migration publication direct rolls back staged v3 failures and closes the writer", async (t) => {
  for (const mode of ["transaction", "rename", "cleanup"] as const) {
    await t.test(mode, async (subtest) => {
      const f = await fixture(subtest, 3);
      const oldBytes = await readFile(f.index);
      const oldRows = rows(f.index);
      const oldSources = catalogRecords(f.home);
      const unrelated = path.join(f.home, ".catalog-1-000000000000000000000000.tmp");
      await writeFile(unrelated, "unowned");
      const handles = new Set<DatabaseSync>();
      const closes = new Map<DatabaseSync, number>();
      const removals: string[] = [];
      const captured = new Map<"temp" | "writer", DatabaseSync>();
      let stage: string | undefined;
      let renames = 0;
      const fault = new Error(`${mode} fault`);
      try {
        mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
          handles.add(this);
          const file = this.location() ?? "";
          if (file === path.join(f.home, "writer-lock.db") && sql === "BEGIN IMMEDIATE") captured.set("writer", this);
          if (path.basename(file).startsWith(".catalog-") && sql === "BEGIN IMMEDIATE") {
            captured.set("temp", this);
            stage = file;
          }
          if (this === captured.get("temp") && sql === MIGRATION_FTS_SQL && mode === "transaction") throw fault;
          return realExec.call(this, sql);
        });
        mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
          handles.add(this);
          if (mode === "cleanup" && this === captured.get("temp") && sql === "UPDATE skills SET dir = ? WHERE id = ?")
            throw new Error("prepare fault");
          return nativePrepare.call(this, sql);
        });
        mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
          closes.set(this, (closes.get(this) ?? 0) + 1);
          return realClose.call(this);
        });
        mock.method(fs, "rename", (async (...args: Parameters<typeof fs.rename>) => {
          if (args[0] === stage && args[1] === f.index) {
            renames++;
            assert.equal(captured.get("temp")?.isOpen, false);
            if (mode === "rename") throw fault;
          }
          return nativeRename(...args);
        }) as typeof fs.rename);
        mock.method(fs, "rm", (async (...args: Parameters<typeof fs.rm>) => {
          if (typeof args[0] === "string" && stage !== undefined && args[0].startsWith(stage)) {
            removals.push(args[0]);
            if (mode === "cleanup") throw fault;
          }
          return nativeRm(...args);
        }) as typeof fs.rm);
        syncBuiltinESMExports();
        await assert.rejects(migrateStore(), (err: unknown) => err === fault);
        const temp = captured.get("temp");
        const writer = captured.get("writer");
        assert.ok(temp && writer && stage);
        assert.equal(temp.isOpen, false);
        assert.equal(writer.isOpen, false);
        assert.equal(closes.get(temp), 1);
        assert.equal(closes.get(writer), 1);
        assert.equal(renames, mode === "rename" ? 1 : 0);
        assert.ok(removals.length > 0);
        if (mode === "cleanup") assert.deepEqual(removals, [stage]);
        assert.ok(
          removals.every(
            (item) =>
              item === stage ||
              item === `${stage}-journal` ||
              item === `${stage}-wal` ||
              item === `${stage}-shm` ||
              item === `${stage}.owner`,
          ),
        );
        assertWriterAvailable(f.home);
        assertDatabaseWriterAvailable(f.index);
        assert.deepEqual(await readFile(f.index), oldBytes);
        assert.deepEqual(rows(f.index), oldRows);
        assert.deepEqual(catalogRecords(f.home), oldSources);
        assert.equal(await readFile(unrelated, "utf8"), "unowned");
        if (mode !== "cleanup") await assert.rejects(readFile(`${stage}.owner`), { code: "ENOENT" });
      } finally {
        restore(handles);
      }
    });
  }
});

test("source migration publication direct reuses a prepared v2 backup after a hot journal", async (t) => {
  const f = await fixture(t, 2);
  const before = rows(f.index);
  const sources = await readLegacySources();
  const backup = await backupMigrationStore(2, sources);
  const manifest = await readFile(path.join(backup, "manifest.json"));
  const archive = await readFile(path.join(backup, "store.tar"));
  await writeMigrationRecord(backup);
  const record = await readFile(f.sources);
  await leaveHotJournal(f.index);
  const handles = new Set<DatabaseSync>();
  const captured = new Map<"writer" | "live", DatabaseSync>();
  try {
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      if (this.location() === path.join(f.home, "writer-lock.db") && sql === "BEGIN IMMEDIATE") captured.set("writer", this);
      if (this.location() === f.index && sql === "BEGIN" && captured.has("live"))
        assert.fail("opened a legacy reader after recovering the exclusive lock");
      const result = realExec.call(this, sql);
      if (this.location() === f.index && sql === "BEGIN EXCLUSIVE") captured.set("live", this);
      return result;
    });
    mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      return nativePrepare.call(this, sql);
    });
    assert.equal(await migrateStore(), true);
    const writer = captured.get("writer");
    const live = captured.get("live");
    assert.ok(writer && live);
    assert.equal(writer.isOpen, false);
    assert.equal(live.isOpen, false);
    assertWriterAvailable(f.home);
    assertDatabaseWriterAvailable(f.index);
    assert.deepEqual(await readFile(f.sources), record);
    assert.deepEqual(await readFile(path.join(backup, "manifest.json")), manifest);
    assert.deepEqual(await readFile(path.join(backup, "store.tar")), archive);
    assert.deepEqual(
      (await readdir(f.parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-")),
      [path.basename(backup)],
    );
    assert.deepEqual(catalogRecords(f.home), sources);
    assert.deepEqual(rows(f.index), [{ ...before[0], dir: "release-upgrade" }]);
    const db = new DatabaseSync(f.index, { readOnly: true, timeout: 0 });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()!["user_version"], SCHEMA_VERSION);
      assert.equal(db.prepare("PRAGMA integrity_check").get()!["integrity_check"], "ok");
      for (const term of ["releas", "upgrad", "surviv"])
        assert.deepEqual(
          db
            .prepare("SELECT skills.id FROM fts JOIN skills ON skills.rowid = fts.rowid WHERE fts MATCH ?")
            .all(term)
            .map((row) => ({ ...row })),
          [{ id: before[0]!["id"] }],
        );
    } finally {
      realClose.call(db);
    }
    assert.equal(
      (await readdir(f.home)).some((name) => name.startsWith(".catalog-")),
      false,
    );
  } finally {
    restore(handles);
  }
});

test("source migration publication direct clears owned stages before reading legacy data and closes held v2 on failure", async (t) => {
  const f = await fixture(t, 2);
  const oldBytes = await readFile(f.index);
  const oldRows = rows(f.index);
  const oldSources = await readFile(f.sources);
  const stage = path.join(f.home, ".catalog-1-0123456789abcdef01234567.tmp");
  await writeFile(stage, "owned");
  await writeFile(`${stage}.owner`, "margrave-catalog-v1\n");
  const handles = new Set<DatabaseSync>();
  const captured = new Map<"writer" | "live", DatabaseSync>();
  let dataRead = false;
  const fault = new Error("legacy rows fault");
  try {
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      if (this.location() === path.join(f.home, "writer-lock.db") && sql === "BEGIN IMMEDIATE") captured.set("writer", this);
      if (this.location() === f.index && sql === "BEGIN IMMEDIATE") captured.set("live", this);
      return realExec.call(this, sql);
    });
    mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      if (this === captured.get("live") && sql.startsWith("SELECT id, name, description, source, dir, hash AS revision")) {
        dataRead = true;
        assert.equal(existsSync(stage), false);
        assert.equal(existsSync(`${stage}.owner`), false);
        throw fault;
      }
      return nativePrepare.call(this, sql);
    });
    mock.method(fs, "readdir", (async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === f.home && dataRead) assert.fail("cleaned catalog temps after the legacy read fault");
      return nativeReaddir(...args);
    }) as typeof fs.readdir);
    syncBuiltinESMExports();
    await assert.rejects(migrateStore(), (err: unknown) => err === fault);
    assert.equal(dataRead, true);
    const writer = captured.get("writer");
    const live = captured.get("live");
    assert.ok(writer && live);
    assert.equal(writer.isOpen, false);
    assert.equal(live.isOpen, false);
    assertWriterAvailable(f.home);
    assertDatabaseWriterAvailable(f.index);
    await assert.rejects(readFile(stage), { code: "ENOENT" });
    await assert.rejects(readFile(`${stage}.owner`), { code: "ENOENT" });
    assert.deepEqual(await readFile(f.index), oldBytes);
    assert.deepEqual(rows(f.index), oldRows);
    assert.deepEqual(await readFile(f.sources), oldSources);
  } finally {
    restore(handles);
  }
});

test("source migration publication direct closes the v3 stage before successful publication", async (t) => {
  const f = await fixture(t, 3);
  const before = rows(f.index);
  const sources = catalogRecords(f.home);
  const handles = new Set<DatabaseSync>();
  const captured = new Map<"temp" | "writer" | "reader", DatabaseSync>();
  let stage: string | undefined;
  let publications = 0;
  try {
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      const file = this.location() ?? "";
      if (file === path.join(f.home, "writer-lock.db") && sql === "BEGIN IMMEDIATE") captured.set("writer", this);
      if (path.basename(file).startsWith(".catalog-") && sql === "BEGIN IMMEDIATE") {
        const reader = captured.get("reader");
        assert.ok(reader);
        assert.equal(reader.isOpen, false);
        captured.set("temp", this);
        stage = file;
      }
      return realExec.call(this, sql);
    });
    mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      if (this.location() === f.index && sql.startsWith("SELECT id, name, description, source, dir, hash AS revision"))
        captured.set("reader", this);
      return nativePrepare.call(this, sql);
    });
    mock.method(fs, "rename", (async (...args: Parameters<typeof fs.rename>) => {
      if (args[0] === stage && args[1] === f.index) {
        publications++;
        assert.equal(captured.get("temp")?.isOpen, false);
      }
      return nativeRename(...args);
    }) as typeof fs.rename);
    syncBuiltinESMExports();
    assert.equal(await migrateStore(), true);
    assert.equal(publications, 1);
    const temp = captured.get("temp");
    const writer = captured.get("writer");
    assert.ok(temp && writer && stage);
    assert.equal(temp.isOpen, false);
    assert.equal(writer.isOpen, false);
    assertWriterAvailable(f.home);
    assertDatabaseWriterAvailable(f.index);
    assert.deepEqual(rows(f.index), before);
    assert.deepEqual(catalogRecords(f.home), sources);
    await assert.rejects(readFile(`${stage}.owner`), { code: "ENOENT" });
    const db = new DatabaseSync(f.index, { readOnly: true, timeout: 0 });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()!["user_version"], SCHEMA_VERSION);
    } finally {
      realClose.call(db);
    }
  } finally {
    restore(handles);
  }
});

test("source migration publication direct commits a fresh v2 migration in place with a prepared backup", async (t) => {
  const f = await fixture(t, 2);
  const indexBytes = await readFile(f.index);
  const sourceBytes = await readFile(f.sources);
  const before = rows(f.index);
  const sources = await readLegacySources();
  const catalogStat = await stat(f.index, { bigint: true });
  const store = await realpath(f.home);
  const handles = new Set<DatabaseSync>();
  const captured = new Map<"live" | "writer", DatabaseSync>();
  let committed = false;
  let activeRenames = 0;
  try {
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      if (this.location() === f.index && sql === "BEGIN IMMEDIATE") captured.set("live", this);
      if (this.location() === path.join(f.home, "writer-lock.db") && sql === "BEGIN IMMEDIATE") captured.set("writer", this);
      const result = realExec.call(this, sql);
      if (this === captured.get("live") && sql === MIGRATION_COMMIT_SQL) committed = true;
      return result;
    });
    mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      return nativePrepare.call(this, sql);
    });
    mock.method(fs, "readdir", (async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === f.home && committed) assert.fail("cleaned catalog temps after the v2 commit");
      return nativeReaddir(...args);
    }) as typeof fs.readdir);
    mock.method(fs, "rename", (async (...args: Parameters<typeof fs.rename>) => {
      if (args[1] === f.index) {
        activeRenames++;
        assert.fail("published the in-place v2 catalog by rename");
      }
      return nativeRename(...args);
    }) as typeof fs.rename);
    syncBuiltinESMExports();
    assert.equal(await migrateStore(), true);
    assert.equal(committed, true);
    assert.equal(activeRenames, 0);
    const live = captured.get("live");
    const writer = captured.get("writer");
    assert.ok(live && writer);
    assert.equal(live.isOpen, false);
    assert.equal(writer.isOpen, false);
    assertWriterAvailable(f.home);
    assertDatabaseWriterAvailable(f.index);
    const marker = JSON.parse(await readFile(f.sources, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(marker).sort(), [
      "backup",
      "catalogDevice",
      "catalogInode",
      "from",
      "indexSha256",
      "kind",
      "phase",
      "sourcesSha256",
      "store",
      "version",
    ]);
    assert.equal(marker["kind"], "margrave-store-migration");
    assert.equal(marker["version"], 1);
    assert.equal(marker["phase"], "prepared");
    assert.equal(marker["from"], 2);
    assert.equal(marker["store"], store);
    assert.equal(marker["catalogDevice"], catalogStat.dev.toString());
    assert.equal(marker["catalogInode"], catalogStat.ino.toString());
    assert.equal(marker["indexSha256"], createHash("sha256").update(indexBytes).digest("hex"));
    assert.equal(marker["sourcesSha256"], createHash("sha256").update(sourceBytes).digest("hex"));
    assert.equal(typeof marker["backup"], "string");
    const backup = path.join(f.parent, marker["backup"] as string);
    const archive = path.join(backup, "store.tar");
    assert.deepEqual(execFileSync("/usr/bin/tar", ["-xOf", archive, "./index.db"]), indexBytes);
    assert.deepEqual(execFileSync("/usr/bin/tar", ["-xOf", archive, "./sources.json"]), sourceBytes);
    assert.equal((await stat(f.index, { bigint: true })).ino, catalogStat.ino);
    assert.deepEqual(catalogRecords(f.home), sources);
    assert.deepEqual(rows(f.index), [{ ...before[0], dir: "release-upgrade" }]);
    await assert.rejects(readFile(path.join(f.home, "catalog-published")), { code: "ENOENT" });
  } finally {
    restore(handles);
  }
});

test("source migration publication direct closes a recovered v2 lock on a pre-stage failure", async (t) => {
  const f = await fixture(t, 2);
  const sources = await readLegacySources();
  const backup = await backupMigrationStore(2, sources);
  await writeMigrationRecord(backup);
  const marker = await readFile(f.sources);
  await leaveHotJournal(f.index);
  const handles = new Set<DatabaseSync>();
  const captured = new Map<"live" | "writer", DatabaseSync>();
  const fault = new Error("recovered legacy rows fault");
  let faulted = false;
  try {
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      if (this.location() === path.join(f.home, "writer-lock.db") && sql === "BEGIN IMMEDIATE") captured.set("writer", this);
      if (this.location() === f.index && sql === "BEGIN" && captured.has("live"))
        assert.fail("opened a legacy reader after recovering the exclusive lock");
      const result = realExec.call(this, sql);
      if (this.location() === f.index && sql === "BEGIN EXCLUSIVE") captured.set("live", this);
      return result;
    });
    mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      handles.add(this);
      if (this === captured.get("live") && sql.startsWith("SELECT id, name, description, source, dir, hash AS revision")) {
        faulted = true;
        throw fault;
      }
      return nativePrepare.call(this, sql);
    });
    mock.method(fs, "readdir", (async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === f.home && faulted) assert.fail("cleaned catalog temps after the recovered read fault");
      return nativeReaddir(...args);
    }) as typeof fs.readdir);
    syncBuiltinESMExports();
    await assert.rejects(migrateStore(), (err: unknown) => err === fault);
    assert.equal(faulted, true);
    const live = captured.get("live");
    const writer = captured.get("writer");
    assert.ok(live && writer);
    assert.equal(live.isOpen, false);
    assert.equal(writer.isOpen, false);
    assertWriterAvailable(f.home);
    assertDatabaseWriterAvailable(f.index);
    assert.deepEqual(await readFile(f.sources), marker);
  } finally {
    restore(handles);
  }
});
