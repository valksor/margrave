import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nativeFs from "node:fs";
import fs, { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import type { TestContext } from "node:test";
import { backupMigrationStore, writeMigrationRecord } from "../src/migration-backup.ts";
import { recoverMigrationRecord } from "../src/migration-recovery.ts";
import { readLegacySources } from "../src/store-files.ts";
import { copyLegacyStoreFixture, hostedUseHome, leaveHotJournal, realClose, realExec } from "./helpers.ts";

const nativeCreateReadStream = nativeFs.createReadStream;
const nativeOpen = fs.open;
const nativeLstat = fs.lstat;
const nativeCopyFile = fs.copyFile;
const nativePrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as typeof DatabaseSync.prototype.prepare;

async function fixture(t: TestContext) {
  const parent = await hostedUseHome(t);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const store = path.join(parent, "store");
  await copyLegacyStoreFixture(store);
  process.env["MARGRAVE_HOME"] = store;
  const index = path.join(store, "index.db");
  const source = path.join(store, "sources.json");
  const journal = `${index}-journal`;
  const sources = await readFile(source, "utf8");
  const indexBytes = await readFile(index);
  const backup = await backupMigrationStore(2, await readLegacySources());
  await writeMigrationRecord(backup);
  const marker = await readFile(source);
  const journalError = {
    name: "Error",
    message: `cannot verify the Margrave upgrade journal at ${journal}. Restore a complete backup. See Upgrading in the README.`,
  };
  const invalid = {
    name: "Error",
    message: `cannot verify the interrupted Margrave upgrade at ${store}. Restore a complete backup. See Upgrading in the README.`,
  };
  async function preserved() {
    assert.deepEqual(await readFile(index), indexBytes);
    assert.deepEqual(await readFile(source), marker);
    assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-tmp-")).length, 0);
  }
  return { parent, store, index, source, journal, sources, indexBytes, backup, marker, journalError, invalid, preserved };
}

function header(sector = 512, page = 512, length = 512) {
  const bytes = Buffer.alloc(length);
  if (length >= 28) {
    bytes.writeUInt32BE(sector, 20);
    bytes.writeUInt32BE(page, 24);
  }
  return bytes;
}

function restoreMocks() {
  mock.restoreAll();
  syncBuiltinESMExports();
}

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("migration recovery journal direct accepts boundary page sizes and rejects malformed headers", async (t) => {
  const f = await fixture(t);
  for (const page of [512, 65536]) {
    const bytes = header(512, page);
    await writeFile(f.journal, bytes);
    assert.deepEqual(await recoverMigrationRecord(), { backup: f.backup, sources: f.sources, journalHash: digest(bytes) });
    assert.deepEqual(await readFile(f.journal), bytes);
    await f.preserved();
  }
  const badMagic = header();
  badMagic[0] = 1;
  for (const [name, bytes] of [
    ["page below minimum", header(512, 256)],
    ["page above maximum", header(512, 131072)],
    ["non-power-of-two page", header(512, 768)],
    ["sector below minimum", header(256, 512)],
    ["non-power-of-two sector", header(768, 512, 768)],
    ["shorter than sector", header(1024, 512)],
    ["shorter than header", header(512, 512, 27)],
    ["invalid magic", badMagic],
  ] as const) {
    await writeFile(f.journal, bytes);
    await assert.rejects(recoverMigrationRecord(), f.journalError, name);
    assert.deepEqual(await readFile(f.journal), bytes);
    await f.preserved();
  }
  await rm(f.journal);
  await mkdir(f.journal);
  await assert.rejects(recoverMigrationRecord(), f.journalError);
  await f.preserved();
});

test("migration recovery journal direct closes the header after a short read or access error", async (t) => {
  const f = await fixture(t);
  const bytes = header();
  await writeFile(f.journal, bytes);
  let closes = 0;
  let reads = 0;
  let short = false;
  let opens = 0;
  try {
    mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
      const handle = await nativeOpen(...args);
      if (args[0] === f.journal) {
        opens++;
        const close = handle.close.bind(handle);
        const read = handle.read.bind(handle);
        mock.method(handle, "read", (async (...readArgs: Parameters<typeof handle.read>) => {
          reads++;
          if (short) return { bytesRead: 27, buffer: Buffer.alloc(28) };
          return read(...readArgs);
        }) as typeof handle.read);
        mock.method(handle, "close", async () => {
          closes++;
          await close();
        });
      }
      return handle;
    }) as typeof fs.open);
    syncBuiltinESMExports();
    assert.deepEqual(await recoverMigrationRecord(), { backup: f.backup, sources: f.sources, journalHash: digest(bytes) });
    assert.equal(reads, 1);
    assert.equal(closes, 1);
    short = true;
    await assert.rejects(recoverMigrationRecord(), f.journalError);
    assert.equal(reads, 2);
    assert.equal(closes, 2);
    short = false;
    await writeFile(f.journal, header(512, 512, 27));
    await assert.rejects(recoverMigrationRecord(), f.journalError);
    assert.equal(opens, 2);
    await writeFile(f.journal, header(512, 512, 28));
    await assert.rejects(recoverMigrationRecord(), f.journalError);
    assert.equal(opens, 3);
    assert.equal(reads, 3);
    assert.equal(closes, 3);
    await writeFile(f.journal, bytes);
  } finally {
    restoreMocks();
  }
  await f.preserved();
  assert.deepEqual(await readFile(f.journal), bytes);
  try {
    mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === f.journal) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return nativeOpen(...args);
    }) as typeof fs.open);
    syncBuiltinESMExports();
    await assert.rejects(recoverMigrationRecord(), f.invalid);
  } finally {
    restoreMocks();
  }
  await f.preserved();
});

