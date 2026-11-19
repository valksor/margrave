// index.db: ranking, the upgrade and validity guard, locking, and concurrent writes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import fsp, { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { MAX_QUERY_TERMS } from "../src/bm25.ts";
import { findSkills, formatFind, readSelectedFile, resolveSkill } from "../src/skills.ts";
import { installSource, localId, reindexAll, removeSource, updateSources } from "../src/sources.ts";
import { deleteSourceSkills, home as storeHome, insertSkills, openIndexRead, openIndexWrite } from "../src/store.ts";
import type { NewEntry, SourceRecord } from "../src/store.ts";
import {
  changeAtLock,
  fakeRipwire,
  holdWriteLock,
  indexIds,
  indexRows,
  leaveHotJournal,
  makeRepo,
  newEntry,
  realClose,
  realExec,
  runCli,
  seedIndex,
  sleep,
  tmp,
  writeIndexRows,
  writeSkill,
} from "./helpers.ts";
import type { Run } from "./helpers.ts";

/** Read a file's bytes and inode through one handle, so the pair cannot straddle a replace (js/file-system-race). */
async function snapshot(file: string): Promise<{ data: Buffer; ino: number }> {
  const fh = await fsp.open(file, "r");
  try {
    return { data: await fh.readFile(), ino: (await fh.stat()).ino };
  } finally {
    await fh.close();
  }
}

/** Point MARGRAVE_HOME at `h` for this test only. */
function useHome(t: { after: (fn: () => void) => void }, h: string): void {
  const prev = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = h;
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
}

/** Rank in a fresh store each call (the caller has pointed MARGRAVE_HOME somewhere that it restores). */
async function ranked(entries: NewEntry[], task: string, limit?: number, explain = false): Promise<{ id: string; score: number }[]> {
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  await seedIndex(entries);
  const db = await openIndexRead();
  try {
    return findSkills(db, task, limit, explain).map((h) => ({ id: h.id, score: h.score }));
  } finally {
    db.close();
  }
}

const ids = (hits: { id: string }[]): string[] => hits.map((h) => h.id);

// ---- ranking ----

test("BM25 ranks the document that matches the query best first", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const entries = [
    newEntry("s", "react-perf", "Optimize React rendering performance"),
    newEntry("s", "postgres", "Tune PostgreSQL queries and indexes"),
    newEntry("s", "docker", "Write Docker Compose files"),
  ];
  await seedIndex(entries);
  const db = await openIndexRead();
  try {
    assert.equal(findSkills(db, "react performance", undefined)[0]?.id, "s/react-perf");
    assert.equal(findSkills(db, "postgresql index", undefined)[0]?.id, "s/postgres");
    assert.deepEqual(findSkills(db, "kubernetes", undefined), []);
    assert.deepEqual(findSkills(db, "docker", undefined)[0], {
      id: "s/docker",
      name: "docker",
      description: "Write Docker Compose files",
      revision: "h",
      score: findSkills(db, "docker", undefined)[0]?.score,
    });
  } finally {
    db.close();
  }
});

test("a name match outweighs the same word in the body", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const hits = await ranked(
    [newEntry("s", "alpha", "Something unrelated", "redis redis redis redis"), newEntry("s", "redis", "Something else")],
    "redis",
  );
  assert.equal(hits[0]?.id, "s/redis");
});

test("an exact name or id match ranks first, even against a skill with strong hits in several columns", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const entries = [
    newEntry("s", "deploy-guide", "deploy deploy deploy production deploy checklist", "deploy production deploy production"),
    newEntry("s", "production", "Short note"),
  ];
  assert.equal((await ranked(entries, "production deploy"))[0]?.id, "s/deploy-guide");
  const exact = await ranked(entries, "production");
  assert.equal(exact[0]?.id, "s/production");
  assert.ok((exact[0]?.score ?? 0) >= 10, "the shown score carries the +10 bonus");
  // The id match is case-insensitive, and an exact match that no token matches still shows up.
  assert.equal((await ranked(entries, "S/PRODUCTION"))[0]?.id, "s/production");
  assert.deepEqual(await ranked(entries, "  PRODUCTION  "), exact);
});

