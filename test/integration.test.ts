import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { atomicWrite } from "../src/store.ts";
import { resolveScanRoot } from "../src/sources.ts";
import { fakeRipwire, git, head, link, makeRepo, runCli, skillMd, tmp, writeSkill } from "./helpers.ts";
import type { Run } from "./helpers.ts";

interface Env {
  home: string;
  fakeBin: string;
}

async function setup(): Promise<Env> {
  return { home: await tmp("mg-home-"), fakeBin: await fakeRipwire() };
}

const mg = (env: Env, args: string[], extra?: Record<string, string>): Promise<Run> =>
  runCli(args, { home: env.home, fakeBin: env.fakeBin, ...(extra === undefined ? {} : { extra }) });

async function snapshot(home: string): Promise<{ sources: string | null; index: string | null }> {
  const read = (f: string): Promise<string | null> => readFile(path.join(home, f), "utf8").catch(() => null);
  return { sources: await read("sources.json"), index: await read("index.json") };
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).sort();
}

function sourceId(r: Run): string {
  const m = /^installed (\S+) \((\d+) skills\)/mu.exec(r.stdout);
  assert.ok(m?.[1], `no source id in: ${r.stdout}${r.stderr}`);
  return m[1];
}

test("git source via file://: install, duplicate, find, load, update, remove", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const first = await head(repo.dir);

  // install
  const inst = await mg(env, ["install", repo.url]);
  assert.equal(inst.code, 0, inst.stderr);
  const id = sourceId(inst);
  assert.match(inst.stdout, /\(3 skills\)/u);
  for (const n of ["react-perf", "postgres-tuning", "docker-compose"]) assert.ok(inst.stdout.includes(`${id}/${n}`));
  assert.deepEqual(await names(path.join(env.home, "staging")), [], "no staging left");
  const rec = JSON.parse((await snapshot(env.home)).sources ?? "[]") as Record<string, unknown>[];
  assert.equal(rec.length, 1);
  assert.equal(rec[0]?.["kind"], "git");
  assert.equal(rec[0]?.["commit"], first);
  assert.equal(rec[0]?.["url"], repo.url);
  assert.equal(rec[0]?.["ref"], null);

  // duplicate install errors and changes nothing
  const before = await snapshot(env.home);
  const dup = await mg(env, ["install", repo.url]);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already installed/u);
  assert.match(dup.stderr, /margrave update/u);
  assert.match(dup.stderr, /margrave remove/u);
  assert.deepEqual(await snapshot(env.home), before);

  // find ranks the expected skill first
  const find = await mg(env, ["find", "optimize react rendering performance"]);
  assert.equal(find.code, 0, find.stderr);
  assert.match(find.stdout, new RegExp(`^1\\. ${id}/react-perf `, "u"));
  assert.match(find.stdout, new RegExp(`load: margrave load ${id}/react-perf\\n$`, "u"));
  const pg = JSON.parse((await mg(env, ["find", "tune postgresql indexes", "--json", "--limit", "1"])).stdout) as { results: { id: string }[] };
  assert.deepEqual(pg.results.map((r) => r.id), [`${id}/postgres-tuning`]);
  const none = await mg(env, ["find", "kubernetes operators"]);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /^no match\n/u);

  // load prints header and body; a bare name works while it is unique
  const load = await mg(env, ["load", "react-perf"]);
  assert.equal(load.code, 0, load.stderr);
  assert.match(load.stdout, new RegExp(`^skill: ${id}/react-perf\\n`, "u"));
  assert.match(load.stdout, new RegExp(`commit: ${first}\\n`, "u"));
  assert.match(load.stdout, new RegExp(`base: ${path.join(env.home, "sources", id, "skills", "react-perf")}\\n`, "u"));
  assert.match(load.stdout, /frontmatter:\n---\nname: react-perf\ndescription: .*\n---\nfiles:\n- SKILL\.md\nbody:\n# react-perf\n\nBody of react-perf\.\n$/u);
  const loadJson = JSON.parse((await mg(env, ["load", `${id}/react-perf`, "--json"])).stdout) as { commit: string; body: string };
  assert.equal(loadJson.commit, first);
  assert.equal(loadJson.body, "# react-perf\n\nBody of react-perf.\n");
  const file = await mg(env, ["load", `${id}/react-perf`, "--file", "SKILL.md"]);
  assert.equal(file.stdout, skillMd("react-perf", "Optimize React rendering performance and bundle size"));
  const escape = await mg(env, ["load", `${id}/react-perf`, "--file", "../postgres-tuning/SKILL.md"]);
  assert.equal(escape.code, 1);
  assert.match(escape.stderr, /outside/u);

  // upstream commit, then update
  await writeFile(path.join(repo.dir, "skills", "react-perf", "SKILL.md"), skillMd("react-perf", "Optimize React rendering, now with signals"));
  await writeSkill(path.join(repo.dir, "skills"), "vue-perf", "Optimize Vue rendering performance");
  await rm(path.join(repo.dir, "skills", "docker-compose"), { recursive: true });
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "second");
  const second = await head(repo.dir);

  const upd = await mg(env, ["update", id]);
  assert.equal(upd.code, 0, upd.stderr);
  assert.ok(upd.stdout.includes(`${id}: ${first.slice(0, 7)} → ${second.slice(0, 7)}`), upd.stdout);
  assert.ok(upd.stdout.includes(`added: ${id}/vue-perf`));
  assert.ok(upd.stdout.includes(`changed: ${id}/react-perf`));
  assert.ok(upd.stdout.includes(`removed: ${id}/docker-compose`));
  assert.ok(!upd.stdout.includes(`changed: ${id}/postgres-tuning`));
  assert.deepEqual(await names(path.join(env.home, "staging")), [], "no staging left");
  const after = (await mg(env, ["load", `${id}/react-perf`])).stdout;
  assert.match(after, /now with signals/u);
  assert.match(after, new RegExp(`commit: ${second}`, "u"));

  // list
  const list = await mg(env, ["list"]);
  assert.equal(list.stdout.trim(), `${id}  git  ref=-  commit=${second.slice(0, 7)}  skills=3`);
  const listSkills = await mg(env, ["list", "--skills"]);
  assert.ok(listSkills.stdout.includes(`  ${id}/vue-perf: Optimize Vue rendering performance`));

  // update by original spec; nothing changed
  const again = await mg(env, ["update", repo.url]);
  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.stdout.includes(`${second.slice(0, 7)} → ${second.slice(0, 7)}`));
  assert.ok(!again.stdout.includes("changed:"));

  // remove deletes sources/<id> only
  const rm1 = await mg(env, ["remove", id]);
  assert.equal(rm1.code, 0, rm1.stderr);
  assert.deepEqual(await names(path.join(env.home, "sources")), []);
  assert.equal((await snapshot(env.home)).sources?.trim(), "[]");
  const empty = await mg(env, ["find", "react"]);
  assert.equal(empty.stdout.trim(), "no skill sources installed; run: margrave install <owner/repo|path>");
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
  assert.equal(rec[0]?.ref, "feature");
  const upd = await mg(env, ["update"]);
  assert.equal(upd.code, 0, upd.stderr);
  assert.match((await mg(env, ["list", "--skills"])).stdout, /only-on-feature/u);

  const bad = await setup();
  const r = await mg(bad, ["install", repo.url, "--ref", "no-such-branch"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git clone/u);
  assert.equal((await snapshot(bad.home)).sources, null);
  assert.equal((await mg(bad, ["install", repo.url, "--ref", "-x"])).code, 2);
});

