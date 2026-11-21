import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fsp, { readFile, readdir, chmod, mkdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { findSource, resolveScanRoot, sourceDir, installSource, localId, reindexAll, removeSource, updateSources } from "../src/sources.ts";
import { UsageError } from "../src/store.ts";
import type { SourceRecord } from "../src/store.ts";
import {
  changeAtLock,
  catalogRecords,
  fakeRipwire,
  git,
  indexIds,
  indexRows,
  makeRepo,
  realExec,
  runCli,
  seedIndex,
  tmp,
  writeCatalogRecords,
  writeSkill,
  quiet,
  inStore,
  failRename,
  passRename,
  read,
  link,
  cliSetup as setup,
  cliMg as mg,
  names,
  sourceId,
  installLocalDir,
} from "./helpers.ts";

/** Make the COMMIT statement of any DatabaseSync throw. Other statements run. */
export function failCommit(): void {
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") throw new Error("mock: COMMIT failed");
    return realExec.call(this, sql);
  });
}

test("source realpath access errors stay visible", async (t) => {
  const prev = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const root = await tmp("mg-source-");
  await writeSkill(root, "alpha", "skill");
  const result = await runCli(["install", root], { home, fakeBin: await fakeRipwire() });
  assert.equal(result.code, 0, result.stderr);
  const original = fsp.realpath;
  const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
  mock.method(fsp, "realpath", ((p: string, ...args: unknown[]) =>
    p === root || p === path.join(root, "alpha")
      ? Promise.reject(denied)
      : (original as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.realpath);
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  await assert.rejects(updateSources(localId(root), { log: () => {}, allowUnsafe: false }), /access denied/u);
  await assert.rejects(resolveScanRoot(root, "alpha"), /access denied/u);
});

test("sourceDir only returns a direct child of sources/", async () => {
  process.env["MARGRAVE_HOME"] = await tmp();
  assert.equal(path.dirname(sourceDir("owner__repo")), path.join(process.env["MARGRAVE_HOME"], "sources"));
  for (const bad of ["..", ".", "", "a/b", "../x", "a b"]) assert.throws(() => sourceDir(bad), UsageError, bad);
});

test("findSource accepts an id or the original spec", () => {
  const rec = (id: string, spec: string): SourceRecord => ({
    id,
    kind: "git",
    spec,
    url: "u",
    subpath: "",
    ref: null,
    commit: "abc",
    installedAt: "now",
  });
  const list = [rec("o__r", "o/r"), rec("o__q", "o/q")];
  assert.equal(findSource(list, "o__r").id, "o__r");
  assert.equal(findSource(list, "o/q").id, "o__q");
  assert.throws(() => findSource(list, "zzz"), /no source/u);
  assert.throws(() => findSource([rec("a", "same"), rec("b", "same")], "same"), /several sources/u);
});

test("install: when catalog publication fails, the old catalog stays", async (t) => {
  await inStore(t, async (home) => {
    const first = await tmp("mg-localsrc-");
    await writeSkill(first, "alpha", "alpha skill");
    const second = await tmp("mg-localsrc2-");
    await writeSkill(second, "beta", "beta skill");

    // A store with no sources: the failed install leaves an empty index and no sources.json.
    failRename((_from, to) => to.endsWith("index.db"));
    await assert.rejects(installSource(first, null, quiet), /mock: cannot rename to .*index\.db/u);
    await assert.rejects(readFile(path.join(home, "index.db")), { code: "ENOENT" });
    assert.equal(await read(home, "sources.json"), null);

    // A store with an index: the old rows and the old sources.json stay.
    passRename();
    await installSource(first, null, quiet);
    const ids = indexIds(home);
    const sources = await read(home, "sources.json");
    assert.equal(ids.length, 1);
    failRename((_from, to) => to.endsWith("index.db"));
    await assert.rejects(installSource(second, null, quiet), /mock: cannot rename to .*index\.db/u);
    assert.deepEqual(indexIds(home), ids);
    assert.equal(await read(home, "sources.json"), sources);
  });
});

test("remove rolls back a moved Git alias when commit fails", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const alias = path.join(home, "sources", id);
    const target = await fsp.readlink(alias);
    const before = await read(home, "sources.json");
    const rows = indexRows(home);
    failCommit();
    await assert.rejects(removeSource(id), /mock: COMMIT failed/u);
    passRename();
    assert.equal(await fsp.readlink(alias), target);
    assert.equal(await read(home, "sources.json"), before);
    assert.deepEqual(indexRows(home), rows);
  });
});

