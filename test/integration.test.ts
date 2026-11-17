import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { atomicWrite } from "../src/store.ts";
import { resolveScanRoot } from "../src/sources.ts";
import { CLI, fakeRipwire, git, head, link, makeRepo, runCli, skillMd, tmp, writeSkill } from "./helpers.ts";
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
  return (await readdir(dir).catch((): string[] => [])).sort();
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
  assert.equal(rec[0]?.["ref"], "main", "no --ref pins the default branch");

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
  const pg = JSON.parse((await mg(env, ["find", "tune postgresql indexes", "--json", "--limit", "1"])).stdout) as {
    results: { id: string }[];
  };
  assert.deepEqual(
    pg.results.map((r) => r.id),
    [`${id}/postgres-tuning`],
  );
  const none = await mg(env, ["find", "kubernetes operators"]);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /^no match\n/u);

  // load prints header and body; a bare name works while it is unique
  const load = await mg(env, ["load", "react-perf"]);
  assert.equal(load.code, 0, load.stderr);
  assert.match(load.stdout, new RegExp(`^skill: ${id}/react-perf\\n`, "u"));
  assert.match(load.stdout, new RegExp(`commit: ${first}\\n`, "u"));
  assert.match(load.stdout, new RegExp(`base: ${path.join(env.home, "sources", id, "skills", "react-perf")}\\n`, "u"));
  assert.match(
    load.stdout,
    /frontmatter:\n---\nname: react-perf\ndescription: .*\n---\nfiles:\n- SKILL\.md\nbody:\n# react-perf\n\nBody of react-perf\.\n$/u,
  );
  const loadJson = JSON.parse((await mg(env, ["load", `${id}/react-perf`, "--json"])).stdout) as { commit: string; body: string };
  assert.equal(loadJson.commit, first);
  assert.equal(loadJson.body, "# react-perf\n\nBody of react-perf.\n");
  const file = await mg(env, ["load", `${id}/react-perf`, "--file", "SKILL.md"]);
  assert.equal(file.stdout, skillMd("react-perf", "Optimize React rendering performance and bundle size"));
  const escape = await mg(env, ["load", `${id}/react-perf`, "--file", "../postgres-tuning/SKILL.md"]);
  assert.equal(escape.code, 1);
  assert.match(escape.stderr, /outside/u);

  // upstream commit, then update
  await writeFile(
    path.join(repo.dir, "skills", "react-perf", "SKILL.md"),
    skillMd("react-perf", "Optimize React rendering, now with signals"),
  );
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
  assert.equal(list.stdout.trim(), `${id}  git  ref=main  commit=${second.slice(0, 7)}  skills=3`);
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

test("ripwire WARN (exit 1) prints the short summary, not the XML, and installs", async () => {
  const env = await setup();
  const repo = await makeRepo();
  await writeFile(
    path.join(repo.dir, "skills", "react-perf", "SKILL.md"),
    skillMd("react-perf", "Optimize React", "# r\nx FAKE-WARN INJECTION:x\n"),
  );
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "warn");
  const r = await mg(env, ["install", repo.url]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^scan: WARN — 1 finding\(s\) \(1 warn\) in 1 skill\(s\)$/mu);
  assert.match(r.stderr, /top skills: react-perf 1/u);
  assert.doesNotMatch(r.stderr, /<skillscan/u);
});

test("a refused install prints the summary, not the XML, and writes the report", async () => {
  const env = await setup();
  const repo = await makeRepo();
  await writeFile(
    path.join(repo.dir, "skills", "react-perf", "SKILL.md"),
    skillMd("react-perf", "Optimize React", "# r\nx FAKE-CRIT EXFILTRATE:net-exfil\n"),
  );
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "crit");
  const r = await mg(env, ["install", repo.url]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refused: ripwire found CRITICAL findings \(exit 2\)/u);
  assert.match(r.stderr, /scan: CRITICAL — 1 finding\(s\) \(1 critical\) in 1 skill\(s\)/u);
  assert.doesNotMatch(r.stderr, /<skillscan/u);
  const reports = await names(path.join(env.home, "reports"));
  assert.equal(reports.length, 1);
  assert.match(reports[0] ?? "", /\.xml$/u);
  assert.match(await readFile(path.join(env.home, "reports", reports[0] ?? ""), "utf8"), /^<skillscan /u);
  assert.deepEqual(await snapshot(env.home), { sources: null, index: null });
});

