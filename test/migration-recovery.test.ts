import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CLI, copyLegacyStoreFixture, indexRows, runCli, stdioTestEnv, tmp } from "./helpers.ts";

test("migration retries after the prepared record is written", async () => {
  const home = path.join(await tmp(), "store");
  await copyLegacyStoreFixture(home);
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(await tmp(), "fail-journal.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql.startsWith("CREATE TABLE sources")) throw new Error("migration setup failed"); return exec.call(this, sql); };\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /migration setup failed/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  assert.ok(!(await readdir(home)).some((name) => name.startsWith(".catalog-")));
  const retried = await runCli(["migrate"], { home });
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(retried.stdout, "store upgraded\n");
});

test("migration retries after process termination at durable transitions", async () => {
  for (const checkpoint of ["before-record", "record", "nonhot", "changes", "committed"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const preload = path.join(parent, "stop.mjs");
    await writeFile(
      preload,
      `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
const checkpoint = ${JSON.stringify(checkpoint)};
const rename = fs.rename;
fs.rename = async function(from, to) {
  if (checkpoint === "before-record" && to === ${JSON.stringify(path.join(home, "sources.json"))}) process.kill(process.pid, "SIGKILL");
  return rename.call(this, from, to);
};
syncBuiltinESMExports();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (checkpoint === "record" && sql.startsWith("CREATE TABLE sources")) process.kill(process.pid, "SIGKILL");
  const result = exec.call(this, sql);
  if (checkpoint === "nonhot" && sql.startsWith("CREATE TABLE sources")) process.kill(process.pid, "SIGKILL");
  if (checkpoint === "changes" && sql.startsWith("DROP TABLE fts")) {
    exec.call(this, "PRAGMA cache_size = 1; UPDATE skills SET description = hex(randomblob(300000))");
    process.kill(process.pid, "SIGKILL");
  }
  if (checkpoint === "committed" && sql === "PRAGMA user_version = 4; COMMIT") process.kill(process.pid, "SIGKILL");
  return result;
};\n`,
    );
    const stopped = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.notEqual(stopped.code, 0, checkpoint);
    if (checkpoint === "nonhot")
      assert.equal((await readFile(path.join(home, "index.db-journal"))).subarray(0, 8).toString("hex"), "0000000000000000");
    const retried = await runCli(["find", "--category", "general", "release upgrade", "--json"], {
      home,
      extra: { TAR_OPTIONS: "--not-a-real-tar-option" },
    });
    assert.equal(retried.code, 0, `${checkpoint}: ${retried.stderr}`);
    assert.ok(JSON.parse(retried.stdout).results.length > 0, checkpoint);
    assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-")).length, 1, checkpoint);
    assert.equal(retried.stderr.includes("store upgraded. Backup:"), checkpoint !== "committed", checkpoint);
  }
});

test("recovered migration retains the SQLite lock through catalog verification", async (t) => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const index = path.join(home, "index.db");
  const crash = path.join(parent, "crash.mjs");
  await writeFile(
    crash,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (sql.startsWith("DROP TABLE fts")) { exec.call(this, "PRAGMA cache_size = 1; UPDATE skills SET description = hex(randomblob(300000))"); process.kill(process.pid, "SIGKILL"); } return result; };\n`,
  );
  assert.notEqual((await runCli(["migrate"], { home, nodeArgs: ["--import", crash] })).code, 0);
  const fifo = path.join(parent, "release");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  const barrier = path.join(parent, "barrier.mjs");
  await writeFile(
    barrier,
    `import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql.startsWith("CREATE TABLE sources")) { process.send("locked"); readFileSync(${JSON.stringify(fifo)}); } return exec.call(this, sql); };\n`,
  );
  const retry = spawn(process.execPath, ["--import", barrier, CLI, "migrate"], {
    env: stdioTestEnv({ ...process.env, MARGRAVE_HOME: home }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  retry.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(retry, "close");
  t.after(async () => {
    if (retry.exitCode === null && retry.signalCode === null) retry.kill();
    await exited;
  });
  assert.equal(await Promise.race([once(retry, "message").then(([message]) => message), exited.then(() => `exited: ${stderr}`)]), "locked");
  const attempt = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(index)}, { timeout: 0 });
try { db.exec("BEGIN IMMEDIATE"); process.exitCode = 2; } catch (err) { process.exitCode = err.errcode === 5 ? 0 : 3; } finally { db.close(); }`,
    ],
    { stdio: "ignore" },
  );
  assert.equal((await once(attempt, "close"))[0], 0);
  await writeFile(fifo, "x");
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(indexRows(home).length, 1);
});