test("migration recovery journal direct probes and closes the private SQLite copy", async (t) => {
  const f = await fixture(t);
  const bytes = header();
  await writeFile(f.journal, bytes);
  const receivers = new Set<DatabaseSync>();
  const closes = new Map<DatabaseSync, number>();
  let fail = false;
  try {
    mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA user_version") {
        assert.match(this.location() ?? "", /\.margrave-upgrade-tmp-[^/]+\/index\.db$/u);
        receivers.add(this);
        if (fail) throw new Error("scratch prepare failed");
      }
      return nativePrepare.call(this, sql);
    });
    mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
      if (receivers.has(this)) closes.set(this, (closes.get(this) ?? 0) + 1);
      return realClose.call(this);
    });
    assert.deepEqual(await recoverMigrationRecord(), { backup: f.backup, sources: f.sources, journalHash: digest(bytes) });
    assert.equal(receivers.size, 1);
    assert.deepEqual([...closes.values()], [1]);
    fail = true;
    await assert.rejects(recoverMigrationRecord(), f.journalError);
    assert.equal(receivers.size, 2);
    assert.deepEqual([...closes.values()], [1, 1]);
  } finally {
    restoreMocks();
  }
  await f.preserved();
  assert.deepEqual(await readFile(f.journal), bytes);
});

test("migration recovery journal direct accepts either owner and rejects another owner", async (t) => {
  const f = await fixture(t);
  const bytes = header();
  await writeFile(f.journal, bytes);
  const owner = process.getuid!();
  const catalogOwner = owner + 1;
  let journalOwner = owner;
  let opens = 0;
  try {
    mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === f.journal) opens++;
      return nativeOpen(...args);
    }) as typeof fs.open);
    mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await nativeLstat(...args);
      if (args[0] === f.index && typeof stat.uid === "bigint") Object.defineProperty(stat, "uid", { value: BigInt(catalogOwner) });
      if (args[0] === f.journal && typeof stat.uid === "number") Object.defineProperty(stat, "uid", { value: journalOwner });
      return stat;
    }) as typeof fs.lstat);
    syncBuiltinESMExports();
    for (journalOwner of [owner, catalogOwner]) {
      assert.deepEqual(await recoverMigrationRecord(), { backup: f.backup, sources: f.sources, journalHash: digest(bytes) });
      await f.preserved();
    }
    journalOwner = owner + 2;
    await assert.rejects(recoverMigrationRecord(), f.journalError);
    assert.equal(opens, 2);
  } finally {
    restoreMocks();
  }
  await f.preserved();
  assert.deepEqual(await readFile(f.journal), bytes);
});

test("migration recovery journal direct locks the catalog when the journal disappears", async (t) => {
  const f = await fixture(t);
  const bytes = header();
  for (const mode of ["gone", "present", "denied"] as const) {
    await writeFile(f.journal, bytes);
    try {
      mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === f.journal) {
          if (mode === "gone") {
            await rm(f.journal);
            return nativeOpen(...args);
          }
          throw Object.assign(new Error(mode), { code: mode === "denied" ? "EACCES" : "ENOENT" });
        }
        return nativeOpen(...args);
      }) as typeof fs.open);
      syncBuiltinESMExports();
      if (mode === "gone") {
        const recovered = await recoverMigrationRecord();
        assert.ok(recovered?.db?.isOpen);
        try {
          assert.equal(recovered.sources, f.sources);
          const contender = new DatabaseSync(f.index, { timeout: 0 });
          try {
            assert.throws(() => contender.exec("BEGIN IMMEDIATE"), /locked/u);
          } finally {
            contender.close();
          }
        } finally {
          recovered.db.close();
        }
        assert.equal(recovered.db.isOpen, false);
      } else
        await assert.rejects(
          recoverMigrationRecord().then((result) => {
            if (result?.db?.isOpen) result.db.close();
          }),
          f.invalid,
        );
    } finally {
      restoreMocks();
    }
    await f.preserved();
  }
});

