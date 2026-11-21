import assert from "node:assert/strict";
import fsp, { readFile, chmod, mkdir, readdir, rename, rm, stat, symlink, writeFile, cp, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { installSource, reindexAll, removeSource, updateSources } from "../src/sources.ts";
import { readSources, deleteSourceSkills, insertSkills, openIndexRead, temporaryCatalog } from "../src/catalog.ts";
import { writerLock, home as storeHome } from "../src/store.ts";
import {
  makeRepo,
  writeCatalogRecords,
  quiet,
  inStore,
  catalogRecords,
  fakeRipwire,
  holdWriteLock,
  indexIds,
  indexRows,
  leaveHotJournal,
  newEntry,
  realClose,
  realExec,
  runCli,
  seedIndex,
  sleep,
  tmp,
  writeSkill,
  useHome,
  catalogSetup,
  localSource,
  git,
  link,
  cliSetup,
  cliMg as mg,
  cliSnapshot,
  sourceId,
  installLocalDir,
  ROOT,
  hostedUseHome,
} from "./helpers.ts";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { loadContext } from "../src/skills.ts";
import type { Run } from "./helpers.ts";

/** How long a child process needs to finish its work before the lock, and reach the wait for it. */
export const CHILD_HEAD_START_MS = 2500;

export const installedId = (r: Run): string => /^installed (\S+)/mu.exec(r.stdout)?.[1] ?? "";

/** Read a file's bytes and inode through one handle, so the pair cannot straddle a replace (js/file-system-race). */
async function catalogSnapshot(file: string): Promise<{ data: Buffer; ino: number }> {
  const fh = await fsp.open(file, "r");
  try {
    return { data: await fh.readFile(), ino: (await fh.stat()).ino };
  } finally {
    await fh.close();
  }
}

const INVALID = /index\.db is not a supported margrave catalog/u;

const FOREIGN = /index\.db is not a supported margrave catalog/u;

const CORRUPT = /cannot open .*index\.db: /u;

interface BadDb {
  why: string;
  make: (file: string) => Promise<void> | void;
}

/** Not ours: NOTADB, a user_version other than 0 and 1 (a negative one too), or user_version 0 with a table. Every command refuses it, reindex included. */
const FOREIGN_DBS: BadDb[] = [
  {
    why: "a wrong user_version",
    make: (file) => {
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE skills(id TEXT); CREATE VIRTUAL TABLE fts USING fts5(a); PRAGMA user_version = 7");
      db.close();
    },
  },
  {
    why: "a negative user_version",
    make: (file) => {
      const db = new DatabaseSync(file);
      db.exec("PRAGMA user_version = -1");
      db.close();
    },
  },
  {
    why: "a database with an unrelated table and user_version 0",
    make: (file) => {
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE other(x)");
      db.close();
    },
  },
  {
    why: "a database with only a view and user_version 0",
    make: (file) => {
      const db = new DatabaseSync(file);
      db.exec("CREATE VIEW v AS SELECT 42");
      db.close();
    },
  },
  {
    why: "a garbage file",
    make: (file) => writeFile(file, "this is not a database, but it is longer than a header would need to be ".repeat(4)),
  },
];

/** Schema-less (user_version 0, no tables): reads refuse it; reindex and the first install initialize it in place. */
const SCHEMALESS_DBS: BadDb[] = [
  { why: "a 0-byte file", make: (file) => writeFile(file, "") },
  {
    why: "an empty database with user_version 0",
    make: (file) => {
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE t(x); DROP TABLE t");
      db.close();
    },
  },
];

/** user_version 1 with a table missing: reindex cannot fill it, so every command says to move it aside. */
const PARTIAL_DBS: BadDb[] = [
  {
    why: "user_version 1 with the fts table missing",
    make: (file) => {
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE skills(id TEXT); PRAGMA user_version = 1");
      db.close();
    },
  },
  {
    why: "user_version 1 with no schema",
    make: (file) => {
      const db = new DatabaseSync(file);
      db.exec("PRAGMA user_version = 1");
      db.close();
    },
  },
];

/** A store set up with alpha, whose index.db is replaced by the bad one. */
async function withBadDb(bad: BadDb): Promise<Awaited<ReturnType<typeof catalogSetup>> & { file: string; other: string }> {
  const s = await catalogSetup();
  const file = path.join(s.home, "index.db");
  await rm(file);
  await bad.make(file);
  return { ...s, file, other: (await localSource("beta")).dir };
}

const readArgs = (s: { id: string; other: string }): string[][] => [
  ["find", "alpha"],
  ["list"],
  ["load", "alpha"],
  ["install", s.other],
  ["update", s.id],
  ["update"],
  ["remove", s.id],
];

test("Git records without a snapshot are rejected", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const records = await readSources();
    delete records[0]!.snapshot;
    writeCatalogRecords(home, records);
    const before = await readFile(path.join(home, "index.db"));
    await assert.rejects(readSources(), /malformed/u);
    await assert.rejects(reindexAll(quiet), /malformed/u);
    await assert.rejects(updateSources(id, quiet), /malformed/u);
    await assert.rejects(removeSource(id), /malformed/u);
    assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  });
});

