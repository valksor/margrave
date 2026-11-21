import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkLockUrl } from "../src/lock.ts";
import { parseLock, readLock } from "../src/lock-format.ts";
import { parseSpec } from "../src/source-git.ts";
import { catalogRecords, makeRepo, cliMg as mg, cliSetup as setup, sourceId, tmp, writeCatalogRecords, writeSkill } from "./helpers.ts";

test("lock validation rejects malformed source and skill fields", () => {
  assert.doesNotThrow(() => checkLockUrl("https://["));
  const parsed = parseSpec("owner/repo");
  assert.equal(parsed.kind, "git");
  if (parsed.kind !== "git") throw new Error("expected Git source");
  const skill = { id: `${parsed.id}/skill`, revision: `sha256:${"b".repeat(64)}` };
  const source = {
    spec: "owner/repo",
    id: parsed.id,
    url: parsed.url,
    subpath: parsed.subpath,
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    skills: [skill],
  };
  for (const selection of [[], ["skill", "skill"], ["z", "a"], ["other"], "skill"]) {
    assert.throws(() => parseLock({ version: 2, sources: [{ ...source, selection }] }), /lock file is malformed/u);
  }
  for (const value of [null, {}, { version: 3, sources: [] }, { version: 1, sources: "bad" }, { version: 1, sources: [], extra: 1 }]) {
    assert.throws(() => parseLock(value), /lock file is malformed/u);
  }
  for (const change of [
    { spec: 1 },
    { id: 1 },
    { url: 1 },
    { subpath: 1 },
    { ref: 1 },
    { commit: 1 },
    { skills: null },
    { extra: 1 },
    { commit: "bad" },
    { skills: [null] },
    { skills: [{ ...skill, id: "wrong" }] },
    { skills: [{ ...skill, id: `${parsed.id}/` }] },
    { skills: [{ ...skill, id: `${parsed.id}/nested/skill` }] },
    { skills: [{ ...skill, id: 1 }] },
    { skills: [{ ...skill, revision: 1 }] },
    { skills: [{ ...skill, revision: "bad" }] },
    { skills: [{ ...skill, extra: 1 }] },
    { skills: [skill, skill] },
  ]) {
    assert.throws(() => parseLock({ version: 1, sources: [{ ...source, ...change }] }), /lock file is malformed/u);
  }
  assert.throws(
    () => parseLock({ version: 1, sources: [{ ...source, spec: "not-a-spec" }] }),
    /lock source does not match its install spec/u,
  );
});

