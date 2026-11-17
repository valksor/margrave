import assert from "node:assert/strict";
import fsp, { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { buildFieldTokens, buildStats } from "../src/bm25.ts";
import {
  assemble,
  checkRef,
  findSource,
  installSource,
  localId,
  parseSpec,
  reindexAll,
  sanitizeId,
  sourceDir,
  updateSources,
} from "../src/sources.ts";
import { MargraveError, UsageError, home as storeHome, readIndex, readSources } from "../src/store.ts";
import type { IndexEntry, SourceRecord } from "../src/store.ts";
import { resolveSkill } from "../src/skills.ts";
import { fakeRipwire, git, makeRepo, runCli, tmp, writeSkill } from "./helpers.ts";

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

function entry(source: string, name: string): IndexEntry {
  return {
    id: `${source}/${name}`,
    name,
    description: `desc ${name}`,
    source,
    dir: `/x/${source}/${name}`,
    hash: "h",
    frontmatter: {},
    headings: [],
    fieldTokens: buildFieldTokens({ name, description: `desc ${name}`, headings: [], body: "" }),
  };
}

test("qualified ids stay stable after a second source adds the same name; the bare alias works only while unique", () => {
  const first = assemble([entry("src-a", "react"), entry("src-a", "docker")]);
  assert.deepEqual(
    first.skills.map((s) => s.id),
    ["src-a/docker", "src-a/react"],
  );
  assert.equal(resolveSkill(first, "react").id, "src-a/react");
  assert.equal(resolveSkill(first, "src-a/react").id, "src-a/react");

  const second = assemble([...first.skills, entry("src-b", "react")]);
  assert.ok(
    second.skills.some((s) => s.id === "src-a/react"),
    "existing id unchanged",
  );
  assert.equal(resolveSkill(second, "src-a/react").id, "src-a/react");
  assert.equal(resolveSkill(second, "src-b/react").id, "src-b/react");
  assert.equal(resolveSkill(second, "docker").id, "src-a/docker");
  assert.throws(
    () => resolveSkill(second, "react"),
    (e: unknown) =>
      e instanceof MargraveError && /ambiguous/u.test(e.message) && e.message.includes("src-a/react") && e.message.includes("src-b/react"),
  );
  assert.throws(() => resolveSkill(second, "nope"), /no skill "nope"/u);
  assert.equal(second.stats.docCount, 3);
  assert.deepEqual(buildStats(second.skills), second.stats);
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
    assert.equal((await readdir(home)).includes("index.json"), false, "no index.json written");
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
  };
  for (const [why, record] of Object.entries(bad)) {
    await writeFile(path.join(h, "sources.json"), JSON.stringify([record]));
    await assert.rejects(readSources(), /malformed/u, why);
  }
  await writeFile(path.join(h, "sources.json"), JSON.stringify({ not: "a list" }));
  await assert.rejects(readSources(), /malformed/u, "not a list");
});

