import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MargraveError } from "../src/store.ts";
import { loadSkill, readSkillFile } from "../src/skills.ts";
import type { IndexEntry } from "../src/store.ts";
import { link, tmp, writeSkill } from "./helpers.ts";

test("--file refuses ../, an absolute path, and a symlink out of the dir", async () => {
  const root = await tmp();
  const dir = await writeSkill(root, "skill", "s");
  await writeFile(path.join(dir, "ref.md"), "inside\n");
  await writeFile(path.join(root, "secret.txt"), "outside\n");
  await link(path.join(root, "secret.txt"), path.join(dir, "leak.txt"));
  await link(root, path.join(dir, "dirleak"));

  assert.equal(await readSkillFile(dir, "ref.md"), "inside\n");
  assert.equal(await readSkillFile(dir, "./ref.md"), "inside\n");
  await assert.rejects(readSkillFile(dir, "../secret.txt"), /outside/u);
  await assert.rejects(readSkillFile(dir, path.join(root, "secret.txt")), /relative/u);
  await assert.rejects(readSkillFile(dir, path.join(dir, "ref.md")), /relative/u);
  await assert.rejects(readSkillFile(dir, "leak.txt"), /outside/u);
  await assert.rejects(readSkillFile(dir, "dirleak/secret.txt"), /outside/u);
  await assert.rejects(readSkillFile(dir, "missing.md"), /no such file/u);
  await assert.rejects(readSkillFile(dir, "../does-not-exist"), /outside/u, "no existence oracle outside the dir");
  await assert.rejects(readSkillFile(dir, ""), MargraveError);
  await assert.rejects(readSkillFile(dir, "ref\u0000.md"), MargraveError);
});

test("the guard compares with a trailing separator: /a/skill does not allow /a/skill2", async () => {
  const root = await tmp();
  const dir = await writeSkill(root, "skill", "s");
  const sibling = await writeSkill(root, "skill2", "s2");
  await writeFile(path.join(sibling, "data.txt"), "sibling\n");
  await link(path.join(sibling, "data.txt"), path.join(dir, "to-sibling.txt"));

  await assert.rejects(readSkillFile(dir, "to-sibling.txt"), /outside/u);
  await assert.rejects(readSkillFile(dir, "../skill2/data.txt"), /outside/u);
  assert.equal(await readSkillFile(sibling, "data.txt"), "sibling\n");
});

test("--file allows a file in a skill dir that is reached through a symlink", async () => {
  const elsewhere = await tmp("mg-elsewhere-");
  const real = await writeSkill(elsewhere, "linked-skill", "s");
  await mkdir(path.join(real, "references"), { recursive: true });
  await writeFile(path.join(real, "references", "x.md"), "reference body\n");

  const local = await tmp("mg-local-");
  const via = path.join(local, "via-link");
  await link(real, via);

  assert.equal(await readSkillFile(via, "references/x.md"), "reference body\n");

  const entry: IndexEntry = {
    id: "s/linked-skill",
    name: "linked-skill",
    description: "s",
    source: "s",
    dir: via,
    hash: "h",
    frontmatter: {},
    headings: [],
    fieldTokens: { name: {}, description: {}, headings: {}, body: {} },
  };
  const loaded = await loadSkill(entry, []);
  assert.deepEqual(loaded.files, ["SKILL.md", "references/x.md"]);
  assert.match(loaded.body, /Body of linked-skill/u);
});

test("load reports a missing directory and says to run reindex", async () => {
  const entry: IndexEntry = {
    id: "s/gone",
    name: "gone",
    description: "x",
    source: "s",
    dir: path.join(await tmp(), "does-not-exist"),
    hash: "h",
    frontmatter: {},
    headings: [],
    fieldTokens: { name: {}, description: {}, headings: {}, body: {} },
  };
  await assert.rejects(loadSkill(entry, []), /margrave reindex/u);
});
