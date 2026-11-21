import assert from "node:assert/strict";
import fsPromises, { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  home as storeHome,
  readLegacySources,
  atomicWrite,
  sourcesRoot,
  stagingRoot,
  reportsRoot,
  sourcesFile,
  indexDbFile,
  publishedMarker,
  ensureDirs,
  readIfExists,
  lstatIfExists,
  MargraveError,
  isRecord,
  isSha256,
  validSelection,
  validSource,
  validScan,
} from "../src/store-files.ts";
import { readSources } from "../src/store.ts";
import { fakeRipwire, runCli, tmp, writeSkill, useHome, cliSetup as setup, cliMg as mg, installLocalDir } from "./helpers.ts";
import { DatabaseSync } from "node:sqlite";

test("a malformed sources.json is an error and nothing is written", async () => {
  const home = await tmp("mg-home-");
  const bin = await fakeRipwire();
  const file = path.join(home, "sources.json");
  await writeFile(file, "{ not json");

  process.env["MARGRAVE_HOME"] = home;
  await assert.rejects(readLegacySources(), /not valid JSON/u);
  await writeFile(file, JSON.stringify([{ id: 1 }]));
  await assert.rejects(readLegacySources(), /malformed/u);

  const src = await tmp("mg-src-");
  await writeSkill(src, "a-skill", "a skill");
  for (const content of ["{ not json", JSON.stringify([{ id: 1 }])]) {
    await writeFile(file, content);
    const r = await runCli(["install", src], { home, fakeBin: bin });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /index\.db is missing/u);
    assert.equal(await readFile(file, "utf8"), content, "sources.json unchanged");
    assert.equal((await readdir(home)).includes("index.db"), false, "no index.db written");
    assert.deepEqual(
      (await readdir(home)).filter((n) => n.endsWith(".tmp")),
      [],
    );
  }
});

test("a missing sources.json is an empty list", async () => {
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  assert.deepEqual(await readSources(), []);
  assert.deepEqual(await readLegacySources(), []);
});

test("home() is MARGRAVE_HOME when set, and ~/.margrave when it is unset or empty", (t) => {
  const prev = process.env["MARGRAVE_HOME"];
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  process.env["MARGRAVE_HOME"] = "/some/where";
  assert.equal(storeHome(), "/some/where");
  delete process.env["MARGRAVE_HOME"];
  assert.equal(storeHome(), path.join(homedir(), ".margrave"));
  process.env["MARGRAVE_HOME"] = "";
  assert.equal(storeHome(), path.join(homedir(), ".margrave"));
});

test("a sources.json that cannot be read for a reason other than ENOENT is an error, not an empty list", async (t) => {
  const h = await tmp("mg-home-");
  useHome(t, h);
  await mkdir(path.join(h, "sources.json"));
  await assert.rejects(readLegacySources(), /EISDIR/u);
});