test("readIndex: a missing file is null; bad JSON or a wrong shape is an error that says to run reindex", async (t) => {
  const h = await tmp("mg-home-");
  useHome(t, h);
  assert.equal(await readIndex(), null);
  const file = path.join(h, "index.json");
  await writeFile(file, "{ not json");
  await assert.rejects(readIndex(), /not valid JSON; run: margrave reindex/u);
  const shapes: Record<string, unknown> = {
    "not an object": [],
    "wrong version": { version: 2, skills: [], stats: {} },
    "skills is not a list": { version: 1, skills: {}, stats: {} },
    "stats is not an object": { version: 1, skills: [], stats: [] },
  };
  for (const [why, shape] of Object.entries(shapes)) {
    await writeFile(file, JSON.stringify(shape));
    await assert.rejects(readIndex(), /is malformed; run: margrave reindex/u, why);
  }
  await writeFile(file, JSON.stringify({ version: 1, skills: [], stats: {} }));
  assert.deepEqual(await readIndex(), { version: 1, skills: [], stats: {} });
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

test("assemble sorts by id, whatever the input order", () => {
  const ids = (list: IndexEntry[]): string[] => assemble(list).skills.map((s) => s.id);
  assert.deepEqual(ids([entry("a", "x"), entry("a", "y"), entry("b", "x")]), ["a/x", "a/y", "b/x"]);
  assert.deepEqual(ids([entry("b", "x"), entry("a", "y"), entry("a", "x")]), ["a/x", "a/y", "b/x"]);
  // assemble() does not require unique ids: equal ids compare as equal and keep their input order.
  const same = assemble([{ ...entry("a", "x"), name: "first" }, entry("b", "x"), { ...entry("a", "x"), name: "second" }]);
  assert.deepEqual(
    same.skills.map((s) => [s.id, s.name]),
    [
      ["a/x", "first"],
      ["a/x", "second"],
      ["b/x", "x"],
    ],
  );
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

test("install: when sources.json cannot be written, the old index comes back (or goes away, when there was none)", async (t) => {
  await inStore(t, async (home) => {
    const first = await tmp("mg-localsrc-");
    await writeSkill(first, "alpha", "alpha skill");
    const second = await tmp("mg-localsrc2-");
    await writeSkill(second, "beta", "beta skill");

    // No index before: the half-written one is removed.
    failRename((_from, to) => to.endsWith("sources.json"));
    await assert.rejects(installSource(first, null, quiet), /mock: cannot rename to .*sources\.json/u);
    assert.equal(await read(home, "index.json"), null);
    assert.equal(await read(home, "sources.json"), null);

    // An index before: the old one is written back.
    passRename();
    await installSource(first, null, quiet);
    const index = await read(home, "index.json");
    const sources = await read(home, "sources.json");
    assert.ok(index?.includes("alpha"));
    failRename((_from, to) => to.endsWith("sources.json"));
    await assert.rejects(installSource(second, null, quiet), /mock: cannot rename to .*sources\.json/u);
    assert.equal(await read(home, "index.json"), index);
    assert.equal(await read(home, "sources.json"), sources);

    // The restore fails too: the first error is the one that is reported.
    failRename((_from, _to, nth) => nth > 1);
    await assert.rejects(installSource(second, null, quiet), /mock: cannot rename to .*sources\.json/u);
  });
});

test("install of a git source: when sources.json cannot be written, the stored copy is removed", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    failRename((_from, to) => to.endsWith("sources.json"));
    await assert.rejects(installSource(repo.url, null, quiet), /mock: cannot rename to .*sources\.json/u);
    assert.deepEqual(await readdir(path.join(home, "sources")), []);
    assert.equal(await read(home, "index.json"), null);
  });
});

test("update of a git source rolls the stored copy back when the swap or the write fails", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const final = path.join(home, "sources", id);
    const stored = async (): Promise<string> => readFile(path.join(final, "skills", "react-perf", "SKILL.md"), "utf8");
    const before = { sources: await read(home, "sources.json"), index: await read(home, "index.json"), skill: await stored() };

    await writeSkill(path.join(repo.dir, "skills"), "react-perf", "Changed description of react perf");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-q", "-m", "change");

    // The new clone cannot be moved into place.
    failRename((from, to) => to === final && from.endsWith(`${path.sep}repo`));
    await assert.rejects(updateSources(id, quiet), /mock: cannot rename to /u);
    assert.equal(await stored(), before.skill);
    assert.equal(await read(home, "sources.json"), before.sources);
    assert.equal(await read(home, "index.json"), before.index);

    // The new clone is in place, but sources.json cannot be written.
    failRename((_from, to) => to.endsWith("sources.json"));
    await assert.rejects(updateSources(id, quiet), /mock: cannot rename to .*sources\.json/u);
    assert.equal(await stored(), before.skill);
    assert.equal(await read(home, "sources.json"), before.sources);
    assert.equal(await read(home, "index.json"), before.index);

    // With the mock gone, the same update works.
    passRename();
    const ok = await updateSources(id, quiet);
    assert.equal(ok.errors.length, 0);
    assert.notEqual(await stored(), before.skill);
  });
});

test("reindex: when the index cannot be written, the old index comes back, and a failed restore does not hide the error", async (t) => {
  await inStore(t, async (home) => {
    const dir = await tmp("mg-localsrc-");
    await writeSkill(dir, "alpha", "alpha skill");
    await installSource(dir, null, quiet);
    const index = await read(home, "index.json");

    // The restore (a second write of the same file) fails too.
    failRename(() => true);
    await assert.rejects(reindexAll(quiet), /mock: cannot rename to .*index\.json/u);
    assert.equal(await read(home, "index.json"), index);

    // No index before: the restore removes the file.
    passRename();
    await fsp.rm(path.join(home, "index.json"));
    failRename(() => true);
    await assert.rejects(reindexAll(quiet), /mock: cannot rename to .*index\.json/u);
    assert.equal(await read(home, "index.json"), null);
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
    const dir = path.join(home, "sources", id);

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

test("reindex: control characters in a failure message are logged as text", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const dir = path.join(home, "sources", id);

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
