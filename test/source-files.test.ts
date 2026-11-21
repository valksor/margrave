import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fsp, { readFile, readdir, chmod, mkdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import type { TestContext } from "node:test";
import { scanSource } from "../src/scan.ts";
import {
  commit as sourceFilesCommit,
  gitDir,
  ownedStage,
  prepareSnapshot,
  syncSnapshot,
  toEntries,
  withStaging,
} from "../src/source-files.ts";
import { findSource, resolveScanRoot, sourceDir, installSource, localId, reindexAll, removeSource, updateSources } from "../src/sources.ts";
import { UsageError } from "../src/store.ts";
import {
  assertWriterAvailable,
  disposableHome,
  gitSourceRecord,
  changeAtLock,
  catalogRecords,
  fakeRipwire,
  git,
  indexIds,
  indexRows,
  makeRepo,
  realExec,
  realClose,
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
  useHome,
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
  const list = [gitSourceRecord("o__r", "o/r"), gitSourceRecord("o__q", "o/q")];
  assert.equal(findSource(list, "o__r").id, "o__r");
  assert.equal(findSource(list, "o/q").id, "o__q");
  assert.throws(() => findSource(list, "zzz"), /no source/u);
  assert.throws(() => findSource([gitSourceRecord("a", "same"), gitSourceRecord("b", "same")], "same"), /several sources/u);
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

test("source files snapshot direct resolve scan roots and exact errors", async (t) => {
  const fixture = await tmp("mg-direct-root-");
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const clone = path.join(fixture, "clone");
  await mkdir(path.join(clone, "nested", "inner"), { recursive: true });
  await mkdir(path.join(fixture, "outside"));
  await writeFile(path.join(clone, "file"), "file");
  await link(path.join(clone, "nested"), path.join(clone, "sibling"));
  await link(path.join(fixture, "outside"), path.join(clone, "escape"));
  const lexicalClone = `${clone}/.`;
  assert.equal(await resolveScanRoot(lexicalClone, ""), lexicalClone);
  assert.equal(await resolveScanRoot(clone, "nested/inner"), path.join(clone, "nested", "inner"));
  assert.equal(await resolveScanRoot(clone, "sibling/inner"), path.join(clone, "sibling", "inner"));
  for (const subpath of ["/nested", "nested/", "nested//inner", "nested/../inner"]) {
    await assert.rejects(resolveScanRoot(clone, subpath), { message: `refused subpath "${subpath}"` });
  }
  await assert.rejects(resolveScanRoot(clone, "missing/member"), { message: 'subpath "missing/member" does not exist in the repository' });
  await assert.rejects(resolveScanRoot(clone, "file"), { message: 'subpath "file" is not a directory' });
  await assert.rejects(resolveScanRoot(clone, "escape"), { message: 'refused subpath "escape": resolves outside the clone' });
});

test("source files snapshot direct entries retain scanned values and input order", async (t) => {
  const root = await tmp("mg-direct-entries-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const alpha = await writeSkill(path.join(root, "one"), "alpha", "first description", "# First\n\nalpha words");
  const beta = await writeSkill(path.join(root, "two", "nested"), "beta", "second description", "# Second\n\nbeta words");
  await writeFile(path.join(alpha, "extra.txt"), "alpha manifest");
  await writeFile(path.join(beta, "extra.txt"), "beta manifest");
  const scanned = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    scanned.skills.map((skill) => skill.name),
    ["alpha", "beta"],
  );
  const skills = [...scanned.skills].reverse();
  const inputs: string[] = [];
  const entries = toEntries("owner__repo", skills, (dir) => {
    inputs.push(dir);
    return `mapped/${path.relative(root, dir)}`;
  });
  assert.deepEqual(inputs, [beta, alpha]);
  assert.deepEqual(
    entries,
    skills.map((skill) => ({
      id: `owner__repo/${skill.name}`,
      name: skill.name,
      description: skill.description,
      source: "owner__repo",
      dir: `mapped/${path.relative(root, skill.dir)}`,
      revision: skill.revision,
      manifest: JSON.stringify(skill.manifest),
      frontmatter: skill.frontmatter,
      tokens: skill.tokens,
    })),
  );
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["owner__repo/beta", "owner__repo/alpha"],
  );
});

test("source files snapshot direct prepare preserves clone contents and relative entries", async (t) => {
  const fixture = await tmp("mg-direct-prepare-");
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, "home");
  const clone = path.join(fixture, "clone");
  await mkdir(home);
  useHome(t, home);
  const skill = await writeSkill(path.join(clone, "nested"), "alpha", "snapshot skill");
  await writeFile(path.join(clone, "top.txt"), "top bytes");
  await writeFile(path.join(fixture, "harmless.txt"), "link target");
  await link(path.join(fixture, "harmless.txt"), path.join(clone, "link"));
  const skillBytes = await readFile(path.join(skill, "SKILL.md"));
  const skills = (await scanSource(clone, { followSymlinks: false })).skills;
  const realClone = await fsp.realpath(clone);
  const commit = "a".repeat(40);
  const result = await prepareSnapshot("owner__repo", commit, clone, realClone, skills);
  assert.match(result.snapshot, /^a{40}-[0-9a-f]{16}$/u);
  assert.equal(result.destination, path.join(home, "snapshots", "owner__repo", result.snapshot));
  await assert.rejects(stat(clone), { code: "ENOENT" });
  assert.equal(await readFile(path.join(result.destination, "top.txt"), "utf8"), "top bytes");
  assert.deepEqual(await readFile(path.join(result.destination, "nested", "alpha", "SKILL.md")), skillBytes);
  assert.equal(await readlink(path.join(result.destination, "link")), path.join(fixture, "harmless.txt"));
  assert.deepEqual(
    result.entries.map((entry) => entry.dir),
    [path.relative(realClone, skills[0]!.dir)],
  );
  assert.equal(result.entries[0]!.dir, path.join("nested", "alpha"));
});