test("Git update preserves the old alias when publication rename fails", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const alias = path.join(home, "sources", id);
    const target = await fsp.readlink(alias);
    const before = await read(home, "sources.json");
    const rows = indexRows(home);
    await writeSkill(path.join(repo.dir, "skills"), "new-skill", "new skill");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-qm", "add skill");
    failRename((from, to) => from.endsWith(".new") && to === alias);
    const warnings: string[] = [];
    mock.method(console, "error", (message: unknown) => {
      warnings.push(String(message));
    });
    await updateSources(id, quiet);
    passRename();
    assert.equal(await fsp.readlink(alias), target);
    assert.notEqual(await read(home, "sources.json"), before);
    assert.notDeepEqual(indexRows(home), rows);
    assert.ok(warnings.some((message) => message.includes("mock: cannot rename")));
    await reindexAll(quiet);
    assert.notEqual(await fsp.readlink(alias), target);
  });
});

test("Git update preserves the old alias when creating its replacement fails", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const alias = path.join(home, "sources", id);
    const target = await fsp.readlink(alias);
    const before = await read(home, "sources.json");
    const rows = indexRows(home);
    const realLstat = fsp.lstat;
    mock.method(fsp, "lstat", ((file: string, ...args: unknown[]) =>
      file === alias
        ? Promise.reject(Object.assign(new Error("alias stat denied"), { code: "EACCES" }))
        : (realLstat as (...a: unknown[]) => Promise<unknown>)(file, ...args)) as typeof fsp.lstat);
    syncBuiltinESMExports();
    await updateSources(id, quiet);
    passRename();
    assert.equal(await fsp.readlink(alias), target);
    assert.notEqual(await read(home, "sources.json"), before);
    assert.deepEqual(indexRows(home), rows);
    const actual = fsp.symlink;
    mock.method(fsp, "symlink", ((targetPath: string, linkPath: string, ...args: unknown[]) =>
      linkPath.startsWith(`${alias}.`) && linkPath.endsWith(".new")
        ? Promise.reject(new Error("mock: symlink failed"))
        : (actual as (...a: unknown[]) => Promise<void>)(targetPath, linkPath, ...args)) as typeof fsp.symlink);
    syncBuiltinESMExports();
    await updateSources(id, quiet);
    passRename();
    assert.equal(await fsp.readlink(alias), target);
    assert.notEqual(await read(home, "sources.json"), before);
    assert.deepEqual(indexRows(home), rows);
  });
});

test("Git install preserves a competing record or alias", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const record = catalogRecords(home);
    const other = await tmp("mg-home-");
    process.env["MARGRAVE_HOME"] = other;
    const competing = JSON.stringify(record);
    await seedIndex([]);
    const first = changeAtLock(t, 3, () => writeCatalogRecords(other, record));
    await assert.rejects(installSource(repo.url, null, quiet), /already installed/u);
    assert.equal(first.fired(), true);
    assert.equal(JSON.stringify(catalogRecords(other)), competing);
    mock.restoreAll();

    const third = await tmp("mg-home-");
    process.env["MARGRAVE_HOME"] = third;
    const alias = path.join(third, "sources", id);
    const second = changeAtLock(t, 3, () => {
      mkdirSync(path.dirname(alias), { recursive: true });
      writeFileSync(alias, "other writer");
    });
    await installSource(repo.url, null, quiet);
    assert.equal(second.fired(), true);
    assert.equal(readFileSync(alias, "utf8"), "other writer");
  });
});

test("a COMMIT that fails restores the old sources.json, rolls back the rows, and reports the COMMIT error", async (t) => {
  await inStore(t, async (home) => {
    const first = await tmp("mg-localsrc-");
    await writeSkill(first, "alpha", "alpha skill");
    const second = await tmp("mg-localsrc2-");
    await writeSkill(second, "beta", "beta skill");
    await installSource(first, null, quiet);
    const ids = indexIds(home);
    const sources = await read(home, "sources.json");

    failCommit();
    await assert.rejects(installSource(second, null, quiet), /mock: COMMIT failed/u);
    assert.deepEqual(indexIds(home), ids);
    assert.equal(await read(home, "sources.json"), sources, "the old sources.json is back");

    // The restore fails too: the COMMIT error is still the one that is reported. The first rename (the new sources.json) works.
    failRename((_from, _to, nth) => nth > 1);
    failCommit();
    await assert.rejects(installSource(second, null, quiet), /mock: COMMIT failed/u);
    assert.deepEqual(indexIds(home), ids);
  });
});

test("a ROLLBACK that fails does not replace the error that caused it", async (t) => {
  await inStore(t, async (home) => {
    const first = await tmp("mg-localsrc-");
    await writeSkill(first, "alpha", "alpha skill");
    const second = await tmp("mg-localsrc2-");
    await writeSkill(second, "beta", "beta skill");
    await installSource(first, null, quiet);
    const ids = indexIds(home);

    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "COMMIT") throw new Error("mock: COMMIT failed");
      if (sql === "ROLLBACK") throw new Error("mock: ROLLBACK failed");
      return realExec.call(this, sql);
    });
    await assert.rejects(installSource(second, null, quiet), /mock: COMMIT failed/u);
    mock.restoreAll();
    assert.deepEqual(indexIds(home), ids, "closing the connection rolled the rows back");
  });
});

