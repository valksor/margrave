import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs, { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock, type TestContext } from "node:test";
import { backupMigrationStore, writeMigrationRecord } from "../src/migration-backup.ts";
import { gitSourceRecord, tmp, useHome } from "./helpers.ts";

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

async function fixture(t: TestContext) {
  const parent = await tmp("mg-publication-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const store = path.join(parent, "store");
  await mkdir(store);
  useHome(t, store);
  await writeFile(path.join(store, "index.db"), "small catalog\n");
  await writeFile(path.join(store, "sources.json"), "[]\n");
  return { parent, store };
}

test("migration backup publication direct reuses the first sorted complete candidate", async (t) => {
  const { parent, store } = await fixture(t);
  const backup = await backupMigrationStore(2, []);
  const prefix = backup.slice(0, -6);
  const first = `${prefix}aaaaaa`;
  const second = `${prefix}zzzzzz`;
  await rename(backup, first);
  await cp(first, second, { recursive: true });
  await mkdir(`${prefix}000000`, { mode: 0o700 });
  const archive = await readFile(path.join(first, "store.tar"));
  const nativeReaddir = fs.readdir.bind(fs);
  const reversed = mock.method(fs, "readdir", (async (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === parent) return (await nativeReaddir(parent)).sort((a, b) => b.localeCompare(a));
    return nativeReaddir(...args);
  }) as typeof fs.readdir);
  syncBuiltinESMExports();
  let reused;
  try {
    reused = await observePublication(parent, () => backupMigrationStore(2, []), undefined, first);
  } finally {
    reversed.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(reused.value, first);
  assert.deepEqual(reused.events, ["backup:sync", "backup:close", "parent:sync", "parent:close"]);
  assert.deepEqual(await readFile(path.join(first, "store.tar")), archive);
  assert.deepEqual(await readFile(path.join(second, "store.tar")), archive);
  assert.ok((await readdir(parent)).includes(path.basename(`${prefix}000000`)));
  assert.equal(await readFile(path.join(store, "sources.json"), "utf8"), "[]\n");
});

for (const [field, value] of [
  ["store", "/another-store"],
  ["from", 3],
  ["indexSha256", "1".repeat(64)],
  ["sourcesSha256", "2".repeat(64)],
  ["inventorySha256", "3".repeat(64)],
] as const) {
  test(`migration backup publication direct rejects candidate with different ${field}`, async (t) => {
    const { store } = await fixture(t);
    const backup = await backupMigrationStore(2, []);
    const other = `${backup.slice(0, -6)}zzzzzz`;
    if (other !== backup) await cp(backup, other, { recursive: true });
    const manifestPath = path.join(backup, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest[field] = value;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(backupMigrationStore(2, []), {
      message: `cannot back up the Margrave store at ${await realpath(store)}: invalid backup: ${backup}`,
    });
    if (other !== backup) assert.ok((await lstat(path.join(other, "store.tar"))).isFile());
  });
}

test("migration backup publication direct records the verified version 2 backup", async (t) => {
  const { parent, store } = await fixture(t);
  const control = path.join(parent, "mode-control");
  await writeFile(control, "control");
  const index = await readFile(path.join(store, "index.db"));
  const sources = await readFile(path.join(store, "sources.json"));
  const stat = await lstat(path.join(store, "index.db"), { bigint: true });
  const calls: unknown[][] = [];
  const nativeLstat = fs.lstat.bind(fs);
  const observer = mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
    if ((args[0] === path.join(store, "index.db") || args[0] === path.join(store, "sources.json")) && args.length > 1) calls.push(args);
    return nativeLstat(...args);
  }) as typeof fs.lstat);
  syncBuiltinESMExports();
  let backup: string;
  try {
    backup = await backupMigrationStore(2, []);
    assert.deepEqual(calls, [
      [path.join(store, "index.db"), { bigint: true }],
      [path.join(store, "index.db"), { bigint: true }],
      [path.join(store, "sources.json"), { bigint: true }],
      [path.join(store, "index.db"), { bigint: true }],
      [path.join(store, "sources.json"), { bigint: true }],
      [path.join(store, "index.db"), { bigint: true }],
      [path.join(store, "index.db"), { bigint: true }],
      [path.join(store, "sources.json"), { bigint: true }],
    ]);
    calls.length = 0;
    await writeMigrationRecord(backup);
    assert.deepEqual(calls, [
      [path.join(store, "index.db"), { bigint: true }],
      [path.join(store, "sources.json"), { bigint: true }],
      [path.join(store, "index.db"), { bigint: true }],
    ]);
  } finally {
    observer.mock.restore();
    syncBuiltinESMExports();
  }
  const raw = await readFile(path.join(store, "sources.json"), "utf8");
  assert.equal(
    raw,
    `${JSON.stringify({
      kind: "margrave-store-migration",
      version: 1,
      phase: "prepared",
      from: 2,
      store: await realpath(store),
      catalogDevice: stat.dev.toString(),
      catalogInode: stat.ino.toString(),
      backup: path.basename(backup),
      indexSha256: digest(index),
      sourcesSha256: digest(sources),
    })}\n`,
  );
  assert.equal((await lstat(path.join(store, "sources.json"))).mode & 0o777, (await lstat(control)).mode & 0o777);
});