async function directSnapshotFixture(t: TestContext) {
  const fixture = await tmp("mg-direct-sync-");
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, "home");
  const destination = path.join(home, "snapshots", "owner__repo", "snapshot");
  const nested = path.join(destination, "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(destination, "top.txt"), "top");
  await writeFile(path.join(nested, "deep.txt"), "deep");
  await writeFile(path.join(fixture, "harmless.txt"), "target");
  await link(path.join(fixture, "harmless.txt"), path.join(destination, "link"));
  useHome(t, home);
  return { home, destination, nested };
}

function directObserveOpen(known: Set<string>, symlink: string, failAt?: string) {
  const events: { action: string; file: string; flags?: unknown }[] = [];
  const failure = new Error("fixture sync failure");
  const original = fsp.open;
  const spy = mock.method(fsp, "open", (async (file: string, flags: string) => {
    events.push({ action: "open", file, flags });
    if (file === symlink) throw new Error("snapshot symlink must not be opened");
    assert.ok(known.has(file), `unexpected open: ${file}`);
    const handle = await original(file, flags);
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    handle.sync = async () => {
      events.push({ action: "sync", file });
      if (file === failAt) throw failure;
      await sync();
    };
    handle.close = async () => {
      events.push({ action: "close", file });
      await close();
    };
    return handle;
  }) as typeof fsp.open);
  syncBuiltinESMExports();
  return {
    events,
    failure,
    restore: () => {
      spy.mock.restore();
      syncBuiltinESMExports();
    },
  };
}

test("source files snapshot direct sync closes every handle in child-first order", async (t) => {
  const { home, destination, nested } = await directSnapshotFixture(t);
  const source = path.dirname(destination);
  const snapshots = path.dirname(source);
  const top = path.join(destination, "top.txt");
  const deep = path.join(nested, "deep.txt");
  const paths = [top, deep, nested, destination, source, snapshots, home];
  const observed = directObserveOpen(new Set(paths), path.join(destination, "link"));
  try {
    await syncSnapshot(destination);
    for (const file of paths) {
      assert.deepEqual(
        observed.events.filter((event) => event.file === file),
        [
          { action: "open", file, flags: "r" },
          { action: "sync", file },
          { action: "close", file },
        ],
      );
    }
    assert.equal(observed.events.length, paths.length * 3);
    const eventIndex = (action: string, file: string) =>
      observed.events.findIndex((event) => event.action === action && event.file === file);
    for (const [child, parent] of [
      [deep, nested],
      [nested, destination],
      [top, destination],
      [destination, source],
      [source, snapshots],
      [snapshots, home],
    ] as const) {
      assert.ok(eventIndex("close", child) < eventIndex("open", parent), `${child} must finish before ${parent}`);
    }
  } finally {
    observed.restore();
  }
});