test("a malformed catalog record closes the reader connection", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  await seedIndex([newEntry("s", "a")]);
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("UPDATE sources SET record = 'invalid json'");
  db.close();
  let closed = 0;
  mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closed++;
    return realClose.call(this);
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(loadContext());
  assert.equal(closed, 1);
});

test("a catalog that appears during an empty-store read is opened", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  await seedIndex([newEntry("s", "a")]);
  const file = path.join(home, "index.db");
  const lstat = fsp.lstat;
  let hidden = 0;
  mock.method(fsp, "lstat", ((name: string, ...args: unknown[]) => {
    if (name === file && hidden++ < 2) return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
    return (lstat as (...values: unknown[]) => unknown)(name, ...args);
  }) as typeof fsp.lstat);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const context = await loadContext();
  assert.ok(context);
  assert.equal(context.sources[0]?.id, "s");
  context.db.close();
});

test("opening a missing catalog and a catalog without its source table fails closed", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  await assert.rejects(openIndexRead(), /Restore the complete store backup/u);
  await seedIndex([newEntry("s", "a")]);
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("DROP TABLE sources");
  db.close();
  await assert.rejects(openIndexRead(), /not a supported margrave catalog/u);
});

test("the catalog uses the DELETE journal, user_version 4, and leaves no side files after a read", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  await seedIndex([newEntry("s", "a")]);
  const db = await openIndexRead();
  try {
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete");
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
  } finally {
    db.close();
  }
  assert.deepEqual((await readdir(home)).sort(), ["index.db"]);
});

test("the writer reads integers as BigInt, and a contentless FTS delete does not break the next write", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  await seedIndex([newEntry("s", "a"), newEntry("s", "b")]);
  const db = new DatabaseSync(path.join(home, "index.db"), { readBigInts: true });
  try {
    assert.equal(typeof (db.prepare("SELECT 1 AS n").get() as { n: unknown }).n, "bigint");
    db.exec("BEGIN IMMEDIATE");
    deleteSourceSkills(db, "s");
    insertSkills(db, [newEntry("s", "c")]);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  assert.deepEqual(indexIds(home), ["s/c"]);
});

test("writer lock timeout and unexpected SQLite errors release the connection", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  let failure: unknown = Object.assign(new Error("busy"), { errcode: 5 });
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE") throw failure;
    return realExec.call(this, sql);
  });
  let now = 0;
  mock.method(Date, "now", () => (now++ === 0 ? 0 : 30_001));
  t.after(() => mock.restoreAll());
  await assert.rejects(writerLock(), /another Margrave writer holds the store lock/u);
  failure = new Error("lock failed");
  await assert.rejects(writerLock(), /lock failed/u);
  mock.restoreAll();
  const lock = await writerLock();
  lock.close();
});

test("a loose index.json is ignored and remains untouched", async () => {
  const s = await catalogSetup();
  const json = path.join(s.home, "index.json");
  await writeFile(json, "legacy bytes");
  assert.equal((await s.mg(["find", "alpha"])).code, 0);
  assert.equal((await s.mg(["reindex"])).code, 0);
  assert.equal(await readFile(json, "utf8"), "legacy bytes");
});

test("a foreign index.db is refused by every command, reindex included, and margrave never changes or deletes it", async () => {
  for (const bad of FOREIGN_DBS) {
    const s = await withBadDb(bad);
    const before = await catalogSnapshot(s.file);
    for (const args of [...readArgs(s), ["reindex"]]) {
      const r = await s.mg(args);
      assert.equal(r.code, 1, `${bad.why}: ${args.join(" ")}`);
      assert.match(r.stderr, FOREIGN, `${bad.why}: ${args.join(" ")}`);
    }
    const after = await catalogSnapshot(s.file);
    assert.deepEqual(after.data, before.data, `${bad.why}: the file is unchanged`);
    assert.equal(after.ino, before.ino, bad.why);
    assert.deepEqual((await readdir(s.home)).filter((n) => n.startsWith("index")).sort(), ["index.db"], `${bad.why}: no side file`);
    // A lost canonical catalog cannot be rebuilt from stale metadata.
    await rename(s.file, `${s.file}.aside`);
    const re = await s.mg(["reindex"]);
    assert.equal(re.code, 1, `${bad.why}: ${re.stderr}`);
    assert.match(re.stderr, /Restore the complete store backup/u);
  }
});

test("the schema probe sees a concurrent initial commit as one snapshot", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  const file = path.join(home, "index.db");
  new DatabaseSync(file).close();
  const { prepare } = DatabaseSync.prototype as unknown as {
    prepare: (this: DatabaseSync, sql: string) => ReturnType<DatabaseSync["prepare"]>;
  };
  let committed = false;
  mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.includes("pragma_user_version") && !committed) {
      committed = true;
      const writer = new DatabaseSync(file);
      writer.exec(
        "BEGIN IMMEDIATE; CREATE TABLE skills(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, id_lc TEXT NOT NULL, name TEXT NOT NULL, name_lc TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL, dir TEXT NOT NULL, hash TEXT NOT NULL, manifest TEXT NOT NULL, frontmatter TEXT NOT NULL); CREATE INDEX skills_name_lc ON skills(name_lc); CREATE INDEX skills_id_lc ON skills(id_lc); CREATE INDEX skills_source ON skills(source); CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL); CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='ascii'); PRAGMA user_version = 4; COMMIT",
      );
      writer.close();
    }
    return prepare.call(this, sql);
  });
  t.after(() => mock.restoreAll());
  const db = await openIndexRead();
  db.close();
  assert.equal(committed, true);
});

