import {
  names,
  installLocalDir,
  CLI,
  cliMg as mg,
  cliSetup as setup,
  cliSnapshot as snapshot,
  sourceId,
  catalogRecords,
  git,
  head,
  indexIds,
  indexRows,
  link,
  makeRepo,
  runCli,
  skillMd,
  tmp,
  writeCatalogRecords,
  writeSkill,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Env, Run } from "./helpers.ts";

test("a copied Git store loads its own snapshot while the original remains", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = sourceId(installed);
  const moved = path.join(await tmp(), "store");
  await cp(env.home, moved, { recursive: true, verbatimSymlinks: true });
  const originalSkill = path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md");
  await writeFile(originalSkill, skillMd("react-perf", "Changed original", "Original store content."));
  const copied = { ...env, home: moved };
  const found = await mg(copied, ["find", "react-perf"]);
  assert.equal(found.code, 0, found.stderr);
  assert.match(found.stdout, /react-perf/u);
  const loaded = await mg(copied, ["load", `${id}/react-perf`]);
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.match(loaded.stdout, /Body of react-perf/u);
  assert.doesNotMatch(loaded.stdout, /Original store content/u);
});

test("Git skill paths cannot escape their managed snapshot", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  const id = sourceId(installed);
  const db = new DatabaseSync(path.join(env.home, "index.db"));
  const row = db.prepare("SELECT dir FROM skills WHERE name = ?").get("react-perf") as { dir: string };
  const update = db.prepare("UPDATE skills SET dir = ? WHERE name = ?");
  for (const dir of ["../outside", "/tmp/outside"]) {
    update.run(dir, "react-perf");
    const loaded = await mg(env, ["load", `${id}/react-perf`]);
    assert.equal(loaded.code, 1);
    assert.match(loaded.stderr, /invalid snapshot path/u);
  }
  update.run(row.dir, "react-perf");
  db.prepare("UPDATE skills SET source = 'unknown' WHERE name = 'react-perf'").run();
  const missingSource = await mg(env, ["load", `${id}/react-perf`]);
  assert.equal(missingSource.code, 1);
  assert.match(missingSource.stderr, /invalid snapshot path/u);
  db.prepare("UPDATE skills SET source = ? WHERE name = 'react-perf'").run(id);
  db.close();
  const loaded = await mg(env, ["load", `${id}/react-perf`]);
  assert.equal(loaded.code, 0, loaded.stderr);
  const record = catalogRecords(env.home)[0]!;
  const skill = path.join(env.home, "snapshots", id, record.snapshot!, row.dir);
  const outside = path.join(await tmp(), "outside");
  await rename(skill, outside);
  await link(outside, skill);
  const escaped = await mg(env, ["load", `${id}/react-perf`]);
  assert.equal(escaped.code, 1);
  assert.match(escaped.stderr, /invalid snapshot path/u);
});

test("first lock restore retries after catalog publication fails", async () => {
  const from = await setup();
  const to = await setup();
  const repo = await makeRepo();
  assert.equal((await mg(from, ["install", repo.url, "--skill", "react-perf"])).code, 0);
  const exported = await mg(from, ["lock", "export"]);
  assert.equal(exported.code, 0, exported.stderr);
  const dir = await tmp();
  const lock = path.join(dir, "lock.json");
  const preload = path.join(dir, "fail-publication.mjs");
  await writeFile(lock, exported.stdout);
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(to.home, "index.db"))}) return Promise.reject(new Error("publication failed")); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["lock", "restore", lock], { home: to.home, fakeBin: to.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /publication failed/u);
  const retried = await mg(to, ["lock", "restore", lock]);
  assert.equal(retried.code, 0, retried.stderr);
  const loaded = await mg(to, ["load", "react-perf"]);
  assert.equal(loaded.code, 0, loaded.stderr);
});

