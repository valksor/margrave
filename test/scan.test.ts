import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp, { chmod, mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock } from "node:test";
import { extractHeadings, isInside, parseSkillMd, scanSource, splitSkillMd } from "../src/scan.ts";
import { link, mkfifo, releaseFifo, skillMd, tmp, writeSkill } from "./helpers.ts";

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
  const invalid = parseSkillMd("---\nname: [unclosed\ndescription: x\n---\n");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.reason, /^frontmatter is not valid YAML \(.{2,}\)$/u);
});

test("a skill carries the four token strings, with headings in their own column, and no frontmatter or headings list", () => {
  const p = parseSkillMd(
    "---\nname: ' xy-tool '\ndescription: ' Tunes things '\nallowed-tools: Bash(git:*), Read\n---\n# Title here\nbody text\n",
  );
  assert.equal(p.ok, true);
  if (p.ok) {
    assert.equal(p.skill.name, "xy-tool");
    assert.equal(p.skill.description, "Tunes things");
    assert.deepEqual(p.skill.tokens, { name: "xy tool", description: "tune thing", headings: "titl here", body: "titl here bodi text" });
    assert.equal("frontmatter" in p.skill, false);
    assert.equal("headings" in p.skill, false);
  }
});

test("quoted whitespace-only skill fields are missing", () => {
  assert.deepEqual(parseSkillMd("---\nname: '  '\ndescription: valid\n---\n"), { ok: false, reason: "missing name" });
  assert.deepEqual(parseSkillMd("---\nname: valid\ndescription: '  '\n---\n"), { ok: false, reason: "missing description" });
});

test("skill fields retain normalized Unicode tokens", () => {
  const parsed = parseSkillMd("---\nname: guide\ndescription: pieturzīmes हिन्दी 資料\n---\n# 火\n");
  assert.ok(parsed.ok);
  assert.equal(parsed.skill.tokens.description, "pieturzīmes हिन्दी 資料");
  assert.equal(parsed.skill.tokens.headings, "火");
});

test("splitSkillMd handles CRLF and a BOM, and returns the body unchanged", () => {
  const s = splitSkillMd("﻿---\r\nname: x\r\ndescription: y\r\n---\r\nbody \u001b[31mred\u001b[0m\r\n");
  assert.equal(s.rawFrontmatter, "name: x\r\ndescription: y");
  assert.equal(s.body, "body \u001b[31mred\u001b[0m\r\n");
});

test("splitSkillMd retains bodies without valid frontmatter delimiters", () => {
  for (const body of [
    "paragraph\uFEFF\n---\nname: x\n---\nbody",
    "paragraph\n---\n---\nbody",
    "---junk\nname: x\n---\nbody",
    "---\nname: x\n---junk",
    "---junk\n---",
  ]) {
    assert.deepEqual(splitSkillMd(body), { rawFrontmatter: null, body });
  }
});

test("splitSkillMd accepts whitespace on delimiters at EOF", () => {
  assert.deepEqual(splitSkillMd("--- \t\nname: x\n--- \t"), { rawFrontmatter: "name: x", body: "" });
  assert.deepEqual(splitSkillMd("--- \t\n--- \t"), { rawFrontmatter: "", body: "" });
});

test("headings skip fenced code blocks", () => {
  const body = "# One\ntext\n```sh\n# not a heading\n```\n## Two ##\n";
  assert.deepEqual(extractHeadings(body), ["One", "Two"]);
});

test("headings require a heading marker at up to three spaces of indentation", () => {
  assert.deepEqual(extractHeadings("text # inline\n   ##   Indented heading ###\n    # too deep"), ["Indented heading"]);
});

for (const marker of ["`", "~"]) {
  const other = marker === "`" ? "~" : "`";
  for (const [name, inside, closer] of [
    ["shorter run", marker.repeat(3), marker.repeat(4)],
    ["opposite marker", other.repeat(4), marker.repeat(4)],
    ["suffix text", `${marker.repeat(4)} suffix`, marker.repeat(4)],
    ["longer closer with whitespace", marker.repeat(3), `   ${marker.repeat(5)} \t`],
  ]) {
    test(`headings: ${marker} fence ignores ${name}`, () => {
      assert.deepEqual(extractHeadings(`${marker.repeat(4)}info\n${inside}\n# hidden\n${closer}\n# visible`), ["visible"]);
    });
  }
  test(`headings: unclosed ${marker} fence hides the rest`, () => {
    assert.deepEqual(extractHeadings(`   ${marker.repeat(3)} language\n# hidden`), []);
  });
}