test("a failed install leaves no staging, no store dir, and no sources.json change", async () => {
  const env = await setup();
  const repo = await makeRepo();

  // ripwire refuses (CRITICAL)
  const refused = await mg(env, ["install", repo.url], { FAKE_RIPWIRE_EXIT: "2" });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /refused/u);
  assert.match(refused.stderr, /--allow-unsafe/u);
  assert.deepEqual(await names(path.join(env.home, "staging")), []);
  assert.deepEqual(await names(path.join(env.home, "sources")), []);
  assert.deepEqual(await snapshot(env.home), { sources: null, index: null });

  // a repo with no valid skills
  const empty = await tmp("mg-emptyrepo-");
  await git(empty, "init", "-q", "-b", "main");
  await mkdir(path.join(empty, "nope"));
  await writeFile(path.join(empty, "nope", "SKILL.md"), "---\nname: only-name\n---\n");
  await git(empty, "add", "-A");
  await git(empty, "commit", "-q", "-m", "x");
  const none = await mg(env, ["install", `file://${empty}`]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no valid skills/u);
  assert.match(none.stderr, /missing description/u);

  // a repo that does not exist: the error names the git command
  const missing = await mg(env, ["install", "file:///definitely/not/here"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /command failed: git clone/u);
  assert.deepEqual(await names(path.join(env.home, "staging")), []);
  assert.deepEqual(await names(path.join(env.home, "sources")), []);
  assert.deepEqual(await snapshot(env.home), { sources: null, index: null });

  // with a good install in place, another failed install changes nothing
  const ok = await mg(env, ["install", repo.url]);
  assert.equal(ok.code, 0, ok.stderr);
  const before = await snapshot(env.home);
  const other = await makeRepo();
  const fail = await mg(env, ["install", other.url], { FAKE_RIPWIRE_EXIT: "3" });
  assert.equal(fail.code, 1);
  assert.deepEqual(await snapshot(env.home), before);
  assert.deepEqual(await names(path.join(env.home, "staging")), []);
  assert.equal((await names(path.join(env.home, "sources"))).length, 1);

  // --allow-unsafe overrides the refusal for that one install, and says so
  const forced = await mg(env, ["install", other.url, "--allow-unsafe"], { FAKE_RIPWIRE_EXIT: "2" });
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stderr, /--allow-unsafe: overriding refusal/u);
  assert.equal((await names(path.join(env.home, "sources"))).length, 2);
});