test("selective install expands and preserves the accepted revision when a skill disappears", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const missing = await mg(env, ["install", repo.url, "--skill", "missing-skill"]);
  assert.match(missing.stderr, /skill "missing-skill" does not exist in source/u);
  const duplicate = await mg(env, ["install", repo.url, "--skill", "react-perf", "--skill", "react-perf"]);
  assert.match(duplicate.stderr, /skill "react-perf" was selected more than once/u);
  const installed = await mg(env, ["install", repo.url, "--skill", "react-perf"]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = sourceId(installed);
  assert.deepEqual(indexIds(env.home), [`${id}/react-perf`]);
  assert.match((await mg(env, ["update", "--skill", "postgres-tuning"])).stderr, /skill selection requires an explicit source ID/u);
  assert.match(
    (await mg(env, ["update", repo.url, "--skill", "postgres-tuning"])).stderr,
    /skill selection requires an explicit source ID/u,
  );
  assert.match((await mg(env, ["update", id, "--skill", " react-perf"])).stderr, /invalid skill name/u);
  const expanded = await mg(env, ["update", id, "--skill", "postgres-tuning"]);
  assert.equal(expanded.code, 0, expanded.stderr);
  assert.deepEqual(indexIds(env.home), [`${id}/postgres-tuning`, `${id}/react-perf`]);
  assert.deepEqual(catalogRecords(env.home)[0]?.selection, ["postgres-tuning", "react-perf"]);
  const before = await snapshot(env.home);
  await rm(path.join(repo.dir, "skills", "postgres-tuning"), { recursive: true });
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "remove skill");
  const failed = await mg(env, ["update", id]);
  assert.match(failed.stderr, /selected skill "postgres-tuning" is missing from the new revision\. The installed source is unchanged/u);
  assert.deepEqual(await snapshot(env.home), before);
  const ambiguousRepo = await makeRepo();
  await writeSkill(path.join(ambiguousRepo.dir, "duplicate"), "react-perf", "another React skill");
  await git(ambiguousRepo.dir, "add", "-A");
  await git(ambiguousRepo.dir, "commit", "-q", "-m", "duplicate name");
  const ambiguous = await mg(await setup(), ["install", ambiguousRepo.url, "--skill", "react-perf"]);
  assert.match(ambiguous.stderr, /skill "react-perf" is ambiguous in source/u);
});

test("a verified pending lock repairs incomplete indexed rows", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  const id = sourceId(installed);
  const exported = await mg(env, ["lock", "export"]);
  const lock = JSON.parse(exported.stdout) as { sources: unknown[] };
  const record = catalogRecords(env.home)[0];
  const pending = path.join(env.home, "restore-pending", `${id}.json`);
  await mkdir(path.dirname(pending), { recursive: true });
  await writeFile(pending, JSON.stringify({ source: lock.sources[0], record }));
  const db = new DatabaseSync(path.join(env.home, "index.db"));
  db.prepare("UPDATE skills SET hash = ? WHERE name = ?").run(`sha256:${"0".repeat(64)}`, "react-perf");
  db.close();
  const file = path.join(await tmp(), "lock.json");
  await writeFile(file, exported.stdout);
  const restored = await mg(env, ["lock", "restore", file]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal((await mg(env, ["lock", "export"])).stdout, exported.stdout);
  await assert.rejects(readFile(pending), { code: "ENOENT" });
});

test("empty stores reject explicit source checks and export empty locks", async () => {
  const env = await setup();
  const check = await mg(env, ["check", "missing"]);
  assert.equal(check.code, 1);
  assert.match(check.stderr, /no source/u);
  const selected = await mg(env, ["lock", "export", "--source", "missing"]);
  assert.equal(selected.code, 1);
  assert.match(selected.stderr, /installed Git source ID/u);
  assert.equal((await mg(env, ["reindex"])).code, 0);
  const exported = await mg(env, ["lock", "export"]);
  assert.equal(exported.code, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout), { version: 2, sources: [] });
});

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
  assert.equal(rec[0]?.["ref"], "refs/heads/main", "no --ref pins the default branch");

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
  assert.match(
    load.stdout,
    new RegExp(`base: ${path.join(env.home, "snapshots", id, String(rec[0]?.["snapshot"]), "skills", "react-perf")}\\n`, "u"),
  );
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
  assert.equal(list.stdout.trim(), `${id}  git  ref=refs/heads/main  commit=${second.slice(0, 7)}  skills=3`);
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