test("a query with no tokens skips the text search; only an exact name or id matches", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const entries = [newEntry("s", "of", "the and of words"), newEntry("s", "other", "of of of")];
  // "of" and "the" are stopwords, so there is no token and no MATCH.
  assert.deepEqual(ids(await ranked(entries, "of")), ["s/of"]);
  const db = await openIndexRead();
  try {
    const hit = findSkills(db, "of", undefined, true)[0];
    assert.equal(hit?.exact, true);
    assert.equal(hit?.recommended, true);
    assert.deepEqual(hit?.matchedTerms, { name: [], description: [], headings: [], body: [] });
    const exactId = findSkills(db, "S/OF", undefined, true);
    assert.equal(exactId[0]?.id, "s/of");
    const text = formatFind(exactId);
    assert.match(text, /exact name or id/u);
    assert.doesNotMatch(text, /matches in/u);
    assert.match(text, /load: margrave load s\/of/u);
  } finally {
    db.close();
  }
  assert.deepEqual(await ranked(entries, "the"), []);
  assert.deepEqual(await ranked(entries, ""), []);
  assert.deepEqual(await ranked(entries, "   "), []);
  assert.deepEqual(await ranked(entries, "!!! ???"), []);
});

test("equal scores break by id in byte order, in any insert order", async (t) => {
  const same = (id: string): NewEntry => newEntry("s", id, "identical description text");
  for (const order of [
    ["zeta", "alpha", "mid"],
    ["mid", "zeta", "alpha"],
  ]) {
    useHome(t, await tmp("mg-home-"));
    assert.deepEqual(ids(await ranked(order.map(same), "identical description")), ["s/alpha", "s/mid", "s/zeta"], order.join());
  }
});

test("the tie-break is SQLite byte order: a high BMP id sorts before an astral id", async (t) => {
  useHome(t, await tmp("mg-home-"));
  // Names without a-z0-9 give no name tokens, so both rows tie on the description. UTF-8: U+FF21 is EF BC A1, U+1F600 is F0 9F 98 80.
  // In UTF-16 order the astral id (D83D ...) would come first.
  const entries = ["\u{1F600}", "Ａ"].map((n) => newEntry("s", n, "identical description text"));
  assert.deepEqual(ids(await ranked(entries, "identical description")), ["s/Ａ", "s/\u{1F600}"]);
});

test("the limit cuts the result list", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const entries = ["a", "b", "c", "d"].map((x) => newEntry("s", x, "shared words here"));
  assert.equal((await ranked(entries, "shared words", 2)).length, 2);
  assert.equal((await ranked(entries, "shared words")).length, 4);
});

test("a recommendation below a higher-scoring weak match survives the limit", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const entries = [
    newEntry("s", "rare", "unrelated"),
    newEntry("s", "target", "unrelated", "rare common extra"),
    ...Array.from({ length: 8 }, (_, i) => newEntry("s", `filler${i}`, "unrelated", "common extra")),
  ];
  await seedIndex(entries);
  const db = await openIndexRead();
  try {
    const hits = findSkills(db, "rare common extra", 25, true);
    const weak = hits.find((hit) => hit.id === "s/rare");
    const recommended = hits.find((hit) => hit.id === "s/target");
    assert.equal(weak?.recommended, false);
    assert.equal(recommended?.recommended, true);
    assert.ok((weak?.score ?? 0) > (recommended?.score ?? 0));
    assert.equal(findSkills(db, "rare common extra", 1)[0]?.id, "s/target");
  } finally {
    db.close();
  }
});

test("tokens named like Object.prototype members rank like any other token", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const hits = await ranked(
    [newEntry("s", "a-skill", "explains the constructor pattern and toString"), newEntry("s", "b-skill", "other")],
    "constructor valueOf",
    undefined,
    true,
  );
  assert.deepEqual(ids(hits), ["s/a-skill"]);
  assert.ok(Number.isFinite(hits[0]?.score));
});

test("a 10,000-term task uses at most 32 terms and returns fast", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const task = Array.from({ length: 10_000 }, (_, i) => `word${i}`).join(" ");
  const entries = [
    newEntry("s", "first", "has word5 in it"),
    newEntry("s", "late", `has word${MAX_QUERY_TERMS + 5} in it`),
    newEntry("s", "last", "has word9999 in it"),
  ];
  await seedIndex(entries);
  const db = await openIndexRead();
  try {
    const started = performance.now();
    const hits = findSkills(db, task, undefined, true);
    const ms = performance.now() - started;
    assert.deepEqual(ids(hits), ["s/first"], "terms after the 32nd are dropped");
    assert.ok(ms < 1000, `took ${ms} ms`);
  } finally {
    db.close();
  }
});