for (const [field, value] of [
  ["store", "/another-store"],
  ["from", 3],
  ["indexSha256", "1".repeat(64)],
  ["sourcesSha256", "2".repeat(64)],
] as const) {
  test(`migration backup publication direct refuses record with different ${field}`, async (t) => {
    const { store } = await fixture(t);
    const backup = await backupMigrationStore(2, []);
    const sourcePath = path.join(store, "sources.json");
    const original = await readFile(sourcePath);
    const manifestPath = path.join(backup, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest[field] = value;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(writeMigrationRecord(backup), {
      message: `cannot verify the interrupted Margrave upgrade at ${await realpath(store)}. Restore a complete backup. See Upgrading in the README.`,
    });
    assert.deepEqual(await readFile(sourcePath), original);
  });
}

test("migration backup publication direct refuses a missing or unverified backup", async (t) => {
  const { parent, store } = await fixture(t);
  const backup = await backupMigrationStore(2, []);
  const original = await readFile(path.join(store, "sources.json"));
  await writeFile(path.join(backup, "store.tar"), "corrupt");
  for (const candidate of [path.join(parent, "missing"), backup]) {
    await assert.rejects(writeMigrationRecord(candidate), {
      message: `cannot verify the interrupted Margrave upgrade at ${await realpath(store)}. Restore a complete backup. See Upgrading in the README.`,
    });
    assert.deepEqual(await readFile(path.join(store, "sources.json")), original);
  }
});

test("migration backup publication direct archives a version 3 store without a source list", async (t) => {
  const { store } = await fixture(t);
  await rm(path.join(store, "sources.json"));
  await writeFile(path.join(store, "catalog-published"), "published\n");
  await writeFile(path.join(store, "unregistered"), "excluded\n");
  const backup = await backupMigrationStore(3, []);
  const archive = path.join(backup, "store.tar");
  const members = execFileSync("/usr/bin/tar", ["-tf", archive], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(members, ["./", "./catalog-published", "./index.db"].sort());
  for (const name of ["index.db", "catalog-published"]) {
    assert.deepEqual(execFileSync("/usr/bin/tar", ["-xOf", archive, `./${name}`]), await readFile(path.join(store, name)));
  }
  const manifest = JSON.parse(await readFile(path.join(backup, "manifest.json"), "utf8")) as Record<string, unknown>;
  const root = await lstat(store, { bigint: true });
  const inventory: unknown[] = [[".", "directory", root.uid.toString(), root.gid.toString(), root.mode.toString(), null]];
  for (const name of ["catalog-published", "index.db"]) {
    const file = path.join(store, name);
    const stat = await lstat(file, { bigint: true });
    inventory.push([
      name,
      "file",
      stat.uid.toString(),
      stat.gid.toString(),
      stat.mode.toString(),
      stat.mtimeNs.toString(),
      stat.ctimeNs.toString(),
      digest(await readFile(file)),
    ]);
  }
  const inventorySha256 = digest(JSON.stringify([inventory, [[".", null, null, null]]]));
  assert.deepEqual(manifest, {
    kind: "margrave-store-backup",
    version: 1,
    store: await realpath(store),
    from: 3,
    indexSha256: digest(await readFile(path.join(store, "index.db"))),
    inventorySha256,
    archiveSha256: digest(await readFile(archive)),
    sourcesSha256: null,
  });
  assert.equal((await lstat(backup)).mode & 0o777, 0o700);
  for (const file of [archive, path.join(backup, "manifest.json")]) assert.equal((await lstat(file)).mode & 0o777, 0o600);
});

for (const name of ["index.db", "sources.json", "catalog-published"]) {
  test(`migration backup publication direct rejects ${name} when it is not a regular file`, async (t) => {
    const { store } = await fixture(t);
    const file = path.join(store, name);
    if (name !== "catalog-published") await rm(file);
    await mkdir(file);
    await assert.rejects(backupMigrationStore(2, []), {
      message: `cannot back up the Margrave store at ${await realpath(store)}: not a regular file: ${file}`,
    });
  });
}

test("migration backup publication direct rejects a special file during snapshot traversal", async (t) => {
  const { store } = await fixture(t);
  const git = { ...gitSourceRecord("managed"), ref: "refs/heads/main" };
  const snapshot = path.join(store, "snapshots", git.id, git.snapshot!);
  await mkdir(snapshot, { recursive: true });
  const fifo = path.join(snapshot, "fifo");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  const calls: unknown[][] = [];
  const nativeLstat = fs.lstat.bind(fs);
  const observer = mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === fifo) calls.push(args);
    return nativeLstat(...args);
  }) as typeof fs.lstat);
  syncBuiltinESMExports();
  try {
    await assert.rejects(backupMigrationStore(2, [git]), {
      message: `cannot back up the Margrave store at ${await realpath(store)}: unsupported file type: ${fifo}`,
    });
    assert.deepEqual(calls, [[fifo]]);
  } finally {
    observer.mock.restore();
    syncBuiltinESMExports();
  }
});