test("prepared journals accept the backup or catalog owner", async () => {
  for (const owner of ["backup", "catalog", "unrelated", "backup-hot", "catalog-hot", "unrelated-hot"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const crash = path.join(parent, "crash.mjs");
    await writeFile(
      crash,
      `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (${JSON.stringify(owner.endsWith("-hot"))} && sql.startsWith("DROP TABLE fts")) { exec.call(this, "PRAGMA cache_size = 1; UPDATE skills SET description = hex(randomblob(300000))"); process.kill(process.pid, "SIGKILL"); } if (!${JSON.stringify(owner.endsWith("-hot"))} && sql.startsWith("CREATE TABLE sources")) process.kill(process.pid, "SIGKILL"); return result; };\n`,
    );
    assert.notEqual((await runCli(["migrate"], { home, nodeArgs: ["--import", crash] })).code, 0);
    const index = path.join(home, "index.db");
    const before = await readFile(index);
    const preload = path.join(parent, "owners.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstat; const catalog = ${JSON.stringify(index)}; const owner = ${JSON.stringify(owner.replace("-hot", ""))};
fs.lstat = async function(file, ...args) { const st = await lstat.call(this, file, ...args); const me = process.getuid();
  if (file === catalog) st.uid = typeof st.uid === "bigint" ? BigInt(me + 1000) : me + 1000;
  if (file === catalog + "-journal") st.uid = owner === "backup" ? me : owner === "catalog" ? me + 1000 : me + 2000;
  return st; };
syncBuiltinESMExports();\n`,
    );
    const result = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    if (owner.startsWith("unrelated")) {
      assert.equal(result.code, 1);
      assert.match(result.stderr, /cannot verify the Margrave upgrade journal/u);
      assert.deepEqual(await readFile(index), before);
    } else {
      assert.equal(result.code, 0, `${owner}: ${result.stderr}`);
      assert.equal(indexRows(home).length, 1);
    }
  }
});

test("hot journal recovery failure leaves the live files intact for retry", async () => {
  for (const failure of ["timeout", "exclusive-error", "scratch-journal", "scratch-open", "wal-race", "short-header"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const crash = path.join(parent, "crash.mjs");
    await writeFile(
      crash,
      `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (sql.startsWith("DROP TABLE fts")) { exec.call(this, "PRAGMA cache_size = 1; UPDATE skills SET description = hex(randomblob(300000))"); process.kill(process.pid, "SIGKILL"); } return result; };\n`,
    );
    assert.notEqual((await runCli(["migrate"], { home, nodeArgs: ["--import", crash] })).code, 0);
    const index = path.join(home, "index.db");
    const journal = `${index}-journal`;
    const beforeIndex = await readFile(index);
    const beforeJournal = await readFile(journal);
    const preload = path.join(parent, "failure.mjs");
    await writeFile(
      preload,
      failure === "short-header"
        ? `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const open = fs.open;
fs.open = async function(file, ...args) { const handle = await open.call(this, file, ...args); if (file === ${JSON.stringify(journal)}) await fs.truncate(file, 1); return handle; };
syncBuiltinESMExports();\n`
        : failure === "scratch-open"
          ? `import { DatabaseSync } from "node:sqlite";
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) { if (sql === "PRAGMA user_version" && this.location("main").includes(".margrave-upgrade-tmp-")) throw new Error("scratch failure"); return prepare.call(this, sql); };\n`
          : failure === "timeout" || failure === "exclusive-error"
            ? `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "BEGIN EXCLUSIVE") throw Object.assign(new Error("failure"), { errcode: ${failure === "timeout" ? 5 : 10} }); return exec.call(this, sql); };\n`
            : `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const copyFile = fs.copyFile;
fs.copyFile = async function(from, to, ...args) { await copyFile.call(this, from, to, ...args); if (String(to).includes(".margrave-upgrade-tmp-") && String(to).endsWith("index.db-journal")) await fs.writeFile(${failure === "wal-race" ? JSON.stringify(`${index}-wal`) : "to"}, "corrupt"); };
syncBuiltinESMExports();\n`,
    );
    const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(failed.code, 1, failure);
    assert.match(
      failed.stderr,
      failure === "timeout"
        ? /another Margrave writer holds the legacy catalog lock/u
        : failure === "exclusive-error"
          ? /cannot verify the interrupted Margrave upgrade/u
          : /cannot verify the Margrave upgrade journal/u,
    );
    assert.deepEqual(await readFile(index), beforeIndex);
    if (failure === "short-header") await writeFile(journal, beforeJournal);
    else assert.deepEqual(await readFile(journal), beforeJournal);
    if (failure === "wal-race") await rm(`${index}-wal`);
    const retried = await runCli(["migrate"], { home });
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(indexRows(home).length, 1);
  }
});

test("recovery rejects a journal replaced after taking the exclusive lock", async () => {
  for (const failure of ["digest", "owner"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const index = path.join(home, "index.db");
    const original = await readFile(index);
    const crash = path.join(parent, "crash.mjs");
    await writeFile(
      crash,
      `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (sql.startsWith("DROP TABLE fts")) { exec.call(this, "PRAGMA cache_size = 1; UPDATE skills SET description = hex(randomblob(300000))"); process.kill(process.pid, "SIGKILL"); } return result; };\n`,
    );
    assert.notEqual((await runCli(["migrate"], { home, nodeArgs: ["--import", crash] })).code, 0);
    const record = await readFile(path.join(home, "sources.json"));
    const inject = path.join(parent, "replace-journal.mjs");
    await writeFile(
      inject,
      `import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