test("source files snapshot direct sync failures close handles and stop ancestor sync", async (t) => {
  const { home, destination, nested } = await directSnapshotFixture(t);
  const source = path.dirname(destination);
  const snapshots = path.dirname(source);
  const top = path.join(destination, "top.txt");
  const deep = path.join(nested, "deep.txt");
  const paths = [top, deep, nested, destination, source, snapshots, home];
  for (const [failAt, later] of [
    [deep, [nested, destination, source, snapshots, home]],
    [nested, [destination, source, snapshots, home]],
    [source, [snapshots, home]],
  ] as const) {
    const observed = directObserveOpen(new Set(paths), path.join(destination, "link"), failAt);
    try {
      await assert.rejects(syncSnapshot(destination), (error) => error === observed.failure);
      assert.deepEqual(
        observed.events.filter((event) => event.file === failAt),
        [
          { action: "open", file: failAt, flags: "r" },
          { action: "sync", file: failAt },
          { action: "close", file: failAt },
        ],
      );
      for (const ancestor of later) assert.ok(!observed.events.some((event) => event.action === "sync" && event.file === ancestor));
    } finally {
      observed.restore();
    }
  }
});

test("source files snapshot direct prepare retains renamed destination after sync failure", async (t) => {
  const fixture = await tmp("mg-direct-failed-prepare-");
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, "home");
  const clone = path.join(fixture, "clone");
  await mkdir(home);
  await mkdir(clone);
  useHome(t, home);
  await writeFile(path.join(clone, "file.txt"), "original bytes");
  const failure = new Error("fixture ancestor sync failure");
  const original = fsp.open;
  let closed = false;
  const spy = mock.method(fsp, "open", (async (file: string, flags: string) => {
    const handle = await original(file, flags);
    if (file === home) {
      const close = handle.close.bind(handle);
      handle.sync = () => Promise.reject(failure);
      handle.close = async () => {
        closed = true;
        await close();
      };
    }
    return handle;
  }) as typeof fsp.open);
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareSnapshot("owner__repo", "b".repeat(40), clone, clone, []), (error) => error === failure);
    assert.equal(closed, true);
    await assert.rejects(stat(clone), { code: "ENOENT" });
    const source = path.join(home, "snapshots", "owner__repo");
    const snapshots = await readdir(source);
    assert.equal(snapshots.length, 1);
    assert.match(snapshots[0]!, /^b{40}-[0-9a-f]{16}$/u);
    assert.equal(await readFile(path.join(source, snapshots[0]!, "file.txt"), "utf8"), "original bytes");
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

async function ownershipStage(home: string, name: string, row: string | null = name): Promise<string> {
  const dir = path.join(home, "staging", name);
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, ".margrave-owner.db"), { timeout: 0 });
  try {
    db.exec("CREATE TABLE owner(name TEXT NOT NULL)");
    if (row !== null) db.prepare("INSERT INTO owner(name) VALUES (?)").run(row);
  } finally {
    db.close();
  }
  return dir;
}

test("source files ownership direct paths and lookup guards", async (t) => {
  const home = await disposableHome(t);
  const root = path.join(home, "sources");
  const dir = path.join(root, "owner__repo");
  const rec = gitSourceRecord("owner__repo", "owner/repo", "snapshot");
  assert.equal(sourceDir(rec.id), dir);
  assert.equal(gitDir(rec), path.join(home, "snapshots", rec.id, "snapshot"));
  assert.throws(() => gitDir({ ...rec, id: "../bad" }), UsageError);
  for (const method of ["dirname", "basename"] as const) {
    const original = path[method];
    const spy = mock.method(path, method, (value: string) => (value === dir ? "unsafe" : original(value)));
    try {
      assert.throws(() => sourceDir(rec.id), { message: `refused: ${dir} is not a direct child of ${root}` });
    } finally {
      spy.mock.restore();
    }
  }
  assert.deepEqual(await readdir(home), []);
  const first = { ...rec, id: "first", spec: "match" };
  const second = { ...rec, id: "match", spec: "other" };
  assert.strictEqual(findSource([first, second], "match"), second);
  assert.strictEqual(findSource([first, second], "other"), second);
  assert.throws(() => findSource([first, second], "missing"), { message: 'no source "missing"; run: margrave list' });
  assert.throws(() => findSource([first, { ...second, id: "second", spec: "match" }], "match"), {
    message: '"match" matches several sources; use an id:\n  first\n  second',
  });
});

