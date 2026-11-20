import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, cp, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { atomicWrite } from "../src/store.ts";
import { resolveScanRoot } from "../src/sources.ts";
import {
  CLI,
  ROOT,
  catalogRecords,
  fakeRipwire,
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
  const index = await stat(path.join(home, "index.db")).then(
    () => JSON.stringify(indexRows(home)),
    () => null,
  );
  return { sources: index === null ? null : JSON.stringify(catalogRecords(home)), index };
}

async function storeFiles(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(await storeFiles(file))) files[path.join(entry.name, name)] = bytes;
    } else if (entry.isFile()) files[entry.name] = (await readFile(file)).toString("base64");
  }
  return files;
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir).catch((): string[] => [])).sort();
}

function sourceId(r: Run): string {
  const m = /^installed (\S+) \((\d+) skills\)/mu.exec(r.stdout);
  assert.ok(m?.[1], `no source id in: ${r.stdout}${r.stderr}`);
  return m[1];
}

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

test("Git reindex preserves the accepted inventory when installed files drift", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = sourceId(installed);
  const before = await snapshot(env.home);
  const normal = await mg(env, ["reindex"]);
  assert.equal(normal.code, 0, normal.stderr);
  assert.deepEqual(await snapshot(env.home), before);
  await writeFile(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"), skillMd("react-perf", "Changed"));
  const drift = await mg(env, ["reindex"]);
  assert.match(
    drift.stdout + drift.stderr,
    /installed Git files differ from the accepted revision\. Restore a verified lock or a known-good backup/u,
  );
  assert.deepEqual(await snapshot(env.home), before);
});

test("interrupted Git recovery resumes only for the original catalog and scanned bytes", async () => {
  for (const action of ["retry", "repaired", "lost", "competing", "removed", "changed"] as const) {
    const env = await setup();
    const repo = await makeRepo();
    const installed = await mg(env, ["install", repo.url]);
    assert.equal(installed.code, 0, installed.stderr);
    const id = sourceId(installed);
    const exported = await mg(env, ["lock", "export"]);
    const lockFile = path.join(await tmp(), "lock.json");
    await writeFile(lockFile, exported.stdout);
    const old = catalogRecords(env.home)[0]!;
    await writeFile(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"), "drift\n");
    const preload = path.join(await tmp(), "fail-recovery.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises"; import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename; fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(env.home, "index.db"))}) return Promise.reject(new Error("publication failed")); return rename.call(this, from, to); }; syncBuiltinESMExports();`,
    );
    const stopped = await runCli(["lock", "restore", lockFile], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
    assert.equal(stopped.code, 1);
    const marker = JSON.parse(await readFile(path.join(env.home, "restore-pending", `${id}.json`), "utf8")) as {
      record: { snapshot: string };
    };
    if (action === "competing") {
      const records = catalogRecords(env.home);
      records[0]!.installedAt = "competing update";
      writeCatalogRecords(env.home, records);
    } else if (action === "removed") writeCatalogRecords(env.home, []);
    else if (action === "lost") await rm(path.join(env.home, "snapshots", id, marker.record.snapshot), { recursive: true });
    else if (action === "repaired")
      await writeFile(
        path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"),
        await readFile(path.join(repo.dir, "skills", "react-perf", "SKILL.md")),
      );
    else if (action === "changed") await writeFile(path.join(env.home, "snapshots", id, marker.record.snapshot, "extra.txt"), "changed");
    const resumed = await mg(env, ["lock", "restore", lockFile]);
    if (action === "retry" || action === "repaired" || action === "lost") {
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(resumed.stdout, `restored ${id}\n`);
      assert.notEqual(catalogRecords(env.home)[0]!.snapshot, old.snapshot);
      assert.equal(catalogRecords(env.home)[0]!.ref, old.ref);
    } else {
      assert.equal(resumed.code, 1);
      assert.match(resumed.stderr, /installed source differs from the lock/u);
      if (action !== "removed") assert.equal(catalogRecords(env.home)[0]!.snapshot, old.snapshot);
    }
  }
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

test("first publication can retry after catalog rename fails", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const preload = path.join(await tmp(), "fail-publication.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(env.home, "index.db"))}) return Promise.reject(new Error("publication failed")); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /publication failed/u);
  const retried = await mg(env, ["install", repo.url]);
  assert.equal(retried.code, 0, retried.stderr);
  const loaded = await mg(env, ["load", "react-perf"]);
  assert.equal(loaded.code, 0, loaded.stderr);
});

test("first publication distinguishes interruption before and after rename", async () => {
  for (const checkpoint of ["before", "after"] as const) {
    const env = await setup();
    const repo = await makeRepo();
    const preload = path.join(await tmp(), "interrupt-first-publication.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = async function(from, to) {
  if (to !== ${JSON.stringify(path.join(env.home, "index.db"))}) return rename.call(this, from, to);
  if (${JSON.stringify(checkpoint)} === "after") await rename.call(this, from, to);
  process.kill(process.pid, "SIGKILL");
};
syncBuiltinESMExports();\n`,
    );
    const stopped = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
    assert.notEqual(stopped.code, 0);
    if (checkpoint === "before") {
      assert.deepEqual(JSON.parse((await mg(env, ["list", "--json"])).stdout), { sources: [] });
      const publicationMarker = path.join(env.home, "catalog-published");
      const markerCopy = path.join(await tmp(), "marker");
      await rename(publicationMarker, markerCopy);
      await link(markerCopy, publicationMarker);
      assert.match((await mg(env, ["list", "--json"])).stderr, /index\.db is missing/u);
      await rm(publicationMarker);
      await rename(markerCopy, publicationMarker);
      const owner = (await readdir(env.home)).find((name) => name.endsWith(".tmp.owner"))!;
      const ownerFile = path.join(env.home, owner);
      const outside = path.join(await tmp(), "owner");
      await rename(ownerFile, outside);
      await link(outside, ownerFile);
      assert.match((await mg(env, ["list", "--json"])).stderr, /index\.db is missing/u);
      await rm(ownerFile);
      await rename(outside, ownerFile);
      const retried = await mg(env, ["install", repo.url]);
      assert.equal(retried.code, 0, retried.stderr);
      assert.equal((await mg(env, ["load", "react-perf"])).code, 0);
    } else {
      assert.equal((await mg(env, ["load", "react-perf"])).code, 0);
      await rm(path.join(env.home, "index.db"));
      const missing = await mg(env, ["list", "--json"]);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /index\.db is missing\. Restore the complete store backup/u);
      const retry = await mg(env, ["install", repo.url]);
      assert.equal(retry.code, 1);
      assert.match(retry.stderr, /index\.db is missing\. Restore the complete store backup/u);
    }
  }
});