test("a version 2 index with incomplete FTS columns is rejected", async (t) => {
  const s = await catalogSetup();
  useHome(t, s.home);
  const db = new DatabaseSync(path.join(s.home, "index.db"));
  db.exec("DROP TABLE fts; CREATE VIRTUAL TABLE fts USING fts5(name)");
  db.close();
  await assert.rejects(openIndexRead(), /not a supported margrave catalog/u);
  await assert.rejects(temporaryCatalog(), /not a supported margrave catalog/u);
  const missingIndex = new DatabaseSync(path.join(s.home, "index.db"));
  missingIndex.exec("DROP TABLE fts; CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body); DROP INDEX skills_source");
  missingIndex.close();
  await assert.rejects(openIndexRead(), /not a supported margrave catalog/u);
});

test("a version 1 schema is rejected before creating a temporary catalog", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  const file = path.join(home, "index.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE unrelated(id TEXT); PRAGMA user_version = 1");
  db.close();
  await assert.rejects(temporaryCatalog(), /not a supported margrave catalog/u);
});

test("a schema-less catalog is refused and left unchanged", async () => {
  for (const bad of SCHEMALESS_DBS) {
    const s = await withBadDb(bad);
    const inode = (await stat(s.file)).ino;
    for (const args of readArgs(s)) {
      const r = await s.mg(args);
      assert.equal(r.code, 1, `${bad.why}: ${args.join(" ")}`);
      assert.match(r.stderr, INVALID, `${bad.why}: ${args.join(" ")}`);
    }
    const re = await s.mg(["reindex"]);
    assert.equal(re.code, 1, `${bad.why}: ${re.stderr}`);
    assert.match(re.stderr, FOREIGN);
    assert.equal((await stat(s.file)).ino, inode, `${bad.why}: file remains in place`);
  }
});

test("user_version 1 with a table missing gives the move-it-aside message for every command, reindex included, and the file is unchanged", async () => {
  for (const bad of PARTIAL_DBS) {
    const s = await withBadDb(bad);
    const before = await readFile(s.file);
    for (const args of [...readArgs(s), ["reindex"]]) {
      const r = await s.mg(args);
      assert.equal(r.code, 1, `${bad.why}: ${args.join(" ")}`);
      assert.match(r.stderr, FOREIGN, `${bad.why}: ${args.join(" ")}`);
    }
    assert.deepEqual(await readFile(s.file), before, bad.why);
  }
});

test("an install into a store with no sources: a schema-less index.db is initialized in place; a foreign or partial one is refused and unchanged", async () => {
  const cases = [
    ...SCHEMALESS_DBS.map((bad) => ({ bad, ok: false, message: INVALID })),
    ...FOREIGN_DBS.map((bad) => ({ bad, ok: false, message: FOREIGN })),
    ...PARTIAL_DBS.map((bad) => ({ bad, ok: false, message: FOREIGN })),
  ];
  for (const { bad, ok, message } of cases) {
    const home = await tmp("mg-home-");
    const dir = await tmp("mg-localsrc-");
    await writeSkill(dir, "alpha", "alpha skill");
    const file = path.join(home, "index.db");
    await bad.make(file);
    const before = await catalogSnapshot(file);
    const r = await runCli(["install", dir], { home, fakeBin: await fakeRipwire() });
    if (ok) {
      assert.equal(r.code, 0, `${bad.why}: ${r.stderr}`);
      assert.equal(indexIds(home).length, 1, bad.why);
      assert.equal((await catalogSnapshot(file)).ino, before.ino, `${bad.why}: opened in place`);
      assert.equal((await runCli(["find", "alpha"], { home })).code, 0, bad.why);
    } else {
      assert.equal(r.code, 1, bad.why);
      assert.match(r.stderr, message, bad.why);
      assert.deepEqual((await catalogSnapshot(file)).data, before.data, `${bad.why}: the file is unchanged`);
      assert.equal((await readdir(home)).includes("sources.json"), false, `${bad.why}: no source was recorded`);
    }
  }
});

test("a damaged index.db (SQLITE_CORRUPT) keeps the open error and adds how to recover; nothing is deleted", async () => {
  const s = await catalogSetup();
  const file = path.join(s.home, "index.db");
  // Keep the 100-byte header (it holds user_version), then overwrite the start of the schema page.
  const fh = await fsp.open(file, "r+");
  try {
    await fh.write(Buffer.alloc(200, 0xff), 0, 200, 100);
  } finally {
    await fh.close();
  }
  const before = await catalogSnapshot(file);
  for (const args of [["find", "alpha"], ["list"], ["reindex"]]) {
    const r = await s.mg(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, CORRUPT, args.join(" "));
    assert.doesNotMatch(r.stderr, /not a valid margrave index|not a supported margrave catalog/u, args.join(" "));
  }
  assert.deepEqual((await catalogSnapshot(file)).data, before.data);
});