test("every field of a source record is checked", async (t) => {
  const h = await tmp("mg-home-");
  useHome(t, h);
  const good = {
    id: "o__r",
    kind: "git",
    spec: "o/r",
    url: "u",
    subpath: "",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    snapshot: `${"a".repeat(40)}-${"b".repeat(16)}`,
    installedAt: "now",
  };
  const local = { id: "l", kind: "local", spec: "/p", path: "/p", subpath: "", ref: null, commit: null, installedAt: "now" };
  await writeFile(path.join(h, "sources.json"), JSON.stringify([good, local]));
  assert.equal((await readLegacySources()).length, 2);

  const { url: _url, ...noUrl } = good;
  const bad: Record<string, unknown> = {
    "not an object": 1,
    "a list instead of an object": [],
    "null instead of an object": null,
    "id is not a string": { ...good, id: 1 },
    "id traverses directories": { ...good, id: "../outside" },
    "id is dot": { ...good, id: "." },
    "id is dot-dot": { ...good, id: ".." },
    "spec is not a string": { ...good, spec: 1 },
    "kind is unknown": { ...good, kind: "svn" },
    "subpath is not a string": { ...good, subpath: 1 },
    "ref is neither null nor a string": { ...good, ref: 1 },
    "commit is neither null nor a string": { ...good, commit: 1 },
    "installedAt is not a string": { ...good, installedAt: 1 },
    "a git record without url": noUrl,
    "a local record without path": { ...local, path: undefined },
    "a local record with a relative path": { ...local, path: "relative" },
    "snapshot on a local source": { ...local, snapshot: `${"a".repeat(40)}-${"b".repeat(16)}` },
    "git record without snapshot": { ...good, snapshot: undefined },
    "git record with short ref": { ...good, ref: "main" },
    "snapshot traversal": { ...good, commit: "a".repeat(40), snapshot: `../${"a".repeat(40)}-${"b".repeat(16)}` },
    "snapshot commit mismatch": { ...good, commit: "c".repeat(40), snapshot: `${"a".repeat(40)}-${"b".repeat(16)}` },
    "snapshot nonce malformed": { ...good, commit: "a".repeat(40), snapshot: `${"a".repeat(40)}-${"B".repeat(16)}` },
  };
  for (const [why, record] of Object.entries(bad)) {
    await writeFile(path.join(h, "sources.json"), JSON.stringify([record]));
    await assert.rejects(readLegacySources(), /malformed/u, why);
  }
  await writeFile(path.join(h, "sources.json"), JSON.stringify({ not: "a list" }));
  await assert.rejects(readLegacySources(), /malformed/u, "not a list");
});

test("atomic writes leave no temp file and a reader never sees a partial file", async () => {
  const dir = await tmp("mg-atomic-");
  const file = path.join(dir, "data.json");
  const big = (n: number): string => JSON.stringify({ n, pad: "x".repeat(200_000) });
  await atomicWrite(file, big(0));
  let stop = false;
  const writer = (async () => {
    // oxlint-disable-next-line no-unmodified-loop-condition -- `stop` is set by the reader below while the writer runs
    for (let i = 1; i <= 40 && !stop; i++) await atomicWrite(file, big(i));
  })();
  let reads = 0;
  for (;;) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { n: number };
    assert.equal(typeof parsed.n, "number");
    reads++;
    if (reads > 400) break;
    if (reads % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  stop = true;
  await writer;
  assert.deepEqual(
    (await readdir(dir)).filter((n) => n.endsWith(".tmp")),
    [],
  );
});

test("a sources.json record with no url, no path, or an unknown kind stops every command that reads it", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  const base = { spec: "x", subpath: "", ref: null, commit: null, installedAt: "now" };
  const records: Record<string, unknown> = {
    "a git record without url": { ...base, id: "bad__git", kind: "git" },
    "a local record without path": { ...base, id: "bad__local", kind: "local" },
    "a record of an unknown kind": { ...base, id: "bad__kind", kind: "svn", url: "u", path: "/p" },
  };
  for (const [why, record] of Object.entries(records)) {
    const db = new DatabaseSync(path.join(env.home, "index.db"));
    db.prepare("UPDATE sources SET record = ?").run(JSON.stringify(record));
    db.close();
    const before = await readFile(path.join(env.home, "index.db"));
    const id = (record as { id: string }).id;
    for (const args of [["update"], ["update", id], ["remove", id], ["reindex"], ["list"]]) {
      const r = await mg(env, args);
      assert.equal(r.code, 1, `${why}: ${args.join(" ")}`);
      assert.match(r.stderr, /malformed source records/u, `${why}: ${args.join(" ")}`);
    }
    assert.deepEqual(await readFile(path.join(env.home, "index.db")), before, `${why}: catalog is unchanged`);
  }
});