test("migration recovery journal direct rejects changed identity, WAL, SHM and a busy recovered lock", async (t) => {
  const f = await fixture(t);
  for (const mode of ["identity", "wal", "shm", "busy"] as const) {
    await writeFile(f.journal, header());
    if (mode === "wal" || mode === "shm") await writeFile(`${f.index}-${mode}`, "");
    try {
      let journalRemoved = false;
      let identityChanged = false;
      mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await nativeLstat(...args);
        if (args[0] === f.index && typeof stat.ino === "bigint" && journalRemoved && !identityChanged && mode === "identity") {
          Object.defineProperty(stat, "ino", { value: stat.ino + 1n });
          identityChanged = true;
        }
        return stat;
      }) as typeof fs.lstat);
      mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === f.journal) {
          await rm(f.journal);
          journalRemoved = true;
          return nativeOpen(...args);
        }
        return nativeOpen(...args);
      }) as typeof fs.open);
      mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
        if (mode === "busy" && sql === "BEGIN EXCLUSIVE") throw Object.assign(new Error("busy"), { errcode: 5 });
        return realExec.call(this, sql);
      });
      syncBuiltinESMExports();
      await assert.rejects(
        recoverMigrationRecord().then((result) => {
          if (result?.db?.isOpen) result.db.close();
        }),
        mode === "busy"
          ? { name: "Error", message: "another Margrave writer holds the legacy catalog lock. Try the command again" }
          : f.journalError,
      );
      if (mode === "identity") assert.equal(identityChanged, true);
    } finally {
      restoreMocks();
    }
    if (mode === "wal" || mode === "shm") await rm(`${f.index}-${mode}`);
    await f.preserved();
  }
});

test("migration recovery journal direct checks post-copy changes", async (t) => {
  const f = await fixture(t);
  const bytes = header();
  const changed = Buffer.concat([f.indexBytes, Buffer.from([1])]);
  for (const mode of ["scratch", "device", "inode", "live", "gone", "gone-live", "non-file", "owner", "journal"] as const) {
    await writeFile(f.journal, bytes);
    let copied = false;
    let current = false;
    let remaining = false;
    let journalStreams = 0;
    try {
      mock.method(nativeFs, "createReadStream", ((...args: Parameters<typeof nativeFs.createReadStream>) => {
        if (copied && args[0] === f.journal) journalStreams++;
        return nativeCreateReadStream(...args);
      }) as typeof nativeFs.createReadStream);
      mock.method(fs, "copyFile", (async (...args: Parameters<typeof fs.copyFile>) => {
        const [source, destination] = args;
        if (source === f.index || source === f.journal) {
          assert.equal(typeof destination, "string");
          const scratch = path.dirname(destination as string);
          assert.equal(path.dirname(scratch), f.parent);
          assert.match(path.basename(scratch), /^\.margrave-upgrade-tmp-/u);
          assert.equal(destination, path.join(scratch, source === f.index ? "index.db" : "index.db-journal"));
          await nativeCopyFile(...args);
          if (source === f.index && mode === "scratch") await writeFile(destination, changed);
          if (source === f.journal) {
            copied = true;
            if (mode === "live" || mode === "gone-live") await writeFile(f.index, changed);
            if (mode === "gone" || mode === "gone-live" || mode === "non-file") await rm(f.journal);
            if (mode === "non-file") await mkdir(f.journal);
            if (mode === "journal") await writeFile(f.journal, Buffer.concat([bytes, Buffer.from([1])]));
          }
          return;
        }
        return nativeCopyFile(...args);
      }) as typeof fs.copyFile);
      mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
        if (copied && args[0] === f.journal) remaining = true;
        const stat = await nativeLstat(...args);
        if (copied && args[0] === f.index && typeof stat.ino === "bigint") {
          current = true;
          if (mode === "device") Object.defineProperty(stat, "dev", { value: BigInt(stat.dev) + 1n });
          if (mode === "inode") Object.defineProperty(stat, "ino", { value: stat.ino + 1n });
        }
        if (copied && args[0] === f.journal && mode === "owner" && typeof stat.uid === "number")
          Object.defineProperty(stat, "uid", { value: stat.uid + 10000 });
        return stat;
      }) as typeof fs.lstat);
      syncBuiltinESMExports();
      if (mode === "gone") {
        assert.deepEqual(await recoverMigrationRecord(), { backup: f.backup, sources: f.sources });
      } else await assert.rejects(recoverMigrationRecord(), f.journalError, mode);
      assert.equal(copied, true, mode);
      assert.equal(current, mode !== "scratch", mode);
      assert.equal(remaining, mode !== "scratch", mode);
      if (mode === "live" || mode === "non-file") assert.equal(journalStreams, 0, mode);
    } finally {
      restoreMocks();
      await writeFile(f.index, f.indexBytes);
      await rm(f.journal, { recursive: true, force: true });
    }
    await f.preserved();
  }
});