test("an extended SQLITE_CORRUPT code (SQLITE_CORRUPT_INDEX, 779) gets the recovery hint, and a code that is not corrupt does not", async (t) => {
  useHome(t, await tmp("mg-home-"));
  await seedIndex([newEntry("s", "a")]);
  let errcode = 779;
  mock.method(DatabaseSync.prototype, "prepare", () => {
    throw Object.assign(new Error("mock: database disk image is malformed"), { errcode });
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(openIndexRead(), CORRUPT);
  errcode = 1;
  await assert.rejects(
    openIndexRead(),
    (err: Error) => /cannot open .*index\.db: mock: /u.test(err.message) && !/move it aside/u.test(err.message),
  );
});

test("a foreign temporary copy is rejected and the active catalog stays intact", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  const file = path.join(home, "index.db");
  await seedIndex([newEntry("s", "a")]);
  const before = await readFile(file);
  const real = fsp.copyFile;
  mock.method(fsp, "copyFile", async (from: Parameters<typeof fsp.copyFile>[0], to: Parameters<typeof fsp.copyFile>[1], flags?: number) => {
    await real(from, to, flags);
    await writeFile(to, "foreign database");
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(temporaryCatalog(), /not a supported margrave catalog/u);
  assert.deepEqual(await readFile(file), before);
});

test(
  "a hot journal from a killed writer: every reader says so, margrave deletes nothing, and reindex recovers",
  { timeout: 60_000 },
  async () => {
    const s = await catalogSetup();
    const file = path.join(s.home, "index.db");
    await leaveHotJournal(file);
    assert.equal((await readdir(s.home)).includes("index.db-journal"), true, "the killed writer left a hot journal");

    const message = /index\.db has an unfinished v0.2.1 write. Restore a complete backup before migrating/u;
    for (const args of [["find", "alpha"], ["list"], ["load", `${s.id}/alpha`]]) {
      const r = await s.mg(args);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.stderr, message, args.join(" "));
      assert.doesNotMatch(r.stderr, /not a valid margrave index|not a margrave index|cannot open/u, args.join(" "));
    }
    assert.equal((await readdir(s.home)).includes("index.db-journal"), true, "a reader never deletes the journal");

    const re = await s.mg(["reindex"]);
    assert.equal(re.code, 1, re.stderr);
    assert.match(re.stderr, message);
    assert.equal((await readdir(s.home)).includes("index.db-journal"), true);
  },
);

test("two first-time installs of different sources into an empty store both survive", { timeout: 60_000 }, async () => {
  for (let round = 0; round < 3; round++) {
    const home = await tmp("mg-home-");
    const fakeBin = await fakeRipwire();
    const [one, two] = [await localSource("beta"), await localSource("gamma")];
    assert.deepEqual(await readdir(home), [], "no sources.json and no index.db yet");
    const runs = await Promise.all([runCli(["install", one.dir], { home, fakeBin }), runCli(["install", two.dir], { home, fakeBin })]);
    for (const r of runs) assert.equal(r.code, 0, r.stderr);
    const sources = catalogRecords(home);
    assert.deepEqual(sources.map((x) => x.id).sort(), runs.map(installedId).sort(), `round ${round}`);
    assert.deepEqual(indexIds(home), [`${installedId(runs[0])}/beta`, `${installedId(runs[1])}/gamma`].sort(), `round ${round}`);
  }
});

test("a locked database is not called invalid, and reindex does not delete it", { timeout: 60_000 }, async () => {
  const s = await catalogSetup();
  const before = indexRows(s.home);
  // EXCLUSIVE blocks readers too. The reader timeout is 5 s.
  const lock = holdWriteLock(s.home, "EXCLUSIVE");
  let runs: Run[];
  try {
    runs = await Promise.all([s.mg(["find", "alpha"]), s.mg(["reindex"]), s.mg(["list"])]);
  } finally {
    lock.release();
  }
  for (const r of runs) {
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /cannot open .*index\.db: /u);
    assert.doesNotMatch(r.stderr, /not a valid margrave index/u);
  }
  assert.deepEqual(indexRows(s.home), before, "the index is intact");
  assert.equal((await s.mg(["find", "alpha"])).code, 0);
});

test("a symlinked or non-regular index.db is refused, and reindex does not follow it", async () => {
  const s = await catalogSetup();
  const file = path.join(s.home, "index.db");
  const real = path.join(s.home, "real.db");
  await rename(file, real);
  await symlink(real, file);
  const other = await localSource("beta");
  for (const args of [["find", "alpha"], ["reindex"], ["install", other.dir]]) {
    const r = await s.mg(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /index\.db is not a regular catalog file/u, args.join(" "));
  }
  assert.equal((await stat(real)).isFile(), true, "the target is untouched");
  await rm(file);
  await mkdir(file);
  assert.match((await s.mg(["find", "alpha"])).stderr, /index\.db is not a regular catalog file/u);
});

test("an index.db that cannot be opened for a reason other than NOTADB is an error that names index.db, and nothing is deleted", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can read a file with mode 000");
  const s = await catalogSetup();
  const file = path.join(s.home, "index.db");
  await chmod(file, 0o000);
  try {
    for (const args of [["find", "alpha"], ["reindex"]]) {
      const r = await s.mg(args);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.stderr, /cannot open .*index\.db: /u, args.join(" "));
    }
  } finally {
    await chmod(file, 0o644);
  }
  assert.deepEqual(indexIds(s.home), [`${s.id}/alpha`]);
});

