import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MargraveError } from "../src/store.ts";
import { listFiles, loadSkill, readSkillFile } from "../src/skills.ts";
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

test("--file refuses any path with a .git component and serves lookalikes", async () => {
  const root = await tmp();
  const dir = await writeSkill(root, "skill", "s");
  await mkdir(path.join(dir, ".git"));
  await writeFile(path.join(dir, ".git", "config"), "[remote]\nurl = https://user:token@example.com/r.git\n");
  await mkdir(path.join(dir, "sub", ".git"), { recursive: true });
  await writeFile(path.join(dir, "sub", ".git", "HEAD"), "ref: refs/heads/main\n");
  await link(path.join(dir, ".git", "config"), path.join(dir, "cfg"));
  await writeFile(path.join(dir, ".gitignore"), "ignore\n");
  await writeFile(path.join(dir, ".gitmodules"), "modules\n");
  await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(dir, ".github", "workflows", "x.yml"), "workflow\n");
  await writeFile(path.join(dir, "git.md"), "git md\n");
  await mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "x", "y.md"), "module\n");

  // `.GIT/config` does not exist on a case-sensitive file system; the lexical check refuses it before any file access.
  for (const bad of [".git/config", "./.git/config", "x/../.git/config", "sub/.git/HEAD", ".GIT/config", "cfg", ".git/nothing"]) {
    await assert.rejects(readSkillFile(dir, bad), /inside \.git/u, bad);
  }
  assert.equal(await readSkillFile(dir, ".gitignore"), "ignore\n");
  assert.equal(await readSkillFile(dir, ".gitmodules"), "modules\n");
  assert.equal(await readSkillFile(dir, ".github/workflows/x.yml"), "workflow\n");
  assert.equal(await readSkillFile(dir, "git.md"), "git md\n");
  assert.equal(await readSkillFile(dir, "node_modules/x/y.md"), "module\n");

  // A worktree or submodule has a .git regular file (a gitfile); it is refused too.
  const gitfile = await writeSkill(root, "gitfile", "s");
  await writeFile(path.join(gitfile, ".git"), "gitdir: /somewhere\n");
  await assert.rejects(readSkillFile(gitfile, ".git"), /inside \.git/u);
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

test("readSkillFile reports a missing skill directory, a directory path, and works from a root directory", async () => {
  const gone = path.join(await tmp(), "does-not-exist");
  await assert.rejects(readSkillFile(gone, "SKILL.md"), /is gone; run: margrave reindex/u);

  const dir = await writeSkill(await tmp(), "dir-path", "a skill");
  await mkdir(path.join(dir, "references"));
  await assert.rejects(readSkillFile(dir, "references"), /not a file: references/u);

  // The filesystem root already ends with a separator, so no second one is added to the prefix.
  await assert.rejects(readSkillFile("/", `margrave-no-such-file-${process.pid}`), /no such file in the skill directory/u);
});

test("listFiles of a directory that cannot be read is an empty list", async () => {
  assert.deepEqual(await listFiles(path.join(await tmp(), "does-not-exist")), []);
});

test("load of a SKILL.md without frontmatter returns an empty frontmatter and the whole text as body", async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, "SKILL.md"), "# plain\n\nno frontmatter here\n");
  const entry: IndexEntry = {
    id: "s/plain",
    name: "plain",
    description: "x",
    source: "s",
    dir,
    hash: "h",
    frontmatter: {},
    headings: [],
    fieldTokens: { name: {}, description: {}, headings: {}, body: {} },
  };
  const r = await loadSkill(entry, []);
  assert.equal(r.frontmatter, "");
  assert.equal(r.body, "# plain\n\nno frontmatter here\n");
  assert.equal(r.spec, "");
  assert.equal(r.commit, null);
});