test("migration recovery journal direct rejects a dirty catalog when a copied hot journal disappears", async (t) => {
  const f = await fixture(t);
  await leaveHotJournal(f.index);
  assert.notDeepEqual(await readFile(f.index), f.indexBytes);
  assert.deepEqual((await readFile(f.journal)).subarray(0, 8), Buffer.from("d9d505f920a163d7", "hex"));
  let copied = false;
  let removed = false;
  let lockAttempts = 0;
  const locks = new Set<DatabaseSync>();
  try {
    mock.method(fs, "copyFile", (async (...args: Parameters<typeof fs.copyFile>) => {
      const [source, destination] = args;
      if (source === f.index || source === f.journal) {
        assert.equal(typeof destination, "string");
        const scratch = path.dirname(destination as string);
        assert.equal(path.dirname(scratch), f.parent);
        assert.match(path.basename(scratch), /^\.margrave-upgrade-tmp-/u);
        assert.equal(destination, path.join(scratch, source === f.index ? "index.db" : "index.db-journal"));
        await nativeCopyFile(...args);
        if (source === f.journal) {
          copied = true;
          await rm(f.journal);
          removed = true;
        }
        return;
      }
      return nativeCopyFile(...args);
    }) as typeof fs.copyFile);
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN EXCLUSIVE" && this.location() === f.index) {
        lockAttempts++;
        locks.add(this);
      }
      return realExec.call(this, sql);
    });
    syncBuiltinESMExports();
    await assert.rejects(recoverMigrationRecord(), f.journalError);
    assert.equal(copied, true);
    assert.equal(removed, true);
    assert.equal(lockAttempts, 0);
  } finally {
    restoreMocks();
    for (const lock of locks) if (lock.isOpen) realClose.call(lock);
    await rm(f.journal, { force: true });
    await writeFile(f.index, f.indexBytes);
  }
  await f.preserved();
});

test("migration recovery journal direct compares zero magic against accepted catalog bytes", async (t) => {
  const f = await fixture(t);
  const bytes = header();
  const changed = Buffer.concat([f.indexBytes, Buffer.from([1])]);
  await writeFile(f.journal, bytes);
  await writeFile(f.index, changed);
  let copied = false;
  let remaining = false;
  try {
    mock.method(fs, "copyFile", (async (...args: Parameters<typeof fs.copyFile>) => {
      const [source, destination] = args;
      if (source === f.index) {
        assert.equal(typeof destination, "string");
        const scratch = path.dirname(destination as string);
        assert.equal(path.dirname(scratch), f.parent);
        assert.match(path.basename(scratch), /^\.margrave-upgrade-tmp-/u);
        assert.equal(destination, path.join(scratch, "index.db"));
        await nativeCopyFile(...args);
        await writeFile(destination, f.indexBytes);
        copied = true;
        return;
      }
      return nativeCopyFile(...args);
    }) as typeof fs.copyFile);
    mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await nativeLstat(...args);
      if (copied && args[0] === f.journal) remaining = true;
      return stat;
    }) as typeof fs.lstat);
    syncBuiltinESMExports();
    await assert.rejects(recoverMigrationRecord(), f.journalError);
    assert.equal(copied, true);
    assert.equal(remaining, true);
    assert.deepEqual(await readFile(f.index), changed);
    assert.deepEqual(await readFile(f.journal), bytes);
  } finally {
    restoreMocks();
    await writeFile(f.index, f.indexBytes);
  }
  await f.preserved();
});

test("migration recovery journal direct rejects a changed catalog without a journal after preflight", async (t) => {
  const f = await fixture(t);
  let checked = false;
  try {
    mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === f.journal && !checked) {
        checked = true;
        await writeFile(f.index, Buffer.concat([f.indexBytes, Buffer.from([1])]));
      }
      return nativeLstat(...args);
    }) as typeof fs.lstat);
    syncBuiltinESMExports();
    await assert.rejects(recoverMigrationRecord(), f.invalid);
    assert.equal(checked, true);
  } finally {
    restoreMocks();
    await writeFile(f.index, f.indexBytes);
  }
  await f.preserved();
});