test("readers recheck the catalog when pending publication changes", async () => {
  for (const change of ["publish", "cleanup"] as const) {
    const env = await setup();
    const repo = await makeRepo();
    const dir = await tmp();
    const stop = path.join(dir, "stop.mjs");
    await writeFile(
      stop,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(env.home, "index.db"))}) process.kill(process.pid, "SIGKILL"); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
    );
    await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", stop] });
    const name = (await readdir(env.home)).find((item) => /^\.catalog-\d+-[0-9a-f]{24}\.tmp$/u.test(item))!;
    const temp = path.join(env.home, name);
    const race = path.join(dir, "race.mjs");
    await writeFile(
      race,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstat;
fs.lstat = async function(file, ...args) {
  if (file === ${JSON.stringify(temp)}) {
    if (${JSON.stringify(change)} === "publish") await fs.rename(file, ${JSON.stringify(path.join(env.home, "index.db"))});
    else { await fs.rm(${JSON.stringify(path.join(env.home, "catalog-published"))}); await fs.rm(file); }
  }
  return lstat.call(this, file, ...args);
};
syncBuiltinESMExports();\n`,
    );
    const result = await runCli(["list", "--json"], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", race] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sources.length, change === "publish" ? 1 : 0);
  }
});

test("cleanup preserves a pending marker while a catalog exists", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  assert.equal((await mg(env, ["install", dir])).code, 0);
  const name = `.catalog-123-${"a".repeat(24)}.tmp`;
  await writeFile(path.join(env.home, name), "owned temporary catalog");
  await writeFile(path.join(env.home, `${name}.owner`), "margrave-catalog-v1\n");
  await writeFile(path.join(env.home, "catalog-published"), `pending ${name}\n`);
  const result = await mg(env, ["reindex"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await mg(env, ["load", "alpha"])).code, 0);
});

test("stage ownership initialization failure leaves the writer reusable", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const preload = path.join(await tmp(), "fail-owner.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql.startsWith("CREATE TABLE owner")) throw new Error("stage initialization failed"); return exec.call(this, sql); };\n`,
  );
  const failed = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /stage initialization failed/u);
  assert.deepEqual(await readdir(path.join(env.home, "staging")), []);
  const retried = await mg(env, ["install", repo.url]);
  assert.equal(retried.code, 0, retried.stderr);
});

test("stage directory creation failure releases the writer lock", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const preload = path.join(await tmp(), "fail-stage-create.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
fs.mkdtemp = () => Promise.reject(Object.assign(new Error("stage creation denied"), { code: "EACCES" }));
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /stage creation denied/u);
  const retried = await mg(env, ["install", repo.url]);
  assert.equal(retried.code, 0, retried.stderr);
});

test("stage cleanup failure still releases the writer lock", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const preload = path.join(await tmp(), "fail-stage-cleanup.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const exec = DatabaseSync.prototype.exec; const rm = fs.rm;
DatabaseSync.prototype.exec = function(sql) { if (sql.startsWith("CREATE TABLE owner")) throw new Error("owner failed"); return exec.call(this, sql); };
fs.rm = function(file, ...args) { if (String(file).startsWith(${JSON.stringify(path.join(env.home, "staging", "s-"))})) return Promise.reject(new Error("stage cleanup failed")); return rm.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /stage cleanup failed/u);
  const retried = await mg(env, ["install", repo.url]);
  assert.equal(retried.code, 0, retried.stderr);
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

test("the next writer repairs a stale managed alias after removal", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = sourceId(installed);
  const alias = path.join(env.home, "sources", id);
  const other = path.join(env.home, "sources", "unrelated");
  await mkdir(other);
  const preload = path.join(await tmp(), "fail-alias.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rm = fs.rm;
fs.rm = function(file, ...args) { if (file === ${JSON.stringify(alias)}) return Promise.reject(new Error("alias cleanup failed")); return rm.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const removed = await runCli(["remove", id], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stderr, /alias cleanup failed/u);
  assert.ok(await readlink(alias));
  await chmod(env.home, 0o555);
  try {
    const view = await mg(env, ["list", "--json"]);
    assert.equal(view.code, 0, view.stderr);
    assert.deepEqual((JSON.parse(view.stdout) as { sources: unknown[] }).sources, []);
  } finally {
    await chmod(env.home, 0o755);
  }
  const repaired = await mg(env, ["reindex"]);
  assert.equal(repaired.code, 0, repaired.stderr);
  await assert.rejects(readlink(alias), { code: "ENOENT" });
  assert.ok((await stat(other)).isDirectory());
});

test("a Git source can be reinstalled after its alias cleanup was interrupted", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  const id = sourceId(installed);
  const alias = path.join(env.home, "sources", id);
  const preload = path.join(await tmp(), "fail-alias.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rm = fs.rm;
fs.rm = function(file, ...args) { if (file === ${JSON.stringify(alias)}) return Promise.reject(new Error("alias cleanup failed")); return rm.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const removed = await runCli(["remove", id], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok(await readlink(alias));
  const reinstalled = await mg(env, ["install", repo.url]);
  assert.equal(reinstalled.code, 0, reinstalled.stderr);
  assert.equal((await mg(env, ["load", "react-perf"])).code, 0);
});

test("an inaccessible Git alias stops installation without publishing", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  const id = sourceId(installed);
  assert.equal((await mg(env, ["remove", id])).code, 0);
  const before = await readFile(path.join(env.home, "index.db"));
  const alias = path.join(env.home, "sources", id);
  const preload = path.join(await tmp(), "fail-alias-stat.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstat;
fs.lstat = function(file, ...args) { if (file === ${JSON.stringify(alias)}) return Promise.reject(Object.assign(new Error("alias denied"), { code: "EACCES" })); return lstat.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /alias denied/u);
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
});

test("installation protects an unexpected Git alias", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  const id = sourceId(installed);
  assert.equal((await mg(env, ["remove", id])).code, 0);
  const alias = path.join(env.home, "sources", id);
  const outside = await tmp();
  for (const kind of ["directory", "link"] as const) {
    if (kind === "directory") await mkdir(alias);
    else await link(outside, alias);
    const failed = await mg(env, ["install", repo.url]);
    assert.equal(failed.code, 1, kind);
    assert.match(failed.stderr, /already installed/u);
    if (kind === "directory") assert.ok((await stat(alias)).isDirectory());
    else assert.equal(await readlink(alias), outside);
    await rm(alias, { recursive: true });
  }
});

test("failure to publish catalog evidence leaves the published catalog readable", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  const preload = path.join(await tmp(), "fail-marker.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
let markers = 0;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(env.home, "catalog-published"))} && ++markers === 2) return Promise.reject(new Error("marker rename failed")); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["install", dir], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /marker rename failed/u);
  assert.equal((await mg(env, ["load", "alpha"])).code, 0);
  assert.equal((await mg(env, ["reindex"])).code, 0);
});