test("a failed first Git publication leaves no active catalog or alias", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    failRename((_from, to) => to.endsWith("index.db"));
    await assert.rejects(installSource(repo.url, null, quiet), /mock: cannot rename to .*index\.db/u);
    assert.deepEqual(await readdir(path.join(home, "sources")), []);
    await assert.rejects(readFile(path.join(home, "index.db")), { code: "ENOENT" });
  });
});

test("update of a git source rolls the stored copy back when the swap or the write fails", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const final = path.join(home, "sources", id);
    const stored = async (): Promise<string> => readFile(path.join(final, "skills", "react-perf", "SKILL.md"), "utf8");
    const before = { sources: await read(home, "sources.json"), index: indexIds(home), skill: await stored() };

    await writeSkill(path.join(repo.dir, "skills"), "react-perf", "Changed description of react perf");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-q", "-m", "change");

    // The new clone cannot be moved into place.
    failRename((from, to) => to.includes(`${path.sep}snapshots${path.sep}`) && from.endsWith(`${path.sep}repo`));
    await assert.rejects(updateSources(id, quiet), /mock: cannot rename to /u);
    assert.equal(await stored(), before.skill);
    assert.equal(await read(home, "sources.json"), before.sources);
    assert.deepEqual(indexIds(home), before.index);
    assert.equal((await readdir(path.join(home, "snapshots", id))).length, 1);

    // The new clone is in place, but sources.json cannot be written.
    failRename((_from, to) => to.endsWith("index.db"));
    await assert.rejects(updateSources(id, quiet), /mock: cannot rename to .*index\.db/u);
    assert.equal(await stored(), before.skill);
    assert.equal(await read(home, "sources.json"), before.sources);
    assert.deepEqual(indexIds(home), before.index);
    assert.equal((await readdir(path.join(home, "snapshots", id))).length, 2);

    // With the mock gone, the same update works.
    passRename();
    const ok = await updateSources(id, quiet);
    assert.equal(ok.errors.length, 0);
    assert.notEqual(await stored(), before.skill);
  });
});

test("a reader keeps the selected snapshot during publication", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const skill = `${id}/react-perf`;
    const old = indexRows(home).find((row) => row.id === skill)!.hash;
    const alias = path.join(home, "sources", id, "skills", "react-perf", "SKILL.md");
    const oldText = await readFile(alias, "utf8");
    await writeSkill(path.join(repo.dir, "skills"), "react-perf", "new description", "new content\n");
    await git(repo.dir, "add", "-A");
    await git(repo.dir, "commit", "-qm", "next");
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = fsp.rename;
    mock.method(fsp, "rename", async (from: string, to: string) => {
      if (to === path.join(home, "index.db")) {
        reached();
        await resume;
      }
      await real(from, to);
    });
    syncBuiltinESMExports();
    const updating = updateSources(id, quiet);
    try {
      await Promise.race([
        paused,
        updating.then(() => {
          throw new Error("writer completed before pause");
        }),
      ]);
      assert.equal(await readFile(alias, "utf8"), oldText);
      const reader = await runCli(["load", skill, "--file", "SKILL.md", "--revision", old], { home });
      assert.equal(reader.code, 0, reader.stderr);
      assert.equal(reader.stdout, oldText);
    } finally {
      release();
      await updating;
      passRename();
    }
    const stale = await runCli(["load", skill, "--revision", old], { home });
    assert.match(stale.stderr, /skill revision changed; search again/u);
    const current = indexRows(home).find((row) => row.id === skill)!.hash;
    const fresh = await runCli(["load", skill, "--file", "SKILL.md", "--revision", current], { home });
    assert.match(fresh.stdout, /new content/u);
    assert.equal((await readdir(path.join(home, "snapshots", id))).length, 2);
  });
});

test("missing and foreign aliases do not delete another directory", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const alias = path.join(home, "sources", id);
    const installed = await fsp.realpath(alias);
    await fsp.unlink(alias);
    const other = await tmp("mg-other-");
    await fsp.symlink(other, alias);
    await updateSources(id, quiet);
    await removeSource(id);
    assert.equal(await fsp.realpath(alias), other);
    assert.equal((await fsp.stat(installed)).isDirectory(), true);
    await fsp.unlink(alias);
    assert.equal((await fsp.stat(installed)).isDirectory(), true);
    assert.equal((await fsp.stat(other)).isDirectory(), true);
  });
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
