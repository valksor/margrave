import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkRef, parseSpec, sanitizeId, installSource, updateSources } from "../src/sources.ts";
import { localId } from "../src/source-git.ts";
import { MargraveError, UsageError } from "../src/store.ts";
import {
  git,
  makeRepo,
  tmp,
  writeSkill,
  quiet,
  inStore,
  catalogRecords,
  head,
  writeCatalogRecords,
  cliSetup as setup,
  cliMg as mg,
  cliSnapshot as snapshot,
  names,
  sourceId,
} from "./helpers.ts";
import { chmod, readFile, writeFile } from "node:fs/promises";

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

test("update propagates a missing Git executable for a valid ref", async (t) => {
  await inStore(t, async () => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    process.env["PATH"] = await tmp("mg-empty-path-");
    await assert.rejects(updateSources(id, quiet, "refs/heads/main"), (err: unknown) => {
      assert.ok(err instanceof MargraveError);
      assert.match(err.message, /git was not found on PATH/u);
      return true;
    });
  });
});

test("--ref installs a branch and update keeps it", async () => {
  const env = await setup();
  const repo = await makeRepo();
  await git(repo.dir, "checkout", "-q", "-b", "feature");
  await writeSkill(path.join(repo.dir, "skills"), "only-on-feature", "A skill that lives on the feature branch");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "feature");
  await git(repo.dir, "checkout", "-q", "main");

  const inst = await mg(env, ["install", repo.url, "--ref", "feature"]);
  assert.equal(inst.code, 0, inst.stderr);
  assert.match(inst.stdout, /\(4 skills\)/u);
  const rec = JSON.parse((await snapshot(env.home)).sources ?? "[]") as { ref: string }[];
  assert.equal(rec[0]?.ref, "refs/heads/feature");
  const upd = await mg(env, ["update"]);
  assert.equal(upd.code, 0, upd.stderr);
  assert.match((await mg(env, ["list", "--skills"])).stdout, /only-on-feature/u);

  const bad = await setup();
  const r = await mg(bad, ["install", repo.url, "--ref", "no-such-branch"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git clone/u);
  assert.equal((await snapshot(bad.home)).sources, null);
  assert.equal((await mg(bad, ["install", repo.url, "--ref", "-x"])).code, 2);
  assert.equal((await mg(bad, ["install", repo.url, "--ref", "refs/heads/bad..ref"])).code, 2);
});

test("short tag install records its full ref and peeled commit", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const commit = await head(repo.dir);
  await git(repo.dir, "tag", "-a", "release", "-m", "release");
  const result = await mg(env, ["install", repo.url, "--ref", "release"]);
  assert.equal(result.code, 0, result.stderr);
  const records = catalogRecords(env.home);
  assert.equal(records[0]?.ref, "refs/tags/release");
  assert.equal(records[0]?.commit, commit);
});

test("stored short refs are rejected while short install refs remain supported", async () => {
  const env = await setup();
  const repo = await makeRepo();
  await git(repo.dir, "branch", "legacy");
  const inst = await mg(env, ["install", repo.url, "--ref", "legacy"]);
  assert.equal(inst.code, 0, inst.stderr);
  const id = sourceId(inst);
  const records = catalogRecords(env.home);
  assert.equal(records[0]?.ref, "refs/heads/legacy");
  records[0].ref = "legacy";
  writeCatalogRecords(env.home, records);
  const before = await readFile(path.join(env.home, "index.db"));
  for (const args of [["check", id], ["update", id], ["reindex"], ["lock", "export"]]) {
    const result = await mg(env, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /malformed/u);
  }
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
});

test("install of a git source without git on PATH, and with a git that fails silently", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const none = await mg(env, ["install", repo.url], { PATH: await tmp("mg-emptybin-") });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /git was not found on PATH \(command: git clone /u);

  // A git that exits 1 and says nothing: the message falls back to the error's own text, which ends in a newline.
  const bin = await tmp("mg-fakegit-");
  await writeFile(path.join(bin, "git"), "#!/bin/sh\nexit 1\n");
  await chmod(path.join(bin, "git"), 0o755);
  const silent = await mg(env, ["install", repo.url], { PATH: `${bin}:${process.env["PATH"] ?? ""}` });
  assert.equal(silent.code, 1);
  assert.match(silent.stderr, /^margrave: command failed: git clone [^\n]*\nCommand failed: git clone [^\n]*\n$/u);
  assert.deepEqual(await names(path.join(env.home, "staging")), []);
});
