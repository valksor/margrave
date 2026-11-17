import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFieldTokens, buildStats } from "../src/bm25.ts";
import { assemble, checkRef, findSource, localId, parseSpec, sanitizeId, sourceDir } from "../src/sources.ts";
import { MargraveError, UsageError, readSources } from "../src/store.ts";
import type { IndexEntry, SourceRecord } from "../src/store.ts";
import { resolveSkill } from "../src/skills.ts";
import { fakeRipwire, runCli, tmp, writeSkill } from "./helpers.ts";

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
  assert.deepEqual(first.skills.map((s) => s.id), ["src-a/docker", "src-a/react"]);
  assert.equal(resolveSkill(first, "react").id, "src-a/react");
  assert.equal(resolveSkill(first, "src-a/react").id, "src-a/react");

  const second = assemble([...first.skills, entry("src-b", "react")]);
  assert.ok(second.skills.some((s) => s.id === "src-a/react"), "existing id unchanged");
  assert.equal(resolveSkill(second, "src-a/react").id, "src-a/react");
  assert.equal(resolveSkill(second, "src-b/react").id, "src-b/react");
  assert.equal(resolveSkill(second, "docker").id, "src-a/docker");
  assert.throws(
    () => resolveSkill(second, "react"),
    (e: unknown) => e instanceof MargraveError && /ambiguous/u.test(e.message) && e.message.includes("src-a/react") && e.message.includes("src-b/react"),
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
    assert.deepEqual((await readdir(home)).filter((n) => n.endsWith(".tmp")), []);
  }
});

test("a missing sources.json is an empty list", async () => {
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  assert.deepEqual(await readSources(), []);
});
