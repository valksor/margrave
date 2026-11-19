import assert from "node:assert/strict";
import { parseLock } from "../src/lock.ts";
import fsp, { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import {
  checkRef,
  checkSources,
  findSource,
  installSource,
  localId,
  parseSpec,
  reindexAll,
  removeSource,
  resolveScanRoot,
  sanitizeId,
  sourceDir,
  updateSources,
} from "../src/sources.ts";
import { MargraveError, UsageError, home as storeHome, openIndexRead, readSources } from "../src/store.ts";
import type { SourceRecord } from "../src/store.ts";
import { resolveSkill } from "../src/skills.ts";
import { fakeRipwire, git, indexIds, indexRows, makeRepo, newEntry, realExec, runCli, seedIndex, tmp, writeSkill } from "./helpers.ts";

test("spec parsing is checked in order: local, git URL, GitHub", () => {
  assert.deepEqual(parseSpec("./skills"), { kind: "local", path: path.resolve("./skills") });
  assert.deepEqual(parseSpec("../x"), { kind: "local", path: path.resolve("../x") });
  assert.deepEqual(parseSpec("/abs/dir"), { kind: "local", path: "/abs/dir" });
  assert.deepEqual(parseSpec("~/skills"), { kind: "local", path: path.join(homedir(), "skills") });
  assert.deepEqual(parseSpec("~"), { kind: "local", path: homedir() });

  const https = parseSpec("https://github.com/vercel-labs/agent-skills.git");
  assert.equal(https.kind, "git");
  if (https.kind === "git") {
    assert.equal(https.url, "https://github.com/vercel-labs/agent-skills.git");
    assert.equal(https.id, "github.com__vercel-labs__agent-skills");
  }
  const ssh = parseSpec("git@github.com:owner/repo.git");
  assert.equal(ssh.kind === "git" && ssh.id, "github.com__owner__repo");
  const file = parseSpec("file:///tmp/some/repo");
  assert.equal(file.kind === "git" && file.id, "tmp__some__repo");

  assert.deepEqual(parseSpec("vercel-labs/agent-skills"), {
    kind: "git",
    url: "https://github.com/vercel-labs/agent-skills.git",
    subpath: "",
    id: "vercel-labs__agent-skills",
  });
  assert.deepEqual(parseSpec("owner/repo/skills/react"), {
    kind: "git",
    url: "https://github.com/owner/repo.git",
    subpath: "skills/react",
    id: "owner__repo__skills__react",
  });
});

test("source realpath access errors stay visible", async (t) => {
  const prev = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const root = await tmp("mg-source-");
  await writeSkill(root, "alpha", "skill");
  const result = await runCli(["install", root], { home, fakeBin: await fakeRipwire() });
  assert.equal(result.code, 0, result.stderr);
  const original = fsp.realpath;
  const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
  mock.method(fsp, "realpath", ((p: string, ...args: unknown[]) =>
    p === root || p === path.join(root, "alpha")
      ? Promise.reject(denied)
      : (original as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.realpath);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  await assert.rejects(updateSources(localId(root), { log: () => {}, allowUnsafe: false }), /access denied/u);
  await assert.rejects(resolveScanRoot(root, "alpha"), /access denied/u);
});

test("owner/repo is GitHub even when a relative directory with that name exists", async () => {
  const dir = await tmp();
  await writeSkill(path.join(dir, "owner", "repo"), "x", "y");
  const prev = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(parseSpec("owner/repo").kind, "git");
  } finally {
    process.chdir(prev);
  }
});

test("a spec or --ref that starts with - is refused", () => {
  assert.throws(() => parseSpec("-x"), UsageError);
  assert.throws(() => parseSpec("--upload-pack=evil"), UsageError);
  assert.throws(() => checkRef("-x"), UsageError);
  assert.throws(() => checkRef("--upload-pack=evil"), UsageError);
  assert.equal(checkRef("v1.2"), "v1.2");
});

test("a subpath segment that is .. is refused", () => {
  assert.throws(() => parseSpec("owner/repo/../x"), /\.\./u);
  assert.throws(() => parseSpec("owner/repo/a/../b"), UsageError);
});

test("malformed specs are errors", () => {
  assert.throws(() => parseSpec(""), UsageError);
  assert.throws(() => parseSpec("justname"), UsageError);
  assert.throws(() => parseSpec("owner//repo"), UsageError);
  assert.throws(() => parseSpec("http://example.com/o/r"), UsageError);
  assert.throws(() => parseSpec("o/r with space"), UsageError);
  assert.throws(() => parseSpec("~someone/x"), UsageError);
});

test("source ids stay inside [A-Za-z0-9._-]+ and are never . or ..", () => {
  const re = /^[A-Za-z0-9._-]+$/u;
  assert.equal(sanitizeId("a b/c:d*e"), "a-b-c-d-e");
  for (const spec of [
    "owner/repo",
    "o/r/sub/dir",
    "https://example.com/a b/c%20d.git",
    "git@host.example:grp/sub/repo.git",
    "file:///tmp/weird name/repo",
  ]) {
    let id: string;
    try {
      const p = parseSpec(spec);
      id = p.kind === "git" ? p.id : "";
    } catch {
      continue;
    }
    assert.match(id, re, spec);
    assert.notEqual(id, ".");
    assert.notEqual(id, "..");
  }
  assert.throws(() => parseSpec("https://.."), UsageError);
  const id = localId("/some/dir with spaces/skills");
  assert.match(id, re);
  assert.match(id, /^local__dir-with-spaces-skills-[0-9a-f]{6}$|^local__skills-[0-9a-f]{6}$/u);
  assert.notEqual(localId("/a/skills"), localId("/b/skills"));
  assert.equal(localId("/a/skills"), localId("/a/skills"));
});

test("sourceDir only returns a direct child of sources/", async () => {
  process.env["MARGRAVE_HOME"] = await tmp();
  assert.equal(path.dirname(sourceDir("owner__repo")), path.join(process.env["MARGRAVE_HOME"], "sources"));
  for (const bad of ["..", ".", "", "a/b", "../x", "a b"]) assert.throws(() => sourceDir(bad), UsageError, bad);
});

test("qualified ids stay stable after a second source adds the same name; the bare alias works only while unique", async (t) => {
  useHome(t, await tmp("mg-home-"));
  await seedIndex([newEntry("src-a", "react"), newEntry("src-a", "docker")]);
  const first = await openIndexRead();
  try {
    assert.equal(resolveSkill(first, "react").id, "src-a/react");
    assert.equal(resolveSkill(first, "src-a/react").id, "src-a/react");
  } finally {
    first.close();
  }

  // A second source with the same name. Rows are replaced here only to build the fixture.
  useHome(t, await tmp("mg-home-"));
  await seedIndex([newEntry("src-a", "react"), newEntry("src-a", "docker"), newEntry("src-b", "react")]);
  const second = await openIndexRead();
  try {
    assert.equal(resolveSkill(second, "src-a/react").id, "src-a/react");
    assert.equal(resolveSkill(second, "src-b/react").id, "src-b/react");
    assert.equal(resolveSkill(second, "docker").id, "src-a/docker");
    assert.throws(
      () => resolveSkill(second, "react"),
      (e: unknown) =>
        e instanceof MargraveError &&
        /ambiguous/u.test(e.message) &&
        e.message.includes("src-a/react") &&
        e.message.includes("src-b/react"),
    );
    assert.throws(() => resolveSkill(second, "nope"), /no skill "nope"/u);
  } finally {
    second.close();
  }
});

test("findSource accepts an id or the original spec", () => {
  const rec = (id: string, spec: string): SourceRecord => ({
    id,
    kind: "git",
    spec,
    url: "u",
    subpath: "",
    ref: null,
    commit: "abc",
    installedAt: "now",
  });
  const list = [rec("o__r", "o/r"), rec("o__q", "o/q")];
  assert.equal(findSource(list, "o__r").id, "o__r");
  assert.equal(findSource(list, "o/q").id, "o__q");
  assert.throws(() => findSource(list, "zzz"), /no source/u);
  assert.throws(() => findSource([rec("a", "same"), rec("b", "same")], "same"), /several sources/u);
});

test("a malformed sources.json is an error and nothing is written", async () => {
  const home = await tmp("mg-home-");
  const bin = await fakeRipwire();
  const file = path.join(home, "sources.json");
  await writeFile(file, "{ not json");

  process.env["MARGRAVE_HOME"] = home;
  await assert.rejects(readSources(), /not valid JSON/u);
  await writeFile(file, JSON.stringify([{ id: 1 }]));
  await assert.rejects(readSources(), /malformed/u);

  const src = await tmp("mg-src-");
  await writeSkill(src, "a-skill", "a skill");
  for (const content of ["{ not json", JSON.stringify([{ id: 1 }])]) {
    await writeFile(file, content);
    const r = await runCli(["install", src], { home, fakeBin: bin });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /sources\.json/u);
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

/** Point MARGRAVE_HOME at `h` for this test only. */
function useHome(t: { after: (fn: () => void) => void }, h: string): void {
  const prev = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = h;
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
}

test("a sources.json that cannot be read for a reason other than ENOENT is an error, not an empty list", async (t) => {
  const h = await tmp("mg-home-");
  useHome(t, h);
  await mkdir(path.join(h, "sources.json"));
  await assert.rejects(readSources(), /EISDIR/u);
});

test("every field of a source record is checked", async (t) => {
  const h = await tmp("mg-home-");
  useHome(t, h);
  const good = { id: "o__r", kind: "git", spec: "o/r", url: "u", subpath: "", ref: null, commit: null, installedAt: "now" };
  await writeFile(path.join(h, "sources.json"), JSON.stringify([good, { ...good, id: "l", kind: "local", path: "/p" }]));
  assert.equal((await readSources()).length, 2);

  const { url: _url, ...noUrl } = good;
  const bad: Record<string, unknown> = {
    "not an object": 1,
    "a list instead of an object": [],
    "null instead of an object": null,
    "id is not a string": { ...good, id: 1 },
    "spec is not a string": { ...good, spec: 1 },
    "kind is unknown": { ...good, kind: "svn" },
    "subpath is not a string": { ...good, subpath: 1 },
    "ref is neither null nor a string": { ...good, ref: 1 },
    "commit is neither null nor a string": { ...good, commit: 1 },
    "installedAt is not a string": { ...good, installedAt: 1 },
    "a git record without url": noUrl,
    "a local record without path": { ...good, kind: "local" },
    "snapshot on a local source": { ...good, kind: "local", path: "/p", snapshot: `${"a".repeat(40)}-${"b".repeat(16)}` },
    "snapshot traversal": { ...good, commit: "a".repeat(40), snapshot: `../${"a".repeat(40)}-${"b".repeat(16)}` },
    "snapshot commit mismatch": { ...good, commit: "c".repeat(40), snapshot: `${"a".repeat(40)}-${"b".repeat(16)}` },
    "snapshot nonce malformed": { ...good, commit: "a".repeat(40), snapshot: `${"a".repeat(40)}-${"B".repeat(16)}` },
  };
  for (const [why, record] of Object.entries(bad)) {
    await writeFile(path.join(h, "sources.json"), JSON.stringify([record]));
    await assert.rejects(readSources(), /malformed/u, why);
  }
  await writeFile(path.join(h, "sources.json"), JSON.stringify({ not: "a list" }));
  await assert.rejects(readSources(), /malformed/u, "not a list");
});

test("a git URL that cannot be parsed, a repo name that is only .git, and a URL with no path", () => {
  assert.throws(
    () => parseSpec("git@github.com"),
    (e: unknown) => e instanceof UsageError && /cannot parse git URL "git@github\.com"/u.test(e.message),
  );
  assert.throws(
    () => parseSpec("https://"),
    (e: unknown) => e instanceof UsageError && /cannot parse git URL "https:\/\/"/u.test(e.message),
  );
  assert.throws(
    () => parseSpec("owner/.git"),
    (e: unknown) => e instanceof UsageError && /unrecognized source "owner\/\.git"/u.test(e.message),
  );
  const bare = parseSpec("https://github.com");
  assert.equal(bare.kind === "git" && bare.id, "github.com");
});

// ---- a write that fails half way ----

const quiet = { log: (): void => undefined, allowUnsafe: false };

/** Run `fn` in this process with the fake ripwire on PATH, a fresh MARGRAVE_HOME, and no global git config. */
async function inStore<T>(t: { after: (fn: () => void) => void }, fn: (home: string) => Promise<T>): Promise<T> {
  const keys = ["PATH", "MARGRAVE_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
  const prev = keys.map((k) => process.env[k]);
  const home = await tmp("mg-home-");
  process.env["PATH"] = `${await fakeRipwire()}:${process.env["PATH"] ?? ""}`;
  process.env["MARGRAVE_HOME"] = home;
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    });
  });
  return fn(home);
}

/** Make fs.rename reject whenever `fails(from, to, nth)` says so. Other renames run. */
function failRename(fails: (from: string, to: string, nth: number) => boolean): void {
  // Drop an earlier mock first: restoring two stacked mocks in creation order would leave the inner one in place.
  mock.restoreAll();
  const real = fsp.rename;
  let nth = 0;
  mock.method(fsp, "rename", (from: string, to: string) =>
    fails(from, to, ++nth) ? Promise.reject(new Error(`mock: cannot rename to ${to}`)) : real(from, to),
  );
  syncBuiltinESMExports();
}

const passRename = (): void => {
  mock.restoreAll();
  syncBuiltinESMExports();
};

const read = (home: string, file: string): Promise<string | null> => readFile(path.join(home, file), "utf8").catch(() => null);

test("install: when sources.json cannot be written, the rows roll back and the old index stays", async (t) => {
  await inStore(t, async (home) => {
    const first = await tmp("mg-localsrc-");
    await writeSkill(first, "alpha", "alpha skill");
    const second = await tmp("mg-localsrc2-");
    await writeSkill(second, "beta", "beta skill");

    // A store with no sources: the failed install leaves an empty index and no sources.json.
    failRename((_from, to) => to.endsWith("sources.json"));
    await assert.rejects(installSource(first, null, quiet), /mock: cannot rename to .*sources\.json/u);
    assert.deepEqual(indexIds(home), []);
    assert.equal(await read(home, "sources.json"), null);

    // A store with an index: the old rows and the old sources.json stay.
    passRename();
    await installSource(first, null, quiet);
    const ids = indexIds(home);
    const sources = await read(home, "sources.json");
    assert.equal(ids.length, 1);
    failRename((_from, to) => to.endsWith("sources.json"));
    await assert.rejects(installSource(second, null, quiet), /mock: cannot rename to .*sources\.json/u);
    assert.deepEqual(indexIds(home), ids);
    assert.equal(await read(home, "sources.json"), sources);
  });
});

/** Make the COMMIT statement of any DatabaseSync throw. Other statements run. */
function failCommit(): void {
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") throw new Error("mock: COMMIT failed");
    return realExec.call(this, sql);
  });
}