test("a store directory that cannot be inspected is an error that names index.db", async (t) => {
  const file = path.join(await tmp("mg-home-"), "not-a-dir");
  await writeFile(file, "x");
  useHome(t, file);
  assert.equal(storeHome(), file);
  await assert.rejects(openIndexRead(), /cannot read .*index\.db: /u);
});

test("a missing index.db with sources says to run reindex", async () => {
  const s = await catalogSetup();
  await rm(path.join(s.home, "index.db"));
  const r = await s.mg(["find", "alpha"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /index\.db is missing\. Restore the complete store backup/u);
});

test("a schema that cannot be created is an error that names index.db, and the handle is closed", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  let closed = 0;
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS skills")) throw new Error("mock: no schema");
    return realExec.call(this, sql);
  });
  mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closed++;
    return realClose.call(this);
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(temporaryCatalog(), /mock: no schema/u);
  assert.equal(closed, 1);
});

test("a temporary catalog configuration failure closes and removes the copy", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "PRAGMA journal_mode = DELETE") throw new Error("journal configuration failed");
    return realExec.call(this, sql);
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(temporaryCatalog(), /journal configuration failed/u);
  assert.deepEqual(await readdir(home), []);
  mock.restoreAll();
  const temp = await temporaryCatalog();
  temp.db.close();
  await rm(temp.file);
});

test("an index.db that cannot be created in a read-only store is an error that names index.db", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can write into a mode 555 directory");
  const home = await tmp("mg-home-");
  t.after(() => chmod(home, 0o755));
  await chmod(home, 0o555);
  const r = await runCli(["reindex"], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot complete the store operation: /u);
});

test("a read-only MARGRAVE_HOME (mode 555) still serves find and load, and creates no side files", async (t) => {
  const s = await catalogSetup();
  t.after(() => chmod(s.home, 0o755));
  await chmod(s.home, 0o555);
  const before = (await readdir(s.home)).sort();
  const find = await s.mg(["find", "alpha"]);
  assert.equal(find.code, 0, find.stderr);
  assert.match(find.stdout, /alpha/u);
  const load = await s.mg(["load", `${s.id}/alpha`]);
  assert.equal(load.code, 0, load.stderr);
  assert.match(load.stdout, /Body of alpha/u);
  const list = await s.mg(["list", "--json", "--skills"]);
  assert.equal(list.code, 0, list.stderr);
  assert.equal((JSON.parse(list.stdout) as { sources: { skillCount: number }[] }).sources[0]?.skillCount, 1);
  assert.deepEqual((await readdir(s.home)).sort(), before);
});

test("two installs of different sources that wait for the same lock both survive", { timeout: 60_000 }, async () => {
  const s = await catalogSetup();
  const [one, two] = [await localSource("beta"), await localSource("gamma")];
  const lockDb = new DatabaseSync(path.join(s.home, "writer-lock.db"));
  lockDb.exec("BEGIN IMMEDIATE");
  const lock = {
    release: () => {
      if (lockDb.isTransaction) lockDb.exec("COMMIT");
    },
  };
  let runs: Run[];
  try {
    const pending = [s.mg(["install", one.dir]), s.mg(["install", two.dir])];
    await sleep(CHILD_HEAD_START_MS);
    lock.release();
    runs = await Promise.all(pending);
  } finally {
    lock.release();
    lockDb.close();
  }
  for (const r of runs) assert.equal(r.code, 0, r.stderr);
  const sources = catalogRecords(s.home);
  assert.equal(sources.length, 3, "all three source records are in the catalog");
  assert.deepEqual(
    indexIds(s.home),
    [`${s.id}/alpha`, `${installedId(runs[0] as Run)}/beta`, `${installedId(runs[1] as Run)}/gamma`].sort(),
  );
  const list = await s.mg(["list", "--skills"]);
  assert.match(list.stdout, /beta skill/u);
  assert.match(list.stdout, /gamma skill/u);
});

test("a reader during an open write transaction gets the old results with no error", { timeout: 30_000 }, async () => {
  const s = await catalogSetup();
  const lock = holdWriteLock(s.home);
  try {
    insertSkills(lock.db, [newEntry(s.id, "uncommitted")]);
    const find = await s.mg(["find", "alpha", "--json"]);
    assert.equal(find.code, 0, find.stderr);
    assert.deepEqual(
      (JSON.parse(find.stdout) as { results: { id: string }[] }).results.map((r) => r.id),
      [`${s.id}/alpha`],
    );
    const list = await s.mg(["list"]);
    assert.match(list.stdout, /skills=1\n/u);
  } finally {
    lock.release();
  }
});

test("schema 1 is rejected without changing the database", async (t) => {
  const s = await catalogSetup();
  useHome(t, s.home);
  const file = path.join(s.home, "index.db");
  const db = new DatabaseSync(file);
  db.exec("ALTER TABLE skills DROP COLUMN manifest; ALTER TABLE skills DROP COLUMN frontmatter; PRAGMA user_version = 1");
  db.close();
  const before = await readFile(file);
  await assert.rejects(openIndexRead(), /not a supported margrave catalog/u);
  await assert.rejects(temporaryCatalog(), /not a supported margrave catalog/u);
  await assert.rejects(reindexAll(quiet), /not a supported margrave catalog/u);
  assert.deepEqual(await readFile(file), before);
});

