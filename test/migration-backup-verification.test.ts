import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import fs, { chmod, link, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import test, { mock } from "node:test";
import type { TestContext } from "node:test";
import {
  backupMigrationStore,
  hashFile,
  hashLiveCatalog,
  migrationRecordSchema,
  sha256,
  verifyBackupFiles,
} from "../src/migration-backup.ts";
import { hasDirectoryAcl, hostedUseHome, tmp } from "./helpers.ts";

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

async function withCatDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cat deadline")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: TestContext) {
  const home = await hostedUseHome(t);
  t.after(() => rm(home, { recursive: true, force: true }));
  const backup = path.join(home, "backup");
  const catalog = path.join(home, "index.db");
  const manifestFile = path.join(backup, "manifest.json");
  const archive = path.join(backup, "store.tar");
  const bytes = Buffer.from([0, 255, 2, 128, 17]);
  await mkdir(backup, { mode: 0o700 });
  await writeFile(catalog, "live catalog", { mode: 0o600 });
  await writeFile(archive, bytes, { mode: 0o600 });
  const manifest = {
    kind: "margrave-store-backup",
    version: 1,
    store: home,
    from: 2,
    indexSha256: digest("index"),
    inventorySha256: digest("inventory"),
    archiveSha256: digest(bytes),
    sourcesSha256: digest("sources"),
  };
  await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  return { home, backup, catalog, manifestFile, archive, manifest };
}