test("a COMMIT that fails restores the old sources.json, rolls back the rows, and reports the COMMIT error", async (t) => {
  await inStore(t, async (home) => {
    const first = await tmp("mg-localsrc-");
    await writeSkill(first, "alpha", "alpha skill");
    const second = await tmp("mg-localsrc2-");
    await writeSkill(second, "beta", "beta skill");
    await installSource(first, null, quiet);
    const ids = indexIds(home);
    const sources = await read(home, "sources.json");

    failCommit();
    await assert.rejects(installSource(second, null, quiet), /mock: COMMIT failed/u);
    assert.deepEqual(indexIds(home), ids);
    assert.equal(await read(home, "sources.json"), sources, "the old sources.json is back");

    // The restore fails too: the COMMIT error is still the one that is reported. The first rename (the new sources.json) works.
    failRename((_from, _to, nth) => nth > 1);
    failCommit();
    await assert.rejects(installSource(second, null, quiet), /mock: COMMIT failed/u);
    assert.deepEqual(indexIds(home), ids);
  });
});

test("a ROLLBACK that fails does not replace the error that caused it", async (t) => {
  await inStore(t, async (home) => {
    const first = await tmp("mg-localsrc-");
    await writeSkill(first, "alpha", "alpha skill");
    const second = await tmp("mg-localsrc2-");
    await writeSkill(second, "beta", "beta skill");
    await installSource(first, null, quiet);
    const ids = indexIds(home);

    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "COMMIT") throw new Error("mock: COMMIT failed");
      if (sql === "ROLLBACK") throw new Error("mock: ROLLBACK failed");
      return realExec.call(this, sql);
    });
    await assert.rejects(installSource(second, null, quiet), /mock: COMMIT failed/u);
    mock.restoreAll();
    assert.deepEqual(indexIds(home), ids, "closing the connection rolled the rows back");
  });
});