test("the term cap is exact: the 32nd distinct token matches and the 33rd does not", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const task = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const entries = [newEntry("s", "inside", "has word31 in it"), newEntry("s", "outside", "has word32 in it")];
  assert.deepEqual(ids(await ranked(entries, task, undefined, true)), ["s/inside"]);
});

test("query text never reaches the SQL: quotes, operators, and FTS syntax are plain tokens or dropped", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const entries = [newEntry("s", "alpha", "alpha near beta"), newEntry("s", "it's", "quote name")];
  assert.deepEqual(ids(await ranked(entries, `alpha" OR "x' ; DROP TABLE skills; -- NEAR(a b) * ^nomatch:`, undefined, true)), ["s/alpha"]);
  assert.deepEqual(ids(await ranked(entries, "it's")), ["s/it's"]);
  const db = await openIndexRead();
  try {
    assert.equal((db.prepare("SELECT count(*) AS n FROM skills").get() as { n: number }).n, 2);
  } finally {
    db.close();
  }
});

test("resolveSkill answers from SQL: id, bare name, ambiguity, unknown", async (t) => {
  useHome(t, await tmp("mg-home-"));
  await seedIndex([newEntry("a", "x"), newEntry("b", "x"), newEntry("a", "only")]);
  const db = await openIndexRead();
  try {
    assert.equal(resolveSkill(db, "a/x").source, "a");
    assert.equal(resolveSkill(db, "only").id, "a/only");
    assert.throws(() => resolveSkill(db, "x"), /"x" is ambiguous; use one of these ids:\n {2}a\/x\n {2}b\/x/u);
    assert.throws(() => resolveSkill(db, "%"), /no skill "%"/u, "a LIKE wildcard matches nothing");
  } finally {
    db.close();
  }
});

// ---- the writer connection ----

test("the index uses the DELETE journal, user_version 2, and leaves no side files after a read", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  await seedIndex([newEntry("s", "a")]);
  const db = await openIndexRead();
  try {
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete");
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  } finally {
    db.close();
  }
  assert.deepEqual((await readdir(home)).sort(), ["index.db"]);
});

test("the writer reads integers as BigInt, and a contentless FTS delete does not break the next write", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  await seedIndex([newEntry("s", "a"), newEntry("s", "b")]);
  const db = await openIndexWrite("existing");
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

// ---- the guard: missing, legacy, invalid, locked ----

async function localSource(name: string): Promise<{ dir: string; record: (id: string) => SourceRecord }> {
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, name, `${name} skill`);
  return {
    dir,
    record: (id) => ({ id, kind: "local", spec: dir, path: dir, subpath: "", ref: null, commit: null, installedAt: "now" }),
  };
}

async function setup(): Promise<{ home: string; fakeBin: string; dir: string; id: string; mg: (args: string[]) => Promise<Run> }> {
  const home = await tmp("mg-home-");
  const fakeBin = await fakeRipwire();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill for the guard tests");
  const mg = (args: string[]): Promise<Run> => runCli(args, { home, fakeBin });
  const inst = await mg(["install", dir]);
  assert.equal(inst.code, 0, inst.stderr);
  return { home, fakeBin, dir, id: /^installed (\S+)/mu.exec(inst.stdout)?.[1] ?? "", mg };
}

const INVALID = /index\.db is not a valid margrave index; run: margrave reindex/u;

test("a loose index.json is ignored and remains untouched", async () => {
  const s = await setup();
  const json = path.join(s.home, "index.json");
  await writeFile(json, "legacy bytes");
  assert.equal((await s.mg(["find", "alpha"])).code, 0);
  assert.equal((await s.mg(["reindex"])).code, 0);
  assert.equal(await readFile(json, "utf8"), "legacy bytes");
});