/** A refused update leaves the old copy live: same sources.json and index.db rows, same files, no staging. */
async function refusedUpdate(m: Marked, extra?: Record<string, string>, ref?: string): Promise<Run> {
  const before = await snapshot(m.env.home);
  const oldFile = await installedFile(m);
  const r = await mg(m.env, ["update", m.id, ...(ref === undefined ? [] : ["--ref", ref])], extra);
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
  await git(m.repo.dir, "branch", "unsafe");
  const before = JSON.parse((await snapshot(m.env.home)).sources ?? "[]") as { ref: string }[];
  const r = await refusedUpdate(m, undefined, "refs/heads/unsafe");
  const after = JSON.parse((await snapshot(m.env.home)).sources ?? "[]") as { ref: string }[];
  assert.equal(after[0]?.ref, before[0]?.ref);
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

test("update ignores findings added to the mutable installed copy", async () => {
  const m = await marked();
  const injected = "new FAKE-CRIT EXFILTRATE:injected";
  const file = path.join(m.env.home, "sources", m.id, "skills", "react-perf", "SKILL.md");
  await writeFile(file, `${await readFile(file, "utf8")}\n${injected}\n`);
  await setBody(m, [KNOWN_CRIT, KNOWN_WARN, injected]);
  const result = await refusedUpdate(m);
  assert.match(result.stderr, /EXFILTRATE:injected/u);
});

test("recovery preserves an accepted critical scan for identical bytes", async () => {
  const m = await marked();
  const original = catalogRecords(m.env.home)[0]!;
  assert.equal(original.scan?.verdict, "critical");
  assert.equal(original.scan?.overridden, true);
  const exported = await mg(m.env, ["lock", "export"]);
  const lock = path.join(await tmp(), "lock.json");
  await writeFile(lock, exported.stdout);
  await writeFile(path.join(m.env.home, "sources", m.id, "skills", "react-perf", "SKILL.md"), "drift\n");
  const restored = await mg(m.env, ["lock", "restore", lock]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(restored.stdout, `restored ${m.id}\n`);
  assert.deepEqual(catalogRecords(m.env.home)[0]?.scan, original.scan);
  assert.equal(await installedFile(m), await readFile(m.file, "utf8"));
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

test("update applies install rules when the accepted scan is unknown", async () => {
  const m = await marked();
  const records = catalogRecords(m.env.home);
  delete records[0]?.scan;
  writeCatalogRecords(m.env.home, records);
  // the known critical line counts as new without a baseline, so exit 2 refuses
  await setBody(m, [KNOWN_CRIT, KNOWN_WARN, "x"]);
  const r = await refusedUpdate(m);
  assert.match(r.stderr, /^scan: no accepted baseline\. Applying install rules$/mu);
  assert.match(r.stderr, /refused: ripwire found CRITICAL findings \(exit 2\)/u);

  // the other direction: warn-only content proceeds, with the no-baseline line
  await setBody(m, [KNOWN_WARN]);
  const ok = await mg(m.env, ["update", m.id]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stderr, /scan: no accepted baseline\. Applying install rules/u);
  assert.match(ok.stderr, /^scan: WARN — 1 finding\(s\) \(1 warn\)/mu);
});

test("update compares against the accepted scan when the installed copy is missing", async () => {
  const m = await marked();
  await rm(await realpath(path.join(m.env.home, "sources", m.id)), { recursive: true });
  const r = await mg(m.env, ["update", m.id]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /0 new vs installed copy/u);
  assert.deepEqual(await names(path.join(m.env.home, "sources")), [m.id]);
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
  assert.match((await mg(env, ["list"])).stdout, new RegExp(`^${id}  git  ref=refs/heads/main `, "mu"));

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

test("version, --version, and -v print the version", async () => {
  const env = await setup();
  for (const args of [["version"], ["--version"], ["-v"]]) {
    const r = await mg(env, args);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^margrave \d+\.\d+\.\d+/u);
  }
});

// ---- paths that the tests above do not reach ----

const NO_SOURCES = "no skill sources installed; run: margrave install <owner/repo|path>";

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
  const revision = `sha256:${"a".repeat(64)}`;
  for (const args of [
    ["load", "missing", "--revision", revision],
    ["load", "missing", "--file", "SKILL.md", "--revision", revision],
  ]) {
    assert.match((await mg(env, args)).stderr, /skill revision changed; search again/u);
  }
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

test("a missing index.db stops install, update, and remove, and says to run reindex", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill");
  const id = await installLocalDir(env, dir);
  await rm(path.join(env.home, "index.db"));
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
    assert.match(r.stderr, /index\.db is missing\. Restore the complete store backup/u, args.join(" "));
  }
  const all = await mg(env, ["update"]);
  assert.equal(all.code, 1);
  // The guard fails once for the whole run, not once per source.
  assert.equal(all.stderr.match(/index\.db is missing\. Restore the complete store backup/gu)?.length, 1, all.stderr);
  assert.doesNotMatch(all.stderr, /failed:/u);
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

test("update of all sources strips terminal control bytes from the path in a per-source error", async () => {
  const env = await setup();
  const parent = await tmp("mg-ctl-");
  const gone = path.join(parent, "bad\u001b]0;T\u0007dir");
  await mkdir(gone);
  await writeSkill(gone, "alpha", "alpha skill");
  const kept = await tmp("mg-kept-");
  await writeSkill(kept, "beta", "beta skill");
  const goneId = await installLocalDir(env, gone);
  const keptId = await installLocalDir(env, kept);
  await rm(gone, { recursive: true });

  const all = await mg(env, ["update"]);
  assert.equal(all.code, 1);
  assert.ok(!all.stderr.includes("\u001b") && !all.stderr.includes("\u0007"), JSON.stringify(all.stderr));
  // cleanBlock drops the whole OSC sequence, so only "bad" and "dir" remain.
  const shown = path.join(parent, "baddir").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(all.stderr, new RegExp(`update ${goneId} failed: ${shown} is not readable`, "u"));
  assert.ok(all.stdout.includes(`${keptId}: reindexed`), all.stdout);
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
  const records = catalogRecords(env.home);
  writeCatalogRecords(
    env.home,
    records.map((r) => ({ ...r, subpath: "skills" })),
  );
  await rm(path.join(env.home, "sources", id, "skills"), { recursive: true });
  const second = await mg(env, ["update", id]);
  assert.equal(second.code, 0, second.stderr);
  assert.ok(indexIds(env.home).some((i) => i.endsWith("/react-perf")));
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
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  const fail = preloadArgs(`import { DatabaseSync } from "node:sqlite";
const real = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) { if (sql.startsWith("SELECT id, record FROM sources")) throw "boom, not an Error"; return real.call(this, sql); };`);
  const r = await runCli(["list"], { home: env.home, nodeArgs: fail });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "margrave: boom, not an Error\n");
  assert.equal(r.stdout, "");
});

test("terminal control bytes in an error message never reach stderr", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  // The doubled backslashes make the preload source hold JS escapes, which the preload turns into the real bytes.
  const fail = preloadArgs(`import { DatabaseSync } from "node:sqlite";
const real = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) { if (sql.startsWith("SELECT id, record FROM sources")) throw new Error("bad \\u001b[31mred\\u001b[0m\\u0007 name\\nsecond line"); return real.call(this, sql); };`);
  const r = await runCli(["list"], { home: env.home, nodeArgs: fail });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "margrave: bad red name\nsecond line\n");
  assert.equal(r.stdout, "");
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

test("reference-only updates change revision and pinned reads detect drift", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const dir = path.join(repo.dir, "skills", "react-perf", "references");
  await mkdir(dir);
  await writeFile(path.join(dir, "tips.md"), "first\n");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-qm", "add reference");
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = `${sourceId(installed)}/react-perf`;
  const find = async () => JSON.parse((await mg(env, ["find", id, "--json"])).stdout) as { results: { revision: string }[] };
  const old = (await find()).results[0]!.revision;
  const oldHash = createHash("sha256")
    .update(await readFile(path.join(repo.dir, "skills", "react-perf", "SKILL.md")))
    .digest("hex");
  assert.equal((await mg(env, ["load", id, "--file", "references/tips.md", "--revision", old])).stdout, "first\n");
  assert.equal(
    (await mg(env, ["load", id, "--file", "SKILL.md", "--revision", old])).stdout,
    await readFile(path.join(repo.dir, "skills", "react-perf", "SKILL.md"), "utf8"),
  );
  assert.equal((await mg(env, ["load", id, "--revision", old])).code, 0);
  assert.match((await mg(env, ["load", id, "--revision", "bad"])).stderr, /revision must be a SHA-256 digest/u);
  assert.match(
    (await mg(env, ["load", id, "--file", "../secret", "--revision", old])).stderr,
    /file is not in the selected skill revision/u,
  );
  await writeFile(path.join(dir, "tips.md"), "second\n");
  const unchangedHash = createHash("sha256")
    .update(await readFile(path.join(repo.dir, "skills", "react-perf", "SKILL.md")))
    .digest("hex");
  assert.equal(unchangedHash, oldHash, "the previous SKILL.md-only comparison omits this change");
  assert.deepEqual(oldHash === unchangedHash ? [] : [id], []);
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-qm", "change reference");
  const update = await mg(env, ["update"]);
  assert.equal(update.code, 0, update.stderr);
  assert.match(update.stdout, /changed: .*react-perf/u);
  assert.match((await mg(env, ["load", id, "--revision", old])).stderr, /skill revision changed; search again/u);
  const current = (await find()).results[0]!.revision;
  const local = path.join(env.home, "sources", sourceId(installed), "skills", "react-perf", "references", "tips.md");
  await writeFile(local, "drift\n");
  assert.match(
    (await mg(env, ["load", id, "--file", "references/tips.md", "--revision", current])).stderr,
    /installed Git files differ from the accepted revision/u,
  );
  const reindex = await mg(env, ["reindex"]);
  assert.equal(reindex.code, 0);
  assert.match(reindex.stdout + reindex.stderr, /installed Git files differ from the accepted revision/u);
  const refreshed = (await find()).results[0]!.revision;
  assert.equal(refreshed, current);
  assert.match(
    (await mg(env, ["load", id, "--file", "references/tips.md", "--revision", refreshed])).stderr,
    /installed Git files differ from the accepted revision/u,
  );
});

test("a Git skill at the snapshot root reports drift", async () => {
  const env = await setup();
  const dir = await tmp("mg-root-repo-");
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "SKILL.md"), skillMd("root-skill", "Root skill"));
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "root");
  const id = sourceId(await mg(env, ["install", `file://${dir}`]));
  const skill = `${id}/root-skill`;
  const revision = indexRows(env.home).find((row) => row.id === skill)!.hash;
  await writeFile(path.join(env.home, "sources", id, "SKILL.md"), skillMd("root-skill", "changed"));
  const result = await mg(env, ["load", skill, "--revision", revision]);
  assert.match(result.stderr, /installed Git files differ from the accepted revision/u);
  await rm(await realpath(path.join(env.home, "sources", id)), { recursive: true });
  const missing = await mg(env, ["load", skill, "--revision", revision]);
  assert.match(missing.stderr, /installed Git files differ from the accepted revision/u);
});