test("first publication can retry after catalog rename fails", async () => {
  const env = await cliSetup();
  const repo = await makeRepo();
  const preload = path.join(await tmp(), "fail-publication.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(env.home, "index.db"))}) return Promise.reject(new Error("publication failed")); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /publication failed/u);
  const retried = await mg(env, ["install", repo.url]);
  assert.equal(retried.code, 0, retried.stderr);
  const loaded = await mg(env, ["load", "react-perf"]);
  assert.equal(loaded.code, 0, loaded.stderr);
});

test("first publication distinguishes interruption before and after rename", async () => {
  for (const checkpoint of ["before", "after"] as const) {
    const env = await cliSetup();
    const repo = await makeRepo();
    const preload = path.join(await tmp(), "interrupt-first-publication.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = async function(from, to) {
  if (to !== ${JSON.stringify(path.join(env.home, "index.db"))}) return rename.call(this, from, to);
  if (${JSON.stringify(checkpoint)} === "after") await rename.call(this, from, to);
  process.kill(process.pid, "SIGKILL");
};
syncBuiltinESMExports();\n`,
    );
    const stopped = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
    assert.notEqual(stopped.code, 0);
    if (checkpoint === "before") {
      assert.deepEqual(JSON.parse((await mg(env, ["list", "--json"])).stdout), { sources: [] });
      const publicationMarker = path.join(env.home, "catalog-published");
      const markerCopy = path.join(await tmp(), "marker");
      await rename(publicationMarker, markerCopy);
      await link(markerCopy, publicationMarker);
      assert.match((await mg(env, ["list", "--json"])).stderr, /index\.db is missing/u);
      await rm(publicationMarker);
      await rename(markerCopy, publicationMarker);
      const owner = (await readdir(env.home)).find((name) => name.endsWith(".tmp.owner"))!;
      const ownerFile = path.join(env.home, owner);
      const outside = path.join(await tmp(), "owner");
      await rename(ownerFile, outside);
      await link(outside, ownerFile);
      assert.match((await mg(env, ["list", "--json"])).stderr, /index\.db is missing/u);
      await rm(ownerFile);
      await rename(outside, ownerFile);
      const retried = await mg(env, ["install", repo.url]);
      assert.equal(retried.code, 0, retried.stderr);
      assert.equal((await mg(env, ["load", "react-perf"])).code, 0);
    } else {
      assert.equal((await mg(env, ["load", "react-perf"])).code, 0);
      await rm(path.join(env.home, "index.db"));
      const missing = await mg(env, ["list", "--json"]);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /index\.db is missing\. Restore the complete store backup/u);
      const retry = await mg(env, ["install", repo.url]);
      assert.equal(retry.code, 1);
      assert.match(retry.stderr, /index\.db is missing\. Restore the complete store backup/u);
    }
  }
});

test("populated Git catalog survives writer termination at publication and cleanup", async () => {
  for (const checkpoint of ["before", "after", "cleanup"] as const) {
    const env = await cliSetup();
    const repo = await makeRepo();
    const support = path.join(repo.dir, "skills", "react-perf", "reference.txt");
    await writeFile(support, "old supporting bytes\n");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-qm", "add supporting file");
    const installed = await mg(env, ["install", repo.url]);
    assert.equal(installed.code, 0, installed.stderr);
    const id = sourceId(installed);
    const old = catalogRecords(env.home)[0]!;
    const oldCatalog = await cliSnapshot(env.home);
    const oldSnapshot = path.join(env.home, "snapshots", id, old.snapshot!);
    await writeSkill(path.join(repo.dir, "skills"), "react-perf", "Updated description", "Updated body.");
    await writeFile(support, "new supporting bytes\n");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-qm", "update skill and supporting file");
    const scratch = await tmp("mg-interruption-");
    const preload = path.join(scratch, "kill.mjs");
    const reached = path.join(scratch, "reached");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename; const rm = fs.rm; let published = false;
const stop = () => { writeFileSync(${JSON.stringify(reached)}, ${JSON.stringify(checkpoint)}); process.kill(process.pid, "SIGKILL"); };
fs.rename = async function(from, to) {
  if (to === ${JSON.stringify(path.join(env.home, "index.db"))}) {
    if (${JSON.stringify(checkpoint)} === "before") stop();
    await rename.call(this, from, to); published = true;
    if (${JSON.stringify(checkpoint)} === "after") stop();
    return;
  }
  return rename.call(this, from, to);
};
fs.rm = function(file, ...args) {
  if (published && ${JSON.stringify(checkpoint)} === "cleanup" && String(file).includes("/.catalog-")) stop();
  return rm.call(this, file, ...args);
};
syncBuiltinESMExports();\n`,
    );
    const stopped = await runCli(["update", id], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
    assert.equal(stopped.code, 1, checkpoint);
    assert.equal(await readFile(reached, "utf8"), checkpoint);
    const committed = catalogRecords(env.home)[0]!;
    if (checkpoint === "before") assert.deepEqual(await cliSnapshot(env.home), oldCatalog);
    else assert.notEqual(committed.snapshot, old.snapshot);
    const alias = path.join(env.home, "sources", id);
    assert.equal(await realpath(alias), checkpoint === "cleanup" ? path.join(env.home, "snapshots", id, committed.snapshot!) : oldSnapshot);
    assert.ok((await readdir(env.home)).some((name) => name.endsWith(".tmp.owner")));

    const copy = path.join(scratch, "store");
    await cp(env.home, copy, { recursive: true, verbatimSymlinks: true });
    const setReadOnly = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await setReadOnly(file);
        else if (entry.isFile()) await chmod(file, 0o444);
      }
      await chmod(dir, 0o555);
    };
    await setReadOnly(copy);
    assert.deepEqual(await cliSnapshot(copy), await cliSnapshot(env.home));
    const loaded = await mg({ ...env, home: copy }, ["load", `${id}/react-perf`]);
    assert.equal(loaded.code, 0, loaded.stderr);
    assert.match(loaded.stdout, checkpoint === "before" ? /Body of react-perf/u : /Updated body/u);
    const reference = await mg({ ...env, home: copy }, ["load", `${id}/react-perf`, "--file", "reference.txt"]);
    assert.equal(reference.code, 0, reference.stderr);
    assert.equal(reference.stdout, checkpoint === "before" ? "old supporting bytes\n" : "new supporting bytes\n");
    const repaired = await mg(env, ["reindex"]);
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.equal(await realpath(alias), path.join(env.home, "snapshots", id, committed.snapshot!));
    assert.ok(!(await readdir(env.home)).some((name) => name.startsWith(".catalog-")));
    assert.equal(await readFile(path.join(oldSnapshot, "skills", "react-perf", "reference.txt"), "utf8"), "old supporting bytes\n");
  }
});