test("migration backup publication direct archives only registered Git inventory", async (t) => {
  const { parent, store } = await fixture(t);
  const git = { ...gitSourceRecord("managed"), ref: "refs/heads/main" };
  const snapshot = path.join("snapshots", git.id, git.snapshot!);
  await mkdir(path.join(store, snapshot), { recursive: true });
  await mkdir(path.join(store, "sources"));
  await symlink(path.join("..", snapshot), path.join(store, "sources", git.id));
  await writeFile(path.join(store, snapshot, "skill"), "registered bytes\n", { mode: 0o640 });
  await chmod(path.join(store, snapshot, "skill"), 0o640);
  await symlink("skill", path.join(store, snapshot, "held"));
  await mkdir(path.join(store, "snapshots", "unregistered"));
  await writeFile(path.join(store, "snapshots", "unregistered", "excluded"), "excluded");
  const localPath = path.join(store, "local");
  await mkdir(localPath);
  await writeFile(path.join(localPath, "excluded"), "local");
  const local = {
    id: "local",
    kind: "local" as const,
    spec: localPath,
    path: localPath,
    subpath: "",
    ref: null,
    commit: null,
    installedAt: "now",
  };
  const backup = await backupMigrationStore(2, [git, local]);
  const archive = path.join(backup, "store.tar");
  const names = execFileSync("/usr/bin/tar", ["-tf", archive], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(
    names,
    [
      "./",
      "./index.db",
      "./sources.json",
      "./snapshots/",
      `./snapshots/${git.id}/`,
      `./${snapshot}/`,
      `./${snapshot}/held`,
      `./${snapshot}/skill`,
      "./sources/",
      `./sources/${git.id}`,
    ].sort(),
  );
  const restored = path.join(parent, "restored");
  await mkdir(restored);
  execFileSync("/usr/bin/tar", ["-xf", archive, "-C", restored]);
  for (const name of ["index.db", "sources.json", path.join(snapshot, "skill")]) {
    assert.deepEqual(await readFile(path.join(restored, name)), await readFile(path.join(store, name)));
    const original = await lstat(path.join(store, name));
    const copy = await lstat(path.join(restored, name));
    assert.equal(copy.mode & 0o777, original.mode & 0o777);
    assert.equal(copy.uid, original.uid);
    assert.equal(copy.gid, original.gid);
  }
  assert.equal(await readlink(path.join(restored, snapshot, "held")), "skill");
  assert.equal(await readlink(path.join(restored, "sources", git.id)), path.join("..", snapshot));
  await assert.rejects(lstat(path.join(restored, "local")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(restored, "snapshots", "unregistered")), { code: "ENOENT" });
});

test("migration backup publication direct rejects an invalid Git record", async (t) => {
  const { store } = await fixture(t);
  const git = { ...gitSourceRecord("managed"), ref: "invalid" };
  await assert.rejects(backupMigrationStore(2, [git]), {
    message: `cannot back up the Margrave store at ${await realpath(store)}: invalid source record`,
  });
});

test("migration backup publication direct does not descend into an alias replaced by a directory", async (t) => {
  const { parent, store } = await fixture(t);
  const git = { ...gitSourceRecord("managed"), ref: "refs/heads/main" };
  await mkdir(path.join(store, "snapshots", git.id, git.snapshot!), { recursive: true });
  const alias = path.join(store, "sources", git.id);
  await mkdir(alias, { recursive: true });
  const nested = path.join(alias, "nested");
  await writeFile(nested, "untouched\n");
  const link = path.join(parent, "alias-link");
  await symlink(alias, link);
  const linkStat = await lstat(link);
  const visits: string[] = [];
  let ordinaryVisits = 0;
  const nativeLstat = fs.lstat.bind(fs);
  const observer = mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === alias) {
      if (args[1]?.bigint) visits.push("bigint");
      else {
        ordinaryVisits++;
        visits.push(ordinaryVisits % 2 === 1 ? "guard" : "add");
        if (ordinaryVisits % 2 === 1) return linkStat;
      }
    }
    return nativeLstat(...args);
  }) as typeof fs.lstat);
  syncBuiltinESMExports();
  let backup: string;
  try {
    backup = await backupMigrationStore(2, [git]);
  } finally {
    observer.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(visits, ["guard", "add", "bigint", "guard", "add", "bigint"]);
  const names = execFileSync("/usr/bin/tar", ["-tf", path.join(backup, "store.tar")], { encoding: "utf8" })
    .trim()
    .split("\n");
  assert.ok(names.includes(`./sources/${git.id}/`));
  assert.ok(!names.includes(`./sources/${git.id}/nested`));
  assert.equal(await readFile(nested, "utf8"), "untouched\n");
});

