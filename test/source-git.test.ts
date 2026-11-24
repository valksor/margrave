import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkRef, parseSpec, sanitizeId, installSource, updateSources } from "../src/sources.ts";
import {
  checkId,
  git as sourceGit,
  gitClone,
  installedRef,
  localId,
  qualifiedRef,
  remoteRefs,
  trackingRef,
  validateGitRef,
  validateUpdateRef,
  validateUpdateRefSyntax,
} from "../src/source-git.ts";
import type { SourceRecord } from "../src/store-files.ts";
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

test("source Git direct validates IDs and refs", () => {
  for (const id of ["a", "a-b_C.9", "-valid-"]) assert.equal(checkId(id), id);
  for (const id of ["", ".", "..", "bad/name", "bad name"]) {
    assert.throws(() => checkId(id), { name: "Error", message: `cannot derive a valid source id (got "${id}")` });
  }
  for (const ref of ["", "--synthetic-option"]) {
    assert.throws(() => checkRef(ref), { message: `refused --ref "${ref}": must not be empty or start with "-"` });
  }
  assert.equal(checkRef("branch-"), "branch-");
});

test("source Git direct reports exact malformed specs", () => {
  const shape = (spec: string) =>
    `unrecognized source "${spec}": use owner/repo, a git URL (https://, git@, file://), or a path starting with ./ ../ / or ~`;
  const chars = (spec: string) => `unrecognized source "${spec}": use owner/repo[/sub/path] with letters, digits, ".", "_", "-"`;
  for (const [spec, message] of [
    ["", "source spec is empty"],
    ["--synthetic-option", 'refused spec "--synthetic-option": must not start with "-"'],
    ["~someone/repo", 'unsupported spec "~someone/repo": only ~ and ~/path are expanded'],
    ["owner//repo", shape("owner//repo")],
    ["single", shape("single")],
    ["owner/repo/..", 'refused spec "owner/repo/..": ".." is not allowed'],
    ["owner/repo/.", chars("owner/repo/.")],
    ["owner/bad name", chars("owner/bad name")],
    ["owner/.git", 'unrecognized source "owner/.git"'],
    ["owner/git@host:repo", chars("owner/git@host:repo")],
    ["owner/https://host/repo", shape("owner/https://host/repo")],
  ] as const)
    assert.throws(() => parseSpec(spec), { message });
});

test("source Git direct parses URL and shorthand boundaries", () => {
  for (const [url, id] of [
    ["https://example.test/repo.git///", "example.test__repo"],
    ["git@example.test:repo.git///", "example.test__repo"],
    ["https://example.test", "example.test"],
    ["https://example.test/repo.git \n", "example.test__repo"],
  ] as const)
    assert.deepEqual(parseSpec(url), { kind: "git", url, subpath: "", id });
  assert.deepEqual(parseSpec("owner/repo-///"), {
    kind: "git",
    url: "https://github.com/owner/repo-.git",
    subpath: "",
    id: "owner__repo-",
  });
  for (const spec of ["git@:bad/git@good:repo", "git@host:repo\nmore"]) {
    assert.throws(() => parseSpec(spec), { message: `cannot parse git URL "${spec}"` });
  }
});

test("source Git direct recognizes only leading qualified refs", () => {
  for (const ref of ["refs/heads/main", "refs/tags/v1"]) assert.equal(qualifiedRef(ref), true);
  for (const ref of [null, "main", "refs/remotes/main", "prefix/refs/heads/main"]) assert.equal(qualifiedRef(ref), false);
});

type GitResult = { stdout?: string; stderr?: string; error?: Error; throws?: Error };
type GitOptions = { encoding: string; maxBuffer: number; env: NodeJS.ProcessEnv };
type GitCallback = (error: Error | null, stdout: string, stderr: string) => void;