test("a non-Error alias failure is reported after publication", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const preload = path.join(await tmp(), "fail-alias-value.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const symlink = fs.symlink;
fs.symlink = function(target, file, ...args) { if (String(file).endsWith(".new")) return Promise.reject("alias unavailable"); return symlink.call(this, target, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const installed = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stderr, /compatibility link could not be updated: alias unavailable/u);
  assert.equal((await mg(env, ["load", "react-perf"])).code, 0);
  assert.equal((await mg(env, ["reindex"])).code, 0);
});

test("temporary catalog cleanup failure releases the writer lock after publication", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const preload = path.join(await tmp(), "fail-cleanup.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rm = fs.rm;
fs.rm = function(file, ...args) { if (String(file).includes('/.catalog-')) return Promise.reject(new Error("cleanup failed")); return rm.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /cleanup failed/u);
  await chmod(env.home, 0o555);
  try {
    const loaded = await mg(env, ["load", "react-perf"]);
    assert.equal(loaded.code, 0, loaded.stderr);
  } finally {
    await chmod(env.home, 0o755);
  }
  const retried = await mg(env, ["reindex"]);
  assert.equal(retried.code, 0, retried.stderr);
});

test("a directory sync failure after publication retains the published snapshot", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  const id = sourceId(installed);
  await writeSkill(path.join(repo.dir, "skills"), "react-perf", "sync failure update");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-qm", "new skill");
  const preload = path.join(await tmp(), "fail-sync.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const open = fs.open; const rename = fs.rename; let published = false;
fs.rename = async function(from, to) { await rename.call(this, from, to); if (to === ${JSON.stringify(path.join(env.home, "index.db"))}) published = true; };
fs.open = async function(file, ...args) { const handle = await open.call(this, file, ...args); if (published && file === ${JSON.stringify(env.home)}) handle.sync = async () => { throw new Error("directory sync failed"); }; return handle; };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["update", id], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /directory sync failed/u);
  const loaded = await mg(env, ["load", "react-perf"]);
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.match(loaded.stdout, /sync failure update/u);
  const repaired = await mg(env, ["reindex"]);
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.match(await readFile(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"), "utf8"), /sync failure update/u);
});

test("migration accepts a store reached through a directory symlink", async () => {
  const root = await tmp();
  const store = path.join(root, "store");
  const alias = path.join(root, "store-link");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), store, { recursive: true, verbatimSymlinks: true });
  await link(store, alias);
  const migrated = await runCli(["migrate"], { home: alias });
  assert.equal(migrated.code, 0, migrated.stderr);
  const loaded = await runCli(["load", "release-upgrade"], { home: alias });
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.match(loaded.stdout, /The installed upgrade skill survived/u);
});

test("a reader held across publication keeps the old catalog", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = sourceId(installed);
  const db = new DatabaseSync(path.join(env.home, "index.db"), { readOnly: true });
  try {
    db.exec("BEGIN");
    const before = db.prepare("SELECT hash FROM skills WHERE id = ?").get(`${id}/react-perf`);
    await writeSkill(path.join(repo.dir, "skills"), "react-perf", "Changed description");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-qm", "change skill");
    const updated = await mg(env, ["update", id]);
    assert.equal(updated.code, 0, updated.stderr);
    assert.deepEqual(db.prepare("SELECT hash FROM skills WHERE id = ?").get(`${id}/react-perf`), before);
    const current = new DatabaseSync(path.join(env.home, "index.db"), { readOnly: true });
    try {
      assert.notDeepEqual(current.prepare("SELECT hash FROM skills WHERE id = ?").get(`${id}/react-perf`), before);
    } finally {
      current.close();
    }
  } finally {
    db.close();
  }
});