test("lock export and restore pins an annotated tag and verifies installed bytes", async () => {
  const from = await setup();
  const to = await setup();
  const repo = await makeRepo();
  const support = path.join(repo.dir, "skills", "react-perf", "guide.txt");
  await writeFile(support, "original");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "support");
  await git(repo.dir, "tag", "-a", "v1", "-m", "annotated");
  const sha = await head(repo.dir);
  const installed = await mg(from, ["install", repo.url, "--ref", "refs/tags/v1"]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = sourceId(installed);
  const exported = await mg(from, ["lock", "export"]);
  assert.equal(exported.code, 0, exported.stderr);
  const lock = JSON.parse(exported.stdout) as { sources: { id: string; commit: string; ref: string; skills: { revision: string }[] }[] };
  assert.equal(lock.sources[0]?.id, id);
  assert.equal(lock.sources[0]?.commit, sha);
  assert.equal(lock.sources[0]?.ref, "refs/tags/v1");
  assert.match(lock.sources[0]?.skills[0]?.revision ?? "", /^sha256:[a-f0-9]{64}$/u);
  const file = path.join(await tmp(), "lock.json");
  await writeFile(file, exported.stdout);
  await writeFile(support, "newer");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "advance");
  const restored = await mg(to, ["lock", "restore", file]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(restored.stdout, `restored ${id}\n`);
  assert.equal(await readFile(path.join(to.home, "sources", id, "skills", "react-perf", "guide.txt"), "utf8"), "original");
  const inode = (await stat(path.join(to.home, "index.db"))).ino;
  assert.equal((await mg(to, ["lock", "restore", file])).stdout, `already restored ${id}\n`);
  assert.equal((await stat(path.join(to.home, "index.db"))).ino, inode);
  await writeFile(path.join(to.home, "sources", id, "skills", "react-perf", "guide.txt"), "changed");
  const conflict = await mg(to, ["lock", "restore", file]);
  assert.equal(conflict.code, 0, conflict.stderr);
  assert.equal(conflict.stdout, `restored ${id}\n`);
  assert.equal(await readFile(path.join(to.home, "sources", id, "skills", "react-perf", "guide.txt"), "utf8"), "original");
  await rm(path.join(to.home, "sources", id, "skills", "react-perf", "guide.txt"));
  assert.equal((await mg(to, ["lock", "restore", file])).code, 0);
});