test("source files ownership direct stage lifecycle and locks", async (t) => {
  const home = await disposableHome(t);
  const owners = new Map<string, DatabaseSync>();
  const writers = new Set<DatabaseSync>();
  const execSpy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && this.location("main") === path.join(home, "writer-lock.db")) writers.add(this);
    const file = this.location("main");
    if (sql === "CREATE TABLE owner(name TEXT NOT NULL)" && file?.startsWith(path.join(home, "staging") + path.sep)) owners.set(file, this);
    return realExec.call(this, sql);
  });
  const originalRm = fsp.rm;
  const removals: Array<[unknown, unknown]> = [];
  const rmSpy = mock.method(fsp, "rm", ((file: string, options: unknown) => {
    if (path.dirname(file) === path.join(home, "staging")) removals.push([file, options]);
    return originalRm(file, options as Parameters<typeof fsp.rm>[1]);
  }) as typeof fsp.rm);
  syncBuiltinESMExports();
  try {
    const stage = await ownedStage("restore-");
    assert.equal(path.dirname(stage.dir), path.join(home, "staging"));
    assert.match(path.basename(stage.dir), /^restore-[A-Za-z0-9]{6}$/u);
    const ownerFile = path.join(stage.dir, ".margrave-owner.db");
    const owner = owners.get(ownerFile);
    assert.ok(owner?.isTransaction);
    assert.equal(owner.location("main"), ownerFile);
    const reader = new DatabaseSync(ownerFile, { readOnly: true, timeout: 0 });
    try {
      assert.equal(reader.prepare("SELECT name FROM owner").get()?.["name"], path.basename(stage.dir));
    } finally {
      reader.close();
    }
    const contender = new DatabaseSync(ownerFile, { timeout: 0 });
    try {
      assert.throws(() => contender.exec("BEGIN IMMEDIATE"), { errcode: 5 });
    } finally {
      contender.close();
    }
    assertWriterAvailable(home);
    await writeFile(path.join(stage.dir, "content"), "data");
    const actualOwner = owner;
    const close = mock.method(DatabaseSync.prototype, "close");
    const stageDir = stage.dir;
    try {
      await stage.close();
      assert.ok(close.mock.calls.some((call) => call.this === actualOwner));
      assert.deepEqual(
        removals.find(([file]) => file === stageDir),
        [stageDir, { recursive: true, force: true }],
      );
    } finally {
      close.mock.restore();
    }
    const value = {};
    let successful = "";
    assert.strictEqual(
      await withStaging(async (dir) => {
        successful = dir;
        await Promise.resolve();
        assert.ok((await stat(dir)).isDirectory());
        return value;
      }),
      value,
    );
    assert.equal(path.dirname(successful), path.join(home, "staging"));
    assert.match(path.basename(successful), /^s-[A-Za-z0-9]{6}$/u);
    await assert.rejects(stat(successful), { code: "ENOENT" });
    const failure = new Error("callback failure");
    let failed = "";
    await assert.rejects(
      withStaging((dir) => {
        failed = dir;
        return Promise.reject(failure);
      }),
      (error) => error === failure,
    );
    await assert.rejects(stat(failed), { code: "ENOENT" });
  } finally {
    for (const handle of [...owners.values(), ...writers]) if (handle.isOpen) realClose.call(handle);
    rmSpy.mock.restore();
    execSpy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("source files ownership direct initialization failures release the writer", async (t) => {
  const home = await disposableHome(t);
  const staging = path.join(home, "staging");
  for (const kind of ["mkdtemp", "owner"] as const) {
    const failure = new Error(kind);
    const writers = new Set<DatabaseSync>();
    const owners = new Set<DatabaseSync>();
    let created: string | undefined;
    const execSpy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && this.location("main") === path.join(home, "writer-lock.db")) writers.add(this);
      if (sql === "CREATE TABLE owner(name TEXT NOT NULL)" && this.location("main") === path.join(created!, ".margrave-owner.db")) {
        owners.add(this);
        if (kind === "owner") throw failure;
      }
      return realExec.call(this, sql);
    });
    const realMkdtemp = fsp.mkdtemp;
    const mkSpy = mock.method(fsp, "mkdtemp", (async (prefix: string, ...args: unknown[]) => {
      if (prefix === path.join(staging, "restore-")) {
        if (kind === "mkdtemp") throw failure;
        created = await (realMkdtemp as (prefix: string) => Promise<string>)(prefix);
        return created;
      }
      return (realMkdtemp as (...args: unknown[]) => Promise<string>)(prefix, ...args);
    }) as typeof fsp.mkdtemp);
    const realRm = fsp.rm;
    const removals: Array<[unknown, unknown]> = [];
    const rmSpy = mock.method(fsp, "rm", ((file: string, options: unknown) => {
      if (file === created) removals.push([file, options]);
      return realRm(file, options as Parameters<typeof fsp.rm>[1]);
    }) as typeof fsp.rm);
    syncBuiltinESMExports();
    try {
      let thrown: unknown;
      try {
        await ownedStage("restore-");
      } catch (error) {
        thrown = error;
      }
      const capturedWriters = [...writers];
      const owner = [...owners][0];
      try {
        assertWriterAvailable(home);
        assert.strictEqual(thrown, failure);
        assert.equal(capturedWriters.length, 1);
        assert.equal(capturedWriters[0]?.isOpen, false);
        if (kind === "owner") {
          assert.ok(owner);
          assert.equal(owner.isOpen, false);
          assert.deepEqual(removals, [[created, { recursive: true, force: true }]]);
        } else {
          assert.equal(owner, undefined);
          assert.deepEqual(removals, []);
        }
        assert.deepEqual(await readdir(staging), []);
      } finally {
        for (const handle of [...writers, ...owners]) if (handle.isOpen) realClose.call(handle);
      }
    } finally {
      rmSpy.mock.restore();
      mkSpy.mock.restore();
      execSpy.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("source files ownership direct commit cleanup selects only abandoned owners", async (t) => {
  const home = await disposableHome(t);
  const writers = new Set<DatabaseSync>();
  const writerSpy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && this.location("main") === path.join(home, "writer-lock.db")) writers.add(this);
    return realExec.call(this, sql);
  });
  try {
    await sourceFilesCommit(() => undefined);
    assertWriterAvailable(home);
    const staging = path.join(home, "staging");
    await mkdir(staging, { recursive: true });
    const removed = [await ownershipStage(home, "s-Ab1234"), await ownershipStage(home, "restore-Cd5678")];
    for (const dir of removed) await writeFile(path.join(dir, "payload"), "keep until removal");
    for (const name of ["xs-Ef9012", "s-Gh3456x", "xrestore-Ij7890", "restore-Kl1234x", "s-Mn12_4", "restore-Op12_4"])
      await ownershipStage(home, name);
    await writeFile(path.join(staging, "s-Qr1234"), "regular file");
    await mkdir(path.join(staging, "s-St1234"));
    await mkdir(path.join(staging, "s-Uv1234", ".margrave-owner.db"), { recursive: true });
    await mkdir(path.join(staging, "s-Wx1234"));
    const symlinkTarget = path.join(home, "symlink-owner.db");
    const symlinkDb = new DatabaseSync(symlinkTarget, { timeout: 0 });
    try {
      symlinkDb.exec("CREATE TABLE owner(name TEXT NOT NULL)");
      symlinkDb.prepare("INSERT INTO owner(name) VALUES (?)").run("s-Wx1234");
    } finally {
      symlinkDb.close();
    }
    await fsp.symlink(symlinkTarget, path.join(staging, "s-Wx1234", ".margrave-owner.db"));
    await ownershipStage(home, "s-Yz1234", null);
    await ownershipStage(home, "s-Aa1234", "wrong");
    const liveDir = await ownershipStage(home, "s-Bb1234");
    const live = new DatabaseSync(path.join(liveDir, ".margrave-owner.db"), { timeout: 0 });
    live.exec("BEGIN IMMEDIATE");
    await mkdir(path.join(staging, "s-Cc1234"));
    await writeFile(path.join(staging, "s-Cc1234", ".margrave-owner.db"), "not sqlite");
    await mkdir(path.join(staging, "s-Dd1234"));
    const missing = new DatabaseSync(path.join(staging, "s-Dd1234", ".margrave-owner.db"), { timeout: 0 });
    missing.exec("CREATE TABLE other(name TEXT)");
    missing.close();
    const handles = new Map<string, DatabaseSync>();
    const realPrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as typeof DatabaseSync.prototype.prepare;
    const prepareSpy = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const file = this.location("main");
      if (sql === "SELECT name FROM owner" && file && removed.some((dir) => file === path.join(dir, ".margrave-owner.db"))) {
        handles.set(path.dirname(file), this);
      }
      return realPrepare.call(this, sql);
    });
    const originalRm = fsp.rm;
    const calls: Array<{ file: string; options: unknown; locked: boolean }> = [];
    const rmSpy = mock.method(fsp, "rm", ((file: string, options: unknown) => {
      if (removed.includes(file)) calls.push({ file, options, locked: handles.get(file)?.isTransaction === true });
      return originalRm(file, options as Parameters<typeof fsp.rm>[1]);
    }) as typeof fsp.rm);
    syncBuiltinESMExports();
    try {
      await sourceFilesCommit(() => undefined);
      assertWriterAvailable(home);
      assert.deepEqual(calls.map(({ file }) => file).sort(), [...removed].sort());
      for (const call of calls) {
        assert.deepEqual(call.options, { recursive: true, force: true });
        assert.equal(call.locked, true);
      }
      assert.equal(handles.size, removed.length);
      assert.ok([...handles.values()].every((db) => !db.isOpen));
      assert.deepEqual(
        (await readdir(staging)).sort(),
        [
          "restore-Kl1234x",
          "restore-Op12_4",
          "s-Aa1234",
          "s-Bb1234",
          "s-Cc1234",
          "s-Dd1234",
          "s-Gh3456x",
          "s-Mn12_4",
          "s-Qr1234",
          "s-St1234",
          "s-Uv1234",
          "s-Wx1234",
          "s-Yz1234",
          "xrestore-Ij7890",
          "xs-Ef9012",
        ].sort(),
      );
    } finally {
      live.close();
      for (const handle of handles.values()) if (handle.isOpen) realClose.call(handle);
      rmSpy.mock.restore();
      prepareSpy.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    for (const writer of writers) if (writer.isOpen) realClose.call(writer);
    writerSpy.mock.restore();
  }
});