test("store files paths resolve each home and create both directories", async (t) => {
  const base = await tmp("mg-paths-");
  const homes = [path.join(base, "nested", "one"), path.join(base, "two")];
  useHome(t, homes[0]!);
  for (const h of homes) {
    process.env["MARGRAVE_HOME"] = h;
    assert.equal(storeHome(), h);
    assert.equal(sourcesRoot(), path.join(h, "sources"));
    assert.equal(stagingRoot(), path.join(h, "staging"));
    assert.equal(reportsRoot(), path.join(h, "reports"));
    assert.equal(sourcesFile(), path.join(h, "sources.json"));
    assert.equal(indexDbFile(), path.join(h, "index.db"));
    assert.equal(publishedMarker(), path.join(h, "catalog-published"));
    await ensureDirs();
    await ensureDirs();
    assert.equal((await lstat(path.join(h, "sources"))).isDirectory(), true);
    assert.equal((await lstat(path.join(h, "staging"))).isDirectory(), true);
  }
  process.env["MARGRAVE_HOME"] = path.relative(process.cwd(), homes[0]!);
  assert.equal(storeHome(), homes[0]);
  assert.equal(sourcesFile(), path.join(homes[0]!, "sources.json"));
});

test("store files atomic writes and reads preserve UTF-8 content", async () => {
  const dir = await tmp("mg-atomic-direct-");
  const file = path.join(dir, "nested", "data");
  const content = "héllo 🌿\n";
  await atomicWrite(file, content);
  assert.equal(await readFile(file, "utf8"), content);
  assert.equal(await readIfExists(file), content);
  assert.equal(await readIfExists(path.join(dir, "missing")), null);
});