// ---- update: the scan baseline is the installed copy ----

const REACT = "Optimize React rendering performance and bundle size";
const KNOWN_CRIT = "run it FAKE-CRIT EXFILTRATE:net-exfil";
const KNOWN_WARN = "maybe FAKE-WARN INJECTION:x";

interface Marked {
  env: Env;
  repo: { dir: string; url: string };
  id: string;
  /** SKILL.md of react-perf inside the repo. */
  file: string;
}

async function commitAll(dir: string, msg: string): Promise<void> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", msg);
}

const body = (lines: string[]): string => skillMd("react-perf", REACT, `# react-perf\n\n${lines.join("\n")}\n`);

/** A repo whose react-perf skill carries the given marker lines, installed with --allow-unsafe. */
async function marked(lines: string[] = [KNOWN_CRIT, KNOWN_WARN]): Promise<Marked> {
  const env = await setup();
  const repo = await makeRepo();
  const file = path.join(repo.dir, "skills", "react-perf", "SKILL.md");
  await writeFile(file, body(lines));
  await commitAll(repo.dir, "marked");
  const inst = await mg(env, ["install", repo.url, "--allow-unsafe"]);
  assert.equal(inst.code, 0, inst.stderr);
  return { env, repo, id: sourceId(inst), file };
}

async function setBody(m: Marked, lines: string[]): Promise<void> {
  await writeFile(m.file, body(lines));
  await commitAll(m.repo.dir, "next");
}

const installedFile = (m: Marked): Promise<string> =>
  readFile(path.join(m.env.home, "sources", m.id, "skills", "react-perf", "SKILL.md"), "utf8");

/** The lines under "  new findings:" in a summary. */
function newFindings(text: string): string[] {
  const out: string[] = [];
  let on = false;
  for (const l of text.split("\n")) {
    if (l === "  new findings:") on = true;
    else if (on && l.startsWith("    ")) out.push(l.trim());
    else on = false;
  }
  return out;
}

/** A refused update leaves the old copy live: same sources.json and index.json, same files, no staging. */
async function refusedUpdate(m: Marked, extra?: Record<string, string>): Promise<Run> {
  const before = await snapshot(m.env.home);
  const oldFile = await installedFile(m);
  const r = await mg(m.env, ["update", m.id], extra);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /refused/u);
  assert.match(r.stderr, /--allow-unsafe/u);
  assert.doesNotMatch(r.stderr, /<skillscan/u);
  assert.deepEqual(await snapshot(m.env.home), before);
  assert.equal(await installedFile(m), oldFile);
  assert.deepEqual(await names(path.join(m.env.home, "staging")), []);
  assert.deepEqual(await names(path.join(m.env.home, "sources")), [m.id]);
  return r;
}

test("update proceeds when every finding is known, even at shifted line numbers", async () => {
  const m = await marked();
  await setBody(m, ["a new intro line", "another one", KNOWN_CRIT, KNOWN_WARN]);
  const r = await mg(m.env, ["update", m.id]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^scan: CRITICAL — 2 finding\(s\) \(1 critical, 1 warn\) in 1 skill\(s\); 0 new vs installed copy$/mu);
  assert.doesNotMatch(r.stderr, /new findings:/u);
  assert.ok(r.stdout.includes(`changed: ${m.id}/react-perf`));
  assert.match(await installedFile(m), /a new intro line/u);
  // the file changed, so the summary points at it
  assert.match(
    r.stderr,
    /known findings in changed files:\n {4}skills\/react-perf\/SKILL\.md · EXFILTRATE:net-exfil · 1\n {4}skills\/react-perf\/SKILL\.md · INJECTION:x · 1\n/u,
  );
});

test("update does not list known findings when their files did not change", async () => {
  const m = await marked();
  await writeSkill(path.join(m.repo.dir, "skills"), "extra", "An extra skill");
  await commitAll(m.repo.dir, "extra");
  const r = await mg(m.env, ["update", m.id]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /0 new vs installed copy/u);
  assert.doesNotMatch(r.stderr, /known findings in changed files/u);
});