test("migration backup publication direct includes an alias directory without a source link", async (t) => {
  const { store } = await fixture(t);
  const git = { ...gitSourceRecord("managed"), ref: "refs/heads/main" };
  await mkdir(path.join(store, "snapshots", git.id, git.snapshot!), { recursive: true });
  await mkdir(path.join(store, "sources"));
  const backup = await backupMigrationStore(2, [git]);
  const names = execFileSync("/usr/bin/tar", ["-tf", path.join(backup, "store.tar")], { encoding: "utf8" })
    .trim()
    .split("\n");
  assert.ok(names.includes("./sources/"));
  assert.ok(!names.includes(`./sources/${git.id}`));
});

async function observePublication<T>(
  parent: string,
  action: () => Promise<T>,
  fault?: "archive-sync" | "rename" | "backup-sync",
  existing?: string,
) {
  const events: string[] = [];
  const removals: unknown[][] = [];
  const memberModes: unknown[][] = [];
  let stage = existing;
  const nativeOpen = fs.open.bind(fs);
  const nativeRename = fs.rename.bind(fs);
  const nativeRm = fs.rm.bind(fs);
  const nativeWriteFile = fs.writeFile.bind(fs);
  const rmObserver = mock.method(fs, "rm", (async (...args: Parameters<typeof fs.rm>) => {
    if (stage !== undefined && args[0] === stage) removals.push(args);
    await nativeRm(...args);
  }) as typeof fs.rm);
  const writeObserver = mock.method(fs, "writeFile", (async (...args: Parameters<typeof fs.writeFile>) => {
    await nativeWriteFile(...args);
    const file = args[0];
    if (
      typeof file === "string" &&
      path.dirname(path.dirname(file)) === parent &&
      ["members", "manifest.tmp"].includes(path.basename(file))
    ) {
      if (path.basename(file) === "manifest.tmp" || path.basename(path.dirname(file)).startsWith(".margrave-upgrade-v2-"))
        memberModes.push([path.basename(file), args[2], (await lstat(file)).mode & 0o777]);
    }
  }) as typeof fs.writeFile);
  const openObserver = mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
    const file = args[0];
    const handle = await nativeOpen(...args);
    if (typeof file !== "string") return handle;
    if (path.basename(file) === "store.tar" && path.dirname(path.dirname(file)) === parent && args[1] === "r+") stage = path.dirname(file);
    let label: string | undefined;
    if (stage !== undefined && file === path.join(stage, "store.tar") && args[1] === "r+") label = "archive";
    else if (stage !== undefined && file === path.join(stage, "manifest.tmp")) label = "manifest";
    else if (stage !== undefined && file === stage) label = "backup";
    else if (file === parent) label = "parent";
    if (label === undefined) return handle;
    const nativeSync = handle.sync.bind(handle);
    const nativeClose = handle.close.bind(handle);
    const nativeChmod = handle.chmod.bind(handle);
    mock.method(handle, "sync", async () => {
      events.push(`${label}:sync`);
      if ((fault === "archive-sync" && label === "archive") || (fault === "backup-sync" && label === "backup"))
        throw new Error("injected sync failure");
      await nativeSync();
    });
    mock.method(handle, "close", async () => {
      events.push(`${label}:close`);
      await nativeClose();
    });
    if (label === "archive")
      mock.method(handle, "chmod", async (mode: Parameters<typeof nativeChmod>[0]) => {
        events.push(`archive:chmod:${mode}`);
        await nativeChmod(mode);
      });
    return handle;
  }) as typeof fs.open);
  const renameObserver = mock.method(fs, "rename", (async (...args: Parameters<typeof fs.rename>) => {
    if (stage !== undefined && args[0] === path.join(stage, "manifest.tmp") && args[1] === path.join(stage, "manifest.json")) {
      events.push("manifest:rename");
      memberModes.push(["store.tar", (await lstat(path.join(stage, "store.tar"))).mode & 0o777]);
      if (fault === "rename") throw new Error("injected rename failure");
    }
    await nativeRename(...args);
  }) as typeof fs.rename);
  syncBuiltinESMExports();
  try {
    const value = await action();
    return { value, events, stage, removals, memberModes };
  } finally {
    openObserver.mock.restore();
    renameObserver.mock.restore();
    rmObserver.mock.restore();
    writeObserver.mock.restore();
    syncBuiltinESMExports();
  }
}

