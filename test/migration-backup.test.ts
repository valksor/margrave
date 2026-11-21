import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { chmod, link as hardlink, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock } from "node:test";
import { backupMigrationStore, writeMigrationRecord, lockLegacyCatalog, readLegacySources } from "../src/store.ts";
import { copyLegacyStoreFixture, tmp, hostedUseHome as useHome, runCli } from "./helpers.ts";

test("legacy backup preserves catalog and registered snapshot", async (t) => {
  const home = await useHome(t);
  t.after(() => rm(home, { recursive: true, force: true }));
  await copyLegacyStoreFixture(home);
  await mkdir(path.join(home, "snapshots", "unregistered"));
  await writeFile(path.join(home, "snapshots", "unregistered", "work"), "not part of the store");
  await writeFile(path.join(home, "work-in-progress"), "not part of the store");
  const sources = await readLegacySources();
  const source = sources[0]!;
  await symlink("release-upgrade/SKILL.md", path.join(home, "snapshots", source.id, source.snapshot!, "skill-link"));
  await mkdir(path.join(home, "snapshots", source.id, source.snapshot!, "long-" + "x".repeat(120)));
  const locked = await lockLegacyCatalog();
  assert.equal(locked.version, 2);
  assert.equal(locked.db.isTransaction, true);
  locked.db.close();
  const previousTarOptions = process.env["TAR_OPTIONS"];
  process.env["TAR_OPTIONS"] = "--not-a-real-tar-option";
  let backup: string;
  try {
    backup = await backupMigrationStore(2, sources);
  } finally {
    if (previousTarOptions === undefined) delete process.env["TAR_OPTIONS"];
    else process.env["TAR_OPTIONS"] = previousTarOptions;
  }
  t.after(() => rm(backup, { recursive: true, force: true }));
  assert.equal(await backupMigrationStore(2, sources), backup);
  assert.equal((await lstat(backup)).mode & 0o777, 0o700);
  const restored = await tmp("mg-restored-");
  t.after(() => rm(restored, { recursive: true, force: true }));
  execFileSync("/usr/bin/tar", ["--acls", "--xattrs", "-xf", path.join(backup, "store.tar"), "-C", restored]);
  for (const file of ["index.db", "sources.json"]) {
    assert.deepEqual(await readFile(path.join(restored, file)), await readFile(path.join(home, file)));
    const restoredStat = await lstat(path.join(restored, file));
    const originalStat = await lstat(path.join(home, file));
    assert.equal(restoredStat.mode & 0o777, originalStat.mode & 0o777);
    assert.equal(restoredStat.uid, originalStat.uid);
    assert.equal(restoredStat.gid, originalStat.gid);
  }
  await assert.rejects(lstat(path.join(restored, "snapshots", "unregistered")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(restored, "work-in-progress")), { code: "ENOENT" });
  const link = path.join("sources", source.id);
  assert.equal(await readlink(path.join(restored, link)), await readlink(path.join(home, link)));
  const snapshot = path.join("snapshots", source.id, source.snapshot!);
  async function compareTree(relative: string): Promise<void> {
    const original = path.join(home, relative);
    const copied = path.join(restored, relative);
    const [before, after] = await Promise.all([lstat(original), lstat(copied)]);
    assert.equal(after.mode, before.mode);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    if (before.isSymbolicLink()) assert.equal(await readlink(copied), await readlink(original));
    else if (before.isDirectory()) {
      const names = (await readdir(original)).sort();
      assert.deepEqual((await readdir(copied)).sort(), names);
      for (const name of names) await compareTree(path.join(relative, name));
    } else assert.deepEqual(await readFile(copied), await readFile(original));
  }
  await compareTree(snapshot);
  const archivedSources = JSON.parse(await readFile(path.join(restored, "sources.json"), "utf8")) as typeof sources;
  assert.deepEqual(
    archivedSources.map(({ id, ref, commit }) => [id, ref, commit]),
    sources.map(({ id, ref, commit }) => [id, ref, commit]),
  );
});