test("install of a git source: when sources.json cannot be written, the stored copy is removed", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    failRename((_from, to) => to.endsWith("sources.json"));
    await assert.rejects(installSource(repo.url, null, quiet), /mock: cannot rename to .*sources\.json/u);
    assert.deepEqual(await readdir(path.join(home, "sources")), []);
    assert.deepEqual(indexIds(home), []);
  });
});

test("update of a git source rolls the stored copy back when the swap or the write fails", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const final = path.join(home, "sources", id);
    const stored = async (): Promise<string> => readFile(path.join(final, "skills", "react-perf", "SKILL.md"), "utf8");
    const before = { sources: await read(home, "sources.json"), index: indexIds(home), skill: await stored() };

    await writeSkill(path.join(repo.dir, "skills"), "react-perf", "Changed description of react perf");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-q", "-m", "change");

    // The new clone cannot be moved into place.
    failRename((from, to) => to.includes(`${path.sep}snapshots${path.sep}`) && from.endsWith(`${path.sep}repo`));
    await assert.rejects(updateSources(id, quiet), /mock: cannot rename to /u);
    assert.equal(await stored(), before.skill);
    assert.equal(await read(home, "sources.json"), before.sources);
    assert.deepEqual(indexIds(home), before.index);
    assert.equal((await readdir(path.join(home, "snapshots", id))).length, 1);

    // The new clone is in place, but sources.json cannot be written.
    failRename((_from, to) => to.endsWith("sources.json"));
    await assert.rejects(updateSources(id, quiet), /mock: cannot rename to .*sources\.json/u);
    assert.equal(await stored(), before.skill);
    assert.equal(await read(home, "sources.json"), before.sources);
    assert.deepEqual(indexIds(home), before.index);
    assert.equal((await readdir(path.join(home, "snapshots", id))).length, 1);

    // With the mock gone, the same update works.
    passRename();
    const ok = await updateSources(id, quiet);
    assert.equal(ok.errors.length, 0);
    assert.notEqual(await stored(), before.skill);
  });
});