test("update proceeds on new warn findings only and lists them", async () => {
  const m = await marked();
  await setBody(m, [KNOWN_CRIT, KNOWN_WARN, "fresh FAKE-WARN EXFILTRATE:dns"]);
  const r = await mg(m.env, ["update", m.id]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\(1 critical, 2 warn\)[^\n]*; 1 new vs installed copy/u);
  assert.deepEqual(newFindings(r.stderr), ["skills/react-perf/SKILL.md:9  EXFILTRATE:dns  warn"]);
});

test("update refuses one new critical finding and lists only that one", async () => {
  const m = await marked();
  await writeSkill(
    path.join(m.repo.dir, "skills"),
    "docker-compose",
    "Write Docker Compose files",
    "# d\nboom FAKE-CRIT EXFILTRATE:new-one\n",
  );
  await commitAll(m.repo.dir, "new crit");
  const r = await refusedUpdate(m);
  assert.match(r.stderr, /; 1 new vs installed copy/u);
  assert.deepEqual(newFindings(r.stderr), ["skills/docker-compose/SKILL.md:6  EXFILTRATE:new-one  critical"]);
});

test("update refuses a duplicated known line (the baseline is a multiset)", async () => {
  const m = await marked();
  await setBody(m, [KNOWN_CRIT, KNOWN_CRIT, KNOWN_WARN]);
  const r = await refusedUpdate(m);
  assert.match(r.stderr, /; 1 new vs installed copy/u);
  assert.equal(newFindings(r.stderr).length, 1);
});

test("update refuses a known line whose severity rose from warn to critical", async () => {
  const m = await marked([KNOWN_WARN]);
  // the content is identical, so an update proceeds
  const calm = await mg(m.env, ["update", m.id]);
  assert.equal(calm.code, 0, calm.stderr);
  assert.match(calm.stderr, /; 0 new vs installed copy/u);
  // the same line, path, and rule, but the new copy's row is critical (the installed copy's is still warn)
  const r = await refusedUpdate(m, { FAKE_RIPWIRE_SEV: "critical", FAKE_RIPWIRE_SEV_ON: "/staging/" });
  assert.deepEqual(newFindings(r.stderr), ["skills/react-perf/SKILL.md:7  INJECTION:x  critical"]);
});

test("update refuses an unreadable flagged file (non-UTF-8, symlink), even for a warn", async () => {
  const m = await marked([KNOWN_WARN]);
  const dir = path.join(m.repo.dir, "skills", "react-perf");
  await writeFile(path.join(dir, "bad.md"), Buffer.from("bad \xff\nflagged FAKE-WARN INJECTION:x\n", "latin1"));
  await commitAll(m.repo.dir, "non-utf8");
  const r = await refusedUpdate(m);
  assert.deepEqual(newFindings(r.stderr), ["skills/react-perf/bad.md:2  INJECTION:x  warn (unreadable)"]);

  await rm(path.join(dir, "bad.md"));
  await link("SKILL.md", path.join(dir, "link.md"));
  await commitAll(m.repo.dir, "symlink");
  const s = await refusedUpdate(m);
  assert.deepEqual(newFindings(s.stderr), ["skills/react-perf/link.md:7  INJECTION:x  warn (unreadable)"]);
});

test("an unreadable finding in the installed copy never matches, so the same finding is new", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const bad = path.join(repo.dir, "skills", "react-perf", "bad.md");
  await writeFile(bad, Buffer.from("bad \xff\nflagged FAKE-WARN INJECTION:x\n", "latin1"));
  await commitAll(repo.dir, "non-utf8");
  // A warn does not stop an install.
  const inst = await mg(env, ["install", repo.url]);
  assert.equal(inst.code, 0, inst.stderr);
  const id = sourceId(inst);
  await writeFile(path.join(repo.dir, "skills", "react-perf", "other.md"), "other\n");
  await commitAll(repo.dir, "unrelated change");
  const before = await snapshot(env.home);
  const r = await mg(env, ["update", id]);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(newFindings(r.stderr), ["skills/react-perf/bad.md:2  INJECTION:x  warn (unreadable)"]);
  assert.deepEqual(await snapshot(env.home), before);
});