test("migration recovery journal direct checks late disappearance failures", async (t) => {
  const f = await fixture(t);
  for (const mode of ["device", "checksum", "denied"] as const) {
    await writeFile(f.journal, header());
    let opened = false;
    let current = false;
    let lockAttempts = 0;
    const locks = new Set<DatabaseSync>();
    try {
      mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
        if (sql === "BEGIN EXCLUSIVE" && this.location() === f.index) {
          lockAttempts++;
          locks.add(this);
        }
        return realExec.call(this, sql);
      });
      mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === f.journal) {
          opened = true;
          await rm(f.journal);
          if (mode === "checksum") await writeFile(f.index, Buffer.concat([f.indexBytes, Buffer.from([1])]));
          if (mode === "denied") throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return nativeOpen(...args);
      }) as typeof fs.open);
      mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await nativeLstat(...args);
        if (opened && args[0] === f.index && typeof stat.dev === "bigint") {
          current = true;
          if (mode === "device") Object.defineProperty(stat, "dev", { value: stat.dev + 1n });
        }
        return stat;
      }) as typeof fs.lstat);
      syncBuiltinESMExports();
      await assert.rejects(recoverMigrationRecord(), mode === "denied" ? f.invalid : f.journalError);
      assert.equal(opened, true);
      assert.equal(current, mode !== "denied");
      if (mode === "checksum") assert.equal(lockAttempts, 0);
    } finally {
      restoreMocks();
      for (const lock of locks) if (lock.isOpen) realClose.call(lock);
      await writeFile(f.index, f.indexBytes);
    }
    await f.preserved();
  }
});

test("migration recovery journal direct rolls back a genuine hot journal and returns the lock", async (t) => {
  const f = await fixture(t);
  await leaveHotJournal(f.index);
  const recovered = await recoverMigrationRecord();
  assert.ok(recovered?.db?.isOpen);
  try {
    assert.equal(recovered.sources, f.sources);
    assert.equal(digest(await readFile(f.index)), digest(f.indexBytes));
    const contender = new DatabaseSync(f.index, { timeout: 0 });
    try {
      assert.throws(() => contender.exec("BEGIN IMMEDIATE"), /locked/u);
    } finally {
      contender.close();
    }
  } finally {
    recovered.db.close();
  }
  assert.equal(recovered.db.isOpen, false);
  await assert.rejects(readFile(f.journal), { code: "ENOENT" });
  await f.preserved();
});

test("migration recovery journal direct closes the recovered lock when scratch cleanup fails", async (t) => {
  const f = await fixture(t);
  await leaveHotJournal(f.index);
  const nativeRm = fs.rm;
  const lock: { db?: DatabaseSync } = {};
  const removals: Parameters<typeof fs.rm>[] = [];
  let scratch: string | undefined;
  try {
    mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      const result = realExec.call(this, sql);
      if (sql === "BEGIN EXCLUSIVE" && this.location() === f.index) lock.db = this;
      return result;
    });
    mock.method(fs, "rm", (async (...args: Parameters<typeof fs.rm>) => {
      if (
        lock.db !== undefined &&
        typeof args[0] === "string" &&
        path.dirname(args[0]) === f.parent &&
        path.basename(args[0]).startsWith(".margrave-upgrade-tmp-")
      ) {
        removals.push(args);
        if (removals.length === 1) {
          scratch = args[0];
          assert.ok((await readdir(f.parent)).includes(path.basename(scratch)));
          throw new Error("scratch cleanup failed");
        }
      }
      return nativeRm(...args);
    }) as typeof fs.rm);
    syncBuiltinESMExports();
    await assert.rejects(recoverMigrationRecord(), f.invalid);
    assert.ok(lock.db);
    assert.equal(lock.db.isOpen, false);
    assert.ok(scratch);
    assert.deepEqual(removals, [
      [scratch, { recursive: true, force: true }],
      [scratch, { recursive: true, force: true }],
    ]);
    const contender = new DatabaseSync(f.index, { timeout: 0 });
    try {
      realExec.call(contender, "BEGIN IMMEDIATE");
    } finally {
      realClose.call(contender);
    }
  } finally {
    restoreMocks();
    if (lock.db?.isOpen) realClose.call(lock.db);
  }
  await assert.rejects(readFile(f.journal), { code: "ENOENT" });
  await f.preserved();
});