test("reindex: when sources.json cannot be written, the rows roll back, and a legacy index.json is kept", async (t) => {
  await inStore(t, async (home) => {
    const dir = await tmp("mg-localsrc-");
    await writeSkill(dir, "alpha", "alpha skill");
    await installSource(dir, null, quiet);
    const ids = indexIds(home);
    const sources = await read(home, "sources.json");
    await writeFile(path.join(home, "index.json"), "legacy");
    await writeSkill(dir, "beta", "beta skill");

    failRename((_from, to) => to.endsWith("sources.json"));
    await assert.rejects(reindexAll(quiet), /mock: cannot rename to .*sources\.json/u);
    assert.deepEqual(indexIds(home), ids, "the old index stays");
    assert.equal(await read(home, "sources.json"), sources);
    assert.equal(await read(home, "index.json"), "legacy", "the legacy file stays after a failed reindex");

    passRename();
    assert.deepEqual(await reindexAll(quiet), { skills: 2, sources: 1 });
    assert.equal(indexIds(home).length, 2);
    assert.equal(await read(home, "index.json"), null, "the legacy file goes after a COMMIT");
  });
});

// ---- an error that is not an Error, and a source that vanishes between two reads ----

/** Make the nth read of sources.json answer with `answer(nth)`, when it gives a promise. Other reads run. */
function mockSourcesRead(answer: (nth: number) => Promise<string> | undefined): void {
  mock.restoreAll();
  const real = fsp.readFile;
  let nth = 0;
  mock.method(fsp, "readFile", (file: never, ...rest: never[]) => {
    if (String(file).endsWith("sources.json")) {
      const given = answer(++nth);
      if (given !== undefined) return given;
    }
    return (real as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
  });
  syncBuiltinESMExports();
}

test("update of all sources: a rejection that is not an Error, or a source that vanished, is reported for that source", async (t) => {
  await inStore(t, async () => {
    const dir = await tmp("mg-localsrc-");
    await writeSkill(dir, "alpha", "alpha skill");
    const { id } = await installSource(dir, null, quiet);

    // The first read (updateSources) works; the second (updateOne) rejects with a string.
    mockSourcesRead((nth) => (nth === 2 ? Promise.reject("boom, not an Error") : undefined));
    assert.deepEqual(await updateSources(null, quiet), { results: [], errors: [{ id, message: "boom, not an Error" }] });

    // The second read finds no sources: someone removed this one in between.
    mockSourcesRead((nth) => (nth === 2 ? Promise.resolve("[]") : undefined));
    assert.deepEqual(await updateSources(null, quiet), { results: [], errors: [{ id, message: `no source "${id}"` }] });
  });
});

test("reindex: a rejection that is not an Error is logged as text and the source is skipped", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const dir = await fsp.realpath(path.join(home, "sources", id));

    mock.restoreAll();
    const real = fsp.realpath;
    mock.method(fsp, "realpath", (p: string, ...rest: never[]) =>
      p === dir ? Promise.reject("boom, not an Error") : (real as (...a: unknown[]) => Promise<string>)(p, ...rest),
    );
    syncBuiltinESMExports();
    const logs: string[] = [];
    const r = await reindexAll({ log: (m) => logs.push(m), allowUnsafe: false });
    assert.deepEqual(r, { skills: 0, sources: 1 });
    assert.deepEqual(logs, [`warning: ${id}: boom, not an Error; skipped`]);
  });
});

