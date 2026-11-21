import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CLI, copyLegacyStoreFixture, catalogRecords, fakeRipwire, indexRows, makeRepo, runCli, tmp } from "./helpers.ts";

test("schema 3 catalog setup failure keeps the original for retry", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  const repo = await makeRepo();
  const fakeBin = await fakeRipwire();
  assert.equal((await runCli(["install", repo.url], { home, fakeBin })).code, 0);
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("PRAGMA user_version = 3");
  db.close();
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(parent, "failure.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "PRAGMA journal_mode = DELETE") throw new Error("catalog setup failed"); return exec.call(this, sql); };\n`,
  );
  const failed = await runCli(["find", "react-perf"], { home, fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /catalog setup failed/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  const retry = await runCli(["find", "react-perf"], { home, fakeBin });
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /react-perf/u);
  assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v3-")).length, 1);
});

test("schema 3 refuses changed catalog copy permissions and retries", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  const repo = await makeRepo();
  const fakeBin = await fakeRipwire();
  assert.equal((await runCli(["install", repo.url], { home, fakeBin })).code, 0);
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("PRAGMA user_version = 3");
  db.close();
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(parent, "copy-mode.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstat;
fs.lstat = async function(file, ...args) { if (String(file).includes("/.catalog-") && String(file).endsWith(".tmp")) await fs.chmod(file, 0); return lstat.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["find", "react-perf"], { home, fakeBin, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /catalog copy did not preserve access metadata/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  assert.ok(!(await readdir(home)).some((name) => name.startsWith(".catalog-")));
  const retry = await runCli(["find", "react-perf"], { home, fakeBin });
  assert.equal(retry.code, 0, retry.stderr);
});

test("legacy writers are fenced by the catalog transaction", async (t) => {
  for (const mode of ["active", "opened"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const original = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { id: string; snapshot: string }[];
    const source = original[0]!;
    const linkPath = path.join(home, "sources", source.id);
    const skillPath = path.join(home, "snapshots", source.id, source.snapshot, "release-upgrade", "SKILL.md");
    const linkBefore = await readlink(linkPath);
    const skillBefore = await readFile(skillPath);
    const writerScript = `
import { DatabaseSync } from "node:sqlite";
import { readFile, rename, writeFile } from "node:fs/promises";
const home = ${JSON.stringify(home)};
const mode = ${JSON.stringify(mode)};
const db = new DatabaseSync(home + "/index.db", { timeout: 10000 });
if (mode === "active") {
  db.exec("BEGIN IMMEDIATE");
  const records = JSON.parse(await readFile(home + "/sources.json", "utf8"));
  records[0].installedAt = "writer-finished";
  await writeFile(home + "/sources.json.old-writer-tmp", JSON.stringify(records));
  await rename(home + "/sources.json.old-writer-tmp", home + "/sources.json");
  db.exec("UPDATE skills SET hash = hash");
}
process.send("ready");
await new Promise(resolve => process.once("message", resolve));
try {
  if (mode === "opened") {
    db.exec("BEGIN IMMEDIATE");
    const records = JSON.parse(await readFile(home + "/sources.json", "utf8"));
    if (!Array.isArray(records)) throw new Error("malformed source list");
    await writeFile(${JSON.stringify(skillPath)}, "stale writer changed this");
    await rename(${JSON.stringify(linkPath)}, ${JSON.stringify(`${linkPath}.stale`)});
    db.exec("DELETE FROM skills");
  }
  db.exec("COMMIT");
  process.send("committed");
} catch {
  if (db.isTransaction) db.exec("ROLLBACK");
  process.send("rejected");
}
db.close();
process.disconnect();\n`;
    const writer = spawn(process.execPath, ["--input-type=module", "-e", writerScript], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const writerExit = once(writer, "close");
    t.after(async () => {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill();
      await writerExit;
    });
    assert.equal(
      await Promise.race([once(writer, "message").then(([message]) => message), writerExit.then(() => "writer exited")]),
      "ready",
    );
    if (mode === "active") {
      const preload = path.join(parent, "barrier.mjs");
      await writeFile(
        preload,
        `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { try { return exec.call(this, sql); } catch (err) { if (sql === "BEGIN IMMEDIATE" && this.location("main") === ${JSON.stringify(path.join(home, "index.db"))} && err.errcode === 5) process.send("busy"); throw err; } };\n`,
      );
      const migration = spawn(process.execPath, ["--import", preload, CLI, "migrate"], {
        env: { ...process.env, MARGRAVE_HOME: home },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stderr = "";
      migration.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exit = once(migration, "close");
      t.after(async () => {
        if (migration.exitCode === null && migration.signalCode === null) migration.kill();
        await exit;
      });
      assert.equal(
        await Promise.race([once(migration, "message").then(([message]) => message), exit.then(() => "migration exited")]),
        "busy",
      );
      writer.send("continue");
      assert.equal((await once(writer, "message"))[0], "committed");
      assert.equal((await exit)[0], 0, stderr);
      assert.equal(catalogRecords(home)[0]?.installedAt, "writer-finished");
      const backupName = (JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { backup: string }).backup;
      const archived = execFileSync("/usr/bin/tar", ["-xOf", path.join(parent, backupName, "store.tar"), "./sources.json"], {
        encoding: "utf8",
      });
      assert.equal(JSON.parse(archived)[0].installedAt, "writer-finished");
    } else {
      const migrated = await runCli(["migrate"], { home });
      assert.equal(migrated.code, 0, migrated.stderr);
      const before = await readFile(path.join(home, "index.db"));
      const sourceBefore = await readFile(path.join(home, "sources.json"));
      writer.send("continue");
      assert.equal((await once(writer, "message"))[0], "rejected");
      assert.deepEqual(await readFile(path.join(home, "index.db")), before);
      assert.deepEqual(await readFile(path.join(home, "sources.json")), sourceBefore);
    }
    assert.equal(await readlink(linkPath), linkBefore);
    assert.deepEqual(await readFile(skillPath), skillBefore);
  }
});

test("migration retains the SQLite lock while preparing the source record", async (t) => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const records = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { id: string; snapshot: string }[];
  const source = records[0]!;
  const aliasPath = path.join(home, "sources", source.id);
  const originalLink = await readlink(aliasPath);
  const skill = path.join(home, "snapshots", source.id, source.snapshot, "release-upgrade", "SKILL.md");
  const originalSkill = await readFile(skill);
  const preload = path.join(parent, "barrier.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = async function(from, to) { if (to === ${JSON.stringify(path.join(home, "sources.json"))}) { process.send("before-record"); await new Promise(resolve => process.once("message", resolve)); } return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  const migration = spawn(process.execPath, ["--import", preload, CLI, "migrate"], {
    env: { ...process.env, MARGRAVE_HOME: home },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  migration.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(migration, "close");
  t.after(async () => {
    if (migration.exitCode === null && migration.signalCode === null) migration.kill();
    await exited;
  });
  assert.equal(
    await Promise.race([once(migration, "message").then(([message]) => message), exited.then(() => `exited: ${stderr}`)]),
    "before-record",
  );
  const attempt = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(path.join(home, "index.db"))}, { timeout: 0 });
try { db.exec("BEGIN IMMEDIATE"); process.exitCode = 2; } catch (err) { process.exitCode = err.errcode === 5 ? 0 : 3; } finally { db.close(); }`,
    ],
    { stdio: "ignore" },
  );
  assert.equal((await once(attempt, "close"))[0], 0, "the legacy writer must see SQLITE_BUSY");
  migration.send("continue");
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(catalogRecords(home)[0]?.id, source.id);
  assert.equal(indexRows(home).length, 1);
  assert.deepEqual(await readFile(skill), originalSkill);
  assert.equal(await readlink(aliasPath), originalLink);
});

test("migration waits for a shared reader at commit", async (t) => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const script = `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(path.join(home, "index.db"))}, { readOnly: true });
db.exec("BEGIN"); db.prepare("SELECT count(*) FROM skills").get(); process.send("ready");
await new Promise(resolve => process.once("message", resolve)); db.exec("COMMIT"); db.close(); process.disconnect();\n`;
  const reader = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const readerExit = once(reader, "close");
  t.after(async () => {
    if (reader.exitCode === null && reader.signalCode === null) reader.kill();
    await readerExit;
  });
  assert.equal(await Promise.race([once(reader, "message").then(([message]) => message), readerExit.then(() => "reader exited")]), "ready");
  const preload = path.join(parent, "commit.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "PRAGMA user_version = 4; COMMIT") process.send({ phase: "commit", timeout: Number(this.prepare("PRAGMA busy_timeout").get().timeout) }); return exec.call(this, sql); };\n`,
  );
  const migration = spawn(process.execPath, ["--import", preload, CLI, "migrate"], {
    env: { ...process.env, MARGRAVE_HOME: home },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  migration.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(migration, "close");
  t.after(async () => {
    if (migration.exitCode === null && migration.signalCode === null) migration.kill();
    await exited;
  });
  assert.deepEqual(await Promise.race([once(migration, "message").then(([message]) => message), exited.then(() => `exited: ${stderr}`)]), {
    phase: "commit",
    timeout: 30000,
  });
  reader.send("release");
  assert.equal((await readerExit)[0], 0);
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(indexRows(home).length, 1);
});

test("legacy writer lock timeout preserves the store for retry", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const index = path.join(home, "index.db");
  const before = await readFile(index);
  const sources = await readFile(path.join(home, "sources.json"));
  const preload = path.join(parent, "timeout.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
let now = 0; Date.now = () => (now += 40000);
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "BEGIN IMMEDIATE" && this.location("main") === ${JSON.stringify(index)}) throw Object.assign(new Error("busy"), { errcode: 5 }); return exec.call(this, sql); };\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /another Margrave writer holds the legacy catalog lock/u);
  assert.deepEqual(await readFile(index), before);
  assert.deepEqual(await readFile(path.join(home, "sources.json")), sources);
  assert.equal((await runCli(["migrate"], { home })).code, 0);
});

