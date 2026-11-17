import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { extractHeadings, parseSkillMd, scanSource, splitSkillMd } from "../src/scan.ts";
import { link, skillMd, tmp, writeSkill } from "./helpers.ts";

test("frontmatter with a missing field is skipped, with a warning", async () => {
  const root = await tmp();
  await writeSkill(root, "good", "a good skill");
  await mkdir(path.join(root, "no-desc"), { recursive: true });
  await writeFile(path.join(root, "no-desc", "SKILL.md"), "---\nname: no-desc\n---\nbody\n");
  await mkdir(path.join(root, "no-name"), { recursive: true });
  await writeFile(path.join(root, "no-name", "SKILL.md"), "---\ndescription: x\n---\nbody\n");
  await mkdir(path.join(root, "no-fm"), { recursive: true });
  await writeFile(path.join(root, "no-fm", "SKILL.md"), "# just a heading\n");
  await mkdir(path.join(root, "bad-yaml"), { recursive: true });
  await writeFile(path.join(root, "bad-yaml", "SKILL.md"), "---\nname: [unclosed\ndescription: x\n---\n");

  const r = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["good"],
  );
  assert.equal(r.warnings.length, 4);
  assert.match(r.warnings.join("\n"), /missing description/u);
  assert.match(r.warnings.join("\n"), /missing name/u);
  assert.match(r.warnings.join("\n"), /no frontmatter/u);
});

test("frontmatter keeps extra keys such as allowed-tools", () => {
  const p = parseSkillMd("---\nname: x\ndescription: y\nallowed-tools: Bash(git:*), Read\n---\n# Title\n");
  assert.equal(p.ok, true);
  if (p.ok) assert.equal(p.skill.frontmatter["allowed-tools"], "Bash(git:*), Read");
});

test("splitSkillMd handles CRLF and a BOM, and returns the body unchanged", () => {
  const s = splitSkillMd("﻿---\r\nname: x\r\ndescription: y\r\n---\r\nbody \u001b[31mred\u001b[0m\r\n");
  assert.equal(s.rawFrontmatter, "name: x\r\ndescription: y");
  assert.equal(s.body, "body \u001b[31mred\u001b[0m\r\n");
});

test("headings skip fenced code blocks", () => {
  const body = "# One\ntext\n```sh\n# not a heading\n```\n## Two ##\n";
  assert.deepEqual(extractHeadings(body), ["One", "Two"]);
});

test("the walk skips .git and node_modules", async () => {
  const root = await tmp();
  await writeSkill(path.join(root, "node_modules"), "hidden", "x");
  await writeSkill(path.join(root, ".git"), "hidden2", "x");
  await writeSkill(root, "shown", "x");
  const r = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["shown"],
  );
});

test("git rules: a symlinked skill dir and a symlinked SKILL.md are skipped with a warning", async () => {
  const outside = await tmp("mg-outside-");
  await writeSkill(outside, "evil", "points outside");
  const root = await tmp("mg-clone-");
  await writeSkill(root, "real", "a real skill");
  await link(path.join(outside, "evil"), path.join(root, "linked-dir"));
  await mkdir(path.join(root, "linked-md"), { recursive: true });
  await link(path.join(outside, "evil", "SKILL.md"), path.join(root, "linked-md", "SKILL.md"));

  const r = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["real"],
  );
  assert.match(r.warnings.join("\n"), /skipped symlink .*linked-dir/u);
  assert.match(r.warnings.join("\n"), /linked-md.*SKILL\.md is a symlink/u);
});

test("git rules: a skill dir whose realpath leaves the boundary is skipped", async () => {
  const outside = await tmp("mg-outside-");
  await writeSkill(outside, "evil", "outside");
  const root = await tmp("mg-clone-");
  await writeSkill(root, "real", "inside");
  // Scan the sibling dir with a boundary that does not contain it.
  const r = await scanSource(outside, { followSymlinks: false, boundary: root });
  assert.deepEqual(r.skills, []);
  assert.match(r.warnings.join("\n"), /resolves outside the source/u);
});

test("local rules: directory symlinks are followed", async () => {
  const elsewhere = await tmp("mg-elsewhere-");
  await writeSkill(elsewhere, "linked-skill", "reached through a symlink");
  const root = await tmp("mg-local-");
  await writeSkill(root, "plain", "plain");
  await link(path.join(elsewhere, "linked-skill"), path.join(root, "via-link"));

  const r = await scanSource(root, { followSymlinks: true });
  assert.deepEqual(r.skills.map((s) => s.name).sort(), ["linked-skill", "plain"]);
});

test("local rules: a symlink cycle terminates", async () => {
  const root = await tmp("mg-cycle-");
  await writeSkill(path.join(root, "a"), "inner", "x");
  await link(root, path.join(root, "a", "back-to-root"));
  await link(path.join(root, "a"), path.join(root, "b"));
  const r = await scanSource(root, { followSymlinks: true });
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["inner"],
  );
});

test("a duplicate name inside one source keeps the first and warns", async () => {
  const root = await tmp();
  await mkdir(path.join(root, "a"), { recursive: true });
  await mkdir(path.join(root, "b"), { recursive: true });
  await writeFile(path.join(root, "a", "SKILL.md"), skillMd("same", "first"));
  await writeFile(path.join(root, "b", "SKILL.md"), skillMd("same", "second"));
  const r = await scanSource(root, { followSymlinks: false });
  assert.equal(r.skills.length, 1);
  assert.equal(r.skills[0]?.description, "first");
  assert.match(r.warnings.join("\n"), /duplicate skill name/u);
});
