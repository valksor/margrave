import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import fs, { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { mock } from "node:test";
import type { TestContext } from "node:test";
import { backupMigrationStore, writeMigrationRecord } from "../src/migration-backup.ts";
import { recoverMigrationRecord } from "../src/migration-recovery.ts";
import { MargraveError, readLegacySources } from "../src/store-files.ts";
import { copyLegacyStoreFixture, hasDirectoryAcl, hostedUseHome } from "./helpers.ts";

async function fixture(t: TestContext) {
  const parent = await hostedUseHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const store = path.join(parent, "store");
  await copyLegacyStoreFixture(store);
  process.env["MARGRAVE_HOME"] = store;
  const source = path.join(store, "sources.json");
  const index = path.join(store, "index.db");
  const sources = await readFile(source, "utf8");
  const indexBytes = await readFile(index);
  const backup = await backupMigrationStore(2, await readLegacySources());
  await writeMigrationRecord(backup);
  const marker = await readFile(source);
  const record = JSON.parse(marker.toString()) as Record<string, string>;
  const manifestFile = path.join(backup, "manifest.json");
  const manifestBytes = await readFile(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString()) as Record<string, unknown>;
  const archiveBytes = await readFile(path.join(backup, "store.tar"));
  const invalid = {
    name: "Error",
    message: `cannot verify the interrupted Margrave upgrade at ${store}. Restore a complete backup. See Upgrading in the README.`,
  };
  async function preserved(expectedMarker = marker, expectedIndex = indexBytes) {
    assert.deepEqual(await readFile(source), expectedMarker);
    assert.deepEqual(await readFile(index), expectedIndex);
    assert.deepEqual(await readFile(manifestFile), manifestBytes);
    assert.deepEqual(await readFile(path.join(backup, "store.tar")), archiveBytes);
    assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-tmp-")).length, 0);
  }
  return {
    parent,
    store,
    source,
    index,
    sources,
    indexBytes,
    backup,
    marker,
    record,
    manifestFile,
    manifestBytes,
    manifest,
    invalid,
    preserved,
  };
}

function restoreMocks() {
  mock.restoreAll();
  syncBuiltinESMExports();
}

async function withExtractionDeadline<T>(recovery: Promise<T>, currentChild: () => EventEmitter | undefined): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = recovery.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    const outcome = await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new assert.AssertionError({ message: "extraction did not settle" }));
          const child = currentChild();
          if (child?.listenerCount("error")) child.emit("error", new Error("extraction timed out"));
        }, 2000);
      }),
    ]);
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    clearTimeout(timer);
    await settled;
  }
}

test("migration recovery record direct ignores absent and ordinary source data", async (t) => {
  const f = await fixture(t);
  await rm(f.source);
  assert.equal(await recoverMigrationRecord(), null);
  assert.deepEqual(await readFile(f.index), f.indexBytes);
  assert.deepEqual(await readFile(f.manifestFile), f.manifestBytes);
  for (const value of [f.sources, "{", "null", "[]", JSON.stringify({ kind: "other" })]) {
    await writeFile(f.source, value);
    assert.equal(await recoverMigrationRecord(), null);
    await f.preserved(Buffer.from(value));
  }
  await writeFile(f.source, f.marker);
  await f.preserved();
});

test("migration recovery record direct rejects non-file and malformed prepared markers", async (t) => {
  const f = await fixture(t);
  await rm(f.source);
  await mkdir(f.source);
  const directory = await lstat(f.source);
  await assert.rejects(recoverMigrationRecord(), f.invalid);
  const after = await lstat(f.source);
  assert.ok(after.isDirectory());
  assert.equal(after.dev, directory.dev);
  assert.equal(after.ino, directory.ino);
  assert.deepEqual(await fs.readdir(f.source), []);
  assert.deepEqual(await readFile(f.index), f.indexBytes);
  assert.deepEqual(await readFile(f.manifestFile), f.manifestBytes);
});

test("migration recovery record direct rejects malformed prepared markers", async (t) => {
  const f = await fixture(t);
  const malformed = Buffer.from(JSON.stringify({ kind: "margrave-store-migration" }));
  await writeFile(f.source, malformed);
  await assert.rejects(recoverMigrationRecord(), f.invalid);
  await f.preserved(malformed);
});

test("migration recovery record direct normalizes source read failures", async (t) => {
  const f = await fixture(t);
  const original = fs.readFile;
  for (const failure of [new Error("read denied"), "read denied"]) {
    mock.method(fs, "readFile", (async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === f.source) return Promise.reject(failure);
      return original(...args);
    }) as typeof fs.readFile);
    syncBuiltinESMExports();
    try {
      await assert.rejects(recoverMigrationRecord(), (error: unknown) => {
        assert.ok(error instanceof MargraveError);
        assert.equal(error.message, "cannot upgrade the v0.2.1 catalog: read denied");
        return true;
      });
    } finally {
      restoreMocks();
    }
    await f.preserved();
  }
});