test("source files ownership direct cleanup readdir and removal failures", async (t) => {
  const home = await disposableHome(t);
  const writers = new Set<DatabaseSync>();
  const writerSpy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && this.location("main") === path.join(home, "writer-lock.db")) writers.add(this);
    return realExec.call(this, sql);
  });
  try {
    const staging = path.join(home, "staging");
    await mkdir(staging, { recursive: true });
    const denied = Object.assign(new Error("staging denied"), { code: "EACCES" });
    const realReaddir = fsp.readdir;
    const readSpy = mock.method(fsp, "readdir", ((file: string, ...args: unknown[]) =>
      file === staging ? Promise.reject(denied) : (realReaddir as (...args: unknown[]) => unknown)(file, ...args)) as typeof fsp.readdir);
    syncBuiltinESMExports();
    let published = false;
    try {
      await assert.rejects(
        sourceFilesCommit(() => {
          published = true;
          return [];
        }),
        (error) => error === denied,
      );
      assertWriterAvailable(home);
      assert.equal(published, false);
    } finally {
      readSpy.mock.restore();
      syncBuiltinESMExports();
    }
    const dir = await ownershipStage(home, "s-Ab1234");
    const failure = new Error("remove denied");
    const realRm = fsp.rm;
    const owners = new Set<DatabaseSync>();
    const realPrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as typeof DatabaseSync.prototype.prepare;
    const prepareSpy = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql === "SELECT name FROM owner" && this.location("main") === path.join(dir, ".margrave-owner.db")) owners.add(this);
      return realPrepare.call(this, sql);
    });
    let removeOptions: unknown;
    const rmSpy = mock.method(fsp, "rm", ((file: string, options: unknown) => {
      if (file === dir) {
        removeOptions = options;
        return Promise.reject(failure);
      }
      return realRm(file, options as Parameters<typeof fsp.rm>[1]);
    }) as typeof fsp.rm);
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        sourceFilesCommit(() => undefined),
        (error) => error === failure,
      );
      assertWriterAvailable(home);
      assert.equal(owners.size, 1);
      assert.ok([...owners].every((owner) => !owner.isOpen));
      assert.deepEqual(removeOptions, { recursive: true, force: true });
      assert.deepEqual(await readdir(dir), [".margrave-owner.db"]);
    } finally {
      for (const owner of owners) if (owner.isOpen) realClose.call(owner);
      rmSpy.mock.restore();
      prepareSpy.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    for (const writer of writers) if (writer.isOpen) realClose.call(writer);
    writerSpy.mock.restore();
  }
});