test("update refuses output whose row count does not match findings=", async () => {
  const m = await marked();
  await setBody(m, [KNOWN_CRIT, KNOWN_WARN, "x"]);
  const r = await refusedUpdate(m, { FAKE_RIPWIRE_DROP_ROW: "1" });
  assert.match(r.stderr, /ripwire declared findings="2" but 1 finding row\(s\) were parsed/u);
});

test("update refuses exit 2 with no finding rows", async () => {
  const m = await marked();
  await setBody(m, ["nothing flagged now"]);
  const r = await refusedUpdate(m, { FAKE_RIPWIRE_EXIT: "2" });
  assert.match(r.stderr, /ripwire reported CRITICAL but no critical finding row was parsed/u);
});

test("update with staging exit 3 refuses and shows ripwire's stderr", async () => {
  const m = await marked();
  await setBody(m, [KNOWN_CRIT, KNOWN_WARN, "x"]);
  const r = await refusedUpdate(m, { FAKE_RIPWIRE_EXIT: "3" });
  assert.match(r.stderr, /ripwire could not read the files \(exit 3\)\nfake ripwire: security --scan-skills=/u);
});

test("update falls back to today's rules when the baseline scan fails", async () => {
  const m = await marked();
  const failBaseline = { FAKE_RIPWIRE_FAIL_ON: "/sources/" };
  // the known critical line counts as new without a baseline, so exit 2 refuses
  await setBody(m, [KNOWN_CRIT, KNOWN_WARN, "x"]);
  const r = await refusedUpdate(m, failBaseline);
  assert.match(r.stderr, /^scan: no baseline \(ripwire could not read the files \(exit 3\)\); every finding counts as new$/mu);
  assert.match(r.stderr, /refused: ripwire found CRITICAL findings \(exit 2\)/u);

  // the other direction: warn-only content proceeds, with the no-baseline line
  await setBody(m, [KNOWN_WARN]);
  const ok = await mg(m.env, ["update", m.id], failBaseline);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /scan: no baseline \(ripwire could not read the files \(exit 3\)\)/u);
  assert.match(ok.stderr, /^scan: WARN — 1 finding\(s\) \(1 warn\)/mu);
});

test("update with no installed copy uses today's rules and prints the no-baseline line", async () => {
  const m = await marked();
  await rm(path.join(m.env.home, "sources", m.id), { recursive: true });
  const before = await snapshot(m.env.home);
  const r = await mg(m.env, ["update", m.id]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^scan: no baseline \(the installed copy is missing\); every finding counts as new$/mu);
  assert.match(r.stderr, /refused: ripwire found CRITICAL findings \(exit 2\)/u);
  assert.deepEqual(await snapshot(m.env.home), before);
  assert.deepEqual(await names(path.join(m.env.home, "sources")), []);
  assert.deepEqual(await names(path.join(m.env.home, "staging")), []);
});