test("migration backup publication direct syncs each published phase in order", async (t) => {
  const { parent, store } = await fixture(t);
  const before = await readFile(path.join(store, "index.db"));
  const result = await observePublication(parent, () => backupMigrationStore(2, []));
  assert.equal(result.value, result.stage);
  assert.deepEqual(result.memberModes, [
    ["members", { mode: 0o600 }, 0o600],
    ["manifest.tmp", { mode: 0o600 }, 0o600],
    ["store.tar", 0o600],
  ]);
  assert.deepEqual(result.events, [
    "archive:chmod:384",
    "archive:sync",
    "archive:close",
    "manifest:sync",
    "manifest:close",
    "manifest:rename",
    "backup:sync",
    "backup:close",
    "parent:sync",
    "parent:close",
  ]);
  assert.deepEqual(await readFile(path.join(store, "index.db")), before);
});

for (const [fault, expected, events] of [
  ["archive-sync", "injected sync failure", ["archive:chmod:384", "archive:sync", "archive:close"]],
  [
    "rename",
    "injected rename failure",
    ["archive:chmod:384", "archive:sync", "archive:close", "manifest:sync", "manifest:close", "manifest:rename"],
  ],
  [
    "backup-sync",
    "injected sync failure",
    [
      "archive:chmod:384",
      "archive:sync",
      "archive:close",
      "manifest:sync",
      "manifest:close",
      "manifest:rename",
      "backup:sync",
      "backup:close",
    ],
  ],
] as const) {
  test(`migration backup publication direct handles ${fault} failure`, async (t) => {
    const { parent, store } = await fixture(t);
    const index = await readFile(path.join(store, "index.db"));
    const sources = await readFile(path.join(store, "sources.json"));
    const result = await observePublication(
      parent,
      async () => {
        await assert.rejects(backupMigrationStore(2, []), {
          message: `cannot back up the Margrave store at ${await realpath(store)}: ${expected}`,
        });
      },
      fault,
    );
    assert.deepEqual(result.events, events);
    if (fault === "rename") {
      assert.deepEqual(result.removals, [[result.stage, { recursive: true, force: true }]]);
      assert.deepEqual(result.memberModes, [
        ["members", { mode: 0o600 }, 0o600],
        ["manifest.tmp", { mode: 0o600 }, 0o600],
        ["store.tar", 0o600],
      ]);
    }
    const candidates = (await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-"));
    if (fault === "backup-sync") {
      assert.deepEqual(candidates, [path.basename(result.stage!)]);
      assert.ok((await lstat(path.join(result.stage!, "manifest.json"))).isFile());
      assert.equal(await backupMigrationStore(2, []), result.stage);
    } else assert.deepEqual(candidates, []);
    assert.deepEqual(await readFile(path.join(store, "index.db")), index);
    assert.deepEqual(await readFile(path.join(store, "sources.json")), sources);
  });
}