test("ripwire WARN (exit 1) prints findings and installs", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const r = await mg(env, ["install", repo.url], { FAKE_RIPWIRE_EXIT: "1" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /ripwire WARN/u);
  assert.match(r.stderr, /fake ripwire: security --scan-skills=/u);
});

test("a failed update leaves the store and sources.json unchanged, and a later update works", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const inst = await mg(env, ["install", repo.url]);
  const id = sourceId(inst);
  const before = await snapshot(env.home);
  const oldFile = await readFile(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"), "utf8");

  await writeFile(path.join(repo.dir, "skills", "react-perf", "SKILL.md"), skillMd("react-perf", "Changed upstream"));
  await writeSkill(path.join(repo.dir, "skills"), "extra", "An extra skill");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "second");

  const fail = await mg(env, ["update", id], { FAKE_RIPWIRE_EXIT: "2" });
  assert.equal(fail.code, 1);
  assert.match(fail.stderr, /refused/u);
  assert.deepEqual(await snapshot(env.home), before);
  assert.equal(await readFile(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"), "utf8"), oldFile);
  await assert.rejects(stat(path.join(env.home, "sources", id, "skills", "extra")));
  assert.deepEqual(await names(path.join(env.home, "staging")), []);
  assert.deepEqual(await names(path.join(env.home, "sources")), [id]);

  const ok = await mg(env, ["update", id]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(ok.stdout.includes(`added: ${id}/extra`));
  assert.ok(ok.stdout.includes(`changed: ${id}/react-perf`));

  // update with no argument keeps going when one source fails, and exits 1
  const both = await mg(env, ["update"], { FAKE_RIPWIRE_EXIT: "2" });
  assert.equal(both.code, 1);
  assert.match(both.stderr, /update .* failed/u);
});

test("local directory source: install, find, load, update, remove leaves the directory", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "ansible-roles", "Write Ansible roles and playbooks");
  await writeSkill(dir, "terraform-modules", "Design reusable Terraform modules");

  const inst = await mg(env, ["install", dir]);
  assert.equal(inst.code, 0, inst.stderr);
  const id = sourceId(inst);
  assert.match(id, /^local__mg-localsrc-.*-[0-9a-f]{6}$/u);
  const rec = JSON.parse((await snapshot(env.home)).sources ?? "[]") as Record<string, unknown>[];
  assert.equal(rec[0]?.["kind"], "local");
  assert.equal(rec[0]?.["path"], dir);
  assert.equal(rec[0]?.["commit"], null);
  assert.deepEqual(await names(path.join(env.home, "sources")), [], "local sources are not copied");

  const dup = await mg(env, ["install", dir]);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already installed/u);
  assert.equal((await mg(env, ["install", dir, "--ref", "main"])).code, 2);

  const find = await mg(env, ["find", "terraform modules"]);
  assert.match(find.stdout, new RegExp(`^1\\. ${id}/terraform-modules `, "u"));
  const load = await mg(env, ["load", "terraform-modules"]);
  assert.equal(load.code, 0, load.stderr);
  assert.match(load.stdout, /commit: none \(local directory\)/u);
  assert.match(load.stdout, new RegExp(`base: ${path.join(dir, "terraform-modules")}\\n`, "u"));

  // change the directory, then update (reindex only)
  await writeFile(path.join(dir, "ansible-roles", "SKILL.md"), skillMd("ansible-roles", "Ansible, now with collections"));
  await writeSkill(dir, "kubectl-debug", "Debug pods with kubectl");
  await rm(path.join(dir, "terraform-modules"), { recursive: true });
  const upd = await mg(env, ["update", dir]);
  assert.equal(upd.code, 0, upd.stderr);
  assert.ok(upd.stdout.includes(`${id}: reindexed`));
  assert.ok(upd.stdout.includes(`added: ${id}/kubectl-debug`));
  assert.ok(upd.stdout.includes(`changed: ${id}/ansible-roles`));
  assert.ok(upd.stdout.includes(`removed: ${id}/terraform-modules`));

  // reindex
  const re = await mg(env, ["reindex"]);
  assert.equal(re.code, 0, re.stderr);
  assert.equal(re.stdout.trim(), "reindexed 2 skills from 1 sources");

  // remove unregisters only
  const rm1 = await mg(env, ["remove", id]);
  assert.equal(rm1.code, 0, rm1.stderr);
  assert.match(rm1.stdout, /unregistered/u);
  assert.deepEqual(await names(dir), ["ansible-roles", "kubectl-debug"], "the local directory is untouched");
  assert.equal(await readFile(path.join(dir, "ansible-roles", "SKILL.md"), "utf8"), skillMd("ansible-roles", "Ansible, now with collections"));
  assert.equal((await snapshot(env.home)).sources?.trim(), "[]");
});