test("store files atomic write cleans up rename and open failures", async (t) => {
  const dir = await tmp("mg-atomic-failure-");
  const target = path.join(dir, "target");
  await mkdir(target);
  await assert.rejects(atomicWrite(target, "data"), (err: NodeJS.ErrnoException) => {
    assert.ok(err.code === "EISDIR" || err.code === "ENOTEMPTY" || err.code === "EEXIST");
    return true;
  });
  assert.deepEqual(await readdir(dir), ["target"]);
  const failure = new Error("synthetic open failure");
  const openMock = t.mock.method(fsPromises, "open", () => Promise.reject(failure));
  syncBuiltinESMExports();
  try {
    await assert.rejects(atomicWrite(path.join(dir, "other"), "data"), (err) => err === failure);
    assert.deepEqual(await readdir(dir), ["target"]);
  } finally {
    openMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("store files lstat distinguishes missing and inaccessible paths", async () => {
  const dir = await tmp("mg-lstat-");
  const file = path.join(dir, "file");
  await writeFile(file, "x");
  assert.equal((await lstatIfExists(file))?.isFile(), true);
  assert.equal(await lstatIfExists(path.join(dir, "missing")), null);
  const child = path.join(file, "child");
  await assert.rejects(lstatIfExists(child), (err: Error) => {
    assert.ok(err instanceof MargraveError);
    assert.match(err.message, /^cannot read /u);
    assert.ok(err.message.includes(child));
    assert.ok(err.message.includes("ENOTDIR"));
    return true;
  });
});

test("store files record and digest guards reject coercion and unanchored values", () => {
  assert.equal(isRecord({}), true);
  for (const value of [[], null, 1, "x", () => {}]) assert.equal(isRecord(value), false);
  const digest = "a".repeat(64);
  assert.equal(isSha256(digest), true);
  for (const value of [digest.toUpperCase(), "g".repeat(64), "a", `x${digest}`, `${digest}x`, [digest], null])
    assert.equal(isSha256(value), false);
});

test("store files selection requires sorted nonempty trimmed strings", () => {
  for (const value of [["a"], ["a", "b", "c"]]) assert.equal(validSelection(value), true);
  for (const value of [["a", "a"], ["b", "a"], [" "], [" a"], ["a "], [""], [], null, "a", ["a", 1]])
    assert.equal(validSelection(value), false, JSON.stringify(value));
});

test("store files sources validate location selection refs and scans", () => {
  const sha1 = "a".repeat(40);
  const sha256 = "b".repeat(64);
  const git = {
    id: "valid.id",
    kind: "git",
    spec: "x",
    url: "u",
    subpath: "",
    ref: "refs/heads/main",
    commit: sha1,
    snapshot: `${sha1}-${"c".repeat(16)}`,
    installedAt: "now",
  };
  const local = { id: "local", kind: "local", spec: "/p", path: "/p", subpath: "", ref: null, commit: null, installedAt: "now" };
  const scan = { tree: null, version: null, overridden: false, verdict: "clean", code: 0, keys: [], files: [] };
  for (const value of [
    git,
    { ...git, id: ".name" },
    { ...git, id: "..name" },
    local,
    { ...git, selection: ["a", "b"] },
    { ...local, selection: ["a"] },
    { ...git, ref: "refs/tags/v1" },
    { ...git, commit: sha256, snapshot: `${sha256}-${"c".repeat(16)}` },
    { ...git, scan },
    { ...local, ref: "x", commit: "x" },
  ])
    assert.equal(validSource(value), true, JSON.stringify(value));
  const bad = [
    { ...git, selection: [] },
    { ...local, selection: ["b", "a"] },
    { ...local, commit: 1 },
    { ...local, ref: 1 },
    { ...git, ref: [git.ref] },
    ...["", ".", "..", "bad/id", " bad", "bad "].map((id) => ({ ...git, id })),
    { ...git, kind: "other" },
    { ...git, snapshot: [git.snapshot] },
    { ...git, commit: null },
    ...[
      `x${git.snapshot}`,
      `${git.snapshot}x`,
      `${sha1.slice(1)}-${"c".repeat(16)}`,
      `${sha1}-${"c".repeat(15)}`,
      `${sha1}-${"C".repeat(16)}`,
    ].map((snapshot) => ({ ...git, snapshot })),
    { ...git, commit: `x${sha1}`, snapshot: `x${git.snapshot}` },
    { ...git, commit: `x${sha1}` },
    { ...git, commit: `${sha1}x` },
    { ...git, commit: "g".repeat(40) },
    { ...git, ref: "xrefs/heads/main" },
    { ...git, ref: "xrefs/tags/v1" },
    { ...git, ref: "refs/heads/" },
    { ...local, scan },
    { ...git, scan: { ...scan, code: 1 } },
  ];
  for (const value of bad) assert.equal(validSource(value), false, JSON.stringify(value));
});

test("store files scans validate verdicts trees and rows", () => {
  const digest = "a".repeat(64);
  const key = (file: unknown, rule: unknown = "rule", severity: unknown = "warn", hash: unknown = digest): string =>
    JSON.stringify([file, rule, severity, hash]);
  const nested = ["nested", "file"].join(path.sep);
  const good = {
    tree: digest,
    version: "1",
    overridden: false,
    verdict: "clean",
    code: 0,
    keys: [
      [key(nested), 1],
      [key("other", "r", "critical"), Number.MAX_SAFE_INTEGER],
    ],
    files: [
      [nested, digest],
      ["other", digest],
    ],
  };
  for (const value of [
    good,
    { ...good, tree: null, version: null, overridden: true },
    { ...good, version: "not a version" },
    { ...good, verdict: "warn", code: 1 },
    { ...good, verdict: "critical", code: 2 },
    { ...good, verdict: "failed", code: null },
    { ...good, verdict: "failed", code: 7 },
  ])
    assert.equal(validScan(value), true, JSON.stringify(value));
  const badPaths = [
    1,
    "",
    path.resolve("absolute"),
    ["..", "file"].join(path.sep),
    ["a", "..", "b"].join(path.sep),
    ["a", "", "b"].join(path.sep),
  ];
  const badKeys: unknown[] = [
    null,
    [],
    [key("x")],
    [key("x"), 1, 2],
    [1, 1],
    [[key("x")], 1],
    [JSON.stringify({ 0: "x", 1: "rule", 2: "warn", 3: digest, length: 4 }), 1],
    [JSON.stringify(["x", "rule", "warn", digest, "extra"]), 1],
    [key("x"), 0],
    [key("x"), 1.5],
    [key("x"), Number.MAX_SAFE_INTEGER + 1],
    ["{", 1],
    [JSON.stringify({}), 1],
    [JSON.stringify(["x"]), 1],
    [key("x", 1), 1],
    [key("x", "r", "low"), 1],
    [key("x", "r", "warn", "bad"), 1],
    ...badPaths.map((p) => [key(p), 1]),
  ];
  const badFiles: unknown[] = [null, [], ["x"], ["x", digest, 1], ["x", 1], ["x", "bad"], ...badPaths.map((p) => [p, digest])];
  const bad: unknown[] = [
    null,
    [],
    { ...good, extra: true },
    { ...good, tree: 1 },
    { ...good, tree: "bad" },
    { ...good, tree: `x${digest}` },
    { ...good, tree: `${digest}x` },
    { ...good, version: 1 },
    { ...good, overridden: 1 },
    { ...good, verdict: "other" },
    { ...good, code: 1 },
    { ...good, verdict: "warn", code: 0 },
    { ...good, verdict: "critical", code: 1 },
    { ...good, verdict: "failed", code: "1" },
    { ...good, keys: null },
    { ...good, files: null },
    ...badKeys.map((row) => ({ ...good, keys: [good.keys[0], row] })),
    ...badFiles.map((row) => ({ ...good, files: [good.files[0], row] })),
  ];
  for (const value of bad) assert.equal(validScan(value), false, JSON.stringify(value));
});

test("store files scan checks the absolute path guard", (t) => {
  const digest = "a".repeat(64);
  const scan = { tree: null, version: null, overridden: false, verdict: "clean", code: 0, keys: [], files: [["C:\\file", digest]] };
  const absoluteMock = t.mock.method(path, "isAbsolute", path.win32.isAbsolute);
  try {
    assert.equal(validScan(scan), false);
    assert.equal(validScan({ ...scan, files: [[["nested", "file"].join(path.sep), digest]] }), true);
  } finally {
    absoluteMock.mock.restore();
  }
});

test("store files legacy parsing reports stable errors and conflict precedence", async (t) => {
  const h = await tmp("mg-legacy-direct-");
  useHome(t, h);
  const file = path.join(h, "sources.json");
  const malformed = `${file} is malformed (expected a list of source records); fix or delete it`;
  const conflict = (id: string): string =>
    `cannot upgrade source "${id}" because its source record, index, or files disagree. Restore a known-good backup or recover the source from a verified lock`;
  const local = { id: "local", kind: "local", spec: "/p", path: "/p", subpath: "", ref: null, commit: null, installedAt: "now" };
  const invalidJson = "{";
  let syntaxDetail = "";
  try {
    JSON.parse(invalidJson);
  } catch (err) {
    assert.ok(err instanceof SyntaxError);
    syntaxDetail = err.message;
  }
  assert.notEqual(syntaxDetail, "");
  await assert.rejects(readLegacySources(invalidJson), {
    name: "Error",
    message: `${file} is not valid JSON (${syntaxDetail}); fix or delete it`,
  });
  for (const records of [[{ id: "scan-only", scan: null }], [{ id: "selection-only", selection: [] }], [1, { id: "later", scan: null }]]) {
    const last = records.at(-1) as { id: string };
    await assert.rejects(readLegacySources(JSON.stringify(records)), { name: "Error", message: conflict(last.id) });
  }
  for (const value of [[local, 1], [1, local], [{ id: 1, scan: null, selection: [] }], {}]) {
    await assert.rejects(readLegacySources(JSON.stringify(value)), { name: "Error", message: malformed });
  }
  assert.deepEqual(await readLegacySources(JSON.stringify([local])), [local]);
});