test("migration backup verify direct hashes text, binary, empty and missing files", async (t) => {
  const dir = await tmp("mg-hash-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "data");
  const text = "text with unicode \u2603\n";
  const binary = Buffer.alloc(256 * 1024 + 13);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
  for (const value of [text, binary, Buffer.alloc(0)]) {
    await writeFile(file, value);
    assert.equal(sha256(value), digest(value));
    assert.equal(await hashFile(file), digest(value));
    assert.match(await hashFile(file), /^[0-9a-f]{64}$/u);
  }
  const missing = path.join(dir, "missing");
  await assert.rejects(hashFile(missing), { code: "ENOENT", syscall: "open", path: missing });
});

test("migration backup verify direct cat hashes bytes and reports native missing input", async (t) => {
  const dir = await tmp("mg-cat-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "catalog");
  const bytes = Buffer.from([0, 255, 10, 128]);
  await writeFile(file, bytes);
  const original = childProcess.spawn;
  const calls: unknown[][] = [];
  mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
    calls.push(args);
    return original(...args);
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    assert.equal(await withCatDeadline(hashLiveCatalog(file)), digest(bytes));
    assert.deepEqual(calls, [["/bin/cat", [file], { stdio: ["ignore", "pipe", "pipe"] }]]);
    const missing = path.join(dir, "missing");
    await assert.rejects(
      withCatDeadline(hashLiveCatalog(missing)),
      (error: Error) => error.message.includes(missing) && /no such file/i.test(error.message),
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("migration backup verify direct cat preserves spawn errors and combines stderr", async () => {
  const failure = new Error("spawn failure");
  for (const result of ["error", "exit", "signal"] as const) {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const encodingCalls: unknown[] = [];
    const setEncoding = child.stderr.setEncoding.bind(child.stderr);
    mock.method(child.stderr, "setEncoding", (encoding: BufferEncoding) => {
      encodingCalls.push(encoding);
      return setEncoding(encoding);
    });
    mock.method(childProcess, "spawn", (() => child) as unknown as typeof childProcess.spawn);
    syncBuiltinESMExports();
    try {
      const bounded = withCatDeadline(hashLiveCatalog("fixture"));
      assert.deepEqual(encodingCalls, ["utf8"]);
      if (result === "error") child.emit("error", failure);
      else {
        const bytes = Buffer.from("first ☃ second");
        child.stderr.write(bytes.subarray(0, 7));
        child.stderr.write(bytes.subarray(7, 8));
        child.stderr.write(bytes.subarray(8));
        child.emit("close", result === "exit" ? 1 : null, result === "signal" ? "SIGTERM" : null);
      }
      await assert.rejects(bounded, result === "error" ? (error: unknown) => error === failure : { message: "first ☃ second" });
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
});

test("migration backup verify direct accepts private backup versions and missing manifest", async (t) => {
  const f = await fixture(t);
  for (const from of [2, 3]) {
    const manifest = { ...f.manifest, from, sourcesSha256: from === 3 ? null : f.manifest.sourcesSha256 };
    await writeFile(f.manifestFile, JSON.stringify(manifest));
    assert.deepEqual(await verifyBackupFiles(f.backup), { manifest, owner: (await lstat(f.backup)).uid });
  }
  await rm(f.manifestFile);
  assert.equal(await verifyBackupFiles(f.backup), null);
});

test("migration backup verify direct rejects path, file type and mode faults", async (t) => {
  const f = await fixture(t);
  const invalid = { message: `invalid backup: ${f.backup}` };
  await assert.rejects(verifyBackupFiles(path.join(f.home, "missing")), { code: "ENOENT" });
  await assert.rejects(verifyBackupFiles(f.archive), { message: `invalid backup: ${f.archive}` });
  const alias = path.join(f.home, "alias");
  await symlink(f.backup, alias);
  await assert.rejects(verifyBackupFiles(alias), { message: `invalid backup: ${alias}` });
  await chmod(f.backup, 0o755);
  await assert.rejects(verifyBackupFiles(f.backup), invalid);
  await chmod(f.backup, 0o700);
  for (const file of [f.manifestFile, f.archive]) {
    await chmod(file, 0o644);
    await assert.rejects(verifyBackupFiles(f.backup), invalid);
    await chmod(file, 0o600);
    await rm(file);
    if (file === f.archive) await assert.rejects(verifyBackupFiles(f.backup), { code: "ENOENT" });
    await mkdir(file, { mode: 0o700 });
    await assert.rejects(verifyBackupFiles(f.backup), invalid);
    await rm(file, { recursive: true });
    await writeFile(file, file === f.archive ? Buffer.from([0, 255, 2, 128, 17]) : JSON.stringify(f.manifest), { mode: 0o600 });
    await rm(file);
    await symlink(f.catalog, file);
    await assert.rejects(verifyBackupFiles(f.backup), invalid);
    await rm(file);
    await writeFile(file, file === f.archive ? Buffer.from([0, 255, 2, 128, 17]) : JSON.stringify(f.manifest), { mode: 0o600 });
  }
});

test("migration backup verify direct rejects owner faults on each fixture path", async (t) => {
  const f = await fixture(t);
  const original = fs.lstat;
  for (const target of [f.backup, f.manifestFile, f.archive]) {
    mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args);
      if (args[0] === target) Object.defineProperty(stat, "uid", { value: Number(process.getuid?.()) + 1 });
      return stat;
    }) as typeof fs.lstat);
    syncBuiltinESMExports();
    try {
      await assert.rejects(verifyBackupFiles(f.backup), { message: `invalid backup: ${f.backup}` });
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});

test("migration backup verify direct rejects unavailable owner at directory and file checks", async (t) => {
  const f = await fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")!;
  const originalStat = fs.lstat;
  const paths: unknown[] = [];
  let disableOwnerAfterArchive = false;
  let toggled = false;
  mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
    paths.push(args[0]);
    const stat = await originalStat(...args);
    if (disableOwnerAfterArchive && args[0] === f.archive) {
      Object.defineProperty(process, "getuid", { ...descriptor, value: undefined });
      toggled = true;
    }
    return stat;
  }) as typeof fs.lstat);
  syncBuiltinESMExports();
  try {
    Object.defineProperty(process, "getuid", { ...descriptor, value: undefined });
    await assert.rejects(verifyBackupFiles(f.backup), { message: `invalid backup: ${f.backup}` });
    assert.deepEqual(paths, [f.backup]);
    Object.defineProperty(process, "getuid", descriptor);
    paths.length = 0;
    disableOwnerAfterArchive = true;
    await assert.rejects(verifyBackupFiles(f.backup), { message: `invalid backup: ${f.backup}` });
    assert.equal(toggled, true);
    assert.ok(paths.includes(f.manifestFile));
    assert.ok(paths.includes(f.archive));
  } finally {
    Object.defineProperty(process, "getuid", descriptor);
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("migration backup verify direct validates each manifest field", async (t) => {
  const f = await fixture(t);
  const changes = [
    { kind: "other" },
    { version: 2 },
    { from: 4 },
    { store: 42 },
    { indexSha256: "bad" },
    { inventorySha256: "bad" },
    { archiveSha256: "bad" },
    { sourcesSha256: "bad" },
    { extra: true },
    { archiveSha256: "0".repeat(64) },
  ];
  for (const change of changes) {
    await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, ...change }));
    await assert.rejects(verifyBackupFiles(f.backup), { message: `invalid backup: ${f.backup}` }, JSON.stringify(change));
  }
  await writeFile(f.manifestFile, "{");
  await assert.rejects(verifyBackupFiles(f.backup), SyntaxError);
});

test("migration backup verify direct handles catalog hardlinks and both identity fields", async (t) => {
  const f = await fixture(t);
  await rm(f.manifestFile);
  await link(f.catalog, f.manifestFile);
  await assert.rejects(verifyBackupFiles(f.backup), { message: `invalid backup: ${f.backup}` });
  const originalStat = fs.lstat;
  for (const field of ["dev", "ino"] as const) {
    mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await originalStat(...args);
      if (args[0] === f.manifestFile && args[1]?.bigint === true) Object.defineProperty(stat, field, { value: BigInt(stat[field]) + 1n });
      return stat;
    }) as typeof fs.lstat);
    syncBuiltinESMExports();
    try {
      await assert.rejects(verifyBackupFiles(f.backup), SyntaxError);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
  await rm(f.manifestFile);
  await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, archiveSha256: digest("live catalog") }), { mode: 0o600 });
  await rm(f.archive);
  await link(f.catalog, f.archive);
  const originalSpawn = childProcess.spawn;
  const calls: unknown[][] = [];
  mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
    calls.push(args);
    return originalSpawn(...args);
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    assert.ok(await verifyBackupFiles(f.backup));
    assert.deepEqual(calls, [["/bin/cat", [f.archive], { stdio: ["ignore", "pipe", "pipe"] }]]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  for (const field of ["dev", "ino"] as const) {
    mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await originalStat(...args);
      if (args[0] === f.archive && args[1]?.bigint === true) Object.defineProperty(stat, field, { value: BigInt(stat[field]) + 1n });
      return stat;
    }) as typeof fs.lstat);
    mock.method(childProcess, "spawn", (() => {
      throw new Error("unexpected cat");
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    try {
      assert.ok(await verifyBackupFiles(f.backup));
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  }
});

test("migration backup verify direct validates prepared record encoding", () => {
  const record = {
    kind: "margrave-store-migration",
    version: 1,
    phase: "prepared",
    from: 2,
    store: "/store",
    catalogDevice: "7",
    catalogInode: "123",
    backup: `.margrave-upgrade-v2-${"a".repeat(64)}-Ab09Zx`,
    indexSha256: digest("index"),
    sourcesSha256: digest("sources"),
  };
  assert.deepEqual(migrationRecordSchema.parse(record), record);
  assert.deepEqual(migrationRecordSchema.parse({ ...record, catalogDevice: "123" }), { ...record, catalogDevice: "123" });
  for (const change of [
    { kind: "other" },
    { phase: "done" },
    { version: 2 },
    { from: 3 },
    { store: 1 },
    { catalogDevice: "-1" },
    { catalogDevice: "123x" },
    { catalogInode: "1.0" },
    { backup: `.margrave-upgrade-v2-${"a".repeat(63)}-Ab09Zx` },
    { backup: `.margrave-upgrade-v2-${"A".repeat(64)}-Ab09Zx` },
    { backup: `x${record.backup}` },
    { backup: `${record.backup}x` },
    { backup: `.margrave-upgrade-v2-${"a".repeat(64)}-Ab09-_` },
    { indexSha256: "bad" },
    { sourcesSha256: "bad" },
    { extra: true },
  ])
    assert.equal(migrationRecordSchema.safeParse({ ...record, ...change }).success, false, JSON.stringify(change));
});

test(
  "migration backup verify direct skips directory ACL listing on alternate platform",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const f = await fixture(t);
    const user = execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();
    execFileSync("/bin/chmod", ["+a", `user:${user} allow list,search,readattr`, f.backup]);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      const listing = execFileSync("/bin/ls", ["-lde", f.backup], { encoding: "utf8" });
      assert.notEqual(listing.split("\n").slice(1).join("\n").trim(), "");
      await assert.rejects(verifyBackupFiles(f.backup), { message: `invalid backup: ${f.backup}` });
      Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
      assert.deepEqual(await verifyBackupFiles(f.backup), { manifest: f.manifest, owner: (await lstat(f.backup)).uid });
      assert.equal(execFileSync("/bin/ls", ["-lde", f.backup], { encoding: "utf8" }), listing);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      execFileSync("/bin/chmod", ["-N", f.backup]);
    }
  },
);