const FOREIGN = /index\.db is not a margrave index; move it aside, then run: margrave reindex/u;
const CORRUPT = /cannot open .*index\.db: .*; if the file is damaged, move it aside, then run: margrave reindex/u;

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
async function withBadDb(bad: BadDb): Promise<Awaited<ReturnType<typeof setup>> & { file: string; other: string }> {
  const s = await setup();
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

test("a foreign index.db is refused by every command, reindex included, and margrave never changes or deletes it", async () => {
  for (const bad of FOREIGN_DBS) {
    const s = await withBadDb(bad);
    const before = await snapshot(s.file);
    for (const args of [...readArgs(s), ["reindex"]]) {
      const r = await s.mg(args);
      assert.equal(r.code, 1, `${bad.why}: ${args.join(" ")}`);
      assert.match(r.stderr, FOREIGN, `${bad.why}: ${args.join(" ")}`);
    }
    const after = await snapshot(s.file);
    assert.deepEqual(after.data, before.data, `${bad.why}: the file is unchanged`);
    assert.equal(after.ino, before.ino, bad.why);
    assert.deepEqual((await readdir(s.home)).filter((n) => n.startsWith("index")).sort(), ["index.db"], `${bad.why}: no side file`);
    // The user moves it aside, then reindex builds a new one.
    await rename(s.file, `${s.file}.aside`);
    const re = await s.mg(["reindex"]);
    assert.equal(re.code, 0, `${bad.why}: ${re.stderr}`);
    assert.deepEqual(indexIds(s.home), [`${s.id}/alpha`], bad.why);
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
        "BEGIN IMMEDIATE; CREATE TABLE skills(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, id_lc TEXT NOT NULL, name TEXT NOT NULL, name_lc TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL, dir TEXT NOT NULL, hash TEXT NOT NULL, manifest TEXT NOT NULL, frontmatter TEXT NOT NULL); CREATE INDEX skills_name_lc ON skills(name_lc); CREATE INDEX skills_id_lc ON skills(id_lc); CREATE INDEX skills_source ON skills(source); CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='unicode61'); PRAGMA user_version = 2; COMMIT",
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
  const s = await setup();
  useHome(t, s.home);
  const db = new DatabaseSync(path.join(s.home, "index.db"));
  db.exec("DROP TABLE fts; CREATE VIRTUAL TABLE fts USING fts5(name)");
  db.close();
  await assert.rejects(openIndexRead(), /not a margrave index/u);
  await assert.rejects(openIndexWrite("create"), /not a margrave index/u);
  const missingIndex = new DatabaseSync(path.join(s.home, "index.db"));
  missingIndex.exec("DROP TABLE fts; CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body); DROP INDEX skills_source");
  missingIndex.close();
  await assert.rejects(openIndexRead(), /not a margrave index/u);
});

test("a version 1 schema committed before the create lock is rejected", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  const file = path.join(home, "index.db");
  new DatabaseSync(file).close();
  let fired = false;
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && !fired) {
      fired = true;
      const writer = new DatabaseSync(file);
      realExec.call(
        writer,
        "CREATE TABLE skills(rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, id_lc TEXT NOT NULL, name TEXT NOT NULL, name_lc TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL, dir TEXT NOT NULL, hash TEXT NOT NULL); CREATE INDEX skills_name_lc ON skills(name_lc); CREATE INDEX skills_id_lc ON skills(id_lc); CREATE INDEX skills_source ON skills(source); CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='unicode61'); PRAGMA user_version = 1",
      );
      writer.close();
    }
    return realExec.call(this, sql);
  });
  t.after(() => mock.restoreAll());
  await assert.rejects(openIndexWrite("create"), /not a margrave index/u);
  assert.equal(fired, true);
});