test("check reports a source record changed during its scan", async (t) => {
  await inStore(t, async (home) => {
    const root = await tmp("mg-source-");
    await writeSkill(root, "alpha", "alpha skill");
    const { id } = await installSource(root, null, quiet);
    const file = path.join(home, "sources.json");
    const real = fsp.readdir;
    let changed = false;
    mock.method(fsp, "readdir", (async (p: string, ...args: unknown[]) => {
      if (p === root && !changed) {
        changed = true;
        const records = JSON.parse(await fsp.readFile(file, "utf8")) as SourceRecord[];
        assert.ok(records[0]);
        records[0].installedAt = "changed";
        await fsp.writeFile(file, JSON.stringify(records));
      }
      return (real as (...x: unknown[]) => Promise<unknown>)(p, ...args);
    }) as typeof fsp.readdir);
    syncBuiltinESMExports();
    const results = await checkSources(id);
    assert.equal(changed, true);
    assert.equal(results[0]?.error, "source changed during check; run margrave check again");
  });
});

test("update propagates a missing Git executable for a valid ref", async (t) => {
  await inStore(t, async () => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    process.env["PATH"] = await tmp("mg-empty-path-");
    await assert.rejects(updateSources(id, quiet, "refs/heads/main"), (err: unknown) => {
      assert.ok(err instanceof MargraveError);
      assert.match(err.message, /git was not found on PATH/u);
      return true;
    });
  });
});

