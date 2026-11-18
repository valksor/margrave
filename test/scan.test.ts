import assert from "node:assert/strict";
import fsp, { chmod, mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock } from "node:test";
import { extractHeadings, isInside, parseSkillMd, scanSource, splitSkillMd } from "../src/scan.ts";
import { link, mkfifo, skillMd, tmp, writeSkill } from "./helpers.ts";

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

test("isInside accepts the parent itself and its children, and works for a root that ends with a separator", () => {
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b/c", "/a/b"), true);
  assert.equal(isInside("/a/bc", "/a/b"), false);
  assert.equal(isInside("/a", "/"), true);
});

test("frontmatter that is not a mapping is skipped: a list, a plain string, or null", () => {
  for (const fm of ["- a\n- b", "just text", "null"]) {
    const r = parseSkillMd(`---\n${fm}\n---\nbody\n`);
    assert.deepEqual(r, { ok: false, reason: "frontmatter is not a mapping" }, fm);
  }
});

test("a SKILL.md that is a directory, or that cannot be read, is skipped with a warning", async (t) => {
  const root = await tmp();
  await mkdir(path.join(root, "dir-skill", "SKILL.md"), { recursive: true });
  await writeSkill(root, "good", "a good skill");
  const r = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["good"],
  );
  assert.match(r.warnings.join("\n"), /dir-skill.SKILL\.md: not a regular file/u);

  // A file mode of 000 does not stop root, so this half does not run as root.
  if (process.getuid?.() === 0) return t.diagnostic("running as root: skipped the unreadable-file half");
  const locked = await tmp();
  const dir = await writeSkill(locked, "locked", "cannot be read");
  const file = path.join(dir, "SKILL.md");
  await chmod(file, 0o000);
  t.after(() => chmod(file, 0o644));
  const r2 = await scanSource(locked, { followSymlinks: false });
  assert.deepEqual(r2.skills, []);
  assert.match(r2.warnings.join("\n"), /locked.SKILL\.md: EACCES/u);
});

test("a SKILL.md that is a FIFO is skipped without blocking, and a regular one beside it is read", { timeout: 10_000 }, async () => {
  const root = await tmp();
  await mkdir(path.join(root, "fifo-skill"));
  await mkfifo(path.join(root, "fifo-skill", "SKILL.md"));
  await writeSkill(root, "good", "a good skill");
  const r = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["good"],
  );
  assert.match(r.warnings.join("\n"), /fifo-skill.SKILL\.md: not a regular file/u);
});

test("a directory that cannot be listed is skipped with a warning", async (t) => {
  if (process.getuid?.() === 0) return t.skip("a file mode of 000 does not stop root");
  const root = await tmp();
  await writeSkill(root, "good", "a good skill");
  const locked = path.join(root, "locked");
  await mkdir(locked);
  await chmod(locked, 0o000);
  t.after(() => chmod(locked, 0o755));
  const r = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["good"],
  );
  assert.match(r.warnings.join("\n"), /cannot read .*locked: EACCES/u);
});

test("a dangling symlink is ignored, for git rules and for local rules", async () => {
  const root = await tmp();
  await writeSkill(root, "good", "a good skill");
  await link(path.join(root, "does-not-exist"), path.join(root, "dangling"));
  for (const followSymlinks of [false, true]) {
    const r = await scanSource(root, { followSymlinks });
    assert.deepEqual(
      r.skills.map((s) => s.name),
      ["good"],
      `followSymlinks=${followSymlinks}`,
    );
    assert.deepEqual(r.warnings, [], `followSymlinks=${followSymlinks}`);
  }
});

test("a directory that vanishes between the listing and the walk is skipped", async (t) => {
  const root = await tmp();
  await writeSkill(root, "good", "a good skill");
  await mkdir(path.join(root, "ghost"));
  const real = fsp.realpath;
  mock.method(fsp, "realpath", (p: string, ...rest: never[]) =>
    p.endsWith("ghost") ? Promise.reject(new Error("ENOENT: vanished")) : (real as (...a: unknown[]) => Promise<string>)(p, ...rest),
  );
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const r = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["good"],
  );
  assert.deepEqual(r.warnings, []);
});

test("the result is sorted by skill name, whatever order the directories and the filesystem list them in", async (t) => {
  const root = await tmp();
  // Directory order is a, b, c; skill order is c, b, a. The reverse of what the walk finds.
  await writeSkill(path.join(root, "a"), "skill-c", "third");
  await writeSkill(path.join(root, "b"), "skill-b", "second");
  await writeSkill(path.join(root, "c"), "skill-a", "first");
  // And skills already in directory order.
  await writeSkill(path.join(root, "d"), "skill-d", "fourth");
  const names = async (): Promise<string[]> => (await scanSource(root, { followSymlinks: false })).skills.map((s) => s.name);
  const expected = ["skill-a", "skill-b", "skill-c", "skill-d"];

  const real = fsp.readdir;
  const listed = (order: 1 | -1) =>
    mock.method(fsp, "readdir", async (...args: unknown[]) => {
      const entries = (await (real as (...a: unknown[]) => Promise<{ name: string }[]>)(...args)) as { name: string }[];
      return entries.sort((x, y) => order * (x.name < y.name ? -1 : 1));
    });
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const order of [1, -1] as const) {
    listed(order);
    syncBuiltinESMExports();
    assert.deepEqual(await names(), expected, `readdir order ${order}`);
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await names(), expected, "real readdir order");
});

test("splitSkillMd reads an empty frontmatter block", () => {
  assert.deepEqual(splitSkillMd("---\n---\nbody\n"), { rawFrontmatter: "", body: "body\n" });
});