test("remove by original spec for a local source never deletes the directory", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "keep-me", "must survive");
  assert.equal((await mg(env, ["install", dir])).code, 0);
  const r = await mg(env, ["remove", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok((await stat(path.join(dir, "keep-me", "SKILL.md"))).isFile());
});

test("local source: a skill reached through a symlink loads, and --file inside it works", async () => {
  const env = await setup();
  const elsewhere = await tmp("mg-elsewhere-");
  const real = await writeSkill(elsewhere, "linked", "Reached through a symlink");
  await mkdir(path.join(real, "references"));
  await writeFile(path.join(real, "references", "a.md"), "ref a\n");
  const dir = await tmp("mg-localsrc-");
  await link(real, path.join(dir, "via"));

  assert.equal((await mg(env, ["install", dir])).code, 0);
  const load = await mg(env, ["load", "linked"]);
  assert.equal(load.code, 0, load.stderr);
  assert.match(load.stdout, /- references\/a\.md/u);
  assert.equal((await mg(env, ["load", "linked", "--file", "references/a.md"])).stdout, "ref a\n");
});

test("git source: a skill dir that is a symlink out of the clone is skipped", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const outside = await tmp("mg-outside-");
  await writeSkill(outside, "stolen", "lives outside the clone");
  await link(path.join(outside, "stolen"), path.join(repo.dir, "skills", "stolen-link"));
  await mkdir(path.join(repo.dir, "skills", "md-link"));
  await link(path.join(outside, "stolen", "SKILL.md"), path.join(repo.dir, "skills", "md-link", "SKILL.md"));
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "links");

  const r = await mg(env, ["install", repo.url]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\(3 skills\)/u);
  assert.ok(!r.stdout.includes("stolen"));
  assert.match(r.stderr, /warning: skipped symlink .*stolen-link/u);
  assert.match(r.stderr, /warning: skipped .*md-link.*SKILL\.md is a symlink/u);
});