test("reindex: control characters in a failure message are logged as text", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const dir = await fsp.realpath(path.join(home, "sources", id));

    mock.restoreAll();
    const real = fsp.realpath;
    mock.method(fsp, "realpath", (p: string, ...rest: never[]) =>
      p === dir ? Promise.reject(new Error("bad \u001b[2J name")) : (real as (...a: unknown[]) => Promise<string>)(p, ...rest),
    );
    syncBuiltinESMExports();
    const logs: string[] = [];
    await reindexAll({ log: (m) => logs.push(m), allowUnsafe: false });
    assert.deepEqual(logs, [`warning: ${id}: bad \\x1b[2J name; skipped`]);
    assert.ok(!logs.join("").includes("\u001b"));
  });
});

test("reindex preserves unreadable source rows and migration rejects an unreadable supporting directory", async (t) => {
  const prev = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const root = await tmp("mg-source-");
  const skill = await writeSkill(root, "alpha", "test skill");
  const refs = path.join(skill, "references");
  await mkdir(refs);
  await writeFile(path.join(refs, "x.md"), "text");
  const result = await runCli(["install", root], { home, fakeBin: await fakeRipwire() });
  assert.equal(result.code, 0, result.stderr);
  const other = await tmp("mg-source-");
  const otherSkill = await writeSkill(other, "beta", "other skill");
  const second = await runCli(["install", other], { home, fakeBin: await fakeRipwire() });
  assert.equal(second.code, 0, second.stderr);
  const rows = indexRows(home);
  await writeFile(path.join(otherSkill, "reference.md"), "new content");
  const actual = fsp.readdir;
  mock.method(fsp, "readdir", ((p: string, ...args: unknown[]) =>
    p === refs
      ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
      : (actual as (...x: unknown[]) => unknown)(p, ...args)) as typeof fsp.readdir);
  syncBuiltinESMExports();
  const checked = await checkSources(null);
  assert.equal(checked.length, 2);
  assert.match(checked[0]?.error ?? "", /denied/u);
  assert.deepEqual(checked[1]?.changed, [`${localId(other)}/beta`]);
  const logs: string[] = [];
  await reindexAll({ log: (line) => logs.push(line), allowUnsafe: false });
  const after = indexRows(home);
  assert.deepEqual(
    after.find((row) => row.name === "alpha"),
    rows.find((row) => row.name === "alpha"),
  );
  assert.notEqual(after.find((row) => row.name === "beta")?.hash, rows.find((row) => row.name === "beta")?.hash);
  assert.match(logs.join("\n"), /denied/u);
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("ALTER TABLE skills DROP COLUMN manifest; ALTER TABLE skills DROP COLUMN frontmatter; PRAGMA user_version = 1");
  db.close();
  await assert.rejects(reindexAll({ log: () => {}, allowUnsafe: false }), /source is unreadable/u);
  const old = new DatabaseSync(path.join(home, "index.db"));
  assert.equal((old.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  assert.equal((old.prepare("SELECT count(*) AS n FROM skills").get() as { n: number }).n, 2);
  old.close();
  mock.restoreAll();
  syncBuiltinESMExports();
  await reindexAll({ log: () => {}, allowUnsafe: false });
});

test("a reader keeps the selected snapshot during publication", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const skill = `${id}/react-perf`;
    const old = indexRows(home).find((row) => row.id === skill)!.hash;
    const alias = path.join(home, "sources", id, "skills", "react-perf", "SKILL.md");
    const oldText = await readFile(alias, "utf8");
    await writeSkill(path.join(repo.dir, "skills"), "react-perf", "new description", "new content\n");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-qm", "next");
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = fsp.rename;
    mock.method(fsp, "rename", async (from: string, to: string) => {
      await real(from, to);
      if (to === path.join(home, "sources.json")) {
        reached();
        await resume;
      }
    });
    syncBuiltinESMExports();
    const updating = updateSources(id, quiet);
    try {
      await Promise.race([
        paused,
        updating.then(() => {
          throw new Error("writer completed before pause");
        }),
      ]);
      assert.match(await readFile(alias, "utf8"), /new content/u);
      const reader = await runCli(["load", skill, "--file", "SKILL.md", "--revision", old], { home });
      assert.equal(reader.code, 0, reader.stderr);
      assert.equal(reader.stdout, oldText);
    } finally {
      release();
      await updating;
      passRename();
    }
    const stale = await runCli(["load", skill, "--revision", old], { home });
    assert.match(stale.stderr, /skill revision changed; search again/u);
    const current = indexRows(home).find((row) => row.id === skill)!.hash;
    const fresh = await runCli(["load", skill, "--file", "SKILL.md", "--revision", current], { home });
    assert.match(fresh.stdout, /new content/u);
    assert.equal((await readdir(path.join(home, "snapshots", id))).length, 1);
  });
});