test("a schema-less index.db is an error for reads; reindex initializes it in place", async () => {
  for (const bad of SCHEMALESS_DBS) {
    const s = await withBadDb(bad);
    const inode = (await stat(s.file)).ino;
    for (const args of readArgs(s)) {
      const r = await s.mg(args);
      assert.equal(r.code, 1, `${bad.why}: ${args.join(" ")}`);
      assert.match(r.stderr, INVALID, `${bad.why}: ${args.join(" ")}`);
    }
    const re = await s.mg(["reindex"]);
    assert.equal(re.code, 0, `${bad.why}: ${re.stderr}`);
    assert.deepEqual(indexIds(s.home), [`${s.id}/alpha`], bad.why);
    assert.equal((await stat(s.file)).ino, inode, `${bad.why}: opened in place, not unlinked`);
    assert.equal((await s.mg(["find", "alpha"])).code, 0, bad.why);
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
    ...SCHEMALESS_DBS.map((bad) => ({ bad, ok: true, message: INVALID })),
    ...FOREIGN_DBS.map((bad) => ({ bad, ok: false, message: FOREIGN })),
    ...PARTIAL_DBS.map((bad) => ({ bad, ok: false, message: FOREIGN })),
  ];
  for (const { bad, ok, message } of cases) {
    const home = await tmp("mg-home-");
    const dir = await tmp("mg-localsrc-");
    await writeSkill(dir, "alpha", "alpha skill");
    const file = path.join(home, "index.db");
    await bad.make(file);
    const before = await snapshot(file);
    const r = await runCli(["install", dir], { home, fakeBin: await fakeRipwire() });
    if (ok) {
      assert.equal(r.code, 0, `${bad.why}: ${r.stderr}`);
      assert.equal(indexIds(home).length, 1, bad.why);
      assert.equal((await snapshot(file)).ino, before.ino, `${bad.why}: opened in place`);
      assert.equal((await runCli(["find", "alpha"], { home })).code, 0, bad.why);
    } else {
      assert.equal(r.code, 1, bad.why);
      assert.match(r.stderr, message, bad.why);
      assert.deepEqual((await snapshot(file)).data, before.data, `${bad.why}: the file is unchanged`);
      assert.equal((await readdir(home)).includes("sources.json"), false, `${bad.why}: no source was recorded`);
    }
  }
});

test("a damaged index.db (SQLITE_CORRUPT) keeps the open error and adds how to recover; nothing is deleted", async () => {
  const s = await setup();
  const file = path.join(s.home, "index.db");
  // Keep the 100-byte header (it holds user_version), then overwrite the start of the schema page.
  const fh = await fsp.open(file, "r+");
  try {
    await fh.write(Buffer.alloc(200, 0xff), 0, 200, 100);
  } finally {
    await fh.close();
  }
  const before = await snapshot(file);
  for (const args of [["find", "alpha"], ["list"], ["reindex"]]) {
    const r = await s.mg(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, CORRUPT, args.join(" "));
    assert.doesNotMatch(r.stderr, /not a valid margrave index|not a margrave index/u, args.join(" "));
  }
  assert.deepEqual((await snapshot(file)).data, before.data);
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

test("a foreign index.db that appears between the lstat and the open in create mode is a foreign index, and is not changed", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  const file = path.join(home, "index.db");
  await writeFile(file, "this is not a database, but it is longer than a header would need to be ".repeat(4));
  const before = await readFile(file);
  const real = fsp.lstat;
  // The lstat sees no index.db, as if the file arrived right after it.
  let hidden = 0;
  mock.method(fsp, "lstat", (p: string, ...rest: never[]) => {
    if (p !== file) return real(p, ...rest);
    hidden += 1;
    return Promise.reject(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }));
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(openIndexWrite("create"), FOREIGN);
  // The create path saw no file, so the error came from the open, not from the probe of an existing file.
  assert.ok(hidden >= 1, "the lstat of index.db was hidden");
  assert.deepEqual(await readFile(file), before);
});

test(
  "a hot journal from a killed writer: every reader says so, margrave deletes nothing, and reindex recovers",
  { timeout: 60_000 },
  async () => {
    const s = await setup();
    const file = path.join(s.home, "index.db");
    await leaveHotJournal(file);
    assert.equal((await readdir(s.home)).includes("index.db-journal"), true, "the killed writer left a hot journal");

    const message = /index\.db has an unfinished write from a stopped margrave process; run: margrave reindex/u;
    for (const args of [["find", "alpha"], ["list"], ["load", `${s.id}/alpha`]]) {
      const r = await s.mg(args);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.stderr, message, args.join(" "));
      assert.doesNotMatch(r.stderr, /not a valid margrave index|not a margrave index|cannot open/u, args.join(" "));
    }
    assert.equal((await readdir(s.home)).includes("index.db-journal"), true, "a reader never deletes the journal");

    const re = await s.mg(["reindex"]);
    assert.equal(re.code, 0, re.stderr);
    assert.deepEqual(indexIds(s.home), [`${s.id}/alpha`], "the killed write was rolled back");
    assert.equal((await s.mg(["find", "alpha"])).code, 0);
  },
);