test("legacy backup validates selected file types and completed backups", async (t) => {
  const parent = await useHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const scenario of [
    "missing-alias",
    "bad-snapshots",
    "bad-sources",
    "bad-alias",
    "bad-catalog",
    "special",
    "special-catalog",
    "bad-record",
    "bad-backup",
    "backup-mode",
    "manifest-mode",
    "manifest-content",
    "manifest-identity",
    "changed-source-list",
    "abandoned",
  ]) {
    const home = path.join(parent, scenario);
    await copyLegacyStoreFixture(home);
    process.env["MARGRAVE_HOME"] = home;
    const sources = await readLegacySources();
    const source = sources[0]!;
    if (scenario === "missing-alias") {
      await rm(path.join(home, "sources"), { recursive: true });
      await backupMigrationStore(2, sources);
      continue;
    }
    if (scenario === "bad-snapshots") {
      await rm(path.join(home, "snapshots"), { recursive: true });
      await writeFile(path.join(home, "snapshots"), "not a directory");
    } else if (scenario === "bad-sources") {
      await rm(path.join(home, "sources"), { recursive: true });
      await writeFile(path.join(home, "sources"), "not a directory");
    } else if (scenario === "bad-alias") {
      await rm(path.join(home, "sources", source.id));
      await writeFile(path.join(home, "sources", source.id), "not a link");
    } else if (scenario === "bad-catalog") {
      await rm(path.join(home, "index.db"));
      await mkdir(path.join(home, "index.db"));
    } else if (scenario === "special") {
      execFileSync("/usr/bin/mkfifo", [path.join(home, "snapshots", source.id, source.snapshot!, "fifo")]);
    } else if (scenario === "special-catalog") {
      await rm(path.join(home, "index.db"));
      execFileSync("/usr/bin/mkfifo", [path.join(home, "index.db")]);
    } else if (scenario === "bad-record") {
      source.id = "../invalid";
    } else if (scenario === "abandoned") {
      const backup = await backupMigrationStore(2, sources);
      const abandoned = `${backup.slice(0, -6)}abcdef`;
      await mkdir(abandoned, { mode: 0o700 });
      assert.equal(await backupMigrationStore(2, sources), backup);
      assert.ok((await lstat(abandoned)).isDirectory());
      continue;
    } else {
      const backup = await backupMigrationStore(2, sources);
      if (scenario === "changed-source-list") {
        await writeFile(path.join(home, "sources.json"), "[]\n");
        await assert.rejects(writeMigrationRecord(backup), /cannot verify the interrupted Margrave upgrade/u);
        continue;
      }
      if (scenario === "backup-mode") await chmod(backup, 0o755);
      else if (scenario === "manifest-mode") await chmod(path.join(backup, "manifest.json"), 0o644);
      else if (scenario === "manifest-content") await writeFile(path.join(backup, "manifest.json"), "{}");
      else if (scenario === "manifest-identity") {
        const manifestFile = path.join(backup, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { store: string };
        manifest.store = "/another-store";
        await writeFile(manifestFile, JSON.stringify(manifest));
      } else await writeFile(path.join(backup, "store.tar"), "corrupt");
    }
    await assert.rejects(backupMigrationStore(2, sources), /cannot back up the Margrave store/u, scenario);
  }
});