test("headings: a backtick in a backtick opener info string prevents opening", () => {
  assert.deepEqual(extractHeadings("```lang`extra\n# visible"), ["visible"]);
});

for (const marker of ["`", "~"]) {
  test(`headings: ${marker} fence accepts info and an equal closer with whitespace`, () => {
    assert.deepEqual(extractHeadings(`   ${marker.repeat(3)} language info\n# hidden\n${marker.repeat(3)} \t\n# visible`), ["visible"]);
  });
  test(`headings: four leading spaces do not open a ${marker} fence`, () => {
    assert.deepEqual(extractHeadings(`    ${marker.repeat(3)} language\n# visible`), ["visible"]);
  });
}

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

test("local rules: a symlink cycle terminates", async (t) => {
  const root = await tmp("mg-cycle-");
  await writeSkill(path.join(root, "a"), "inner", "x");
  await link(root, path.join(root, "a", "back-to-root"));
  await link(path.join(root, "a"), path.join(root, "b"));
  const real = fsp.realpath;
  let observations = 0;
  mock.method(fsp, "realpath", ((p: string, ...args: unknown[]) => {
    if ((p === root || p.startsWith(root + path.sep)) && ++observations > 20) throw new Error("cycle observation budget exceeded");
    return (real as (...a: unknown[]) => unknown)(p, ...args);
  }) as typeof fsp.realpath);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const r = await scanSource(root, { followSymlinks: true, strict: true });
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ["inner"],
  );
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.duplicates, []);
});

test("a duplicate name inside one source keeps the first and warns", async (t) => {
  const root = await tmp();
  await mkdir(path.join(root, "a"), { recursive: true });
  await mkdir(path.join(root, "b"), { recursive: true });
  await writeFile(path.join(root, "a", "SKILL.md"), skillMd("z-name", "first"));
  await writeFile(path.join(root, "b", "SKILL.md"), skillMd("z-name", "second"));
  await mkdir(path.join(root, "c"));
  await mkdir(path.join(root, "d"));
  await writeFile(path.join(root, "c", "SKILL.md"), skillMd("a-name", "first"));
  await writeFile(path.join(root, "d", "SKILL.md"), skillMd("a-name", "second"));
  const real = fsp.readdir;
  mock.method(fsp, "readdir", (async (p: string, ...args: unknown[]) => {
    const entries = await (real as (...a: unknown[]) => Promise<{ name: string }[]>)(p, ...args);
    return p === root ? entries.sort((a, b) => (a.name < b.name ? 1 : -1)) : entries;
  }) as typeof fsp.readdir);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const r = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    r.skills.map((s) => [s.name, s.description]),
    [
      ["a-name", "first"],
      ["z-name", "first"],
    ],
  );
  assert.deepEqual(r.duplicates, ["a-name", "z-name"]);
  assert.match(r.warnings[0] ?? "", /duplicate skill name "z-name"/u);
  assert.match(r.warnings[1] ?? "", /duplicate skill name "a-name"/u);
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

test("a SKILL.md that is a FIFO is skipped without blocking, and a regular one beside it is read", { timeout: 10_000 }, async (t) => {
  const root = await tmp();
  await mkdir(path.join(root, "fifo-skill"));
  const fifo = path.join(root, "fifo-skill", "SKILL.md");
  await mkfifo(fifo);
  t.after(() => releaseFifo(fifo));
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
    assert.equal((await scanSource(root, { followSymlinks, strict: true })).skills.length, 1);
  }
});