for (const aliasState of ["missing", "incorrect"] as const) {
  test(`lock restore handles a ${aliasState} snapshot alias`, async () => {
    const env = await setup();
    const repo = await makeRepo();
    const installed = await mg(env, ["install", repo.url]);
    assert.equal(installed.code, 0, installed.stderr);
    const id = sourceId(installed);
    const exported = await mg(env, ["lock", "export"]);
    assert.equal(exported.code, 0, exported.stderr);
    const file = path.join(await tmp(), "lock.json");
    await writeFile(file, exported.stdout);
    const alias = path.join(env.home, "sources", id);
    const target = await readlink(alias);
    const expected = await readFile(path.join(alias, "skills", "react-perf", "SKILL.md"), "utf8");
    await rm(alias);
    if (aliasState === "incorrect") await link(repo.dir, alias);
    const restored = await mg(env, ["lock", "restore", file]);
    if (aliasState === "missing") {
      assert.equal(restored.code, 0, restored.stderr);
      assert.equal(await readlink(alias), target);
      assert.equal(await readFile(path.join(alias, "skills", "react-perf", "SKILL.md"), "utf8"), expected);
    } else {
      assert.equal(restored.code, 0);
      assert.match(restored.stderr, /compatibility link could not be updated/u);
      assert.match(restored.stdout, /already restored/u);
      assert.equal(await readlink(alias), repo.dir);
      assert.equal(await readFile(path.join(repo.dir, "skills", "react-perf", "SKILL.md"), "utf8"), expected);
    }
  });
}