test("readers recheck the catalog when pending publication changes", async () => {
  for (const change of ["publish", "cleanup"] as const) {
    const env = await cliSetup();
    const repo = await makeRepo();
    const dir = await tmp();
    const stop = path.join(dir, "stop.mjs");
    await writeFile(
      stop,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(env.home, "index.db"))}) process.kill(process.pid, "SIGKILL"); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
    );
    await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", stop] });
    const name = (await readdir(env.home)).find((item) => /^\.catalog-\d+-[0-9a-f]{24}\.tmp$/u.test(item))!;
    const temp = path.join(env.home, name);
    const race = path.join(dir, "race.mjs");
    await writeFile(
      race,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstat;
fs.lstat = async function(file, ...args) {
  if (file === ${JSON.stringify(temp)}) {
    if (${JSON.stringify(change)} === "publish") await fs.rename(file, ${JSON.stringify(path.join(env.home, "index.db"))});
    else { await fs.rm(${JSON.stringify(path.join(env.home, "catalog-published"))}); await fs.rm(file); }
  }
  return lstat.call(this, file, ...args);
};
syncBuiltinESMExports();\n`,
    );
    const result = await runCli(["list", "--json"], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", race] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sources.length, change === "publish" ? 1 : 0);
  }
});

test("cleanup preserves a pending marker while a catalog exists", async () => {
  const env = await cliSetup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  assert.equal((await mg(env, ["install", dir])).code, 0);
  const name = `.catalog-123-${"a".repeat(24)}.tmp`;
  await writeFile(path.join(env.home, name), "owned temporary catalog");
  await writeFile(path.join(env.home, `${name}.owner`), "margrave-catalog-v1\n");
  await writeFile(path.join(env.home, "catalog-published"), `pending ${name}\n`);
  const result = await mg(env, ["reindex"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await mg(env, ["load", "alpha"])).code, 0);
});

test("failure to publish catalog evidence leaves the published catalog readable", async () => {
  const env = await cliSetup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  const preload = path.join(await tmp(), "fail-marker.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
let markers = 0;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(env.home, "catalog-published"))} && ++markers === 2) return Promise.reject(new Error("marker rename failed")); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["install", dir], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /marker rename failed/u);
  assert.equal((await mg(env, ["load", "alpha"])).code, 0);
  assert.equal((await mg(env, ["reindex"])).code, 0);
});

test("a reader held across publication keeps the old catalog", async () => {
  const env = await cliSetup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = sourceId(installed);
  const db = new DatabaseSync(path.join(env.home, "index.db"), { readOnly: true });
  try {
    db.exec("BEGIN");
    const before = db.prepare("SELECT hash FROM skills WHERE id = ?").get(`${id}/react-perf`);
    await writeSkill(path.join(repo.dir, "skills"), "react-perf", "Changed description");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-qm", "change skill");
    const updated = await mg(env, ["update", id]);
    assert.equal(updated.code, 0, updated.stderr);
    assert.deepEqual(db.prepare("SELECT hash FROM skills WHERE id = ?").get(`${id}/react-perf`), before);
    const current = new DatabaseSync(path.join(env.home, "index.db"), { readOnly: true });
    try {
      assert.notDeepEqual(current.prepare("SELECT hash FROM skills WHERE id = ?").get(`${id}/react-perf`), before);
    } finally {
      current.close();
    }
  } finally {
    db.close();
  }
});

test("a writer retries while the separate store lock is held", async () => {
  const env = await cliSetup();
  const repo = await makeRepo();
  const lock = new DatabaseSync(path.join(env.home, "writer-lock.db"));
  lock.exec("BEGIN IMMEDIATE");
  const scratch = await tmp();
  const signal = path.join(scratch, "busy");
  const preload = path.join(scratch, "observe-lock.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { try { return exec.call(this, sql); } catch (err) { if (sql === "BEGIN IMMEDIATE" && err.errcode === 5) writeFileSync(${JSON.stringify(signal)}, "busy"); throw err; } };\n`,
  );
  try {
    const installing = runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
    const deadline = Date.now() + 10_000;
    while (
      !(await stat(signal).then(
        () => true,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < deadline, "writer did not encounter the held lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    lock.exec("COMMIT");
    const result = await installing;
    assert.equal(result.code, 0, result.stderr);
  } finally {
    lock.close();
  }
});

test("a writer cleans owned catalog temporaries and preserves unrelated objects", async () => {
  const env = await cliSetup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  const owned = path.join(env.home, `.catalog-123-${"a".repeat(24)}.tmp`);
  const unowned = path.join(env.home, `.catalog-456-${"b".repeat(24)}.tmp`);
  const protectedPath = path.join(env.home, `.catalog-789-${"c".repeat(24)}.tmp`);
  const malformed = path.join(env.home, `.catalog-987-${"d".repeat(24)}.tmp`);
  const outside = path.join(await tmp(), "outside");
  await writeFile(owned, "temporary catalog");
  await writeFile(`${owned}-journal`, "temporary journal");
  await writeFile(`${owned}.owner`, "margrave-catalog-v1\n");
  await writeFile(unowned, "unrelated bytes");
  await writeFile(outside, "protected bytes");
  await link(outside, protectedPath);
  await writeFile(`${protectedPath}.owner`, "margrave-catalog-v1\n");
  await writeFile(malformed, "unrelated catalog");
  await writeFile(`${malformed}.owner`, "not a Margrave owner");
  const result = await mg(env, ["reindex"]);
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(readFile(owned), { code: "ENOENT" });
  await assert.rejects(readFile(`${owned}-journal`), { code: "ENOENT" });
  await assert.rejects(readFile(`${owned}.owner`), { code: "ENOENT" });
  assert.equal(await readFile(unowned, "utf8"), "unrelated bytes");
  assert.equal(await readFile(outside, "utf8"), "protected bytes");
  assert.equal(await readFile(malformed, "utf8"), "unrelated catalog");
  assert.equal(await readlink(protectedPath), outside);
  assert.equal((await mg(env, ["load", "alpha"])).code, 0);
});

test("a killed writer leaves an owned catalog copy that the next writer removes", async () => {
  const env = await cliSetup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  await writeSkill(dir, "beta", "beta skill");
  const preload = path.join(await tmp(), "kill-before-publish.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(env.home, "index.db"))}) process.kill(process.pid, "SIGKILL"); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  const killed = await runCli(["reindex"], { home: env.home, nodeArgs: ["--import", preload] });
  assert.equal(killed.code, 1);
  assert.ok((await readdir(env.home)).some((name) => name.endsWith(".tmp.owner")));
  await chmod(env.home, 0o555);
  try {
    const before = await mg(env, ["list", "--skills"]);
    assert.equal(before.code, 0, before.stderr);
    assert.match(before.stdout, /alpha/u);
    assert.doesNotMatch(before.stdout, /beta/u);
  } finally {
    await chmod(env.home, 0o755);
  }
  const retry = await mg(env, ["reindex"]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.ok(!(await readdir(env.home)).some((name) => name.startsWith(".catalog-")));
  assert.match((await mg(env, ["list", "--skills"])).stdout, /beta/u);
});

test("a malformed or missing catalog requires restoration from a backup", async () => {
  const env = await cliSetup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill");
  assert.equal((await mg(env, ["install", dir])).code, 0);
  const backup = await readFile(path.join(env.home, "index.db"));
  await writeFile(path.join(env.home, "index.db"), "{ broken");
  const r = await mg(env, ["find", "alpha"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /index\.db is not a supported margrave catalog/u);
  assert.equal((await mg(env, ["reindex"])).code, 1, "reindex does not replace a file that is not ours");
  await rename(path.join(env.home, "index.db"), path.join(env.home, "index.db.aside"));
  assert.equal((await mg(env, ["reindex"])).code, 1);
  const missing = await mg(env, ["find", "alpha"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /index\.db is missing\. Restore the complete store backup/u);
  await writeFile(path.join(env.home, "index.db"), backup);
  assert.equal((await mg(env, ["find", "alpha"])).code, 0);
});

test("store readers refuse legacy, empty, and missing catalogs", async (t) => {
  const home = await hostedUseHome(t);
  t.after(() => rm(home, { recursive: true, force: true }));
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  await assert.rejects(openIndexRead(), /store upgrade required/u);
  await rm(path.join(home, "index.db"));
  await assert.rejects(readSources(), /store upgrade required/u);
  const empty = new DatabaseSync(path.join(home, "index.db"));
  empty.close();
  await assert.rejects(openIndexRead(), /not a supported margrave catalog/u);
});