test("a writer retries while the separate store lock is held", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const lock = new DatabaseSync(path.join(env.home, "writer-lock.db"));
  lock.exec("BEGIN IMMEDIATE");
  const scratch = await tmp();
  const signal = path.join(scratch, "busy");
  const preload = path.join(scratch, "observe-lock.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { try { return exec.call(this, sql); } catch (err) { if (sql === "BEGIN IMMEDIATE" && err.errcode === 5) writeFileSync(${JSON.stringify(signal)}, "busy"); throw err; } };\n`,
  );
  try {
    const installing = runCli(["install", repo.url], { home: env.home, fakeBin: env.fakeBin, nodeArgs: ["--import", preload] });
    const deadline = Date.now() + 10_000;
    while (
      !(await stat(signal).then(
        () => true,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < deadline, "writer did not encounter the held lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    lock.exec("COMMIT");
    const result = await installing;
    assert.equal(result.code, 0, result.stderr);
  } finally {
    lock.close();
  }
});

test("a writer cleans abandoned stages but preserves live and unrelated directories", async () => {
  const env = await setup();
  const staging = path.join(env.home, "staging");
  await mkdir(staging);
  const createStage = async (name: string): Promise<DatabaseSync> => {
    const dir = path.join(staging, name);
    await mkdir(dir);
    const db = new DatabaseSync(path.join(dir, ".margrave-owner.db"));
    db.exec("CREATE TABLE owner(name TEXT NOT NULL)");
    db.prepare("INSERT INTO owner(name) VALUES (?)").run(name);
    return db;
  };
  const abandoned = await createStage("s-Ab1234");
  abandoned.close();
  const live = await createStage("s-Cd5678");
  live.exec("BEGIN IMMEDIATE");
  await mkdir(path.join(staging, "unrelated"));
  await mkdir(path.join(staging, "s-Ef9012"));
  const mismatched = await createStage("s-Gh3456");
  mismatched.exec("UPDATE owner SET name = 'different'");
  mismatched.close();
  await mkdir(path.join(staging, "s-Ij7890"));
  await writeFile(path.join(staging, "s-Ij7890", ".margrave-owner.db"), "not a database");
  await mkdir(path.join(staging, "s-Kl1234"));
  const unrelatedDb = new DatabaseSync(path.join(staging, "s-Kl1234", ".margrave-owner.db"));
  unrelatedDb.exec("CREATE TABLE unrelated(value TEXT)");
  unrelatedDb.close();
  try {
    const result = await mg(env, ["reindex"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((await readdir(staging)).sort(), ["s-Cd5678", "s-Ef9012", "s-Gh3456", "s-Ij7890", "s-Kl1234", "unrelated"]);
  } finally {
    live.close();
  }
});

test("a writer cleans owned catalog temporaries and preserves unrelated objects", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  const owned = path.join(env.home, `.catalog-123-${"a".repeat(24)}.tmp`);
  const unowned = path.join(env.home, `.catalog-456-${"b".repeat(24)}.tmp`);
  const protectedPath = path.join(env.home, `.catalog-789-${"c".repeat(24)}.tmp`);
  const malformed = path.join(env.home, `.catalog-987-${"d".repeat(24)}.tmp`);
  const outside = path.join(await tmp(), "outside");
  await writeFile(owned, "temporary catalog");
  await writeFile(`${owned}-journal`, "temporary journal");
  await writeFile(`${owned}.owner`, "margrave-catalog-v1\n");
  await writeFile(unowned, "unrelated bytes");
  await writeFile(outside, "protected bytes");
  await link(outside, protectedPath);
  await writeFile(`${protectedPath}.owner`, "margrave-catalog-v1\n");
  await writeFile(malformed, "unrelated catalog");
  await writeFile(`${malformed}.owner`, "not a Margrave owner");
  const result = await mg(env, ["reindex"]);
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(readFile(owned), { code: "ENOENT" });
  await assert.rejects(readFile(`${owned}-journal`), { code: "ENOENT" });
  await assert.rejects(readFile(`${owned}.owner`), { code: "ENOENT" });
  assert.equal(await readFile(unowned, "utf8"), "unrelated bytes");
  assert.equal(await readFile(outside, "utf8"), "protected bytes");
  assert.equal(await readFile(malformed, "utf8"), "unrelated catalog");
  assert.equal(await readlink(protectedPath), outside);
  assert.equal((await mg(env, ["load", "alpha"])).code, 0);
});

test("a killed writer leaves an owned catalog copy that the next writer removes", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  await writeSkill(dir, "beta", "beta skill");
  const preload = path.join(await tmp(), "kill-before-publish.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(env.home, "index.db"))}) process.kill(process.pid, "SIGKILL"); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  const killed = await runCli(["reindex"], { home: env.home, nodeArgs: ["--import", preload] });
  assert.equal(killed.code, 1);
  assert.ok((await readdir(env.home)).some((name) => name.endsWith(".tmp.owner")));
  await chmod(env.home, 0o555);
  try {
    const before = await mg(env, ["list", "--skills"]);
    assert.equal(before.code, 0, before.stderr);
    assert.match(before.stdout, /alpha/u);
    assert.doesNotMatch(before.stdout, /beta/u);
  } finally {
    await chmod(env.home, 0o755);
  }
  const retry = await mg(env, ["reindex"]);
  assert.equal(retry.code, 0, retry.stderr);
  assert.ok(!(await readdir(env.home)).some((name) => name.startsWith(".catalog-")));
  assert.match((await mg(env, ["list", "--skills"])).stdout, /beta/u);
});

test("a staging cleanup access failure keeps the catalog and releases the lock", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  const before = await readFile(path.join(env.home, "index.db"));
  const preload = path.join(await tmp(), "fail-staging-read.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const readdir = fs.readdir;
fs.readdir = function(file, ...args) { if (file === ${JSON.stringify(path.join(env.home, "staging"))}) return Promise.reject(Object.assign(new Error("staging denied"), { code: "EACCES" })); return readdir.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["reindex"], { home: env.home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /staging denied/u);
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
  const retried = await mg(env, ["reindex"]);
  assert.equal(retried.code, 0, retried.stderr);
});

test("an unreadable stage ownership file stops cleanup without deleting it", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  const stage = path.join(env.home, "staging", "s-Ab1234");
  await mkdir(stage);
  const owner = path.join(stage, ".margrave-owner.db");
  await writeFile(owner, "protected");
  const preload = path.join(await tmp(), "fail-owner-stat.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstat;
fs.lstat = function(file, ...args) { if (file === ${JSON.stringify(owner)}) return Promise.reject(Object.assign(new Error("owner denied"), { code: "EACCES" })); return lstat.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["reindex"], { home: env.home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /owner denied/u);
  assert.equal(await readFile(owner, "utf8"), "protected");
});

test("unexpected SQLite errors during stage cleanup stop publication", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  const stage = path.join(env.home, "staging", "s-Ab1234");
  await mkdir(stage);
  const owner = new DatabaseSync(path.join(stage, ".margrave-owner.db"));
  owner.exec("CREATE TABLE owner(name TEXT NOT NULL)");
  owner.prepare("INSERT INTO owner(name) VALUES (?)").run("s-Ab1234");
  owner.close();
  const preload = path.join(await tmp(), "fail-stage-db.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) { if (sql === "SELECT name FROM owner") throw Object.assign(new Error("stage database I/O error"), { errcode: 10 }); return prepare.call(this, sql); };\n`,
  );
  const before = await readFile(path.join(env.home, "index.db"));
  const failed = await runCli(["reindex"], { home: env.home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /stage database I\/O error/u);
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
  const retried = await mg(env, ["reindex"]);
  assert.equal(retried.code, 0, retried.stderr);
});

test("migration rejects changed legacy skill bytes without publishing", async () => {
  const home = path.join(await tmp(), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const before = await readFile(path.join(home, "index.db"));
  const source = "example.invalid__fixtures__margrave-upgrade";
  await writeFile(path.join(home, "sources", source, "release-upgrade", "SKILL.md"), "changed bytes");
  const result = await runCli(["migrate"], { home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot upgrade source "example\.invalid__fixtures__margrave-upgrade"/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
});

test("schema 3 migration rebuilds search and preserves accepted Git records", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const before = await snapshot(env.home);
  const db = new DatabaseSync(path.join(env.home, "index.db"));
  db.exec(
    "DROP TABLE fts; CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='unicode61'); PRAGMA user_version = 3",
  );
  db.close();
  const source = sourceId(installed);
  const skill = path.join(env.home, "sources", source, "skills", "react-perf", "SKILL.md");
  const accepted = await readFile(skill);
  const oldCatalog = await readFile(path.join(env.home, "index.db"));
  await writeFile(skill, "changed bytes");
  const rejected = await mg(env, ["migrate"]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /cannot upgrade source/u);
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), oldCatalog);
  await writeFile(skill, accepted);
  const migrated = await mg(env, ["migrate"]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.deepEqual(await snapshot(env.home), before);
  assert.match((await mg(env, ["find", "react-perf"])).stdout, /react-perf/u);
});

test("schema 3 migration refuses changed local content without publication", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "Original description");
  assert.equal((await mg(env, ["install", dir])).code, 0);
  const db = new DatabaseSync(path.join(env.home, "index.db"));
  db.exec("PRAGMA user_version = 3");
  db.close();
  const before = await readFile(path.join(env.home, "index.db"));
  await writeSkill(dir, "alpha", "Changed description");
  const result = await mg(env, ["migrate"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot upgrade source/u);
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
});

test("schema 3 migration rejects selection metadata", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "Alpha skill");
  const installed = await mg(env, ["install", dir]);
  assert.equal(installed.code, 0, installed.stderr);
  const records = catalogRecords(env.home);
  records[0]!.selection = ["alpha"];
  writeCatalogRecords(env.home, records);
  const db = new DatabaseSync(path.join(env.home, "index.db"));
  db.exec("PRAGMA user_version = 3");
  db.close();
  const before = await readFile(path.join(env.home, "index.db"));
  const result = await mg(env, ["migrate"]);
  assert.match(result.stderr, /cannot upgrade source/u);
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
});

test("migration preserves a legacy local source with no indexed skills", async () => {
  const home = path.join(await tmp(), "store");
  const local = await tmp();
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const record = {
    id: "local__empty-123456",
    kind: "local",
    spec: local,
    path: local,
    subpath: "",
    ref: null,
    commit: null,
    installedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(path.join(home, "sources.json"), JSON.stringify([record]));
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("DELETE FROM fts; DELETE FROM skills");
  db.close();
  const conflicting = path.join(await tmp(), "store");
  await cp(home, conflicting, { recursive: true, verbatimSymlinks: true });
  const migrated = await runCli(["migrate"], { home });
  assert.equal(migrated.code, 0, migrated.stderr);
  const list = await runCli(["list", "--json"], { home });
  assert.equal(list.code, 0, list.stderr);
  const result = JSON.parse(list.stdout) as { sources: { id: string; skillCount: number }[] };
  assert.equal(result.sources[0]?.id, record.id);
  assert.equal(result.sources[0]?.skillCount, 0);
  await writeSkill(local, "new-skill", "unindexed skill");
  const rejected = await runCli(["migrate"], { home: conflicting });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /cannot upgrade source "local__empty-123456"/u);
});

test("migration preserves a Git skill at the snapshot root", async () => {
  const home = path.join(await tmp(), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const source = "example.invalid__fixtures__margrave-upgrade";
  const records = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { snapshot: string }[];
  const snapshotDir = path.join(home, "snapshots", source, records[0]!.snapshot);
  await rename(path.join(snapshotDir, "release-upgrade", "SKILL.md"), path.join(snapshotDir, "SKILL.md"));
  await rm(path.join(snapshotDir, "release-upgrade"), { recursive: true });
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("UPDATE skills SET dir = substr(dir, 1, length(dir) - length('/release-upgrade'))");
  db.close();
  const migrated = await runCli(["migrate"], { home });
  assert.equal(migrated.code, 0, migrated.stderr);
  const loaded = await runCli(["load", "release-upgrade"], { home });
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.match(loaded.stdout, /The installed upgrade skill survived/u);
});

test("migration refuses incomplete and conflicting legacy catalogs", async () => {
  const source = "example.invalid__fixtures__margrave-upgrade";
  const cases: { name: string; mutate: (home: string) => Promise<void> | void; expected: RegExp }[] = [
    { name: "missing source file", mutate: async (home) => rm(path.join(home, "sources.json")), expected: /sources\.json is missing/u },
    {
      name: "legacy scan provenance",
      mutate: async (home) => {
        const file = path.join(home, "sources.json");
        const records = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
        records[0]!["scan"] = { code: 0, files: [], keys: [], overridden: false, tree: null, verdict: "clean", version: null };
        await writeFile(file, JSON.stringify(records));
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "malformed source file",
      mutate: async (home) => writeFile(path.join(home, "sources.json"), "invalid json"),
      expected: /cannot upgrade the v0\.2\.1 catalog/u,
    },
    {
      name: "source identity mismatch",
      mutate: async (home) => {
        const file = path.join(home, "sources.json");
        const records = JSON.parse(await readFile(file, "utf8")) as { spec: string }[];
        records[0]!.spec = "other/repo";
        await writeFile(file, JSON.stringify(records));
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "duplicate source record",
      mutate: async (home) => {
        const file = path.join(home, "sources.json");
        const records = JSON.parse(await readFile(file, "utf8")) as unknown[];
        await writeFile(file, JSON.stringify([...records, records[0]]));
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "unknown indexed source",
      mutate: (home) => {
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.exec(
          "INSERT INTO skills(id, id_lc, name, name_lc, description, source, dir, hash, manifest, frontmatter) VALUES ('unknown/x', 'unknown/x', 'x', 'x', '', 'unknown', '/x', 'h', '[]', '')",
        );
        db.close();
      },
      expected: /index contains an unknown source/u,
    },
    {
      name: "indexed path escape",
      mutate: (home) => {
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.exec("UPDATE skills SET dir = dir || '/../../escape'");
        db.close();
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "indexed path with a different skill directory",
      mutate: (home) => {
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.exec("UPDATE skills SET dir = replace(dir, '/release-upgrade', '/different')");
        db.close();
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "indexed path with an invalid snapshot suffix",
      mutate: async (home) => {
        const records = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { snapshot: string }[];
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.prepare("UPDATE skills SET dir = replace(dir, ?, ?)").run(records[0]!.snapshot, `${records[0]!.snapshot}-other`);
        db.close();
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "snapshot symlink escape",
      mutate: async (home) => {
        const records = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { snapshot: string }[];
        const snapshotDir = path.join(home, "snapshots", source, records[0]!.snapshot);
        const outside = path.join(await tmp(), "outside");
        await rename(snapshotDir, outside);
        await link(outside, snapshotDir);
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "interrupted legacy write",
      mutate: async (home) => writeFile(path.join(home, "index.db-journal"), "unfinished"),
      expected: /unfinished v0\.2\.1 write/u,
    },
  ];
  for (const [column, value] of [
    ["id", "different/id"],
    ["hash", `sha256:${"0".repeat(64)}`],
    ["manifest", "[]"],
    ["name", "different-name"],
    ["description", "different description"],
    ["frontmatter", "different frontmatter"],
    ["dir", "relative/path"],
    ["dir", "/tmp/outside"],
  ]) {
    cases.push({
      name: `changed ${column}`,
      mutate: (home) => {
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.prepare(`UPDATE skills SET ${column} = ?`).run(value!);
        db.close();
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    });
  }
  for (const item of cases) {
    const home = path.join(await tmp(), "store");
    await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
    await item.mutate(home);
    const before = await readFile(path.join(home, "index.db"));
    const result = await runCli(["migrate"], { home });
    assert.equal(result.code, 1, item.name);
    assert.match(result.stderr, item.expected, item.name);
    assert.deepEqual(await readFile(path.join(home, "index.db")), before, item.name);
  }
  const empty = await tmp();
  const current = await runCli(["migrate"], { home: empty });
  assert.equal(current.code, 0, current.stderr);
  assert.equal(current.stdout, "store is current\n");
  await writeFile(path.join(empty, "sources.json"), "[]");
  const missing = await runCli(["migrate"], { home: empty });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /index\.db is missing/u);
  await writeFile(path.join(empty, "index.db"), "");
  const unsupported = await runCli(["migrate"], { home: empty });
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.stderr, /not a supported margrave catalog/u);
});

test("migration retries after temporary catalog setup fails", async () => {
  const home = path.join(await tmp(), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(await tmp(), "fail-journal.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "PRAGMA journal_mode = DELETE") throw new Error("journal configuration failed"); return exec.call(this, sql); };\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /journal configuration failed/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  assert.ok(!(await readdir(home)).some((name) => name.startsWith(".catalog-")));
  const retried = await runCli(["migrate"], { home });
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(retried.stdout, "store upgraded\n");
});

test("migration rolls back a failed temporary catalog transaction", async () => {
  const home = path.join(await tmp(), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(await tmp(), "fail-migration-commit.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "PRAGMA user_version = 4; COMMIT") throw new Error("migration commit failed"); return exec.call(this, sql); };\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /migration commit failed/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  assert.ok(!(await readdir(home)).some((name) => name.startsWith(".catalog-")));
  assert.equal((await runCli(["migrate"], { home })).code, 0);
});

test("migration reports source metadata access failures without changing the store", async () => {
  for (const legacyIndex of [false, true]) {
    const home = path.join(await tmp(), "store");
    await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
    const index = path.join(home, "index.db");
    if (!legacyIndex) await rm(index);
    const before = legacyIndex ? await readFile(index) : null;
    const source = path.join(home, "sources.json");
    const preload = path.join(await tmp(), "fail-source-stat.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstat;
fs.lstat = function(file, ...args) { if (file === ${JSON.stringify(source)}) return Promise.reject(Object.assign(new Error("source metadata denied"), { code: "EACCES" })); return lstat.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
    );
    const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /source metadata denied/u);
    if (before !== null) assert.deepEqual(await readFile(index), before);
    else await assert.rejects(readFile(index), { code: "ENOENT" });
  }
});

test("migration reports a non-Error metadata read failure", async () => {
  const home = path.join(await tmp(), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(await tmp(), "fail-source-read.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const readFile = fs.readFile;
fs.readFile = function(file, ...args) { if (file === ${JSON.stringify(path.join(home, "sources.json"))}) return Promise.reject("source read failed"); return readFile.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /cannot upgrade the v0\.2\.1 catalog: source read failed/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
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

test("check and explicit Git tracking refs", async () => {
  const env = await setup();
  const repo = await makeRepo();
  await git(repo.dir, "branch", "refs/topic");
  await git(repo.dir, "tag", "-a", "shared", "-m", "tag");
  await git(repo.dir, "branch", "shared");
  const sharedEnv = await setup();
  const shared = await mg(sharedEnv, ["install", repo.url, "--ref", "shared"]);
  assert.equal(shared.code, 0, shared.stderr);
  const sharedRecords = catalogRecords(sharedEnv.home);
  assert.equal(sharedRecords[0]?.ref, "refs/heads/shared");
  const inst = await mg(env, ["install", repo.url, "--ref", "refs/topic"]);
  assert.equal(inst.code, 0, inst.stderr);
  const id = sourceId(inst);
  const indexFile = path.join(env.home, "index.db");
  const record = (): ReturnType<typeof catalogRecords> => catalogRecords(env.home);
  assert.equal(record()[0]?.ref, "refs/heads/refs/topic");
  const taggedCommit = record()[0]?.commit;
  const before = await storeFiles(env.home);
  const current = await mg(env, ["check", id, "--json"]);
  assert.equal(current.code, 0, current.stderr);
  assert.equal((JSON.parse(current.stdout) as { updateAvailable: boolean }[])[0]?.updateAvailable, false);
  assert.deepEqual(await storeFiles(env.home), before);
  const originalSources = catalogRecords(env.home);
  const invalidRecords = structuredClone(originalSources);
  assert.ok(invalidRecords[0]);
  invalidRecords[0].ref = "refs/heads/bad..ref";
  writeCatalogRecords(env.home, invalidRecords);
  assert.equal((await mg(env, ["check", id])).code, 1);
  writeCatalogRecords(env.home, originalSources);
  await writeSkill(path.join(repo.dir, "skills"), "branch-only", "A branch skill");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-qm", "branch commit");
  await git(repo.dir, "branch", "-f", "shared", "HEAD");
  const tag = await mg(env, ["update", id, "--ref", "refs/tags/shared"]);
  assert.equal(tag.code, 0, tag.stderr);
  assert.equal(record()[0]?.ref, "refs/tags/shared");
  assert.equal(record()[0]?.commit, taggedCommit);
  assert.equal((await mg(env, ["check", id])).code, 0);
  await git(repo.dir, "tag", "-d", "shared");
  const missingBefore = await storeFiles(env.home);
  assert.equal((await mg(env, ["check", id])).code, 1);
  const missingJson = await mg(env, ["check", id, "--json"]);
  assert.equal(missingJson.code, 1);
  assert.ok((JSON.parse(missingJson.stdout) as { error: string | null }[])[0]?.error);
  assert.deepEqual(await storeFiles(env.home), missingBefore);
  const failed = await mg(env, ["update", id, "--ref", "refs/heads/missing"]);
  assert.equal(failed.code, 1);
  assert.equal(record()[0]?.ref, "refs/tags/shared");
  const branch = await mg(env, ["update", id, "--ref", "refs/heads/shared"]);
  assert.equal(branch.code, 0, branch.stderr);
  assert.equal(record()[0]?.commit, await head(repo.dir));
  await writeSkill(path.join(repo.dir, "skills"), "later", "A later skill");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-qm", "later commit");
  await git(repo.dir, "branch", "-f", "shared", "HEAD");
  const available = await mg(env, ["check", id]);
  assert.equal(available.code, 1);
  assert.match(available.stdout, /update available/u);
  assert.equal((await mg(env, ["update", "--ref", "refs/heads/main"])).code, 2);
  assert.equal((await mg(env, ["update", id, "--ref", "main"])).code, 2);
  assert.equal((await mg(env, ["update", id, "--ref", "refs/heads/bad..ref"])).code, 2);
  await writeFile(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"), skillMd("react-perf", "changed"));
  const driftBefore = [JSON.stringify(catalogRecords(env.home)), await readFile(indexFile)];
  const drift = await mg(env, ["check", id, "--json"]);
  assert.equal(drift.code, 1, drift.stderr);
  assert.deepEqual((JSON.parse(drift.stdout) as { changed: string[] }[])[0]?.changed, [`${id}/react-perf`]);
  assert.equal((JSON.parse(drift.stdout) as { updateAvailable: boolean }[])[0]?.updateAvailable, true);
  assert.deepEqual([JSON.stringify(catalogRecords(env.home)), await readFile(indexFile)], driftBefore);
});

test("check reports local additions, removals, and supporting file changes", async () => {
  const env = await setup();
  const empty = await mg(env, ["check"]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /no skill sources installed/u);
  const invalidLock = await mg(env, ["lock", "invalid"]);
  assert.equal(invalidLock.code, 2);
  assert.match(invalidLock.stderr, /expected lock export or lock restore/u);
  const root = await tmp("mg-local-");
  await writeSkill(root, "old", "Old skill");
  await writeSkill(root, "kept", "Kept skill");
  const inst = await mg(env, ["install", root]);
  assert.equal(inst.code, 0, inst.stderr);
  const id = sourceId(inst);
  await writeFile(path.join(root, "kept", "support.txt"), "new bytes");
  await rm(path.join(root, "old"), { recursive: true });
  await writeSkill(root, "new", "New skill");
  const before = [JSON.stringify(catalogRecords(env.home)), await readFile(path.join(env.home, "index.db"))];
  const checked = await mg(env, ["check", root, "--json"]);
  assert.equal(checked.code, 1, checked.stderr);
  const rows = JSON.parse(checked.stdout) as { added: string[]; changed: string[]; removed: string[] }[];
  assert.deepEqual(rows[0]?.added, [`${id}/new`]);
  assert.deepEqual(rows[0]?.changed, [`${id}/kept`]);
  assert.deepEqual(rows[0]?.removed, [`${id}/old`]);
  const text = await mg(env, ["check", id]);
  assert.equal(text.code, 1, text.stderr);
  assert.match(text.stdout, new RegExp(`added: ${id}/new`, "u"));
  assert.match(text.stdout, new RegExp(`changed: ${id}/kept`, "u"));
  assert.match(text.stdout, new RegExp(`removed: ${id}/old`, "u"));
  assert.deepEqual([JSON.stringify(catalogRecords(env.home)), await readFile(path.join(env.home, "index.db"))], before);
  assert.equal((await mg(env, ["update", id, "--ref", "refs/heads/main"])).code, 2);
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

test("a malformed or missing catalog requires restoration from a backup", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill");
  assert.equal((await mg(env, ["install", dir])).code, 0);
  const backup = await readFile(path.join(env.home, "index.db"));
  await writeFile(path.join(env.home, "index.db"), "{ broken");
  const r = await mg(env, ["find", "alpha"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /index\.db is not a supported margrave catalog/u);
  assert.equal((await mg(env, ["reindex"])).code, 1, "reindex does not replace a file that is not ours");
  await rename(path.join(env.home, "index.db"), path.join(env.home, "index.db.aside"));
  assert.equal((await mg(env, ["reindex"])).code, 1);
  const missing = await mg(env, ["find", "alpha"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /index\.db is missing\. Restore the complete store backup/u);
  await writeFile(path.join(env.home, "index.db"), backup);
  assert.equal((await mg(env, ["find", "alpha"])).code, 0);
});

test("atomic writes leave no temp file and a reader never sees a partial file", async () => {
  const dir = await tmp("mg-atomic-");
  const file = path.join(dir, "data.json");
  const big = (n: number): string => JSON.stringify({ n, pad: "x".repeat(200_000) });
  await atomicWrite(file, big(0));
  let stop = false;
  const writer = (async () => {
    // oxlint-disable-next-line no-unmodified-loop-condition -- `stop` is set by the reader below while the writer runs
    for (let i = 1; i <= 40 && !stop; i++) await atomicWrite(file, big(i));
  })();
  let reads = 0;
  for (;;) {
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

test("list errors when index.db is gone, instead of printing skills=0", async () => {
  const env = await setup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  await rm(path.join(env.home, "index.db"));
  for (const args of [["list"], ["list", "--skills"], ["list", "--json", "--skills"]]) {
    const r = await mg(env, args);
    assert.equal(r.code, 1, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    assert.match(r.stderr, /index\.db is missing\. Restore the complete store backup/u, args.join(" "));
  }
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

test("git source: reindex rescans the stored copy, and skips it when the copy is gone", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const id = sourceId(await mg(env, ["install", repo.url]));
  const re = await mg(env, ["reindex"]);
  assert.equal(re.code, 0, re.stderr);
  assert.equal(re.stdout.trim(), "reindexed 3 skills from 1 sources");

  await rm(await realpath(path.join(env.home, "sources", id)), { recursive: true });
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

test("a sources.json record with no url, no path, or an unknown kind stops every command that reads it", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  const base = { spec: "x", subpath: "", ref: null, commit: null, installedAt: "now" };
  const records: Record<string, unknown> = {
    "a git record without url": { ...base, id: "bad__git", kind: "git" },
    "a local record without path": { ...base, id: "bad__local", kind: "local" },
    "a record of an unknown kind": { ...base, id: "bad__kind", kind: "svn", url: "u", path: "/p" },
  };
  for (const [why, record] of Object.entries(records)) {
    const db = new DatabaseSync(path.join(env.home, "index.db"));
    db.prepare("UPDATE sources SET record = ?").run(JSON.stringify(record));
    db.close();
    const before = await readFile(path.join(env.home, "index.db"));
    const id = (record as { id: string }).id;
    for (const args of [["update"], ["update", id], ["remove", id], ["reindex"], ["list"]]) {
      const r = await mg(env, args);
      assert.equal(r.code, 1, `${why}: ${args.join(" ")}`);
      assert.match(r.stderr, /malformed source records/u, `${why}: ${args.join(" ")}`);
    }
    assert.deepEqual(await readFile(path.join(env.home, "index.db")), before, `${why}: catalog is unchanged`);
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

test("concurrent Git updates retain the active and retired snapshots", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const id = sourceId(await mg(env, ["install", repo.url]));
  await writeSkill(path.join(repo.dir, "skills"), "react-perf", "concurrent update");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-qm", "concurrent");
  const results = await Promise.all([mg(env, ["update", id]), mg(env, ["update", id])]);
  assert.ok(results.some((result) => result.code === 0));
  for (const result of results) {
    if (result.code !== 0) assert.match(result.stderr, /source changed during update; run margrave update again/u);
  }
  const records = catalogRecords(env.home);
  const snapshots = await names(path.join(env.home, "snapshots", id));
  assert.ok(snapshots.includes(records[0]!.snapshot!));
  assert.ok(snapshots.length >= 2);
  assert.match(await readFile(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"), "utf8"), /concurrent update/u);
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

test("lock export rejects a Git record without a snapshot", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const records = catalogRecords(env.home);
  delete records[0]!.snapshot;
  writeCatalogRecords(env.home, records);
  const before = await readFile(path.join(env.home, "index.db"));
  for (const args of [["reindex"], ["lock", "export"]]) {
    const result = await mg(env, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /malformed/u);
  }
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
});

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

test("lock export requires explicit Git selection in mixed stores", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  const id = sourceId(installed);
  const local = await tmp();
  await writeSkill(local, "local", "Local skill");
  const localInstall = await mg(env, ["install", local]);
  const localId = sourceId(localInstall);
  assert.match((await mg(env, ["lock", "export"])).stderr, /select Git sources with --source/u);
  for (const selected of [localId, "missing"])
    assert.match((await mg(env, ["lock", "export", "--source", selected])).stderr, /--source must be an installed Git source ID/u);
  const exported = await mg(env, ["lock", "export", "--source", id]);
  assert.equal(exported.code, 0, exported.stderr);
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