test("--allow-unsafe overrides an update refusal and says so", async () => {
  const m = await marked();
  await setBody(m, [KNOWN_CRIT, KNOWN_WARN, "boom FAKE-CRIT EXFILTRATE:new-one"]);
  const r = await mg(m.env, ["update", m.id, "--allow-unsafe"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /--allow-unsafe: overriding refusal \(new critical or unreadable findings/u);
  assert.match(await installedFile(m), /new-one/u);
});

test("the report holds the raw staging XML; terminal output escapes control characters", async () => {
  const m = await marked();
  const name = "e\u001bm.md";
  await writeFile(path.join(m.repo.dir, "skills", "react-perf", name), "x\nboom FAKE-CRIT EXFILTRATE:esc\n");
  await commitAll(m.repo.dir, "escape");
  const r = await refusedUpdate(m);
  assert.deepEqual(newFindings(r.stderr), ["skills/react-perf/e\\x1bm.md:2  EXFILTRATE:esc  critical"]);
  assert.ok(!r.stderr.includes("\u001b"), "no raw escape character reaches the terminal");
  const report = await readFile(path.join(m.env.home, "reports", `${m.id}.xml`), "utf8");
  assert.ok(report.startsWith("<skillscan "));
  assert.ok(report.includes(`${path.join(m.env.home, "staging")}${path.sep}`), "paths are the staging copy's");
  assert.ok(!report.includes(path.join(m.env.home, "sources")), "not the installed copy's");
  assert.ok(report.includes(`skills/react-perf/${name}:2`), "the file name stays raw in the report");
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
  assert.equal(
    await readFile(path.join(dir, "ansible-roles", "SKILL.md"), "utf8"),
    skillMd("ansible-roles", "Ansible, now with collections"),
  );
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

test("git source: the stored copy keeps no .git after install, and update drops one left by an older install", async () => {
  const env = await setup();
  const dir = await tmp("mg-rootrepo-");
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "SKILL.md"), skillMd("root-skill", "A skill at the repository root"));
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "initial");

  const inst = await mg(env, ["install", `file://${dir}`]);
  assert.equal(inst.code, 0, inst.stderr);
  const id = sourceId(inst);
  const stored = path.join(env.home, "sources", id);
  await assert.rejects(stat(path.join(stored, ".git")), { code: "ENOENT" });
  assert.equal((await stat(path.join(stored, "SKILL.md"))).isFile(), true);
  assert.match((await mg(env, ["list"])).stdout, new RegExp(`^${id}  git  ref=main `, "mu"));

  // A copy installed by an earlier version still holds the clone's .git.
  await mkdir(path.join(stored, ".git"));
  await writeFile(path.join(stored, ".git", "config"), "[remote]\n");
  await writeFile(path.join(dir, "SKILL.md"), skillMd("root-skill", "A skill at the repository root, changed"));
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "second");
  const upd = await mg(env, ["update", id]);
  assert.equal(upd.code, 0, upd.stderr);
  assert.ok(upd.stdout.includes(`changed: ${id}/root-skill`), upd.stdout);
  await assert.rejects(stat(path.join(stored, ".git")), { code: "ENOENT" });
});

