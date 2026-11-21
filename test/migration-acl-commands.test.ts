import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock } from "node:test";
import { promisify } from "node:util";

const realExecFile = promisify(childProcess.execFile);
const calls: [string, readonly string[], unknown][] = [];
let listing = "drwx------  2 owner group 64 Nov 21 00:00 .\n";
const replacement = Object.assign(childProcess.execFile.bind(childProcess), {
  [promisify.custom]: async (file: string, args: string[], options?: Parameters<typeof realExecFile>[2]) => {
    if (file === "/bin/ls" && args[0] === "-lde") {
      calls.push([file, args, options]);
      return { stdout: listing, stderr: "" };
    }
    if (file === "/bin/chmod" && args[0] === "-N") {
      calls.push([file, args, options]);
      assert.ok((await lstat(args[1]!)).isDirectory());
      return { stdout: "", stderr: "" };
    }
    return realExecFile(file, args, options);
  },
});
let backupModule: typeof import("../src/migration-backup.ts");
let recoveryModule: typeof import("../src/migration-recovery.ts");
try {
  mock.property(childProcess, "execFile", replacement);
  syncBuiltinESMExports();
  backupModule = await import("../src/migration-backup.ts");
  recoveryModule = await import("../src/migration-recovery.ts");
} finally {
  mock.restoreAll();
  syncBuiltinESMExports();
}
const { backupMigrationStore, verifyBackupChild, writeMigrationRecord } = backupModule;
const { recoverMigrationRecord } = recoveryModule;
const { readLegacySources } = await import("../src/store-files.ts");
const { copyLegacyStoreFixture, hostedUseHome } = await import("./helpers.ts");

test("backup verification checks extended directory ACLs on macOS", async (t) => {
  const parent = await hostedUseHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const store = path.join(parent, "store");
  await copyLegacyStoreFixture(store);
  process.env["MARGRAVE_HOME"] = store;
  const backup = await backupMigrationStore(2, await readLegacySources());
  const dir = await lstat(backup, { bigint: true });
  const args = [dir.dev.toString(), dir.ino.toString(), path.join(store, "index.db"), ""];
  const cwd = process.cwd();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let output = "";
  mock.method(process.stdout, "write", ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
  try {
    process.chdir(backup);
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    calls.length = 0;
    await verifyBackupChild(args);
    assert.equal(JSON.parse(output).kind, "ok");
    assert.deepEqual(calls, [["/bin/ls", ["-lde", "."], { env: {} }]]);
    listing += " 0: user:someone allow list\n";
    await assert.rejects(verifyBackupChild(args), /invalid directory ACL/u);
    assert.equal(calls.length, 2);
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    calls.length = 0;
    output = "";
    await verifyBackupChild(args);
    assert.equal(JSON.parse(output).kind, "ok");
    assert.deepEqual(calls, []);
  } finally {
    listing = "drwx------  2 owner group 64 Nov 21 00:00 .\n";
    process.chdir(cwd);
    Object.defineProperty(process, "platform", platform);
    mock.restoreAll();
  }
});

test("migration backup and recovery clear staging directory ACLs on macOS", async (t) => {
  const parent = await hostedUseHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const value of ["darwin", "linux"]) {
      const store = path.join(parent, value);
      await copyLegacyStoreFixture(store);
      process.env["MARGRAVE_HOME"] = store;
      const sources = await readFile(path.join(store, "sources.json"), "utf8");
      Object.defineProperty(process, "platform", { ...platform, value });
      calls.length = 0;
      const backup = await backupMigrationStore(2, await readLegacySources());
      if (value === "darwin") {
        assert.equal(calls.length, 3);
        const paths = calls.map(([file, args, options]) => {
          assert.equal(file, "/bin/chmod");
          assert.equal(args[0], "-N");
          assert.equal(args.length, 2);
          assert.equal(options, undefined);
          return args[1]!;
        });
        assert.equal(paths.filter((item) => item === backup).length, 1);
        const scratch = paths.filter((item) => item !== backup);
        assert.equal(new Set(scratch).size, 2);
        for (const item of scratch) {
          assert.equal(path.dirname(item), parent);
          assert.match(path.basename(item), /^\.margrave-upgrade-tmp-/u);
        }
      } else assert.deepEqual(calls, []);
      await writeMigrationRecord(backup);
      calls.length = 0;
      assert.deepEqual(await recoverMigrationRecord(), { backup, sources });
      if (value === "darwin") {
        assert.equal(calls.length, 1);
        const [file, args, options] = calls[0]!;
        assert.equal(file, "/bin/chmod");
        assert.equal(args[0], "-N");
        assert.equal(path.dirname(args[1]!), parent);
        assert.match(path.basename(args[1]!), /^\.margrave-upgrade-tmp-/u);
        assert.equal(options, undefined);
      } else assert.deepEqual(calls, []);
      assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-tmp-")).length, 0);
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    mock.restoreAll();
  }
});