test("legacy migration refuses WAL sidecars and non-file journals", async () => {
  for (const sidecar of ["index.db-wal", "index.db-shm", "index.db-journal"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const before = await readFile(path.join(home, "index.db"));
    if (sidecar === "index.db-journal") await mkdir(path.join(home, sidecar));
    else await writeFile(path.join(home, sidecar), "unrelated");
    const result = await runCli(["migrate"], { home });
    assert.equal(result.code, 1, sidecar);
    assert.deepEqual(await readFile(path.join(home, "index.db")), before);
    assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-")).length, 0);
  }
});

test("migration refuses catalog probe and journal races before writing", async () => {
  for (const failure of ["probe", "open", "journal-directory"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const index = path.join(home, "index.db");
    const before = await readFile(index);
    const source = await readFile(path.join(home, "sources.json"));
    const preload = path.join(parent, "race.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
const failure = ${JSON.stringify(failure)}; const prepare = DatabaseSync.prototype.prepare; const exec = DatabaseSync.prototype.exec;
let reader = false;
DatabaseSync.prototype.prepare = function(sql) { if (failure === "probe" && sql.startsWith("SELECT (SELECT user_version")) throw new Error("probe denied"); return prepare.call(this, sql); };
DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this, sql); if (sql === "BEGIN") reader = true; return result; };
const lstat = fs.lstat;
let replaced = false;
fs.lstat = async function(file, ...args) { if (failure === "open" && !replaced && file === ${JSON.stringify(`${index}-journal`)}) { replaced = true; await fs.rename(${JSON.stringify(index)}, ${JSON.stringify(`${index}.saved`)}); await fs.mkdir(${JSON.stringify(index)}); } if (failure === "journal-directory" && reader && file === ${JSON.stringify(`${index}-journal`)}) { reader = false; await fs.mkdir(file); } return lstat.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
    );
    const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(failed.code, 1, failure);
    assert.match(failed.stderr, failure === "probe" ? /probe denied/u : failure === "open" ? /cannot open/u : /unfinished v0\.2\.1 write/u);
    if (failure === "open") {
      await rm(index, { recursive: true });
      await rename(`${index}.saved`, index);
    }
    assert.deepEqual(await readFile(index), before);
    assert.deepEqual(await readFile(path.join(home, "sources.json")), source);
    if (failure === "journal-directory") await rm(`${index}-journal`, { recursive: true });
    assert.equal((await runCli(["migrate"], { home })).code, 0);
  }
});