test("install scan warnings show control characters in a path as text", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const bad = "bad\u001b]0;T\u0007\nINJECTED-LINE";
  await mkdir(path.join(repo.dir, "skills", bad));
  await writeFile(path.join(repo.dir, "skills", bad, "SKILL.md"), "no frontmatter\n");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "bad dir");

  const r = await mg(env, ["install", repo.url]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stderr.split("\n");
  const warnings = lines.filter((l) => l.startsWith("warning:"));
  assert.ok(!warnings.join("\n").includes("\u001b"), "no ESC byte in a warning");
  const forBad = warnings.filter((l) => l.includes("bad"));
  assert.equal(forBad.length, 1, warnings.join("\n"));
  assert.ok(forBad[0]?.includes("\\x1b]0;T\\x07\\x0aINJECTED-LINE"), warnings.join("\n"));
  assert.ok(!lines.some((l) => l.startsWith("INJECTED-LINE")));
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
    // oxlint-disable-next-line no-unmodified-loop-condition -- `stop` is set by the reader below while the writer runs
    for (let i = 1; i <= 40 && !stop; i++) await atomicWrite(file, big(i));
  })();
  let reads = 0;
  // oxlint-disable-next-line no-unmodified-loop-condition -- the reader leaves with break; `stop` is set after the loop, to stop the writer
  while (!stop) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { n: number };
    assert.equal(typeof parsed.n, "number");
    reads++;
    if (reads > 400) break;
    if (reads % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  stop = true;
  await writer;
  assert.deepEqual(
    (await readdir(dir)).filter((n) => n.endsWith(".tmp")),
    [],
  );
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

// ---- paths that the tests above do not reach ----

const NO_SOURCES = "no skill sources installed; run: margrave install <owner/repo|path>";

async function installLocalDir(env: Env, dir: string): Promise<string> {
  const r = await mg(env, ["install", dir]);
  assert.equal(r.code, 0, r.stderr);
  return sourceId(r);
}

test("with no sources: update, find --json, and list --skills say so", async () => {
  const env = await setup();
  const upd = await mg(env, ["update"]);
  assert.equal(upd.code, 0, upd.stderr);
  assert.equal(upd.stdout.trim(), NO_SOURCES);
  const find = await mg(env, ["find", "anything", "--json"]);
  assert.equal(find.code, 0, find.stderr);
  assert.deepEqual(JSON.parse(find.stdout), { task: "anything", results: [], message: NO_SOURCES });
  assert.equal((await mg(env, ["list", "--skills"])).stdout.trim(), NO_SOURCES);
  assert.deepEqual(JSON.parse((await mg(env, ["list", "--json", "--skills"])).stdout), { sources: [], skills: [] });
});

test("list shows a local source with no ref and no commit; --skills adds the skills; load --file prints the file as is", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  const skill = await writeSkill(dir, "terraform-modules", "Design reusable Terraform modules");
  await mkdir(path.join(skill, "references"));
  await writeFile(path.join(skill, "references", "x.md"), "reference text\n");
  const other = await tmp("mg-localsrc2-");
  await writeSkill(other, "ansible-roles", "Write Ansible roles");
  const id = await installLocalDir(env, dir);
  const otherId = await installLocalDir(env, other);

  const list = await mg(env, ["list"]);
  assert.equal(list.code, 0, list.stderr);
  assert.ok(list.stdout.includes(`${id}  local  ref=-  commit=-  skills=1\n`), list.stdout);
  const withSkills = await mg(env, ["list", "--skills"]);
  assert.ok(
    withSkills.stdout.includes(`${id}  local  ref=-  commit=-  skills=1\n  ${id}/terraform-modules: Design reusable Terraform modules\n`),
  );
  assert.ok(withSkills.stdout.includes(`  ${otherId}/ansible-roles: Write Ansible roles\n`));
  const asJson = JSON.parse((await mg(env, ["list", "--json", "--skills"])).stdout) as { skills: { id: string }[] };
  assert.deepEqual(asJson.skills.map((s) => s.id).sort(), [`${otherId}/ansible-roles`, `${id}/terraform-modules`].sort());

  const file = await mg(env, ["load", `${id}/terraform-modules`, "--file", "references/x.md"]);
  assert.equal(file.code, 0, file.stderr);
  assert.equal(file.stdout, "reference text\n");
  const fileJson = await mg(env, ["load", `${id}/terraform-modules`, "--file", "references/x.md", "--json"]);
  assert.deepEqual(JSON.parse(fileJson.stdout), { id: `${id}/terraform-modules`, path: "references/x.md", content: "reference text\n" });
});

test("list still works when index.json is gone: the sources show with no skills", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill");
  const id = await installLocalDir(env, dir);
  await rm(path.join(env.home, "index.json"));
  const list = await mg(env, ["list", "--skills"]);
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.stdout, `${id}  local  ref=-  commit=-  skills=0\n`);
  const asJson = JSON.parse((await mg(env, ["list", "--json", "--skills"])).stdout) as {
    sources: { skillCount: number }[];
    skills: unknown[];
  };
  assert.deepEqual(asJson.skills, []);
  assert.equal(asJson.sources[0]?.skillCount, 0);
});

test("a missing index.json stops install, update, and remove, and says to run reindex", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill");
  const id = await installLocalDir(env, dir);
  await rm(path.join(env.home, "index.json"));
  const before = await snapshot(env.home);

  const other = await tmp("mg-localsrc2-");
  await writeSkill(other, "beta", "beta skill");
  for (const args of [
    ["install", other],
    ["update", id],
    ["remove", id],
  ]) {
    const r = await mg(env, args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /index\.json is missing; run: margrave reindex/u, args.join(" "));
  }
  const all = await mg(env, ["update"]);
  assert.equal(all.code, 1);
  assert.match(all.stderr, new RegExp(`update ${id} failed: index\\.json is missing`, "u"));
  assert.deepEqual(await snapshot(env.home), before);
});

test("install refuses a path that is a file and a directory with no valid skill", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeFile(path.join(dir, "file.txt"), "text\n");
  const file = await mg(env, ["install", path.join(dir, "file.txt")]);
  assert.equal(file.code, 1);
  assert.match(file.stderr, /is not a directory that exists/u);
  const empty = await mg(env, ["install", dir]);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /no valid skills \(SKILL\.md with name and description\) found in/u);
  assert.deepEqual(await names(path.join(env.home, "reports")), []);
});

