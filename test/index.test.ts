import {
  localSource,
  readSourceRecords,
  removedByAnother,
  catalogSetup as setup,
  quiet,
  useHome,
  catalogRecords,
  changeAtLock,
  fakeRipwire,
  indexIds,
  makeRepo,
  newEntry,
  runCli,
  seedIndex,
  tmp,
  writeCatalogRecords,
  writeIndexRows,
} from "./helpers.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp, { mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { MAX_QUERY_TERMS } from "../src/bm25.ts";
import {
  findSkills,
  findSkillsWithCount,
  formatFind,
  loadContext,
  NO_SOURCES_MESSAGE,
  readSelectedFile,
  resolveSkill,
  validateRevision,
} from "../src/skills.ts";
import { installSource, localId, updateSources } from "../src/sources.ts";
import { insertSkills, openIndexRead } from "../src/store.ts";
import type { NewEntry } from "../src/store.ts";

/** Put the fake ripwire first on PATH for this test, so an in-process install can scan. */
export async function useFakeRipwire(t: { after: (fn: () => void) => void }): Promise<void> {
  const prev = process.env["PATH"] ?? "";
  process.env["PATH"] = `${await fakeRipwire()}:${prev}`;
  t.after(() => {
    process.env["PATH"] = prev;
  });
}

// index.db: ranking, the upgrade and validity guard, locking, and concurrent writes.

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

test("context opens populated catalogs and closes empty and malformed catalogs", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  assert.equal(NO_SOURCES_MESSAGE, "no skill sources installed; run: margrave install <owner/repo|path>");
  assert.equal(await loadContext(), null);
  await seedIndex([]);
  const close = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "close")!.value as DatabaseSync["close"];
  const spy = mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    return close.call(this);
  });
  try {
    assert.equal(await loadContext(), null);
    assert.equal(spy.mock.callCount(), 1);
  } finally {
    spy.mock.restore();
  }
  await rm(path.join(home, "index.db"));
  await seedIndex([newEntry("s", "one")]);
  const context = await loadContext();
  assert.ok(context);
  try {
    assert.equal(context.sources[0]?.id, "s");
    assert.equal(resolveSkill(context.db, "s/one").id, "s/one");
  } finally {
    context.db.close();
  }
  writeIndexRows(home, (db) => db.prepare("UPDATE sources SET record = ?").run("{}"));
  const malformedClose = mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    return close.call(this);
  });
  try {
    await assert.rejects(loadContext(), { message: "cannot upgrade the v0.2.1 catalog: malformed source records" });
    assert.equal(malformedClose.mock.callCount(), 1);
  } finally {
    malformedClose.mock.restore();
  }
});

test("revision validation requires a lowercase SHA-256 digest", () => {
  validateRevision(undefined);
  validateRevision(`sha256:${"a".repeat(64)}`);
  for (const revision of [
    `SHA256:${"a".repeat(64)}`,
    `sha256:${"g".repeat(64)}`,
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `xsha256:${"a".repeat(64)}`,
    `sha256:${"a".repeat(64)}x`,
  ]) {
    assert.throws(() => validateRevision(revision), { message: "revision must be a SHA-256 digest" });
  }
});

