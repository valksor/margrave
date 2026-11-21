import assert from "node:assert/strict";
import { constants } from "node:fs";
import fsp, { mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock } from "node:test";
import { MargraveError } from "../src/store.ts";
import { readSkillFileBytes } from "../src/skill-files.ts";
import { listFiles, loadSkill, readSkillFile } from "../src/skills.ts";
import type { IndexEntry } from "../src/store.ts";
import { link, mkfifo, releaseFifo, tmp, writeSkill } from "./helpers.ts";

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
    revision: "h",
    manifest: "[]",
    frontmatter: "",
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
    revision: "h",
    manifest: "[]",
    frontmatter: "",
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

test("readSkillFile refuses a FIFO without blocking, and reads a regular file beside it", { timeout: 10_000 }, async (t) => {
  const dir = await writeSkill(await tmp(), "fifo-dir", "a skill");
  const fifo = path.join(dir, "pipe.md");
  await mkfifo(fifo);
  t.after(() => releaseFifo(fifo));
  await writeFile(path.join(dir, "ref.md"), "regular\n");
  const realFifo = await fsp.realpath(fifo);
  const originalOpen = fsp.open;
  mock.method(fsp, "open", (async (p: Parameters<typeof fsp.open>[0], flags: number, mode?: Parameters<typeof fsp.open>[2]) => {
    if (p === realFifo) {
      assert.ok(flags & constants.O_NONBLOCK);
      assert.ok(flags & constants.O_NOFOLLOW);
    }
    return originalOpen(p, flags, mode);
  }) as typeof fsp.open);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(readSkillFile(dir, "pipe.md"), /not a file: pipe\.md/u);
  assert.equal(await readSkillFile(dir, "ref.md"), "regular\n");
});

test("listFiles of a directory that cannot be read is an empty list", async () => {
  const missing = path.join(await tmp(), "does-not-exist");
  assert.deepEqual(await listFiles(missing), []);
  await assert.rejects(listFiles(missing, true), { code: "ENOENT" });
});

test("listFiles skips metadata and symlinks and sorts regular files", async (t) => {
  const dir = await tmp();
  for (const name of ["dir", ".GiT", "node_modules"]) await mkdir(path.join(dir, name));
  for (const name of ["z.md", "a.md", "dir/b.md", ".GiT/hidden", "node_modules/hidden"]) await writeFile(path.join(dir, name), "x");
  await link(path.join(dir, "z.md"), path.join(dir, "alias.md"));

  const original = fsp.readdir;
  mock.method(fsp, "readdir", (async (p: string, ...args: unknown[]) => {
    const entries = await (original as (...a: unknown[]) => Promise<{ name: string }[]>)(p, ...args);
    return p === dir ? entries.sort((a, b) => (a.name < b.name ? 1 : -1)) : entries;
  }) as typeof fsp.readdir);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.deepEqual(await listFiles(dir), ["a.md", "dir/b.md", "z.md"]);
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
    revision: "h",
    manifest: "[]",
    frontmatter: "",
  };
  const r = await loadSkill(entry, []);
  assert.equal(r.frontmatter, "");
  assert.equal(r.body, "# plain\n\nno frontmatter here\n");
  assert.equal(r.spec, "");
  assert.equal(r.commit, null);
});