test("lock validation and staging failures do not publish", async () => {
  const from = await setup();
  const to = await setup();
  const repo = await makeRepo();
  const install = await mg(from, ["install", repo.url]);
  assert.equal(install.code, 0, install.stderr);
  const exported = await mg(from, ["lock", "export"]);
  const lock = JSON.parse(exported.stdout) as { sources: { spec: string; url: string; commit: string; skills: { revision: string }[] }[] };
  const file = path.join(await tmp(), "lock.json");
  await writeFile(file, "{");
  assert.match((await mg(to, ["lock", "restore", file])).stderr, /lock file is malformed/u);
  const bad = structuredClone(lock);
  Object.assign(bad.sources[0] as object, { unexpected: true });
  await writeFile(file, JSON.stringify(bad));
  assert.match((await mg(to, ["lock", "restore", file])).stderr, /lock file is malformed/u);
  const credential = structuredClone(lock);
  if (credential.sources[0] !== undefined) credential.sources[0].spec = "https:////user:secret@example.com/repo";
  await writeFile(file, JSON.stringify(credential));
  const redacted = await mg(to, ["lock", "restore", file]);
  assert.match(redacted.stderr, /lock source URL must not contain credentials/u);
  assert.doesNotMatch(redacted.stderr, /secret|user/u);
  const unavailable = structuredClone(lock);
  if (unavailable.sources[0] !== undefined) unavailable.sources[0].commit = "0".repeat(40);
  await writeFile(file, JSON.stringify(unavailable));
  assert.match((await mg(to, ["lock", "restore", file])).stderr, /locked commit is unavailable/u);
  const incorrect = structuredClone(lock);
  if (incorrect.sources[0]?.skills[0] !== undefined) incorrect.sources[0].skills[0].revision = `sha256:${"0".repeat(64)}`;
  await writeFile(file, JSON.stringify(incorrect));
  assert.match((await mg(to, ["lock", "restore", file])).stderr, /staged skills differ/u);
  await writeFile(file, exported.stdout);
  assert.equal((await mg(to, ["lock", "restore", file], { FAKE_RIPWIRE_EXIT: "2" })).code, 1);
  assert.deepEqual(await names(path.join(to.home, "sources")), []);
});