test("migration backup verify direct clears staging ACLs only on macOS", { skip: process.platform !== "darwin" }, async (t) => {
  const parent = await hostedUseHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const user = execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalMkdtemp = fs.mkdtemp;
  const originalOpen = fs.open;
  for (const platform of ["darwin", "linux"] as const) {
    const root = path.join(parent, platform);
    const store = path.join(root, "store");
    await mkdir(store, { recursive: true, mode: 0o700 });
    const catalog = new DatabaseSync(path.join(store, "index.db"));
    catalog.exec("CREATE TABLE fixture (value TEXT)");
    catalog.close();
    await chmod(path.join(store, "index.db"), 0o600);
    process.env["MARGRAVE_HOME"] = store;
    const metadataStages = new Set<string>();
    const metadataAcls: boolean[] = [];
    const stageAcls: string[] = [];
    mock.method(fs, "mkdtemp", (async (...args: Parameters<typeof fs.mkdtemp>) => {
      const dir = await originalMkdtemp(...args);
      assert.equal(typeof dir, "string");
      assert.equal(path.dirname(dir), root);
      assert.match(path.basename(dir), /^\.margrave-upgrade-(?:tmp-|v2-)/u);
      execFileSync("/bin/chmod", ["+a", `user:${user} allow list,search,readattr`, dir]);
      assert.equal(hasDirectoryAcl(dir), true);
      if (path.basename(dir).startsWith(".margrave-upgrade-tmp-")) metadataStages.add(dir);
      else stageAcls.push(dir);
      return dir;
    }) as typeof fs.mkdtemp);
    mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
      if (typeof args[0] === "string" && path.basename(args[0]) === "directories.tar" && metadataStages.has(path.dirname(args[0]))) {
        metadataAcls.push(hasDirectoryAcl(path.dirname(args[0])));
      }
      return originalOpen(...args);
    }) as typeof fs.open);
    syncBuiltinESMExports();
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      const backup = await backupMigrationStore(2, []);
      assert.deepEqual(metadataAcls, [platform === "linux", platform === "linux"]);
      assert.deepEqual(stageAcls, [backup]);
      assert.equal(hasDirectoryAcl(backup), platform === "linux");
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      mock.restoreAll();
      syncBuiltinESMExports();
      for (const dir of stageAcls) if (existsSync(dir)) execFileSync("/bin/chmod", ["-N", dir]);
    }
  }
});