test("Git snapshot resolution checks lexical and canonical paths and reports drift", async (t) => {
  const home = await tmp("mg-home-");
  useHome(t, home);
  const commit = "a".repeat(40);
  const snapshot = `${commit}-${"b".repeat(16)}`;
  const root = path.join(home, "snapshots", "git", snapshot);
  await mkdir(path.join(root, "child..name"), { recursive: true });
  await mkdir(path.join(root, "target"));
  await writeFile(path.join(root, "file"), "file");
  await symlink("target", path.join(root, "link"));
  const dirs = [".", "child..name", "missing", "file/child", "/absolute", "..", "../escape", "link", path.join(root, "child..name")];
  await seedIndex(
    [...dirs.map((dir, i) => ({ ...newEntry("git", `item${i}`), dir })), newEntry("absent", "orphan")],
    [
      {
        id: "local",
        kind: "local",
        spec: "/x/local",
        path: "/x/local",
        subpath: "",
        ref: null,
        commit: null,
        installedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "git",
        kind: "git",
        spec: "owner/repo",
        url: "https://example.com/owner/repo.git",
        subpath: "",
        ref: "refs/heads/main",
        commit,
        snapshot,
        installedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  );
  const db = await openIndexRead();
  const invalid = 'invalid snapshot path for source "git"';
  const cli = "installed Git files differ from the accepted revision. Restore a verified lock or a known-good backup";
  const mcp = "skill files differ from the accepted revision. Ask the store operator to restore a verified copy";
  try {
    assert.equal(resolveSkill(db, "git/item0").dir, root);
    assert.equal(resolveSkill(db, "git/item1").dir, path.join(root, "child..name"));
    for (const i of [2, 3]) {
      assert.throws(() => resolveSkill(db, `git/item${i}`), { message: cli });
      assert.throws(() => resolveSkill(db, `git/item${i}`, undefined, undefined, true), { message: mcp });
    }
    for (const i of [4, 5, 6, 7, 8]) assert.throws(() => resolveSkill(db, `git/item${i}`), { message: invalid });
    assert.throws(() => resolveSkill(db, "absent/orphan"), { message: 'invalid snapshot path for source "absent"' });
    await rename(root, `${root}-actual`);
    assert.throws(() => resolveSkill(db, "git/item0"), { message: cli });
    await symlink(path.basename(`${root}-actual`), root);
    assert.throws(() => resolveSkill(db, "git/item0"), { message: invalid });
    await rm(root);
    await rename(`${root}-actual`, root);
    const actualRealpath = fs.realpathSync;
    const child = path.join(root, "child..name");
    const canonicalRoot = actualRealpath(root);
    const canonicalChild = actualRealpath(child);
    const alternate = mock.method(fs, "realpathSync", ((p: fs.PathLike, ...args: unknown[]) => {
      if (p === root) return `${canonicalRoot}-alternate`;
      if (p === child) return canonicalChild;
      return Reflect.apply(actualRealpath, fs, [p, ...args]);
    }) as typeof fs.realpathSync);
    syncBuiltinESMExports();
    try {
      assert.throws(() => resolveSkill(db, "git/item1"), { message: invalid });
    } finally {
      alternate.mock.restore();
      syncBuiltinESMExports();
    }
    const injected = mock.method(fs, "realpathSync", ((p: fs.PathLike, ...args: unknown[]) => {
      if (p === root) throw Object.assign(new Error("synthetic failure"), { code: "EACCES" });
      return Reflect.apply(actualRealpath, fs, [p, ...args]);
    }) as typeof fs.realpathSync);
    syncBuiltinESMExports();
    try {
      assert.throws(() => resolveSkill(db, "git/item0"), { message: invalid });
    } finally {
      injected.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    db.close();
  }
});

test("recommendation evidence and SQL scope use only visible hits", async (t) => {
  useHome(t, await tmp("mg-home-"));
  await seedIndex([
    newEntry("a", "one", "solitary comet"),
    newEntry("a", "two", "shared nebula"),
    newEntry("a", "three", "shared nebula"),
    newEntry("a", "four", "orbit", "planet"),
    newEntry("a", "other", "unrelated", "comet orbit"),
    newEntry("a", "extra", "unrelated", "comet"),
    newEntry("b", "comet", "shared nebula", "orbit planet"),
  ]);
  const db = await openIndexRead();
  try {
    const scope = new Set(["a"]);
    const { hits: one, matchCount, exact } = findSkillsWithCount(db, "comet", 10, true, scope);
    assert.equal(matchCount, 1);
    assert.equal(exact, false);
    assert.deepEqual(
      [one[0]?.id, one[0]?.recommended, one[0]?.matchedTerms],
      ["a/one", true, { name: [], description: ["comet"], headings: [], body: [] }],
    );
    assert.deepEqual(
      Object.fromEntries(one.slice(1).map((h) => [h.id, [h.recommended, h.matchedTerms]])),
      Object.fromEntries(["a/extra", "a/other"].map((id) => [id, [false, { name: [], description: [], headings: [], body: ["comet"] }]])),
    );
    const two = findSkills(db, "nebula", 10, true, scope);
    assert.deepEqual(
      Object.fromEntries(two.map((h) => [h.id, [h.recommended, h.matchedTerms]])),
      Object.fromEntries(["a/three", "a/two"].map((id) => [id, [false, { name: [], description: ["nebula"], headings: [], body: [] }]])),
    );
    const multi = findSkills(db, "orbit planet", 10, true, scope);
    assert.deepEqual(
      multi.map((h) => [h.id, h.recommended, h.matchedTerms]),
      [
        ["a/four", true, { name: [], description: ["orbit"], headings: [], body: ["planet"] }],
        ["a/other", false, { name: [], description: [], headings: [], body: ["orbit"] }],
      ],
    );
    const partial = findSkills(db, "orbit unknown", 10, true, scope);
    assert.deepEqual(Object.fromEntries(partial.map((h) => [h.id, [h.recommended, h.matchedTerms]])), {
      "a/four": [false, { name: [], description: ["orbit"], headings: [], body: [] }],
      "a/other": [false, { name: [], description: [], headings: [], body: ["orbit"] }],
    });
    assert.deepEqual(findSkills(db, "comet", 10, true, new Set()), []);
    assert.deepEqual(ids(findSkills(db, "comet", 1, true, scope)), ["a/one"]);
    assert.deepEqual(ids(findSkills(db, "orbit planet", 1, true, scope)), ["a/four"]);
  } finally {
    db.close();
  }
});

test("resolution respects source scope and revision diagnostics", async (t) => {
  useHome(t, await tmp("mg-home-"));
  await seedIndex([newEntry("z", "shared"), newEntry("a", "shared")]);
  const db = await openIndexRead();
  try {
    assert.equal(resolveSkill(db, "z/shared").id, "z/shared");
    assert.equal(resolveSkill(db, "shared", undefined, new Set(["a"])).id, "a/shared");
    const missing = 'no skill "z/shared"; run: margrave find "<task>" or margrave list --skills';
    assert.throws(() => resolveSkill(db, "z/shared", undefined, new Set(["a"])), { message: missing });
    assert.throws(() => resolveSkill(db, "shared", undefined, new Set()), {
      message: 'no skill "shared"; run: margrave find "<task>" or margrave list --skills',
    });
    assert.throws(() => resolveSkill(db, "shared"), { message: '"shared" is ambiguous; use one of these ids:\n  a/shared\n  z/shared' });
    assert.throws(() => resolveSkill(db, "missing", `sha256:${"a".repeat(64)}`), { message: "skill revision changed; search again" });
    assert.throws(() => resolveSkill(db, "missing", "bad"), { message: "revision must be a SHA-256 digest" });
  } finally {
    db.close();
  }
});

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

test("a visible name match keeps a unique description match weak", async (t) => {
  useHome(t, await tmp("mg-home-"));
  const entries = [newEntry("s", "redis-guide", "General guide"), newEntry("s", "cache-guide", "Redis configuration")];
  assert.deepEqual(ids(await ranked(entries, "redis")), ["s/redis-guide"]);
  const explained = await ranked(entries, "redis", 5, true);
  assert.deepEqual(ids(explained), ["s/redis-guide", "s/cache-guide"]);
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
  // Both names yield one token. UTF-8 orders U+FF21 before U+10400.
  // In UTF-16 order the astral id (D83D ...) would come first.
  const entries = ["\u{10400}", "Ａ"].map((n) => newEntry("s", n, "identical description text"));
  assert.deepEqual(ids(await ranked(entries, "identical description")), ["s/Ａ", "s/\u{10400}"]);
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
  await seedIndex([newEntry("a", "x"), newEntry("b", "x"), newEntry("a", "only"), newEntry("a", "Älpha"), newEntry("b", "älpha")]);
  const db = await openIndexRead();
  try {
    assert.equal(resolveSkill(db, "a/x").source, "a");
    assert.equal(resolveSkill(db, "only").id, "a/only");
    assert.equal(resolveSkill(db, "Älpha").id, "a/Älpha");
    assert.equal(resolveSkill(db, "älpha").id, "b/älpha");
    assert.throws(() => resolveSkill(db, "ÄLPHA"), /no skill "ÄLPHA"/u);
    assert.throws(() => resolveSkill(db, "x"), /"x" is ambiguous; use one of these ids:\n {2}a\/x\n {2}b\/x/u);
    assert.throws(() => resolveSkill(db, "%"), /no skill "%"/u, "a LIKE wildcard matches nothing");
  } finally {
    db.close();
  }
});

// ---- the guard: missing, legacy, invalid, locked ----

test("update with no argument prints a guard error once, not once per source", async () => {
  const s = await setup();
  const second = await localSource("beta");
  assert.equal((await s.mg(["install", second.dir])).code, 0);
  await rm(path.join(s.home, "index.db"));
  await writeFile(path.join(s.home, "index.json"), "{}");
  const r = await s.mg(["update"]);
  assert.equal(r.code, 1);
  assert.equal(r.stderr.match(/index\.db is missing\. Restore the complete store backup/gu)?.length, 1, r.stderr);
});

// ---- a write that changes the store between a command's checks and its lock, in this process ----

test("an update whose source another write removed fails under the lock and changes nothing", async (t) => {
  const s = await setup();
  useHome(t, s.home);
  const lock = removedByAnother(t, s.home, s.id);
  await assert.rejects(updateSources(s.id, quiet), new RegExp(`no source "${s.id}"$`, "u"));
  // The message is the same before the lock, so the counter tells the two apart.
  assert.equal(lock.fired(), true, "the error came after the update's lock was taken");
  assert.equal(lock.begins(), 2);
  assert.deepEqual(readSourceRecords(s.home), []);
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
    writeCatalogRecords(s.home, [...existing, third.record(newId)]);
  });
  await assert.rejects(installSource(third.dir, null, quiet), /is already installed; run: margrave update/u);
  assert.equal(lock.fired(), true, "the error came after the install's lock was taken");
  assert.equal(lock.begins(), 2);
  assert.deepEqual(
    readSourceRecords(s.home)
      .map((x) => x.id)
      .sort(),
    [s.id, newId].sort(),
  );
  assert.deepEqual(indexIds(s.home), [`${s.id}/alpha`, `${newId}/gamma`].sort());
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
  assert.match(await readSelectedFile(entry, "SKILL.md", entry.revision), /Body of alpha/u);
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
  const records = catalogRecords(home);
  assert.ok(records[0]);
  records[0].snapshot = `${records[0].snapshot!.slice(0, -16)}0000000000000000`;
  writeCatalogRecords(home, records);
  await assert.rejects(readSelectedFile(entry, "SKILL.md", entry.revision), /skill files changed since indexing/u);
  writeCatalogRecords(home, []);
  await assert.rejects(readSelectedFile(entry, "SKILL.md", entry.revision), /skill files changed since indexing/u);
});