test("legacy Git directories reindex, update and remove", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const alias = path.join(home, "sources", id);
    const target = await fsp.realpath(alias);
    await fsp.unlink(alias);
    await fsp.rename(target, alias);
    const records = await readSources();
    delete records[0]!.snapshot;
    await writeFile(path.join(home, "sources.json"), JSON.stringify(records));
    assert.equal((await reindexAll(quiet)).skills, 3);
    const skill = `${id}/react-perf`;
    const oldRevision = indexRows(home).find((row) => row.id === skill)!.hash;
    const oldText = await readFile(path.join(alias, "skills", "react-perf", "SKILL.md"), "utf8");
    await writeSkill(path.join(repo.dir, "skills"), "react-perf", "new description", "new content\n");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-qm", "legacy update");
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = fsp.rename;
    mock.method(fsp, "rename", async (from: string, to: string) => {
      if (to === path.join(home, "sources.json")) {
        reached();
        await resume;
      }
      return real(from, to);
    });
    syncBuiltinESMExports();
    const updating = updateSources(id, quiet);
    try {
      await Promise.race([
        paused,
        updating.then(() => {
          throw new Error("writer completed before pause");
        }),
      ]);
      const reader = await runCli(["load", skill, "--file", "SKILL.md", "--revision", oldRevision], { home });
      assert.ok(reader.code === 0 || reader.stderr.includes("skill revision changed; search again"), reader.stderr);
      if (reader.code === 0) assert.equal(reader.stdout, oldText);
    } finally {
      release();
      await updating;
      passRename();
    }
    assert.equal((await fsp.lstat(alias)).isSymbolicLink(), true);
    assert.equal((await reindexAll(quiet)).skills, 3);
    await removeSource(id);
    assert.equal((await readdir(path.join(home, "snapshots", id))).length, 0);
    await installSource(repo.url, null, quiet);
    const installed = await fsp.realpath(alias);
    await fsp.unlink(alias);
    await fsp.rename(installed, alias);
    const legacy = await readSources();
    delete legacy[0]!.snapshot;
    await writeFile(path.join(home, "sources.json"), JSON.stringify(legacy));
    await removeSource(id);
    await assert.rejects(fsp.lstat(alias), /ENOENT/u);
  });
});