test("lock restore resumes after interruption before SQLite commit", async () => {
  const from = await setup();
  const to = await setup();
  const repo = await makeRepo();
  const install = await mg(from, ["install", repo.url]);
  const id = sourceId(install);
  const exported = await mg(from, ["lock", "export"]);
  const dir = await tmp();
  const file = path.join(dir, "lock.json");
  const preload = path.join(dir, "kill.mjs");
  await writeFile(file, exported.stdout);
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";\nimport { existsSync } from "node:fs";\nconst original = DatabaseSync.prototype.exec;\nDatabaseSync.prototype.exec = function(sql) { if (sql === "COMMIT" && existsSync(process.env.MARGRAVE_HOME + "/restore-pending/${id}.json")) process.kill(process.pid, "SIGKILL"); return original.call(this, sql); };\n`,
  );
  const unrelated = path.join(to.home, "snapshots", "other", "keep");
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, "data"), "keep");
  const interrupted = await runCli(["lock", "restore", file], { home: to.home, fakeBin: to.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(interrupted.code, 1);
  assert.ok(await stat(path.join(to.home, "restore-pending", `${id}.json`)));
  const retry = await mg(to, ["lock", "restore", file]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(retry.stdout, `restored ${id}\n`);
  assert.equal(await readFile(path.join(unrelated, "data"), "utf8"), "keep");
  assert.equal((await mg(to, ["lock", "restore", file])).stdout, `already restored ${id}\n`);
});

test("lock restore stages every missing source before publication", async () => {
  const from = await setup();
  const to = await setup();
  const first = await makeRepo();
  const second = await makeRepo();
  assert.equal((await mg(from, ["install", first.url])).code, 0);
  assert.equal((await mg(from, ["install", second.url])).code, 0);
  const exported = await mg(from, ["lock", "export"]);
  const lock = JSON.parse(exported.stdout) as { sources: { skills: { revision: string }[] }[] };
  assert.equal(lock.sources.length, 2);
  if (lock.sources[1]?.skills[0] !== undefined) lock.sources[1].skills[0].revision = `sha256:${"0".repeat(64)}`;
  const file = path.join(await tmp(), "lock.json");
  await writeFile(file, JSON.stringify(lock));
  const result = await mg(to, ["lock", "restore", file]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /staged skills differ from the lock/u);
  assert.deepEqual(await names(path.join(to.home, "sources")), []);
});

test("lock round trips shorthand and subpath IDs using a local URL rewrite", async () => {
  const from = await setup();
  const to = await setup();
  const repo = await makeRepo();
  const env = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${repo.url}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/example/repo.git",
  };
  for (const spec of ["example/repo", "example/repo/skills/react-perf"]) {
    const installed = await mg(from, ["install", spec], env);
    assert.equal(installed.code, 0, installed.stderr);
  }
  const exported = await mg(from, ["lock", "export"], env);
  assert.equal(exported.code, 0, exported.stderr);
  const lock = JSON.parse(exported.stdout) as { sources: { id: string; skills: { id: string }[] }[] };
  assert.deepEqual(
    lock.sources.map((s) => s.id),
    ["example__repo", "example__repo__skills__react-perf"],
  );
  assert.deepEqual(
    lock.sources[1]?.skills.map((s) => s.id),
    ["example__repo__skills__react-perf/react-perf"],
  );
  const file = path.join(await tmp(), "lock.json");
  await writeFile(file, exported.stdout);
  const restored = await mg(to, ["lock", "restore", file], env);
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(indexIds(to.home), lock.sources.flatMap((s) => s.skills.map((skill) => skill.id)).sort());
});