test("reindex creates MARGRAVE_HOME when it does not exist", async () => {
  const home = path.join(await tmp("mg-parent-"), "not", "there", "yet");
  const r = await runCli(["reindex"], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(indexIds(home), []);
});

test("update with no argument prints a guard error once, not once per source", async () => {
  const s = await setup();
  const second = await localSource("beta");
  assert.equal((await s.mg(["install", second.dir])).code, 0);
  await rm(path.join(s.home, "index.db"));
  await writeFile(path.join(s.home, "index.json"), "{}");
  const r = await s.mg(["update"]);
  assert.equal(r.code, 1);
  assert.equal(r.stderr.match(/index\.db is missing; run: margrave reindex/gu)?.length, 1, r.stderr);
});

test("two first-time installs of different sources into an empty store both survive", { timeout: 60_000 }, async () => {
  for (let round = 0; round < 3; round++) {
    const home = await tmp("mg-home-");
    const fakeBin = await fakeRipwire();
    const [one, two] = [await localSource("beta"), await localSource("gamma")];
    assert.deepEqual(await readdir(home), [], "no sources.json and no index.db yet");
    const runs = await Promise.all([runCli(["install", one.dir], { home, fakeBin }), runCli(["install", two.dir], { home, fakeBin })]);
    for (const r of runs) assert.equal(r.code, 0, r.stderr);
    const sources = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { id: string }[];
    assert.deepEqual(sources.map((x) => x.id).sort(), runs.map(installedId).sort(), `round ${round}`);
    assert.deepEqual(indexIds(home), [`${installedId(runs[0])}/beta`, `${installedId(runs[1])}/gamma`].sort(), `round ${round}`);
  }
});

test("a locked database is not called invalid, and reindex does not delete it", { timeout: 60_000 }, async () => {
  const s = await setup();
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
  const s = await setup();
  const file = path.join(s.home, "index.db");
  const real = path.join(s.home, "real.db");
  await rename(file, real);
  await symlink(real, file);
  const other = await localSource("beta");
  for (const args of [["find", "alpha"], ["reindex"], ["install", other.dir]]) {
    const r = await s.mg(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /index\.db is not a regular file/u, args.join(" "));
  }
  assert.equal((await stat(real)).isFile(), true, "the target is untouched");
  await rm(file);
  await mkdir(file);
  assert.match((await s.mg(["find", "alpha"])).stderr, /index\.db is not a regular file/u);
});

test("an index.db that cannot be opened for a reason other than NOTADB is an error that names index.db, and nothing is deleted", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can read a file with mode 000");
  const s = await setup();
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
  const s = await setup();
  await rm(path.join(s.home, "index.db"));
  const r = await s.mg(["find", "alpha"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /index\.db is missing; run: margrave reindex/u);
});

test("a source whose skills are gone lists with skills=0 after a reindex", async () => {
  const s = await setup();
  await rm(path.join(s.dir, "alpha"), { recursive: true });
  assert.equal((await s.mg(["reindex"])).code, 0);
  const list = await s.mg(["list"]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /skills=0\n$/u);
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
  await assert.rejects(openIndexWrite("create"), /cannot create .*index\.db: mock: no schema/u);
  assert.equal(closed, 1);
});

test("an index.db that cannot be created in a read-only store is an error that names index.db", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root can write into a mode 555 directory");
  const home = await tmp("mg-home-");
  t.after(() => chmod(home, 0o755));
  await chmod(home, 0o555);
  const r = await runCli(["reindex"], { home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot create .*index\.db: /u);
});

// ---- read-only store ----

test("a read-only MARGRAVE_HOME (mode 555) still serves find and load, and creates no side files", async (t) => {
  const s = await setup();
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

// ---- concurrency, forced with a helper connection that holds the write lock ----

/** How long a child process needs to finish its work before the lock, and reach the wait for it. */
const CHILD_HEAD_START_MS = 2500;

const installedId = (r: Run): string => /^installed (\S+)/mu.exec(r.stdout)?.[1] ?? "";

test("two installs of different sources that wait for the same lock both survive", { timeout: 60_000 }, async () => {
  const s = await setup();
  const [one, two] = [await localSource("beta"), await localSource("gamma")];
  const lock = holdWriteLock(s.home);
  let runs: Run[];
  try {
    const pending = [s.mg(["install", one.dir]), s.mg(["install", two.dir])];
    await sleep(CHILD_HEAD_START_MS);
    lock.release();
    runs = await Promise.all(pending);
  } finally {
    lock.release();
  }
  for (const r of runs) assert.equal(r.code, 0, r.stderr);
  const sources = JSON.parse(await readFile(path.join(s.home, "sources.json"), "utf8")) as { id: string }[];
  assert.equal(sources.length, 3, "all three source records are in sources.json");
  assert.deepEqual(
    indexIds(s.home),
    [`${s.id}/alpha`, `${installedId(runs[0] as Run)}/beta`, `${installedId(runs[1] as Run)}/gamma`].sort(),
  );
  const list = await s.mg(["list", "--skills"]);
  assert.match(list.stdout, /beta skill/u);
  assert.match(list.stdout, /gamma skill/u);
});

// ---- a write that changes the store between a command's checks and its lock, in this process ----

const quiet = { log: (): void => undefined, allowUnsafe: false };

/** Put the fake ripwire first on PATH for this test, so an in-process install can scan. */
async function useFakeRipwire(t: { after: (fn: () => void) => void }): Promise<void> {
  const prev = process.env["PATH"] ?? "";
  process.env["PATH"] = `${await fakeRipwire()}:${prev}`;
  t.after(() => {
    process.env["PATH"] = prev;
  });
}

const sourcesFilePath = (home: string): string => path.join(home, "sources.json");
const readSourceRecords = (home: string): SourceRecord[] => JSON.parse(readFileSync(sourcesFilePath(home), "utf8")) as SourceRecord[];

test("a reindex whose sources change after its scan reports it under the lock, and loses nothing", async (t) => {
  const s = await setup();
  useHome(t, s.home);
  const extra = await localSource("beta");
  const record = extra.record("local__extra-abc123");
  const existing = readSourceRecords(s.home);
  // BEGIN IMMEDIATE number 1 is the schema check when the connection opens; number 2 is the reindex's own lock.
  const lock = changeAtLock(t, 2, () => {
    // The change acts as an install that won the lock: a new source record and new rows.
    writeIndexRows(s.home, (db) => insertSkills(db, [newEntry(record.id, "beta")]));
    writeFileSync(sourcesFilePath(s.home), JSON.stringify([...existing, record], null, 2));
  });
  await assert.rejects(reindexAll(quiet), /sources changed during reindex; run: margrave reindex/u);
  assert.equal(lock.fired(), true, "the error came after the reindex's lock was taken");
  assert.equal(lock.begins(), 2);
  assert.deepEqual(
    readSourceRecords(s.home)
      .map((x) => x.id)
      .sort(),
    [s.id, "local__extra-abc123"].sort(),
  );
  assert.deepEqual(indexIds(s.home), ["local__extra-abc123/beta", `${s.id}/alpha`].sort());
  // The next reindex sees the new set and works.
  mock.restoreAll();
  assert.deepEqual(await reindexAll(quiet), { skills: 2, sources: 2 });
});

/** The change for the next three tests: another command removed `id` (rows and record) before this command took the lock. */
function removedByAnother(t: { after: (fn: () => void) => void }, home: string, id: string): ReturnType<typeof changeAtLock> {
  return changeAtLock(t, 1, () => {
    writeIndexRows(home, (db) => deleteSourceSkills(db, id));
    writeFileSync(sourcesFilePath(home), "[]\n");
  });
}

test("an update whose source another write removed fails under the lock and changes nothing", async (t) => {
  const s = await setup();
  useHome(t, s.home);
  const lock = removedByAnother(t, s.home, s.id);
  await assert.rejects(updateSources(s.id, quiet), new RegExp(`no source "${s.id}"$`, "u"));
  // The message is the same before the lock, so the counter tells the two apart.
  assert.equal(lock.fired(), true, "the error came after the update's lock was taken");
  assert.equal(lock.begins(), 1);
  assert.equal(readFileSync(sourcesFilePath(s.home), "utf8"), "[]\n");
  assert.deepEqual(indexIds(s.home), []);
});

test("a remove whose source another write removed fails under the lock and changes nothing", async (t) => {
  const s = await setup();
  useHome(t, s.home);
  const lock = removedByAnother(t, s.home, s.id);
  await assert.rejects(removeSource(s.id), new RegExp(`no source "${s.id}"; run: margrave list`, "u"));
  assert.equal(lock.fired(), true, "the error came after the remove's lock was taken");
  assert.equal(lock.begins(), 1);
  assert.equal(readFileSync(sourcesFilePath(s.home), "utf8"), "[]\n");
  assert.deepEqual(indexIds(s.home), []);
});

test("an install of a source that another install added first fails under the lock and keeps one set of rows", async (t) => {
  const s = await setup();
  useHome(t, s.home);
  await useFakeRipwire(t);
  const third = await localSource("gamma");
  const newId = localId(await realpath(third.dir));
  const existing = readSourceRecords(s.home);
  const lock = changeAtLock(t, 1, () => {
    writeIndexRows(s.home, (db) => insertSkills(db, [newEntry(newId, "gamma")]));
    writeFileSync(sourcesFilePath(s.home), JSON.stringify([...existing, third.record(newId)], null, 2));
  });
  await assert.rejects(installSource(third.dir, null, quiet), /is already installed; run: margrave update/u);
  assert.equal(lock.fired(), true, "the error came after the install's lock was taken");
  assert.equal(lock.begins(), 1);
  assert.deepEqual(
    readSourceRecords(s.home)
      .map((x) => x.id)
      .sort(),
    [s.id, newId].sort(),
  );
  assert.deepEqual(indexIds(s.home), [`${s.id}/alpha`, `${newId}/gamma`].sort());
});

test("a reader during an open write transaction gets the old results with no error", { timeout: 30_000 }, async () => {
  const s = await setup();
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
  const s = await setup();
  useHome(t, s.home);
  const file = path.join(s.home, "index.db");
  const db = new DatabaseSync(file);
  db.exec("ALTER TABLE skills DROP COLUMN manifest; ALTER TABLE skills DROP COLUMN frontmatter; PRAGMA user_version = 1");
  db.close();
  const before = await readFile(file);
  await assert.rejects(openIndexRead(), /not a margrave index/u);
  await assert.rejects(openIndexWrite("existing"), /not a margrave index/u);
  await assert.rejects(reindexAll(quiet), /not a margrave index/u);
  assert.deepEqual(await readFile(file), before);
});

test("a selected revision reports an operational read error and an index change", async (t) => {
  const s = await setup();
  useHome(t, s.home);
  const db = await openIndexRead();
  const entry = resolveSkill(db, `${s.id}/alpha`);
  db.close();
  const actual = fsp.realpath;
  mock.method(fsp, "realpath", ((p: string, ...args: unknown[]) =>
    p === entry.dir
      ? Promise.reject(Object.assign(new Error("read denied"), { code: "EACCES" }))
      : (actual as (...args: unknown[]) => unknown)(p, ...args)) as typeof fsp.realpath);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(readSelectedFile(entry, "SKILL.md", entry.revision), /read denied/u);
  mock.restoreAll();
  syncBuiltinESMExports();
  const writer = new DatabaseSync(path.join(s.home, "index.db"));
  writer.prepare("UPDATE skills SET hash = ? WHERE id = ?").run(`sha256:${"b".repeat(64)}`, entry.id);
  writer.close();
  await assert.rejects(readSelectedFile(entry, "SKILL.md", entry.revision), /skill revision changed; search again/u);
});

test("a pinned Git read reports file drift when its source record disappears", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  const repo = await makeRepo();
  const fakeBin = await fakeRipwire();
  const installed = await runCli(["install", repo.url], { home, fakeBin });
  assert.equal(installed.code, 0, installed.stderr);
  const db = await openIndexRead();
  const entry = resolveSkill(db, "react-perf");
  db.close();
  await writeFile(path.join(entry.dir, "SKILL.md"), "changed bytes\n");
  const sourceFile = path.join(home, "sources.json");
  const records = JSON.parse(await readFile(sourceFile, "utf8")) as { snapshot: string }[];
  assert.ok(records[0]);
  records[0].snapshot = `${records[0].snapshot.slice(0, -16)}0000000000000000`;
  await writeFile(sourceFile, JSON.stringify(records));
  await assert.rejects(readSelectedFile(entry, "SKILL.md", entry.revision), /skill revision changed; search again/u);
  await writeFile(path.join(home, "sources.json"), "[]\n");
  await assert.rejects(readSelectedFile(entry, "SKILL.md", entry.revision), /skill files changed since indexing/u);
});