test("migration recovery record direct does not remove scratch when allocation fails", async (t) => {
  const f = await fixture(t);
  const originalMkdtemp = fs.mkdtemp;
  const originalRm = fs.rm;
  const prefix = path.join(f.parent, ".margrave-upgrade-tmp-");
  let allocations = 0;
  const removals: Parameters<typeof fs.rm>[] = [];
  mock.method(fs, "mkdtemp", (async (...args: Parameters<typeof fs.mkdtemp>) => {
    if (args[0] === prefix) {
      allocations++;
      throw new Error("injected allocation failure");
    }
    return originalMkdtemp(...args);
  }) as typeof fs.mkdtemp);
  mock.method(fs, "rm", (async (...args: Parameters<typeof fs.rm>) => {
    removals.push(args);
    return originalRm(...args);
  }) as typeof fs.rm);
  syncBuiltinESMExports();
  try {
    await assert.rejects(recoverMigrationRecord(), f.invalid);
    assert.equal(allocations, 1);
    assert.deepEqual(removals, []);
  } finally {
    restoreMocks();
  }
  await f.preserved();
});

test("migration recovery record direct extracts verified members and closes native handles", async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  const originalSpawn = childProcess.spawn;
  const originalMkdtemp = fs.mkdtemp;
  const originalRm = fs.rm;
  const opened: { file: string; flags: unknown; mode: unknown; fd: number; closes: number }[] = [];
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  const calls: Parameters<typeof childProcess.spawn>[] = [];
  let child: ReturnType<typeof childProcess.spawn> | undefined;
  let scratch: string | undefined;
  const removed: Parameters<typeof fs.rm>[] = [];
  mock.method(fs, "mkdtemp", (async (...args: Parameters<typeof fs.mkdtemp>) => {
    const directory = await originalMkdtemp(...args);
    if (args[0] === path.join(f.parent, ".margrave-upgrade-tmp-")) scratch = directory;
    return directory;
  }) as typeof fs.mkdtemp);
  mock.method(fs, "rm", (async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === scratch) removed.push(args);
    return originalRm(...args);
  }) as typeof fs.rm);
  mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(path.join(f.parent, ".margrave-upgrade-tmp-"))) {
      const item = { file: String(args[0]), flags: args[1], mode: args[2], fd: handle.fd, closes: 0 };
      opened.push(item);
      handles.push(handle);
      const close = handle.close.bind(handle);
      mock.method(handle, "close", async () => {
        item.closes++;
        await close();
      });
    }
    return handle;
  }) as typeof fs.open);
  mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
    if (args[0] === "/usr/bin/tar") calls.push(args);
    const spawned = originalSpawn(...args);
    if (args[0] === "/usr/bin/tar") child = spawned;
    return spawned;
  }) as typeof childProcess.spawn);
  const previous = process.env["TAR_OPTIONS"];
  const previousInherited = process.env["MARGRAVE_TEST_INHERITED"];
  process.env["TAR_OPTIONS"] = "--invalid-option";
  process.env["MARGRAVE_TEST_INHERITED"] = "preserved";
  syncBuiltinESMExports();
  const recovery = recoverMigrationRecord();
  try {
    const result = await withExtractionDeadline(recovery, () => child);
    assert.deepEqual(result, { backup: f.backup, sources: f.sources });
  } finally {
    if (previous === undefined) delete process.env["TAR_OPTIONS"];
    else process.env["TAR_OPTIONS"] = previous;
    if (previousInherited === undefined) delete process.env["MARGRAVE_TEST_INHERITED"];
    else process.env["MARGRAVE_TEST_INHERITED"] = previousInherited;
    restoreMocks();
    for (const handle of handles) if (handle.fd !== -1) await handle.close();
  }
  assert.ok(scratch);
  assert.deepEqual(removed, [[scratch, { recursive: true, force: true }]]);
  assert.equal(existsSync(scratch), false);
  assert.equal(opened.length, 2);
  assert.deepEqual(
    opened.map(({ file, flags, mode, closes }) => [path.basename(file), flags, mode, closes]),
    [
      ["original.db", "wx", 0o600, 1],
      ["sources.json", "wx", 0o600, 1],
    ],
  );
  assert.equal(calls.length, 2);
  for (const [i, member] of ["./index.db", "./sources.json"].entries()) {
    const [command, args, options] = calls[i]!;
    assert.equal(command, "/usr/bin/tar");
    assert.deepEqual(args, ["-xOf", path.join(scratch, "store.tar"), member]);
    assert.deepEqual(options?.stdio, ["ignore", opened[i]!.fd, "pipe"]);
    assert.ok(Object.hasOwn(options?.env ?? {}, "TAR_OPTIONS"));
    assert.equal(options?.env?.["TAR_OPTIONS"], undefined);
    assert.equal(options?.env?.["MARGRAVE_TEST_INHERITED"], "preserved");
  }
  await f.preserved();
});