async function withSyntheticGit(
  t: import("node:test").TestContext,
  results: GitResult[],
  run: (calls: string[][]) => Promise<void>,
): Promise<void> {
  const calls: string[][] = [];
  const previousMarker = process.env["SOURCE_GIT_TEST_MARKER"];
  process.env["SOURCE_GIT_TEST_MARKER"] = "inherited-synthetic-marker";
  const mock = t.mock.method(childProcess, "execFile", ((
    file: string,
    args: string[],
    options: GitOptions,
    callback: GitCallback,
  ): ChildProcess => {
    assert.equal(file, "git");
    assert.equal(options.encoding, "utf8");
    assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    assert.equal(options.env["GIT_ALLOW_PROTOCOL"], "https:ssh:git:file");
    assert.equal(options.env["GIT_TERMINAL_PROMPT"], "0");
    assert.equal(options.env["SOURCE_GIT_TEST_MARKER"], "inherited-synthetic-marker");
    calls.push(args);
    const result = results.shift();
    assert.ok(result, "unexpected git invocation");
    if (result.throws) throw result.throws;
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? "", result.stderr ?? ""));
    return new ChildProcess();
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(calls),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("synthetic Git calls did not settle within 500 ms")), 500);
      }),
    ]);
    assert.equal(results.length, 0, "unused synthetic git results");
  } finally {
    clearTimeout(timer);
    mock.mock.restore();
    syncBuiltinESMExports();
    if (previousMarker === undefined) delete process.env["SOURCE_GIT_TEST_MARKER"];
    else process.env["SOURCE_GIT_TEST_MARKER"] = previousMarker;
  }
}

const directSource: SourceRecord = {
  id: "synthetic",
  kind: "git",
  spec: "synthetic",
  url: "https://example.test/repo",
  subpath: "",
  ref: "refs/tags/v1",
  commit: null,
  installedAt: "synthetic",
};

test("source Git direct executes and reports process failures", async (t) => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const failed = Object.assign(new Error("fallback error"), { code: 2 });
  const sync = new Error("synchronous failure");
  await withSyntheticGit(
    t,
    [
      { stdout: " output \n" },
      { error: missing },
      { error: failed, stderr: "  detail \n" },
      { error: failed, stderr: " \n" },
      { throws: sync },
    ],
    async (calls) => {
      assert.equal(await sourceGit(["status", "--short"]), " output \n");
      await assert.rejects(sourceGit(["one"]), { message: "git was not found on PATH (command: git one)", cause: missing });
      await assert.rejects(sourceGit(["two"]), { message: "command failed: git two\ndetail", cause: failed });
      await assert.rejects(sourceGit(["three"]), { message: "command failed: git three\nfallback error", cause: failed });
      await assert.rejects(sourceGit(["four"]), (err: unknown) => err === sync);
      assert.deepEqual(calls, [["status", "--short"], ["one"], ["two"], ["three"], ["four"]]);
    },
  );
});

test("source Git direct clones short and qualified refs", async (t) => {
  const url = "https://example.test/repo";
  const dest = "/synthetic/clone";
  for (const ref of [null, "branch", "refs/heads/main", "refs/tags/v1"]) {
    const qualified = ref !== null && ref.startsWith("refs/");
    const expected = [["clone", "--depth", "1", ...(ref !== null && !qualified ? ["--branch", ref] : []), "--", url, dest]];
    if (qualified) expected.push(["-C", dest, "fetch", "--depth", "1", "origin", ref], ["-C", dest, "checkout", "--detach", "FETCH_HEAD"]);
    expected.push(["-C", dest, "rev-parse", "HEAD"]);
    await withSyntheticGit(
      t,
      expected.map((_, i) => ({ stdout: i === expected.length - 1 ? "  abc123 \n" : "" })),
      async (calls) => {
        assert.equal(await gitClone(url, ref, dest), "abc123");
        assert.deepEqual(calls, expected);
      },
    );
  }
});