test("missing and foreign aliases do not delete another directory", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const alias = path.join(home, "sources", id);
    const installed = await fsp.realpath(alias);
    await fsp.unlink(alias);
    const other = await tmp("mg-other-");
    await fsp.symlink(other, alias);
    await assert.rejects(updateSources(id, quiet), /already installed/u);
    await assert.rejects(removeSource(id), /already installed/u);
    assert.equal(await fsp.realpath(alias), other);
    assert.equal((await fsp.stat(installed)).isDirectory(), true);
    await fsp.unlink(alias);
    await removeSource(id);
    await assert.rejects(fsp.stat(installed), /ENOENT/u);
    assert.equal((await fsp.stat(other)).isDirectory(), true);
  });
});

test("lock identity validation supports Git specs and rejects malformed records", () => {
  for (const spec of ["owner/repo", "owner/repo/skills/react", "https://example.com/a/repo.git", "file:///tmp/repo"]) {
    const parsed = parseSpec(spec);
    assert.equal(parsed.kind, "git");
    if (parsed.kind !== "git") continue;
    const source = {
      spec,
      id: parsed.id,
      url: parsed.url,
      subpath: parsed.subpath,
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      skills: [{ id: `${parsed.id}/skill`, revision: `sha256:${"b".repeat(64)}` }],
    };
    assert.equal(parseLock({ version: 1, sources: [source] }).sources[0]?.id, parsed.id);
    assert.throws(() => parseLock({ version: 1, sources: [{ ...source, id: "wrong" }] }), /lock source does not match its install spec/u);
    assert.throws(() => parseLock({ version: 1, sources: [{ ...source, ref: "main" }] }), /lock file is malformed/u);
    assert.throws(() => parseLock({ version: 1, sources: [source, source] }), /lock file is malformed/u);
  }
  assert.deepEqual(parseLock({ version: 1, sources: [] }), { version: 1, sources: [] });
  for (const spec of ["https://example.com/a?", "https://example.com/a#", "https:////user:secret@example.com/a"]) {
    assert.throws(
      () => parseLock({ version: 1, sources: [{ spec }] }),
      /lock source URL must not contain credentials, a query, or a fragment/u,
    );
  }
});