test("migration recovery extracts the verified copy after the backup archive is replaced", async (t) => {
  const f = await fixture(t);
  const originalSpawn = childProcess.spawn;
  let replaced = false;
  mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
    if (args[0] === "/usr/bin/tar" && !replaced) {
      writeFileSync(path.join(f.backup, "store.tar"), "replacement");
      replaced = true;
    }
    return originalSpawn(...args);
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await recoverMigrationRecord(), { backup: f.backup, sources: f.sources });
    assert.equal(replaced, true);
    assert.equal(await readFile(path.join(f.backup, "store.tar"), "utf8"), "replacement");
    assert.equal((await readdir(f.parent)).filter((name) => name.startsWith(".margrave-upgrade-tmp-")).length, 0);
  } finally {
    restoreMocks();
  }
});

test("migration recovery record direct handles scratch ACL by platform", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await fixture(t);
  const originalMkdtemp = fs.mkdtemp;
  const originalOpen = fs.open;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const user = execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();
  const prefix = path.join(f.parent, ".margrave-upgrade-tmp-");
  for (const system of ["darwin", "linux"] as const) {
    let scratch: string | undefined;
    let observed: boolean | undefined;
    mock.method(fs, "mkdtemp", (async (...args: Parameters<typeof fs.mkdtemp>) => {
      const directory = await originalMkdtemp(...args);
      if (args[0] === prefix) {
        assert.equal(scratch, undefined);
        scratch = directory;
        execFileSync("/bin/chmod", ["+a", `user:${user} allow list,search,readattr`, directory]);
        assert.equal(hasDirectoryAcl(directory), true);
      }
      return directory;
    }) as typeof fs.mkdtemp);
    mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
      if (scratch !== undefined && args[0] === path.join(scratch, "original.db")) {
        assert.equal(observed, undefined);
        observed = hasDirectoryAcl(scratch);
      }
      return originalOpen(...args);
    }) as typeof fs.open);
    syncBuiltinESMExports();
    try {
      if (system === "linux") Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      assert.deepEqual(await recoverMigrationRecord(), { backup: f.backup, sources: f.sources });
      assert.ok(scratch?.startsWith(prefix));
      assert.notEqual(observed, undefined);
      if (system === "darwin") assert.equal(observed, false);
      else assert.equal(observed, true);
    } finally {
      Object.defineProperty(process, "platform", platform);
      restoreMocks();
      if (scratch !== undefined && existsSync(scratch)) execFileSync("/bin/chmod", ["-N", scratch]);
    }
    await f.preserved();
  }
});

test("migration recovery record direct rejects independent verification mismatches", async (t) => {
  const f = await fixture(t);
  const otherBackup = path.join(f.parent, `.margrave-upgrade-v2-${"0".repeat(64)}-Ab09Zx`);
  await cp(f.backup, otherBackup, { recursive: true });
  const changes = [
    { store: path.join(f.parent, "other") },
    { catalogDevice: (BigInt(f.record["catalogDevice"]!) + 1n).toString() },
    { catalogInode: (BigInt(f.record["catalogInode"]!) + 1n).toString() },
    { backup: path.basename(otherBackup) },
    { backup: `.margrave-upgrade-v2-${"1".repeat(64)}-Ab09Zx` },
  ];
  for (const change of changes) {
    const marker = Buffer.from(JSON.stringify({ ...f.record, ...change }));
    await writeFile(f.source, marker);
    await assert.rejects(recoverMigrationRecord(), f.invalid, JSON.stringify(change));
    await f.preserved(marker);
  }
  await writeFile(f.source, f.marker);
  for (const change of [
    { store: path.join(f.parent, "other") },
    { from: 3 },
    { indexSha256: "0".repeat(64) },
    { sourcesSha256: "0".repeat(64) },
  ]) {
    await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, ...change }));
    try {
      await assert.rejects(recoverMigrationRecord(), f.invalid, JSON.stringify(change));
    } finally {
      await writeFile(f.manifestFile, f.manifestBytes);
    }
    await f.preserved();
  }
  await rm(f.manifestFile);
  try {
    await assert.rejects(recoverMigrationRecord(), f.invalid);
  } finally {
    await writeFile(f.manifestFile, f.manifestBytes);
  }
  await f.preserved();
  const changed = Buffer.concat([f.indexBytes, Buffer.from("changed")]);
  await writeFile(f.index, changed);
  try {
    await assert.rejects(recoverMigrationRecord(), f.invalid);
    await f.preserved(f.marker, changed);
  } finally {
    await writeFile(f.index, f.indexBytes);
  }
  await f.preserved();
});