test("backup cleanup handles non-Error failures before and after staging", async (t) => {
  const parent = await useHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  process.env["MARGRAVE_HOME"] = home;
  const sources = await readLegacySources();
  const before = await readFile(path.join(home, "index.db"));
  let error: unknown = "backup failure";
  const readdirOriginal = fs.readdir;
  mock.method(fs, "readdir", ((...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === parent) throw error;
    return readdirOriginal(...args);
  }) as typeof fs.readdir);
  syncBuiltinESMExports();
  try {
    await assert.rejects(backupMigrationStore(2, sources), /backup failure/u);
    error = new Error("backup failure");
    await assert.rejects(backupMigrationStore(2, sources), /backup failure/u);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  const writeOriginal = fs.writeFile;
  mock.method(fs, "writeFile", ((...args: Parameters<typeof fs.writeFile>) => {
    if (typeof args[0] === "string" && args[0].includes(".margrave-upgrade-v2-") && args[0].endsWith("/members")) throw error;
    return writeOriginal(...args);
  }) as typeof fs.writeFile);
  syncBuiltinESMExports();
  try {
    await assert.rejects(backupMigrationStore(2, sources), /backup failure/u);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-")).length, 0);
  await backupMigrationStore(2, sources);
});

test("directory ACL changes create a distinct backup and survive restore", { skip: process.platform !== "darwin" }, async (t) => {
  const parent = await useHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  process.env["MARGRAVE_HOME"] = home;
  const sources = await readLegacySources();
  const source = sources[0]!;
  const directory = path.join("snapshots", source.id, source.snapshot!);
  const before = await backupMigrationStore(2, sources);
  const mode = (await lstat(path.join(home, directory))).mode;
  const user = execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();
  execFileSync("/bin/chmod", ["+a", `user:${user} allow list,search,readattr`, path.join(home, directory)]);
  assert.equal((await lstat(path.join(home, directory))).mode, mode);
  const after = await backupMigrationStore(2, sources);
  assert.notEqual(after, before);
  assert.equal(await backupMigrationStore(2, sources), after);
  const restored = path.join(parent, "restored");
  await mkdir(restored);
  execFileSync("/usr/bin/tar", ["--acls", "--xattrs", "-xf", path.join(after, "store.tar"), "-C", restored]);
  const acl = (dir: string): string =>
    execFileSync("/bin/ls", ["-lde", path.join(dir, directory)], { encoding: "utf8" })
      .split("\n")
      .slice(1)
      .join("\n");
  assert.notEqual(acl(home).trim(), "");
  assert.equal(acl(restored), acl(home));
});

test("backup does not release the catalog lock for another hard link", async (t) => {
  const parent = await useHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  process.env["MARGRAVE_HOME"] = home;
  const sources = await readLegacySources();
  const source = sources[0]!;
  const index = path.join(home, "index.db");
  await hardlink(index, path.join(home, "snapshots", source.id, source.snapshot!, "catalog-link"));
  const locked = await lockLegacyCatalog();
  try {
    await backupMigrationStore(2, sources);
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(${JSON.stringify(index)}, { timeout: 0 });
try { db.exec("BEGIN IMMEDIATE"); process.exitCode = 2; } catch (err) { process.exitCode = err.errcode === 5 ? 0 : 3; } finally { db.close(); }`,
    ]);
  } finally {
    locked.db.close();
  }
});

test("backup reports an unreadable catalog", { skip: process.getuid?.() === 0 }, async (t) => {
  const parent = await useHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  process.env["MARGRAVE_HOME"] = home;
  const sources = await readLegacySources();
  const index = path.join(home, "index.db");
  const mode = (await lstat(index)).mode & 0o777;
  await chmod(index, 0);
  try {
    await assert.rejects(backupMigrationStore(2, sources), /cannot back up the Margrave store/u);
  } finally {
    await chmod(index, mode);
  }
});

test("prepared record refuses backup files linked to the live catalog", async (t) => {
  const parent = await useHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const member of ["manifest.json", "store.tar"]) {
    const home = path.join(parent, member.replace(".", "-"));
    await copyLegacyStoreFixture(home);
    process.env["MARGRAVE_HOME"] = home;
    const sources = await readLegacySources();
    const backup = await backupMigrationStore(2, sources);
    const index = path.join(home, "index.db");
    const original = await readFile(index);
    await chmod(index, 0o600);
    const target = path.join(backup, member);
    await rm(target);
    await hardlink(index, target);
    await assert.rejects(writeMigrationRecord(backup), /cannot verify the interrupted Margrave upgrade/u);
    assert.deepEqual(await readFile(index), original);
  }
});

test("backup and record hashing preserve the catalog when the source list is a hard link", async (t) => {
  const parent = await useHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  process.env["MARGRAVE_HOME"] = home;
  const index = path.join(home, "index.db");
  const sourceFile = path.join(home, "sources.json");
  const original = await readFile(index);
  await rm(sourceFile);
  await hardlink(index, sourceFile);
  const locked = await lockLegacyCatalog();
  try {
    const backup = await backupMigrationStore(2, []);
    await writeMigrationRecord(backup);
  } finally {
    locked.db.close();
  }
  assert.deepEqual(await readFile(index), original);
});

test("backup reuse rejects a directory with an extended ACL", { skip: process.platform !== "darwin" }, async (t) => {
  const parent = await useHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  process.env["MARGRAVE_HOME"] = home;
  const sources = await readLegacySources();
  const backup = await backupMigrationStore(2, sources);
  const user = execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();
  execFileSync("/bin/chmod", ["+a", `user:${user} allow list,search,readattr`, backup]);
  try {
    await assert.rejects(backupMigrationStore(2, sources), /cannot back up the Margrave store/u);
  } finally {
    execFileSync("/bin/chmod", ["-N", backup]);
  }
});

test("backup rejects a snapshot changed during archiving", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const record = (JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { id: string; snapshot: string }[])[0]!;
  const snapshotPath = path.join(home, "snapshots", record.id, record.snapshot);
  const skill = path.join(snapshotPath, "release-upgrade", "SKILL.md");
  const original = await readFile(skill);
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(parent, "change.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const readdir = fs.readdir; let visits = 0;
fs.readdir = async function(dir, ...args) { if (dir === ${JSON.stringify(snapshotPath)} && ++visits === 3) await fs.writeFile(${JSON.stringify(skill)}, "changed"); return readdir.call(this, dir, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /store changed during backup/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  await writeFile(skill, original);
  assert.equal((await runCli(["migrate"], { home })).code, 0);
});

test("backup publication failures clean private staging and preserve the store", async () => {
  for (const point of ["before-stage", "after-stage"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await copyLegacyStoreFixture(home);
    const index = path.join(home, "index.db");
    const source = path.join(home, "sources.json");
    const beforeIndex = await readFile(index);
    const beforeSource = await readFile(source);
    const preload = path.join(parent, "backup-failure.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const point = ${JSON.stringify(point)};
const readdir = fs.readdir; const writeFile = fs.writeFile;
fs.readdir = function(dir, ...args) { if (point === "before-stage" && dir === ${JSON.stringify(parent)}) throw "backup failure"; return readdir.call(this, dir, ...args); };
fs.writeFile = function(file, ...args) { if (point === "after-stage" && String(file).includes(".margrave-upgrade-v2-") && String(file).endsWith("/members")) throw "backup failure"; return writeFile.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
    );
    const result = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(result.code, 1, point);
    assert.match(result.stderr, /cannot back up the Margrave store.*backup failure/u);
    assert.deepEqual(await readFile(index), beforeIndex);
    assert.deepEqual(await readFile(source), beforeSource);
    assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-")).length, 0);
    assert.equal((await runCli(["migrate"], { home })).code, 0);
  }
});