test("a directory that vanishes between the listing and the walk is skipped", async (t) => {
  const root = await tmp();
  await writeSkill(root, "good", "a good skill");
  await writeSkill(path.join(root, "ghost"), "hidden", "unread");
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

test("strict scans ignore ordinary files at the source root", async (t) => {
  const root = await tmp();
  await writeSkill(root, "good", "a good skill");
  const file = path.join(root, "ordinary.txt");
  await writeFile(file, "ordinary");
  const real = fsp.stat;
  mock.method(fsp, "stat", ((p: string, ...args: unknown[]) => {
    if (p === file) throw new Error("ordinary file was inspected");
    return (real as (...a: unknown[]) => unknown)(p, ...args);
  }) as typeof fsp.stat);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await scanSource(root, { followSymlinks: false, strict: true });
  assert.deepEqual(
    result.skills.map((s) => s.name),
    ["good"],
  );
  assert.deepEqual(result.warnings, []);
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

test("manifests fingerprint sorted paths and binary bytes", async (t) => {
  const root = await fsp.realpath(await tmp());
  const dir = await writeSkill(root, "asset", "asset skill");
  const scan = async () => (await scanSource(root, { followSymlinks: false, strict: true })).skills[0]!;
  const before = await scan();
  await mkdir(path.join(dir, "references"));
  await mkdir(path.join(dir, ".Git"));
  await writeFile(path.join(dir, ".Git", "config"), "hidden");
  await link(path.join(dir, "SKILL.md"), path.join(dir, "alias.md"));
  await writeFile(path.join(dir, "references", "z.bin"), Buffer.from([0, 255, 1]));
  await writeFile(path.join(dir, "references", "a.bin"), Buffer.from([1, 2]));
  const realOpen = fsp.open;
  let skillOpens = 0;
  let skillHandle: Awaited<ReturnType<typeof realOpen>> | undefined;
  mock.method(fsp, "open", async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args);
    if (args[0] === path.join(dir, "SKILL.md")) {
      skillOpens++;
      skillHandle = handle;
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (skillHandle && skillHandle.fd !== -1) await skillHandle.close();
  });
  const first = await scan();
  assert.equal(skillOpens, 1);
  assert.ok(skillHandle);
  assert.equal(skillHandle.fd, -1);
  mock.restoreAll();
  syncBuiltinESMExports();
  assert.notEqual(first.revision, before.revision);
  assert.deepEqual(
    first.manifest.map((e) => e.path),
    ["SKILL.md", "references/a.bin", "references/z.bin"],
  );
  assert.equal(first.manifest[2]?.size, 3);
  const tuples = [
    ["SKILL.md", Buffer.from(skillMd("asset", "asset skill"))],
    ["references/a.bin", Buffer.from([1, 2])],
    ["references/z.bin", Buffer.from([0, 255, 1])],
  ] as const;
  const expected = tuples.map(([name, bytes]) => [name, `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes.length]);
  assert.equal(first.revision, `sha256:${createHash("sha256").update(JSON.stringify(expected)).digest("hex")}`);
  assert.match(first.manifest[2]?.digest ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    first.manifest[2]?.digest,
    `sha256:${createHash("sha256")
      .update(Buffer.from([0, 255, 1]))
      .digest("hex")}`,
  );
  assert.equal((await scan()).revision, first.revision);
  await writeFile(path.join(dir, "references", "z.bin"), Buffer.from([0, 255, 2]));
  const changed = await scan();
  assert.notEqual(changed.revision, first.revision);
  assert.notEqual(changed.manifest[2]?.digest, first.manifest[2]?.digest);
  await fsp.rename(path.join(dir, "references", "a.bin"), path.join(dir, "references", "b.bin"));
  const renamed = await scan();
  assert.deepEqual(
    renamed.manifest.map((e) => e.path),
    ["SKILL.md", "references/b.bin", "references/z.bin"],
  );
  assert.notEqual(renamed.revision, changed.revision);
  await fsp.rm(path.join(dir, "references", "z.bin"));
  const removed = await scan();
  assert.deepEqual(
    removed.manifest.map((e) => e.path),
    ["SKILL.md", "references/b.bin"],
  );
  assert.notEqual(removed.revision, renamed.revision);
});

test("manifest listing errors propagate or skip the skill", async (t) => {
  const root = await fsp.realpath(await tmp());
  const dir = await writeSkill(root, "good", "skill");
  const references = path.join(dir, "references");
  await mkdir(references);
  const denied = Object.assign(new Error("nested listing denied"), { code: "EACCES" });
  const real = fsp.readdir;
  mock.method(fsp, "readdir", ((p: string, ...args: unknown[]) =>
    p === references ? Promise.reject(denied) : (real as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.readdir);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(scanSource(root, { followSymlinks: false, strict: true }), (err) => err === denied);
  const result = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(result.skills, []);
  assert.match(result.warnings[0] ?? "", /skipped .*SKILL\.md: nested listing denied/u);
});

test("a reference missing after listing propagates its original error", async (t) => {
  const root = await fsp.realpath(await tmp());
  const dir = await writeSkill(root, "good", "skill");
  const reference = path.join(dir, "reference.txt");
  await writeFile(reference, "reference");
  const missing = Object.assign(new Error("reference disappeared"), { code: "ENOENT" });
  const real = fsp.realpath;
  mock.method(fsp, "realpath", ((p: string, ...args: unknown[]) =>
    p === reference ? Promise.reject(missing) : (real as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.realpath);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(scanSource(root, { followSymlinks: false, strict: true }), (err) => err === missing);
});

test("a reference whose canonical path changes is rejected", async (t) => {
  const root = await fsp.realpath(await tmp());
  const dir = await writeSkill(root, "good", "skill");
  const reference = path.join(dir, "reference.txt");
  const other = path.join(dir, "other.txt");
  await writeFile(reference, "reference");
  await writeFile(other, "other");
  const real = fsp.realpath;
  mock.method(fsp, "realpath", ((p: string, ...args: unknown[]) =>
    p === reference ? Promise.resolve(other) : (real as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.realpath);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(scanSource(root, { followSymlinks: false, strict: true }), /file path changed during manifest construction/u);
});

test("strict scans propagate directory, symlink, and skill read errors", async (t) => {
  const root = await tmp();
  const dir = await writeSkill(root, "good", "skill");
  const child = path.join(root, "child");
  await mkdir(child);
  const alias = path.join(root, "alias");
  await link(child, alias);
  const denied = Object.assign(new Error("injected access failure"), { code: "EACCES" });
  const actualReadDir = fsp.readdir;
  mock.method(fsp, "readdir", ((p: string, ...args: unknown[]) =>
    p === root ? Promise.reject(denied) : (actualReadDir as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.readdir);
  syncBuiltinESMExports();
  await assert.rejects(scanSource(root, { followSymlinks: false, strict: true }), /injected access failure/u);
  mock.restoreAll();
  syncBuiltinESMExports();
  const real = fsp.realpath;
  mock.method(fsp, "realpath", ((p: string, ...args: unknown[]) =>
    p === child ? Promise.reject(denied) : (real as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.realpath);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(scanSource(root, { followSymlinks: false, strict: true }), /injected access failure/u);
  mock.restoreAll();
  syncBuiltinESMExports();
  const actualStat = fsp.stat;
  mock.method(fsp, "stat", ((p: string, ...args: unknown[]) =>
    p === alias ? Promise.reject(denied) : (actualStat as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.stat);
  syncBuiltinESMExports();
  for (const followSymlinks of [false, true])
    await assert.rejects(scanSource(root, { followSymlinks, strict: true }), /injected access failure/u);
  mock.restoreAll();
  syncBuiltinESMExports();
  const actualOpen = fsp.open;
  mock.method(fsp, "open", ((p: string, ...args: unknown[]) =>
    p === path.join(dir, "SKILL.md")
      ? Promise.reject(denied)
      : (actualOpen as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.open);
  syncBuiltinESMExports();
  await assert.rejects(scanSource(root, { followSymlinks: false, strict: true }), /injected access failure/u);
});

test("a skill file removed during enumeration aborts its manifest", async (t) => {
  const root = await tmp();
  const dir = await writeSkill(root, "good", "skill");
  await writeFile(path.join(dir, "reference.txt"), "reference");
  const actual = fsp.readdir;
  let reads = 0;
  mock.method(fsp, "readdir", (async (p: string, ...args: unknown[]) => {
    const entries = await (actual as (...a: unknown[]) => Promise<{ name: string }[]>)(p, ...args);
    if (p === dir && ++reads === 2) return entries.filter((entry) => entry.name !== "SKILL.md");
    return entries;
  }) as typeof fsp.readdir);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(scanSource(root, { followSymlinks: false, strict: true }), /disappeared during manifest/u);
  reads = 0;
  const result = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(result.skills, []);
  assert.match(result.warnings[0] ?? "", /disappeared during manifest/u);
});