const exec = DatabaseSync.prototype.exec; const lstat = fs.lstat; let locked = false;
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (sql === "BEGIN EXCLUSIVE") { locked = true; writeFileSync(${JSON.stringify(`${index}-journal`)}, Buffer.alloc(512)); } return result; };
fs.lstat = async function(file, ...args) { const stat = await lstat.call(this, file, ...args); if (locked && file === ${JSON.stringify(`${index}-journal`)} && ${JSON.stringify(failure)} === "owner") stat.uid = process.getuid() + 1000; return stat; };
syncBuiltinESMExports();\n`,
    );
    const refused = await runCli(["migrate"], { home, nodeArgs: ["--import", inject] });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /cannot verify the Margrave upgrade journal/u);
    assert.deepEqual(await readFile(index), original);
    assert.deepEqual(await readFile(path.join(home, "sources.json")), record);
    await rm(`${index}-journal`, { force: true });
    const retried = await runCli(["migrate"], { home });
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(indexRows(home).length, 1);
  }
});

test("recovery closes its lock after scratch cleanup fails", async () => {
  for (const point of ["allocation", "cleanup", "schema"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const index = path.join(home, "index.db");
    const original = await readFile(index);
    const crash = path.join(parent, "crash.mjs");
    await writeFile(
      crash,
      `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (sql.startsWith("DROP TABLE fts")) { exec.call(this, "PRAGMA cache_size = 1; UPDATE skills SET description = hex(randomblob(300000))"); process.kill(process.pid, "SIGKILL"); } return result; };\n`,
    );
    assert.notEqual((await runCli(["migrate"], { home, nodeArgs: ["--import", crash] })).code, 0);
    const preload = path.join(parent, "scratch-failure.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
const point = ${JSON.stringify(point)}; const mkdtemp = fs.mkdtemp; const rm = fs.rm; let locked = false; let failed = false;
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (sql === "BEGIN EXCLUSIVE") locked = true; return result; };
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) { if (point === "schema" && locked && sql.startsWith("SELECT (SELECT user_version")) { const stmt = prepare.call(this, sql); return { get: () => ({ ...stmt.get(), user_version: 3 }) }; } if (point === "schema" && locked && sql.startsWith("SELECT count(*) AS n FROM sqlite_master")) return { get: () => ({ n: 1 }) }; return prepare.call(this, sql); };
fs.mkdtemp = function(prefix, ...args) { if (point === "allocation" && String(prefix).includes(".margrave-upgrade-tmp-")) throw new Error("scratch allocation failed"); return mkdtemp.call(this, prefix, ...args); };
fs.rm = function(file, ...args) { if (point === "cleanup" && locked && !failed && String(file).includes(".margrave-upgrade-tmp-")) { failed = true; throw new Error("scratch cleanup failed"); } return rm.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
    );
    const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(failed.code, 1, point);
    assert.match(
      failed.stderr,
      point === "schema" ? /cannot verify the Margrave upgrade journal/u : /cannot verify the interrupted Margrave upgrade/u,
    );
    if (point !== "allocation") assert.deepEqual(await readFile(index), original);
    const retry = await runCli(["migrate"], { home });
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(indexRows(home).length, 1);
  }
});

test("recovery rejects journal and catalog changes during scratch verification", async () => {
  for (const race of ["missing-journal", "changed-journal", "nonhot-catalog", "enoent-catalog"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const index = path.join(home, "index.db");
    const original = await readFile(index);
    const originalFile = path.join(parent, "original.db");
    await writeFile(originalFile, original);
    const crash = path.join(parent, "crash.mjs");
    await writeFile(
      crash,
      `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (${JSON.stringify(race)} === "nonhot-catalog" && sql.startsWith("CREATE TABLE sources")) process.kill(process.pid, "SIGKILL"); if (${JSON.stringify(race)} !== "nonhot-catalog" && sql.startsWith("DROP TABLE fts")) { exec.call(this, "PRAGMA cache_size = 1; UPDATE skills SET description = hex(randomblob(300000))"); process.kill(process.pid, "SIGKILL"); } return result; };\n`,
    );
    assert.notEqual((await runCli(["migrate"], { home, nodeArgs: ["--import", crash] })).code, 0);
    const journal = `${index}-journal`;
    const beforeIndex = await readFile(index);
    const beforeJournal = await readFile(journal);
    const record = await readFile(path.join(home, "sources.json"));
    const preload = path.join(parent, "race.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const race = ${JSON.stringify(race)}; const journal = ${JSON.stringify(journal)}; const index = ${JSON.stringify(index)};
const open = fs.open; const copyFile = fs.copyFile;
fs.open = async function(file, ...args) { if (race === "nonhot-catalog" && file === journal) await fs.appendFile(index, "changed"); return open.call(this, file, ...args); };
fs.copyFile = async function(from, to, ...args) {
  if (race === "enoent-catalog" && from === journal) { await fs.rm(journal); await fs.appendFile(index, "changed"); throw Object.assign(new Error("gone"), { code: "ENOENT" }); }
  await copyFile.call(this, from, to, ...args);
  if (race === "nonhot-catalog" && from === index && String(to).includes(".margrave-upgrade-tmp-")) await fs.writeFile(to, await fs.readFile(${JSON.stringify(originalFile)}));
  if (from === journal) {
    if (race === "missing-journal") { await fs.rm(journal); await fs.appendFile(index, "changed"); }
    if (race === "changed-journal") await fs.appendFile(journal, "changed");
  }
}; syncBuiltinESMExports();\n`,
    );
    const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(failed.code, 1, race);
    assert.match(failed.stderr, /cannot verify the Margrave upgrade journal/u);
    assert.deepEqual(await readFile(path.join(home, "sources.json")), record);
    await writeFile(index, beforeIndex);
    await writeFile(journal, beforeJournal);
    const retry = await runCli(["migrate"], { home });
    assert.equal(retry.code, 0, `${race}: ${retry.stderr}`);
  }
});