test("source files ownership direct cleanup preserves unexpected errors", async (t) => {
  const home = await disposableHome(t);
  const writers = new Set<DatabaseSync>();
  const writerSpy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && this.location("main") === path.join(home, "writer-lock.db")) writers.add(this);
    return realExec.call(this, sql);
  });
  try {
    const dir = await ownershipStage(home, "s-Ab1234");
    const file = path.join(dir, ".margrave-owner.db");
    const denial = Object.assign(new Error("owner denied"), { code: "EACCES" });
    const realLstat = fsp.lstat;
    const statSpy = mock.method(fsp, "lstat", ((name: string, ...args: unknown[]) =>
      name === file ? Promise.reject(denial) : (realLstat as (...args: unknown[]) => unknown)(name, ...args)) as typeof fsp.lstat);
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        sourceFilesCommit(() => undefined),
        (error) => error === denial,
      );
      assertWriterAvailable(home);
    } finally {
      statSpy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(await readdir(dir), [".margrave-owner.db"]);
    for (const failure of [
      Object.assign(new Error("no such table: owner"), { errcode: 10 }),
      Object.assign(new Error("other error"), { errcode: 1 }),
      { errcode: 1, message: "no such table: owner" },
    ]) {
      const owners = new Set<DatabaseSync>();
      const realPrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!
        .value as typeof DatabaseSync.prototype.prepare;
      const prepareSpy = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        if (sql === "SELECT name FROM owner" && this.location("main") === file) {
          owners.add(this);
          // This case deliberately throws a non-Error value.
          throw failure as Error;
        }
        return realPrepare.call(this, sql);
      });
      try {
        await assert.rejects(
          sourceFilesCommit(() => undefined),
          (error) => error === failure,
        );
        assertWriterAvailable(home);
        assert.equal(owners.size, 1);
        assert.ok([...owners].every((owner) => !owner.isOpen));
        assert.deepEqual(await readdir(dir), [".margrave-owner.db"]);
      } finally {
        for (const owner of owners) if (owner.isOpen) realClose.call(owner);
        prepareSpy.mock.restore();
      }
    }
    let openError: unknown;
    const goneSpy = mock.method(fsp, "lstat", (async (name: string, ...args: unknown[]) => {
      const result = await (realLstat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fsp.lstat>>>)(name, ...args);
      if (name === file) {
        await rm(dir, { recursive: true, force: true });
        try {
          new DatabaseSync(file, { timeout: 0 }).close();
        } catch (error) {
          openError = error;
        }
      }
      return result;
    }) as typeof fsp.lstat);
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        sourceFilesCommit(() => undefined),
        (error) =>
          error instanceof Error &&
          openError instanceof Error &&
          error.message === openError.message &&
          (error as NodeJS.ErrnoException).code === (openError as NodeJS.ErrnoException).code,
      );
      assertWriterAvailable(home);
      assert.ok(openError);
      await assert.rejects(stat(dir), { code: "ENOENT" });
    } finally {
      goneSpy.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    for (const writer of writers) if (writer.isOpen) realClose.call(writer);
    writerSpy.mock.restore();
  }
});