test("update of all sources reports the one that fails and still updates the rest", async () => {
  const env = await setup();
  const gone = await tmp("mg-gone-");
  await writeSkill(gone, "alpha", "alpha skill");
  const kept = await tmp("mg-kept-");
  await writeSkill(kept, "beta", "beta skill");
  const goneId = await installLocalDir(env, gone);
  const keptId = await installLocalDir(env, kept);
  await rm(gone, { recursive: true });

  const all = await mg(env, ["update"]);
  assert.equal(all.code, 1);
  assert.ok(all.stdout.includes(`${keptId}: reindexed\n`), all.stdout);
  assert.match(
    all.stderr,
    new RegExp(`margrave: update ${goneId} failed: ${gone} is not readable; remove the source or restore the directory\n$`, "u"),
  );
  const one = await mg(env, ["update", goneId]);
  assert.equal(one.code, 1);
  assert.match(one.stderr, /is not readable/u);

  // reindex skips the source that cannot be read and keeps the rest
  const re = await mg(env, ["reindex"]);
  assert.equal(re.code, 0, re.stderr);
  assert.equal(re.stdout.trim(), "reindexed 1 skills from 2 sources");
  assert.match(re.stderr, new RegExp(`warning: ${goneId}: ${gone} is not readable[^\\n]*; skipped`, "u"));
});

test("git source: reindex rescans the stored copy, and skips it when the copy is gone", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const id = sourceId(await mg(env, ["install", repo.url]));
  const re = await mg(env, ["reindex"]);
  assert.equal(re.code, 0, re.stderr);
  assert.equal(re.stdout.trim(), "reindexed 3 skills from 1 sources");

  await rm(path.join(env.home, "sources", id), { recursive: true });
  const gone = await mg(env, ["reindex"]);
  assert.equal(gone.code, 0, gone.stderr);
  assert.equal(gone.stdout.trim(), "reindexed 0 skills from 1 sources");
  assert.match(gone.stderr, new RegExp(`warning: ${id}: .*; skipped`, "u"));
});

test("git source: update when the new revision has no skills keeps the old copy", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const id = sourceId(await mg(env, ["install", repo.url]));
  const before = await snapshot(env.home);
  const stored = await names(path.join(env.home, "sources", id, "skills"));
  await git(repo.dir, "rm", "-r", "-q", "skills");
  await git(repo.dir, "commit", "-q", "-m", "drop every skill");

  const r = await mg(env, ["update", id]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`no valid skills found in the new revision of ${id}; kept the old copy`, "u"));
  assert.deepEqual(await snapshot(env.home), before);
  assert.deepEqual(await names(path.join(env.home, "sources", id, "skills")), stored);
});