test("an older open connection can recover before the migration takes its exclusive lock", async (t) => {
  for (const point of ["journal-open", "exclusive"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const oldScript = `import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
const db = new DatabaseSync(${JSON.stringify(path.join(home, "index.db"))}, { timeout: 10000 });
process.send("opened");
await new Promise(resolve => process.once("message", resolve));
db.exec("BEGIN IMMEDIATE");
const sources = JSON.parse(await readFile(${JSON.stringify(path.join(home, "sources.json"))}, "utf8"));
if (!Array.isArray(sources)) { db.exec("ROLLBACK"); process.send("rejected"); }
else { db.exec("COMMIT"); process.send("accepted"); }
db.close(); process.disconnect();\n`;
    const old = spawn(process.execPath, ["--input-type=module", "-e", oldScript], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const oldExit = once(old, "close");
    t.after(async () => {
      if (old.exitCode === null && old.signalCode === null) old.kill();
      await oldExit;
    });
    assert.equal(
      await Promise.race([once(old, "message").then(([message]) => message), oldExit.then(() => "old writer exited")]),
      "opened",
    );
    const crash = path.join(parent, "crash.mjs");
    await writeFile(
      crash,
      `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  const result = exec.call(this, sql);
  if (sql.startsWith("DROP TABLE fts")) { exec.call(this, "PRAGMA cache_size = 1; UPDATE skills SET description = hex(randomblob(300000))"); process.kill(process.pid, "SIGKILL"); }
  return result;
};\n`,
    );
    assert.notEqual((await runCli(["migrate"], { home, nodeArgs: ["--import", crash] })).code, 0);
    assert.equal((await readFile(path.join(home, "index.db-journal"))).subarray(0, 8).toString("hex"), "d9d505f920a163d7");
    const barrier = path.join(parent, "barrier.mjs");
    const fifo = path.join(parent, "release");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    await writeFile(
      barrier,
      `import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const point = ${JSON.stringify(point)};
const open = fs.open;
fs.open = async function(file, ...args) { if (point === "journal-open" && file === ${JSON.stringify(path.join(home, "index.db-journal"))}) { process.send("paused"); await new Promise(resolve => process.once("message", resolve)); } return open.call(this, file, ...args); };
syncBuiltinESMExports();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (point === "exclusive" && sql === "BEGIN EXCLUSIVE") { process.send("paused"); readFileSync(${JSON.stringify(fifo)}); } return exec.call(this, sql); };\n`,
    );
    const retry = spawn(process.execPath, ["--import", barrier, CLI, "migrate"], {
      env: stdioTestEnv({ ...process.env, MARGRAVE_HOME: home }),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    retry.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const retryExit = once(retry, "close");
    t.after(async () => {
      if (retry.exitCode === null && retry.signalCode === null) retry.kill();
      await retryExit;
    });
    assert.equal(
      await Promise.race([once(retry, "message").then(([message]) => message), retryExit.then(() => `retry exited: ${stderr}`)]),
      "paused",
    );
    old.send("continue");
    assert.equal(
      await Promise.race([once(old, "message").then(([message]) => message), oldExit.then(() => "old writer exited")]),
      "rejected",
    );
    if (point === "exclusive") await writeFile(fifo, "x");
    else retry.send("continue");
    assert.equal((await retryExit)[0], 0, stderr);
    assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-")).length, 1);
    assert.match((await runCli(["find", "--category", "general", "release upgrade"], { home })).stdout, /release-upgrade/u);
  }
});

test("prepared migration rejects a changed record, backup, or journal", async () => {
  for (const damage of [
    "record",
    "extra",
    "phase",
    "path",
    "digest",
    "backup",
    "backup-mode",
    "missing-manifest",
    "manifest-identity",
    "backup-key",
    "archive-missing",
    "archive-index",
    "catalog-hash",
    "journal",
    "zero-journal",
  ]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const preload = path.join(parent, "stop.mjs");
    await writeFile(
      preload,
      `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql.startsWith("CREATE TABLE sources")) process.kill(process.pid, "SIGKILL"); return exec.call(this, sql); };\n`,
    );
    assert.notEqual((await runCli(["migrate"], { home, nodeArgs: ["--import", preload] })).code, 0);
    const sourceFile = path.join(home, "sources.json");
    const marker = JSON.parse(await readFile(sourceFile, "utf8")) as { backup: string; catalogInode: string; [key: string]: unknown };
    if (damage === "record") {
      marker.catalogInode = "0";
      await writeFile(sourceFile, JSON.stringify(marker));
    } else if (damage === "extra" || damage === "phase" || damage === "path" || damage === "digest") {
      if (damage === "extra") marker["unexpected"] = true;
      if (damage === "phase") marker["phase"] = "committed";
      if (damage === "path") marker.backup = "../outside";
      if (damage === "digest") marker["indexSha256"] = "invalid";
      await writeFile(sourceFile, JSON.stringify(marker));
    } else if (damage === "backup") {
      await writeFile(path.join(parent, marker.backup, "store.tar"), "changed");
    } else if (damage === "backup-mode") {
      await chmod(path.join(parent, marker.backup), 0o755);
    } else if (damage === "missing-manifest") {
      await rm(path.join(parent, marker.backup, "manifest.json"));
    } else if (damage === "manifest-identity" || damage === "backup-key") {
      const manifestFile = path.join(parent, marker.backup, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { store: string; inventorySha256: string };
      if (damage === "manifest-identity") manifest.store = "/another-store";
      else manifest.inventorySha256 = "0".repeat(64);
      await writeFile(manifestFile, JSON.stringify(manifest));
    } else if (damage === "archive-missing" || damage === "archive-index") {
      const archiveRoot = path.join(parent, "archive-input");
      await mkdir(archiveRoot);
      await writeFile(path.join(archiveRoot, "sources.json"), "[]\n");
      if (damage === "archive-index") await writeFile(path.join(archiveRoot, "index.db"), "changed");
      const archive = path.join(parent, marker.backup, "store.tar");
      execFileSync("/usr/bin/tar", [
        "-cf",
        archive,
        "-C",
        archiveRoot,
        "./sources.json",
        ...(damage === "archive-index" ? ["./index.db"] : []),
      ]);
      const manifestFile = path.join(parent, marker.backup, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { archiveSha256: string };
      manifest.archiveSha256 = createHash("sha256")
        .update(await readFile(archive))
        .digest("hex");
      await writeFile(manifestFile, JSON.stringify(manifest));
    } else if (damage === "catalog-hash") {
      const index = path.join(home, "index.db");
      await writeFile(index, Buffer.concat([await readFile(index), Buffer.from("changed")]));
    } else if (damage === "journal") {
      await writeFile(path.join(home, "index.db-journal"), "unrelated journal");
    } else {
      await writeFile(path.join(home, "index.db-journal"), Buffer.alloc(512));
    }
    const before = await readFile(path.join(home, "index.db"));
    const result = await runCli(["migrate"], { home });
    assert.equal(result.code, 1, damage);
    assert.match(
      result.stderr,
      damage.endsWith("journal") ? /cannot verify the Margrave upgrade journal/u : /cannot verify the interrupted Margrave upgrade/u,
    );
    assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  }
});

test("invalid directory metadata archives stop migration before live changes", async () => {
  for (const damage of ["truncated", "size", "pax-space", "pax-length", "pax-record", "entry-type", "entry-name", "missing-entry"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const before = await readFile(path.join(home, "index.db"));
    const sources = await readFile(path.join(home, "sources.json"));
    const preload = path.join(parent, "archive-failure.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const open = fs.open; const damage = ${JSON.stringify(damage)}; let changed = false;
fs.open = async function(file, ...args) {
  const handle = await open.call(this, file, ...args);
  if (String(file).endsWith("/directories.tar")) {
    const read = handle.read.bind(handle);
    handle.read = async function(buffer, offset, length, position) {
      const result = await read(buffer, offset, length, position);
      if (!changed && damage === "truncated") { changed = true; return { bytesRead: 0, buffer }; }
      if (!changed && position === 0 && damage === "size") { buffer[124] = 120; changed = true; }
      if (!changed && position === 0 && damage === "entry-type") { buffer[156] = 48; changed = true; }
      if (!changed && position === 0 && damage === "missing-entry") { buffer.fill(0); changed = true; }
      if (!changed && position === 512 && damage === "pax-space") { buffer.fill(49); changed = true; }
      if (!changed && position === 512 && damage === "pax-length") { buffer[0] = 120; changed = true; }
      if (!changed && position === 512 && damage === "pax-record") { buffer[0] = 48; changed = true; }
      if (!changed && length === 512 && buffer[156] === 53 && damage === "entry-name") { buffer[0] = 120; changed = true; }
      return result;
    };
  }
  return handle;
}; syncBuiltinESMExports();\n`,
    );
    const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(failed.code, 1, `${damage}: ${failed.stderr}`);
    assert.match(failed.stderr, /cannot back up the Margrave store/u);
    assert.deepEqual(await readFile(path.join(home, "index.db")), before);
    assert.deepEqual(await readFile(path.join(home, "sources.json")), sources);
    const retried = await runCli(["migrate"], { home });
    assert.equal(retried.code, 0, `${damage}: ${retried.stderr}`);
  }
});

test("recovery reports Error failures while reading the source list", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(parent, "fail-read.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const readFile = fs.readFile;
fs.readFile = function(file, ...args) { if (file === ${JSON.stringify(path.join(home, "sources.json"))}) throw new Error("source read denied"); return readFile.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /cannot upgrade the v0\.2\.1 catalog: source read denied/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  assert.equal((await runCli(["migrate"], { home })).code, 0);
});