test("lock parsing orders sources and skills lexically", () => {
  const makeSource = (spec: string) => {
    const parsed = parseSpec(spec);
    assert.equal(parsed.kind, "git");
    if (parsed.kind !== "git") throw new Error("expected Git source");
    return {
      spec,
      id: parsed.id,
      url: parsed.url,
      subpath: parsed.subpath,
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      skills: ["z", "a", "m"].map((name) => ({ id: `${parsed.id}/${name}`, revision: `sha256:${"b".repeat(64)}` })),
    };
  };
  const sources = [makeSource("z/repo"), makeSource("a/repo"), makeSource("m/repo")];
  const result = parseLock({ version: 1, sources });
  assert.deepEqual(
    result.sources.map((source) => source.id),
    ["a__repo", "m__repo", "z__repo"],
  );
  for (const source of result.sources) {
    assert.deepEqual(
      source.skills.map((skill) => skill.id),
      ["a", "m", "z"].map((name) => `${source.id}/${name}`),
    );
  }
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

test("lock validation checks digests, commits, and full reference syntax", () => {
  const parsed = parseSpec("owner/repo");
  if (parsed.kind !== "git") throw new Error("expected Git source");
  const skill = { id: `${parsed.id}/skill`, revision: `sha256:${"b".repeat(64)}` };
  const source = {
    spec: "owner/repo",
    id: parsed.id,
    url: parsed.url,
    subpath: parsed.subpath,
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    skills: [skill],
  };
  for (const commit of ["a".repeat(40), "0123456789abcdef".repeat(4)])
    assert.equal(parseLock({ version: 1, sources: [{ ...source, commit }] }).sources[0]?.commit, commit);
  for (const commit of [`x${"a".repeat(40)}`, `${"a".repeat(40)}x`, "a".repeat(39), "a".repeat(41), "g".repeat(64), "A".repeat(40)])
    assert.throws(() => parseLock({ version: 1, sources: [{ ...source, commit }] }), /lock file is malformed/u);
  for (const change of [{ ref: [source.ref] }, { commit: [source.commit] }])
    assert.throws(() => parseLock({ version: 1, sources: [{ ...source, ...change }] }), /lock file is malformed/u);
  for (const revision of [`other:${"b".repeat(64)}`, `sha512:${"b".repeat(64)}`, `sha256:${"b".repeat(63)}`, `sha256:${"g".repeat(64)}`])
    assert.throws(() => parseLock({ version: 1, sources: [{ ...source, skills: [{ ...skill, revision }] }] }), /lock file is malformed/u);
  for (const ref of ["refs/heads/topic/nested", "refs/tags/release/v1", "refs/heads/release.v1"])
    assert.equal(parseLock({ version: 1, sources: [{ ...source, ref }] }).sources[0]?.ref, ref);
  for (const ref of [
    "xrefs/heads/main",
    "refs/heads/",
    "refs/heads/a b",
    "refs/heads/a\u007fb",
    ...["~", "^", ":", "?", "*", "[", "\\"].map((c) => `refs/heads/a${c}b`),
    "refs/heads/a/",
    "refs/heads/a.",
    "refs/heads/.hidden/a",
    "refs/heads/a.lock/b",
    "refs/heads/a..b",
    "refs/heads/a@{b",
    "refs/heads/a//b",
  ])
    assert.throws(() => parseLock({ version: 1, sources: [{ ...source, ref }] }), /lock file is malformed/u, ref);
});

test("lock validation checks raw and normalized URL credentials before identity", () => {
  const diagnostic = /lock source URL must not contain credentials, a query, or a fragment/u;
  for (const url of [
    "https:////user@example.invalid/repo",
    "https:////:password@example.invalid/repo",
    "https://@example.invalid/repo",
    "https://example.invalid/repo?",
    "https://example.invalid/repo#",
  ])
    assert.throws(() => checkLockUrl(url), diagnostic);
  for (const url of ["https://example.invalid/path/@user", "prefix https://example.invalid/repo?x", "http://example.invalid/repo?x#y"])
    assert.doesNotThrow(() => checkLockUrl(url));
  for (const field of ["spec", "url"]) {
    assert.throws(
      () => parseLock({ version: 1, sources: [{ spec: "invalid" }, { [field]: "https:////user@example.invalid/repo" }] }),
      diagnostic,
    );
    assert.throws(() => parseLock({ version: 1, sources: [{ [field]: ["https://@example.invalid/repo"] }] }), /lock file is malformed/u);
  }
  for (const source of [null, {}, { spec: 1 }, { spec: "owner/repo", extra: true }])
    assert.throws(() => parseLock({ version: 1, sources: [source] }), /lock file is malformed/u);
});

test("lock parsing preserves version shapes and selected inventories", () => {
  const parsed = parseSpec("owner/repo");
  if (parsed.kind !== "git") throw new Error("expected Git source");
  const skill = (name: string) => ({ id: `${parsed.id}/${name}`, revision: `sha256:${"b".repeat(64)}` });
  const source = {
    spec: "owner/repo",
    id: parsed.id,
    url: parsed.url,
    subpath: parsed.subpath,
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    skills: [skill("z"), skill("A")],
  };
  const v1 = parseLock({ version: 1, sources: [source] });
  assert.deepEqual(Object.keys(v1), ["version", "sources"]);
  assert.equal(v1.version, 1);
  assert.deepEqual(Object.keys(v1.sources[0]!), ["spec", "id", "url", "subpath", "ref", "commit", "skills"]);
  for (const selection of [null, ["A", "z"]]) {
    const result = parseLock({ version: 2, sources: [{ ...source, selection }] });
    assert.equal(result.version, 2);
    assert.deepEqual(Object.keys(result.sources[0]!), ["spec", "id", "url", "subpath", "ref", "commit", "skills", "selection"]);
    assert.deepEqual(result.sources[0]?.selection, selection);
    assert.deepEqual(
      result.sources[0]?.skills.map((entry) => entry.id),
      [skill("A").id, skill("z").id],
    );
  }
  const nested = { ...source, skills: [skill("nested/skill")], selection: ["nested/skill"] };
  assert.deepEqual(parseLock({ version: 2, sources: [nested] }).sources[0]?.skills, nested.skills);
  for (const invalid of [
    { version: 2, sources: [source] },
    { version: 1, sources: [{ ...source, selection: null }] },
    ...[[" A"], [""], [1], ["A"], ["A", "other"]].map((selection) => ({ version: 2, sources: [{ ...source, selection }] })),
    { version: 2, sources: [{ ...nested, skills: [skill("other")] }] },
    { version: 2, sources: [{ ...nested, skills: [skill("nested/skill"), skill("nested/skill")] }] },
    { version: 2, sources: [{ ...nested, skills: [{}] }] },
    { version: 2, sources: [nested, nested] },
  ])
    assert.throws(() => parseLock(invalid), /lock file is malformed/u);
});

test("lock identity compares parsed ID, URL, subpath, and kind", () => {
  const parsed = parseSpec("owner/repo/nested");
  if (parsed.kind !== "git") throw new Error("expected Git source");
  const source = {
    spec: "owner/repo/nested",
    id: parsed.id,
    url: parsed.url,
    subpath: parsed.subpath,
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    skills: [],
  };
  for (const change of [{ id: `${parsed.id}_` }, { url: `${parsed.url}/` }, { subpath: `${parsed.subpath}/` }, { spec: "./owner/repo" }])
    assert.throws(() => parseLock({ version: 1, sources: [{ ...source, ...change }] }), /lock source does not match its install spec/u);
});

test("lock parsing reads UTF-8 JSON and preserves file errors", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "margrave-lock-format-"));
  try {
    const valid = path.join(dir, "valid.json");
    const invalid = path.join(dir, "invalid.json");
    const forbidden = path.join(dir, "forbidden.json");
    await writeFile(valid, JSON.stringify({ version: 1, sources: [] }), "utf8");
    await writeFile(invalid, "{", "utf8");
    await writeFile(forbidden, JSON.stringify({ version: 1, sources: [{ spec: "https://@example.invalid/repo" }] }), "utf8");
    assert.deepEqual(await readLock(valid), { version: 1, sources: [] });
    await assert.rejects(readLock(invalid), /lock file is malformed/u);
    await assert.rejects(readLock(forbidden), /lock source URL must not contain credentials, a query, or a fragment/u);
    await assert.rejects(readLock(path.join(dir, "missing.json")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lock export rejects a Git record without a snapshot", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const records = catalogRecords(env.home);
  delete records[0]!.snapshot;
  writeCatalogRecords(env.home, records);
  const before = await readFile(path.join(env.home, "index.db"));
  for (const args of [["reindex"], ["lock", "export"]]) {
    const result = await mg(env, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /malformed/u);
  }
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
});

test("lock export requires explicit Git selection in mixed stores", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  const id = sourceId(installed);
  const local = await tmp();
  await writeSkill(local, "local", "Local skill");
  const localInstall = await mg(env, ["install", local]);
  const localId = sourceId(localInstall);
  assert.match((await mg(env, ["lock", "export"])).stderr, /select Git sources with --source/u);
  for (const selected of [localId, "missing"])
    assert.match((await mg(env, ["lock", "export", "--source", selected])).stderr, /--source must be an installed Git source ID/u);
  const exported = await mg(env, ["lock", "export", "--source", id]);
  assert.equal(exported.code, 0, exported.stderr);
});