test("usage errors exit 2, unknown commands exit 2, and find/list say when no sources exist", async () => {
  const env = await setup();
  assert.equal((await mg(env, [])).code, 2);
  assert.equal((await mg(env, ["bogus"])).code, 2);
  assert.equal((await mg(env, ["install"])).code, 2);
  assert.equal((await mg(env, ["find", "x", "--bogus"])).code, 2);
  assert.equal((await mg(env, ["install", "-x"])).code, 2);
  assert.equal((await mg(env, ["install", "owner/repo/../x"])).code, 2);
  assert.equal((await mg(env, ["wrap", "nope"])).code, 2);
  const help = await mg(env, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage: margrave/u);

  const msg = "no skill sources installed; run: margrave install <owner/repo|path>";
  assert.equal((await mg(env, ["find", "x"])).stdout.trim(), msg);
  assert.equal((await mg(env, ["list"])).stdout.trim(), msg);
  assert.deepEqual(JSON.parse((await mg(env, ["list", "--json"])).stdout), { sources: [] });
  assert.equal((await mg(env, ["load", "x"])).code, 1);
  assert.equal((await mg(env, ["remove", "x"])).code, 1);
});

test("a malformed index.json is an error that says to run reindex, and reindex repairs it", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill");
  assert.equal((await mg(env, ["install", dir])).code, 0);
  await writeFile(path.join(env.home, "index.json"), "{ broken");
  const r = await mg(env, ["find", "alpha"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /margrave reindex/u);
  assert.equal((await mg(env, ["reindex"])).code, 0);
  assert.equal((await mg(env, ["find", "alpha"])).code, 0);
  await rm(path.join(env.home, "index.json"));
  const missing = await mg(env, ["find", "alpha"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /margrave reindex/u);
});

test("atomic writes leave no temp file and a reader never sees a partial file", async () => {
  const dir = await tmp("mg-atomic-");
  const file = path.join(dir, "index.json");
  const big = (n: number): string => JSON.stringify({ n, pad: "x".repeat(200_000) });
  await atomicWrite(file, big(0));
  let stop = false;
  const writer = (async () => {
    for (let i = 1; i <= 40 && !stop; i++) await atomicWrite(file, big(i));
  })();
  let reads = 0;
  while (!stop) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { n: number };
    assert.equal(typeof parsed.n, "number");
    reads++;
    if (reads > 400) break;
    if (reads % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  stop = true;
  await writer;
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".tmp")), []);
});

test("subpath resolution refuses .., a missing dir, a file, and a symlink out of the clone", async () => {
  const outside = await tmp("mg-outside-");
  const clone = await tmp("mg-clone-");
  await mkdir(path.join(clone, "skills", "inner"), { recursive: true });
  await writeFile(path.join(clone, "afile"), "x");
  await link(outside, path.join(clone, "escape"));

  assert.equal(await resolveScanRoot(clone, ""), clone);
  assert.equal(await resolveScanRoot(clone, "skills/inner"), path.join(clone, "skills", "inner"));
  await assert.rejects(resolveScanRoot(clone, "../x"), /refused/u);
  await assert.rejects(resolveScanRoot(clone, "skills/../../x"), /refused/u);
  await assert.rejects(resolveScanRoot(clone, "missing"), /does not exist/u);
  await assert.rejects(resolveScanRoot(clone, "afile"), /not a directory/u);
  await assert.rejects(resolveScanRoot(clone, "escape"), /outside the clone/u);
});