test("git source: update works when the stored copy is gone, or no longer holds the subpath", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const id = sourceId(await mg(env, ["install", repo.url]));

  // The stored copy is gone: nothing to swap aside, and no baseline.
  await rm(path.join(env.home, "sources", id), { recursive: true });
  const first = await mg(env, ["update", id]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`^${id}: [0-9a-f]{7} → [0-9a-f]{7}\n`, "u"));
  assert.equal((await stat(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"))).isFile(), true);

  // The source record names a subpath that the stored copy does not have (a GitHub spec can; a file:// URL cannot).
  const file = path.join(env.home, "sources.json");
  const records = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
  await writeFile(file, JSON.stringify(records.map((r) => ({ ...r, subpath: "skills" }))));
  await rm(path.join(env.home, "sources", id, "skills"), { recursive: true });
  const second = await mg(env, ["update", id]);
  assert.equal(second.code, 0, second.stderr);
  assert.ok((await readFile(path.join(env.home, "index.json"), "utf8")).includes("react-perf"));
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

test("wrap adds a build note on stderr when dist/cli.js does not exist", async () => {
  const env = await setup();
  const preload = `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const real = fs.existsSync;
fs.existsSync = (p) => (String(p).endsWith("dist/cli.js") ? false : real(p));
syncBuiltinESMExports();`;
  const r = await runCli(["wrap", "claude"], {
    home: env.home,
    nodeArgs: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^note: .*dist\/cli\.js does not exist yet; run: pnpm run build\n$/u);
  assert.match(r.stdout, /claude mcp add margrave/u);
});

/** `--import` arguments that run `code` as an ES module before the CLI starts. */
const preloadArgs = (code: string): string[] => ["--import", `data:text/javascript,${encodeURIComponent(code)}`];

test("a closed stdout pipe is not an error: `margrave load` piped into a reader that quits exits 0", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "big", "a big skill", `# big\n\n${"lorem ".repeat(500_000)}\n`);
  const id = await installLocalDir(env, dir);

  // The preload reports every stdout error code on stderr, so the test sees that EPIPE really happened.
  const seen = preloadArgs(`process.stdout.prependListener("error", (e) => process.stderr.write("stdout error: " + e.code + ";"));`);
  // 3 MB cannot fit in the pipe, so the child is still writing when the reader closes it.
  const child = spawn(process.execPath, [...seen, CLI, "load", `${id}/big`], {
    env: { ...process.env, MARGRAVE_HOME: env.home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let received = 0;
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdout.on("data", (d: Buffer) => {
    received += d.length;
    child.stdout.destroy();
  });
  const [code] = (await once(child, "close")) as [number | null];
  assert.match(stderr, /^(stdout error: EPIPE;)+$/u);
  assert.ok(received > 0 && received < 3_000_000, `the reader got ${received} bytes of more than 3 MB`);
  assert.equal(code, 0);
});

test("a rejection that is not an Error is still printed as text, with exit 1", async () => {
  const env = await setup();
  const fail = preloadArgs(`import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const real = fsp.readFile;
fsp.readFile = (p, ...rest) => (String(p).endsWith("sources.json") ? Promise.reject("boom, not an Error") : real(p, ...rest));
syncBuiltinESMExports();`);
  const r = await runCli(["list"], { home: env.home, nodeArgs: fail });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "margrave: boom, not an Error\n");
  assert.equal(r.stdout, "");
});

test("a sources.json record with no url, no path, or an unknown kind stops every command that reads it", async () => {
  const env = await setup();
  const base = { spec: "x", subpath: "", ref: null, commit: null, installedAt: "now" };
  const records: Record<string, unknown> = {
    "a git record without url": { ...base, id: "bad__git", kind: "git" },
    "a local record without path": { ...base, id: "bad__local", kind: "local" },
    "a record of an unknown kind": { ...base, id: "bad__kind", kind: "svn", url: "u", path: "/p" },
  };
  const file = path.join(env.home, "sources.json");
  for (const [why, record] of Object.entries(records)) {
    const text = JSON.stringify([record]);
    await writeFile(file, text);
    const id = (record as { id: string }).id;
    for (const args of [["update"], ["update", id], ["remove", id], ["reindex"], ["list"]]) {
      const r = await mg(env, args);
      assert.equal(r.code, 1, `${why}: ${args.join(" ")}`);
      assert.match(r.stderr, /sources\.json is malformed/u, `${why}: ${args.join(" ")}`);
    }
    assert.equal(await readFile(file, "utf8"), text, `${why}: sources.json is unchanged`);
  }
});

test("git source: updating one source leaves the record of another source as it was", async () => {
  const env = await setup();
  const repoA = await makeRepo();
  const repoB = await makeRepo();
  const idA = sourceId(await mg(env, ["install", repoA.url]));
  const idB = sourceId(await mg(env, ["install", repoB.url]));
  const recordOf = async (id: string): Promise<unknown> =>
    (JSON.parse((await snapshot(env.home)).sources ?? "[]") as { id: string }[]).find((r) => r.id === id);
  const beforeB = await recordOf(idB);
  const beforeA = await recordOf(idA);

  await writeSkill(path.join(repoA.dir, "skills"), "extra-skill", "A skill that arrives with the update");
  await git(repoA.dir, "add", "-A");
  await git(repoA.dir, "commit", "-q", "-m", "more");
  const r = await mg(env, ["update", idA]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`added: ${idA}/extra-skill`));
  assert.deepEqual(await recordOf(idB), beforeB);
  assert.notDeepEqual(await recordOf(idA), beforeA);
});
