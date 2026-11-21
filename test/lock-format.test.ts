import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkLockUrl } from "../src/lock.ts";
import { parseLock } from "../src/lock-format.ts";
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