test("lock round trips a SHA-256 Git repository", async () => {
  const from = await setup();
  const to = await setup();
  const repo = await tmp("mg-sha256-");
  await git(repo, "init", "-q", "-b", "main", "--object-format=sha256");
  await writeSkill(repo, "sha-skill", "SHA skill");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "initial");
  const installed = await mg(from, ["install", `file://${repo}`]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = sourceId(installed);
  const exported = await mg(from, ["lock", "export"]);
  const lock = JSON.parse(exported.stdout) as { sources: { commit: string }[] };
  assert.match(lock.sources[0]?.commit ?? "", /^[a-f0-9]{64}$/u);
  const file = path.join(await tmp(), "lock.json");
  await writeFile(file, exported.stdout);
  const restored = await mg(to, ["lock", "restore", file]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(indexIds(to.home), [`${id}/sha-skill`]);
});

test("lock restore rejects a competing pending marker without deleting its snapshot", async () => {
  const from = await setup();
  const to = await setup();
  const repo = await makeRepo();
  const installed = await mg(from, ["install", repo.url]);
  const id = sourceId(installed);
  const exported = await mg(from, ["lock", "export"]);
  const source = (
    JSON.parse(exported.stdout) as { sources: { spec: string; id: string; url: string; subpath: string; ref: string; commit: string }[] }
  ).sources[0]!;
  const snapshotKey = `${source.commit}-0123456789abcdef`;
  const record = { ...source, kind: "git", snapshot: snapshotKey, installedAt: "2026-01-01T00:00:00.000Z" };
  delete (record as { skills?: unknown }).skills;
  delete (record as { selection?: unknown }).selection;
  const marker = JSON.stringify({ source, record });
  const dir = await tmp();
  const file = path.join(dir, "lock.json");
  const preload = path.join(dir, "compete.mjs");
  await writeFile(file, exported.stdout);
  const markerFile = path.join(to.home, "restore-pending", `${id}.json`);
  const competing = path.join(to.home, "snapshots", id, snapshotKey);
  await mkdir(competing, { recursive: true });
  await writeFile(path.join(competing, "keep"), "untouched");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
const original = DatabaseSync.prototype.exec; let begins = 0;
DatabaseSync.prototype.exec = function(sql) { if (sql === "BEGIN IMMEDIATE" && ++begins === 2) { mkdirSync(${JSON.stringify(path.dirname(markerFile))}, { recursive: true }); writeFileSync(${JSON.stringify(markerFile)}, ${JSON.stringify(marker)}); } return original.call(this, sql); };
`,
  );
  const result = await runCli(["lock", "restore", file], { home: to.home, fakeBin: to.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /restore is pending for a different lock source/u);
  assert.equal(await readFile(markerFile, "utf8"), marker);
  assert.equal(await readFile(path.join(competing, "keep"), "utf8"), "untouched");
});

test("lock restore validates only selected pending markers", async () => {
  const from = await setup();
  const to = await setup();
  const repo = await makeRepo();
  const id = sourceId(await mg(from, ["install", repo.url]));
  const exported = await mg(from, ["lock", "export"]);
  const file = path.join(await tmp(), "lock.json");
  await writeFile(file, exported.stdout);
  const pending = path.join(to.home, "restore-pending");
  await mkdir(pending, { recursive: true });
  await writeFile(path.join(pending, "unrelated.json"), "not json");
  await writeFile(path.join(pending, "other.tmp"), "temporary");
  await writeFile(path.join(pending, `${id}.json`), "not json");
  const malformed = await mg(to, ["lock", "restore", file]);
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /pending restore record is malformed/u);
  await rm(path.join(pending, `${id}.json`));
  const restored = await mg(to, ["lock", "restore", file]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(await readFile(path.join(pending, "unrelated.json"), "utf8"), "not json");
});

test("lock restore reports publication when marker cleanup fails", async () => {
  const from = await setup();
  const to = await setup();
  const repo = await makeRepo();
  const id = sourceId(await mg(from, ["install", repo.url]));
  const exported = await mg(from, ["lock", "export"]);
  const dir = await tmp();
  const file = path.join(dir, "lock.json");
  const preload = path.join(dir, "fail-cleanup.mjs");
  await writeFile(file, exported.stdout);
  await writeFile(
    preload,
    `import fs from "node:fs/promises";\nimport { syncBuiltinESMExports } from "node:module";\nconst original = fs.rm;\nfs.rm = function(file, ...args) { if (file === ${JSON.stringify(path.join(to.home, "restore-pending", `${id}.json`))}) return Promise.reject(new Error("cleanup failed")); return original.call(this, file, ...args); };\nsyncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["lock", "restore", file], { home: to.home, fakeBin: to.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, `restored ${id}\n`);
  assert.match(failed.stderr, /restore partially completed: cleanup failed/u);
  assert.equal((await mg(to, ["lock", "restore", file])).stdout, `already restored ${id}\n`);
});