test("byte reads preserve missing, access, and canonical path failures", async (t) => {
  const root = await tmp();
  const dir = await writeSkill(root, "skill", "test");
  const ref = path.join(dir, "ref.md");
  await writeFile(ref, "inside");
  await link(ref, path.join(dir, "alias.md"));
  await assert.rejects(readSkillFileBytes(dir, ""), { message: "path is empty" });
  await assert.rejects(readSkillFileBytes(dir, "ref\u0000.md"), { message: "no such file in the skill directory: ref.md" });
  assert.deepEqual(await readSkillFileBytes(dir, "ref.md", true, true), Buffer.from("inside"));
  await assert.rejects(readSkillFileBytes(dir, "alias.md", true, true), /path changed/u);
  await assert.rejects(readSkillFileBytes(dir, "missing", true), /ENOENT/u);
  await assert.rejects(readSkillFileBytes(path.join(root, "missing"), "x", true), /ENOENT/u);
  const original = fsp.realpath;
  const denied = Object.assign(new Error("injected denial"), { code: "EACCES" });
  mock.method(fsp, "realpath", ((p: string, ...args: unknown[]) =>
    p === dir || p === ref ? Promise.reject(denied) : (original as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.realpath);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(readSkillFileBytes(dir, "ref.md", true), /injected denial/u);
  await assert.rejects(readSkillFileBytes(dir, "ref.md"), { code: "EACCES" });
  mock.restoreAll();
  syncBuiltinESMExports();
  mock.method(fsp, "realpath", ((p: string, ...args: unknown[]) =>
    p === ref ? Promise.reject(denied) : (original as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.realpath);
  syncBuiltinESMExports();
  await assert.rejects(readSkillFileBytes(dir, "ref.md", true), /injected denial/u);
  await assert.rejects(readSkillFileBytes(dir, "ref.md"), { code: "EACCES" });
});

test("bounded skill reads accept the exact size and reject larger files", async (t) => {
  const dir = await tmp();
  const file = path.join(dir, "ref.md");
  const bytes = Buffer.from([0, 1, 2, 3]);
  await writeFile(file, bytes);
  const realFile = await fsp.realpath(file);
  const originalOpen = fsp.open;
  const reads: [number, number][][] = [];
  const closes: boolean[] = [];
  let grow = false;
  let failRead = false;
  const readError = new Error("injected read failure");
  mock.method(fsp, "open", (async (p: Parameters<typeof fsp.open>[0], flags: number, mode?: Parameters<typeof fsp.open>[2]) => {
    const handle = await originalOpen(p, flags, mode);
    if (p !== realFile) return handle;
    const calls: [number, number][] = [];
    reads.push(calls);
    const index = closes.push(false) - 1;
    const originalRead = handle.read.bind(handle);
    const originalClose = handle.close.bind(handle);
    const originalStat = handle.stat.bind(handle);
    t.mock.method(handle, "read", (async (buffer: Buffer, offset: number, length: number, position: null) => {
      calls.push([offset, length]);
      assert.ok(calls.length <= 5, "read budget exceeded");
      if (failRead) throw readError;
      return originalRead(buffer, offset, Math.min(length, 2), position);
    }) as typeof handle.read);
    t.mock.method(handle, "close", async () => {
      closes[index] = true;
      await originalClose();
    });
    t.mock.method(handle, "stat", (async (...args: Parameters<typeof handle.stat>) => {
      const result = await originalStat(...args);
      if (grow) await fsp.appendFile(file, "x");
      return result;
    }) as typeof handle.stat);
    return handle;
  }) as typeof fsp.open);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  await assert.rejects(readSkillFileBytes(dir, "ref.md", false, false, 3), {
    message: "skill file exceeds the hosted size limit",
  });
  assert.deepEqual(reads[0], []);
  assert.equal(closes[0], true);
  assert.deepEqual(await readSkillFileBytes(dir, "ref.md", false, false, 5), bytes);
  assert.deepEqual(reads[1], [
    [0, 6],
    [2, 4],
    [4, 2],
  ]);
  assert.equal(closes[1], true);
  assert.deepEqual(await readSkillFileBytes(dir, "ref.md", false, false, 4), bytes);
  assert.deepEqual(reads[2], [
    [0, 5],
    [2, 3],
    [4, 1],
  ]);
  assert.equal(closes[2], true);

  failRead = true;
  await assert.rejects(readSkillFileBytes(dir, "ref.md", false, false, 4), (err) => err === readError);
  assert.equal(closes[3], true);
  failRead = false;
  grow = true;
  await assert.rejects(readSkillFileBytes(dir, "ref.md", false, false, 4), {
    message: "skill file exceeds the hosted size limit",
  });
  assert.deepEqual(reads[4], [
    [0, 5],
    [2, 3],
    [4, 1],
  ]);
  assert.equal(closes[4], true);
});