test("migration recovery record direct rejects changed extracted member bytes", async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  const originalSpawn = childProcess.spawn;
  for (const target of ["original.db", "sources.json"]) {
    const opened: { file: string; fd: number; closes: number; changed: boolean }[] = [];
    const calls: Parameters<typeof childProcess.spawn>[] = [];
    mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const file = String(args[0]);
      if (file.startsWith(path.join(f.parent, ".margrave-upgrade-tmp-"))) {
        const item = { file, fd: handle.fd, closes: 0, changed: false };
        opened.push(item);
        const close = handle.close.bind(handle);
        mock.method(handle, "close", async () => {
          await close();
          item.closes++;
          if (path.basename(file) === target) {
            await writeFile(file, "changed extracted bytes");
            item.changed = true;
          }
        });
      }
      return handle;
    }) as typeof fs.open);
    mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
      if (args[0] === "/usr/bin/tar") calls.push(args);
      return originalSpawn(...args);
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    try {
      await assert.rejects(recoverMigrationRecord(), f.invalid);
    } finally {
      restoreMocks();
    }
    assert.deepEqual(
      opened.map(({ file, closes, changed }) => [path.basename(file), closes, changed]),
      [
        ["original.db", 1, target === "original.db"],
        ["sources.json", 1, target === "sources.json"],
      ],
    );
    assert.equal(calls.length, 2);
    for (const [i, member] of ["./index.db", "./sources.json"].entries()) {
      assert.deepEqual(calls[i]![1], ["-xOf", path.join(path.dirname(opened[i]!.file), "store.tar"), member]);
      assert.deepEqual(calls[i]![2]?.stdio, ["ignore", opened[i]!.fd, "pipe"]);
    }
    await f.preserved();
  }
});

test("migration recovery record direct normalizes extraction failure and closes output", async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  const originalSpawn = childProcess.spawn;
  const originalMkdtemp = fs.mkdtemp;
  const originalRm = fs.rm;
  for (const failure of ["error", "exit", "signal"] as const) {
    const opened: { fd: number; closes: number }[] = [];
    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    let scratch: string | undefined;
    const removed: Parameters<typeof fs.rm>[] = [];
    let calls = 0;
    let child: EventEmitter | undefined;
    const stderr = new PassThrough();
    mock.method(fs, "mkdtemp", (async (...args: Parameters<typeof fs.mkdtemp>) => {
      const directory = await originalMkdtemp(...args);
      if (args[0] === path.join(f.parent, ".margrave-upgrade-tmp-")) scratch = directory;
      return directory;
    }) as typeof fs.mkdtemp);
    mock.method(fs, "rm", (async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === scratch) removed.push(args);
      return originalRm(...args);
    }) as typeof fs.rm);
    mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(path.join(f.parent, ".margrave-upgrade-tmp-"))) {
        const item = { fd: handle.fd, closes: 0 };
        opened.push(item);
        handles.push(handle);
        const close = handle.close.bind(handle);
        mock.method(handle, "close", async () => {
          item.closes++;
          await close();
        });
      }
      return handle;
    }) as typeof fs.open);
    mock.method(childProcess, "spawn", ((...args: Parameters<typeof childProcess.spawn>) => {
      if (args[0] !== "/usr/bin/tar") return originalSpawn(...args);
      calls++;
      assert.deepEqual(args[1], ["-xOf", path.join(f.backup, "store.tar"), "./index.db"]);
      assert.deepEqual(args[2]?.stdio, ["ignore", opened[0]!.fd, "pipe"]);
      child = Object.assign(new EventEmitter(), { stderr });
      const spawned = child;
      process.nextTick(() => {
        stderr.end("ordinary tar diagnostic");
        if (failure === "error") spawned.emit("error", new Error("injected"));
        else if (failure === "exit") spawned.emit("close", 1);
        else spawned.emit("close", null, "SIGTERM");
      });
      return spawned as unknown as ReturnType<typeof childProcess.spawn>;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    const recovery = recoverMigrationRecord();
    try {
      await assert.rejects(
        withExtractionDeadline(recovery, () => child),
        f.invalid,
      );
    } finally {
      stderr.end();
      restoreMocks();
      for (const handle of handles) if (handle.fd !== -1) await handle.close();
    }
    assert.ok(scratch);
    assert.deepEqual(removed, [[scratch, { recursive: true, force: true }]]);
    assert.equal(existsSync(scratch), false);
    assert.equal(calls, 1);
    assert.deepEqual(
      opened.map(({ closes }) => closes),
      [1],
    );
    await f.preserved();
  }
});