test("source Git direct resolves installed refs", async (t) => {
  await withSyntheticGit(
    t,
    [{ stdout: " refs/heads/main \n" }, { stdout: " refs/heads/branch \n" }, { error: new Error("detached") }],
    async (calls) => {
      assert.equal(await installedRef("/clone", null), "refs/heads/main");
      assert.equal(await installedRef("/clone", "refs/tags/v1"), "refs/tags/v1");
      assert.equal(await installedRef("/clone", "branch"), "refs/heads/branch");
      assert.equal(await installedRef("/clone", "v1"), "refs/tags/v1");
      assert.deepEqual(calls, [
        ["-C", "/clone", "symbolic-ref", "HEAD"],
        ["-C", "/clone", "symbolic-ref", "-q", "HEAD"],
        ["-C", "/clone", "symbolic-ref", "-q", "HEAD"],
      ]);
    },
  );
});

test("source Git direct validates update refs and process errors", async (t) => {
  const invalid = Object.assign(new Error("bad ref"), { code: 1 });
  const other = Object.assign(new Error("other failure"), { code: 2 });
  const sync = Object.assign(new Error("sync failure"), { code: 1 });
  const noCause = new MargraveError("no cause");
  const message = "update --ref requires a fully qualified Git branch or tag";
  await withSyntheticGit(
    t,
    [{}, { error: invalid }, {}, { error: invalid }, { error: invalid }, { error: other }, { throws: sync }, { throws: noCause }],
    async (calls) => {
      await validateUpdateRef(null, undefined);
      await assert.rejects(validateUpdateRef("refs/heads/main", undefined), { message: "update --ref requires one Git source" });
      await assert.rejects(validateUpdateRef("refs/heads/main", { ...directSource, kind: "local" }), {
        message: "update --ref requires one Git source",
      });
      await validateUpdateRef("refs/heads/main", directSource);
      await assert.rejects(validateUpdateRefSyntax("short"), { message });
      await assert.rejects(validateUpdateRefSyntax("refs/heads/bad..ref"), { message });
      await validateUpdateRefSyntax("refs/tags/good");
      await assert.rejects(validateGitRef("bad"), { message: "command failed: git check-ref-format bad\nbad ref" });
      await assert.rejects(validateGitRef("bad-custom", "custom message"), { message: "custom message" });
      await assert.rejects(validateGitRef("other"), { message: "command failed: git check-ref-format other\nother failure", cause: other });
      await assert.rejects(validateGitRef("sync"), (err: unknown) => err === sync);
      await assert.rejects(validateGitRef("no-cause"), (err: unknown) => err === noCause);
      assert.deepEqual(
        calls,
        ["refs/heads/main", "refs/heads/bad..ref", "refs/tags/good", "bad", "bad-custom", "other", "sync", "no-cause"].map((ref) => [
          "check-ref-format",
          ref,
        ]),
      );
    },
  );
});

test("source Git direct reads remote and tracking refs", async (t) => {
  const url = "https://example.test/repo";
  const ref = "refs/tags/v1";
  const query = ["ls-remote", "--", url, ref, `${ref}^{}`];
  await withSyntheticGit(
    t,
    [
      { stdout: `base\t${ref}\npeeled\t${ref}^{}\nignored\trefs/tags/other\nmalformed\n` },
      { stdout: "" },
      { stdout: `peeled\t${ref}^{}\n` },
      { error: new Error("remote failure") },
      {},
      { stdout: `  sha\t${ref} \n` },
      {},
      { stdout: "" },
    ],
    async (calls) => {
      assert.deepEqual(await remoteRefs(url, ref), new Map([[ref, "peeled"]]));
      assert.deepEqual(await remoteRefs(url, ref), new Map());
      assert.deepEqual(await remoteRefs(url, ref), new Map());
      await assert.rejects(remoteRefs(url, ref), { message: "cannot read remote tracking ref" });
      assert.equal(await trackingRef(directSource), "sha");
      await assert.rejects(trackingRef(directSource), { message: "remote tracking ref was not found" });
      assert.deepEqual(calls, [query, query, query, query, ["check-ref-format", ref], query, ["check-ref-format", ref], query]);
    },
  );
});
