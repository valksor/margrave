import assert from "node:assert/strict";
import childProcess, { type ExecFileOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { promisify } from "node:util";

const originalExecFile = childProcess.execFile;
const realExecFile = promisify(originalExecFile);
const metadataCalls: {
  file: string;
  args: string[];
  tarOptionsOwn: boolean;
  tarOptions: string | undefined;
  copyfileDisable: string | undefined;
  inherited: string | undefined;
}[] = [];
let metadataParent: string | undefined;
const recordingExecFile = (...args: Parameters<typeof originalExecFile>): ReturnType<typeof originalExecFile> => originalExecFile(...args);
Object.defineProperty(recordingExecFile, promisify.custom, {
  value: (file: string, args: string[], options: ExecFileOptions) => {
    const archivePath = args[args.indexOf("-cf") + 1];
    if (
      metadataParent !== undefined &&
      file === "/usr/bin/tar" &&
      archivePath !== undefined &&
      path.dirname(path.dirname(archivePath)) === metadataParent &&
      ((path.basename(archivePath) === "directories.tar" &&
        path.basename(path.dirname(archivePath)).startsWith(".margrave-upgrade-tmp-")) ||
        (path.basename(archivePath) === "store.tar" && path.basename(path.dirname(archivePath)).startsWith(".margrave-upgrade-v2-")))
    ) {
      const env = options.env;
      metadataCalls.push({
        file,
        args: [...args],
        tarOptionsOwn: Object.hasOwn(env ?? {}, "TAR_OPTIONS"),
        tarOptions: env?.["TAR_OPTIONS"],
        copyfileDisable: path.basename(archivePath) === "directories.tar" ? env?.["COPYFILE_DISABLE"] : undefined,
        inherited: env?.["MARGRAVE_ACL_TEST_INHERITED"],
      });
    }
    return realExecFile(file, args, options);
  },
});
let backupMigrationStore: typeof import("../src/migration-backup.ts").backupMigrationStore;
try {
  childProcess.execFile = recordingExecFile as typeof originalExecFile;
  syncBuiltinESMExports();
  ({ backupMigrationStore } = await import("../src/migration-backup.ts"));
} finally {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
}

const source = {
  id: "example.invalid__fixtures__margrave-upgrade",
  kind: "git" as const,
  spec: "https://example.invalid/fixtures/margrave-upgrade.git",
  url: "https://example.invalid/fixtures/margrave-upgrade.git",
  subpath: "",
  ref: "refs/heads/master",
  commit: "29d8fef69168a981a9b40157a0ab717a15d348a4",
  snapshot: "29d8fef69168a981a9b40157a0ab717a15d348a4-7ca6d211a503c26c",
  installedAt: "2026-11-20T09:29:04.539Z",
};
const snapshot = `snapshots/${source.id}/${source.snapshot}`;
const directories = [".", "snapshots", `snapshots/${source.id}`, snapshot, `${snapshot}/nested`];
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

function paxLine(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`);
  let length = body.length + 1;
  while (Buffer.byteLength(String(length)) + body.length !== length) length = Buffer.byteLength(String(length)) + body.length;
  return Buffer.concat([Buffer.from(String(length)), body]);
}

function member(name: string, type: "5" | "x" | "0", payload = Buffer.alloc(0), prefix = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(payload.length.toString(8).padStart(11, "0"), 124, 11);
  header.write(type, 156);
  header.write(prefix, 345, 155);
  return Buffer.concat([header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512)]);
}

function archive(...members: Buffer[]): Buffer {
  return Buffer.concat([...members, Buffer.alloc(512)]);
}

function managedArchive(access: string, defaults: string, ace: string): Buffer {
  return archive(
    member("", "5"),
    member("./snapshots/", "5"),
    member(source.id, "5", Buffer.alloc(0), "snapshots"),
    member(
      "PaxHeader",
      "x",
      Buffer.concat([
        paxLine("path", `./${snapshot}/`),
        paxLine("SCHILY.acl.access", access),
        paxLine("SCHILY.acl.default", defaults),
        paxLine("SCHILY.acl.ace", ace),
        paxLine("", "ignored"),
        paxLine("padding", "x".repeat(500)),
      ]),
    ),
    member("ignored", "5"),
    member("nested", "5", Buffer.alloc(0), snapshot),
  );
}

async function withStore(run: (parent: string, store: string) => Promise<void>): Promise<void> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "margrave-acl-direct-")));
  const store = path.join(parent, "store");
  const previous = process.env["MARGRAVE_HOME"];
  try {
    await mkdir(store);
    await writeFile(path.join(store, "index.db"), "disposable catalog\n");
    process.env["MARGRAVE_HOME"] = store;
    await run(parent, store);
  } finally {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
    await rm(parent, { recursive: true, force: true });
  }
}

async function withArchive<T>(
  parent: string,
  bytes: Buffer,
  run: () => Promise<T>,
  expectedDirectories: readonly string[] = ["."],
): Promise<{ value: T; reads: number[][]; closed: number; synced: number }> {
  const originalOpen = fs.open;
  const originalWriteFile = fs.writeFile;
  const originalRm = fs.rm;
  const reads: number[][] = [];
  const lists: string[] = [];
  const removed: string[] = [];
  let closed = 0;
  let synced = 0;
  const isStage = (dir: string): boolean => path.dirname(dir) === parent && path.basename(dir).startsWith(".margrave-upgrade-tmp-");
  mock.method(fs, "writeFile", (async (...args: Parameters<typeof fs.writeFile>) => {
    const [file, , options] = args;
    if (typeof file === "string" && path.basename(file) === "members" && isStage(path.dirname(file))) {
      assert.deepEqual(options, { mode: 0o600 });
      await originalWriteFile(...args);
      assert.deepEqual(
        await readFile(file),
        Buffer.from(`${expectedDirectories.map((name) => (name === "." ? "." : `./${name}`)).join("\0")}\0`),
      );
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
      lists.push(path.dirname(file));
      return;
    }
    return originalWriteFile(...args);
  }) as typeof fs.writeFile);
  mock.method(fs, "rm", (async (...args: Parameters<typeof fs.rm>) => {
    const [file, options] = args;
    if (typeof file === "string" && isStage(file)) {
      assert.deepEqual(options, { recursive: true, force: true });
      removed.push(file);
    }
    return originalRm(...args);
  }) as typeof fs.rm);
  mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
    const [file, flags] = args;
    if (
      typeof file !== "string" ||
      flags !== "r" ||
      path.dirname(path.dirname(file)) !== parent ||
      !path.basename(path.dirname(file)).startsWith(".margrave-upgrade-tmp-") ||
      path.basename(file) !== "directories.tar"
    )
      return originalOpen(...args);
    await fs.writeFile(file, bytes);
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    const sync = handle.sync.bind(handle);
    let calls = 0;
    mock.method(handle, "read", (async (buffer: Buffer, offset: number, length: number, position: number) => {
      if (++calls > 40) throw new Error("metadata read limit exceeded");
      reads.push([length, position]);
      return read(buffer, offset, length, position);
    }) as typeof handle.read);
    mock.method(handle, "close", async () => {
      closed++;
      return close();
    });
    mock.method(handle, "sync", async () => {
      synced++;
      return sync();
    });
    return handle;
  }) as typeof fs.open);
  syncBuiltinESMExports();
  try {
    const value = await run();
    assert.ok(lists.length > 0);
    assert.deepEqual(removed, lists);
    return { value, reads, closed, synced };
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

async function expectedDigest(store: string, acl: (string | null)[][]): Promise<string> {
  const names = [".", "index.db", ...directories.slice(1), `${snapshot}/z-file`, `${snapshot}/a-link`].sort();
  const inventory: unknown[] = [];
  for (const name of names) {
    const st = await lstat(path.join(store, name), { bigint: true });
    const type = directories.includes(name) ? "directory" : name === `${snapshot}/a-link` ? "symlink" : "file";
    inventory.push([
      name,
      type,
      st.uid.toString(),
      st.gid.toString(),
      st.mode.toString(),
      ...(type === "directory" ? [] : [st.mtimeNs.toString(), st.ctimeNs.toString()]),
      type === "directory" ? null : type === "symlink" ? "z-file" : hash(await readFile(path.join(store, name))),
    ]);
  }
  return hash(JSON.stringify([inventory, acl]));
}

test("migration backup metadata direct passes exact tar arguments and environment", async () => {
  const previous = process.env["MARGRAVE_ACL_TEST_INHERITED"];
  process.env["MARGRAVE_ACL_TEST_INHERITED"] = "fixture-value";
  try {
    await withStore(async (parent, store) => {
      metadataCalls.length = 0;
      metadataParent = parent;
      let backup: string;
      try {
        backup = await backupMigrationStore(2, []);
      } finally {
        metadataParent = undefined;
      }
      const directoryCalls = metadataCalls.filter((call) => path.basename(call.args[6]!) === "directories.tar");
      const publicationCalls = metadataCalls.filter((call) => path.basename(call.args[6]!) === "store.tar");
      assert.equal(directoryCalls.length, 2);
      assert.deepEqual(
        publicationCalls.map((call) => call.args[6]),
        [path.join(backup, "store.tar")],
      );
      assert.equal(publicationCalls.length, 1);
      for (const call of directoryCalls) {
        const stage = path.dirname(call.args[6]!);
        assert.equal(path.dirname(stage), parent);
        assert.ok(path.basename(stage).startsWith(".margrave-upgrade-tmp-"));
        assert.equal(call.file, "/usr/bin/tar");
        assert.deepEqual(call.args, [
          "--acls",
          "--no-xattrs",
          "--format",
          "pax",
          "--no-recursion",
          "-cf",
          path.join(stage, "directories.tar"),
          "-C",
          store,
          "--null",
          "-T",
          path.join(stage, "members"),
        ]);
        assert.equal(call.tarOptionsOwn, true);
        assert.equal(call.tarOptions, undefined);
        assert.equal(call.copyfileDisable, "1");
        assert.equal(call.inherited, "fixture-value");
      }
      const publication = publicationCalls[0]!;
      assert.equal(publication.file, "/usr/bin/tar");
      assert.deepEqual(publication.args, [
        "--acls",
        "--xattrs",
        "--format",
        "pax",
        "--no-recursion",
        "-cf",
        path.join(backup, "store.tar"),
        "-C",
        store,
        "--null",
        "-T",
        path.join(backup, "members"),
      ]);
      assert.equal(publication.tarOptionsOwn, true);
      assert.equal(publication.tarOptions, undefined);
      assert.equal(publication.inherited, "fixture-value");
    });
  } finally {
    if (previous === undefined) delete process.env["MARGRAVE_ACL_TEST_INHERITED"];
    else process.env["MARGRAVE_ACL_TEST_INHERITED"] = previous;
  }
});

test("migration backup metadata direct empty archive fails and root fallback succeeds", async () => {
  await withStore(async (parent, store) => {
    const catalog = await readFile(path.join(store, "index.db"));
    const empty = await withArchive(parent, archive(), async () => {
      await assert.rejects(backupMigrationStore(2, []), /: metadata archive members do not match$/u);
    });
    assert.equal(empty.closed, 1);
    assert.equal(empty.synced, 0);
    assert.deepEqual(await readdir(parent), ["store"]);
    const result = await withArchive(parent, archive(member("", "5")), () => backupMigrationStore(2, []));
    assert.deepEqual(result.reads, [
      [512, 0],
      [512, 512],
      [512, 0],
      [512, 512],
    ]);
    assert.equal(result.closed, 2);
    assert.equal(result.synced, 0);
    const manifest = JSON.parse(await readFile(path.join(result.value, "manifest.json"), "utf8")) as { inventorySha256: string };
    const st = await lstat(path.join(store, "index.db"), { bigint: true });
    const root = await lstat(store, { bigint: true });
    const inventory = [
      [".", "directory", root.uid.toString(), root.gid.toString(), root.mode.toString(), null],
      [
        "index.db",
        "file",
        st.uid.toString(),
        st.gid.toString(),
        st.mode.toString(),
        st.mtimeNs.toString(),
        st.ctimeNs.toString(),
        hash(catalog),
      ],
    ];
    assert.equal(manifest.inventorySha256, hash(JSON.stringify([inventory, [[".", null, null, null]]])));
    assert.deepEqual(await readFile(path.join(store, "index.db")), catalog);
  });
});

test("migration backup metadata direct records sorted managed directories and ACL bytes", async () => {
  await withStore(async (parent, store) => {
    await mkdir(path.join(store, snapshot, "nested"), { recursive: true });
    await writeFile(path.join(store, snapshot, "z-file"), "known file contents\n");
    await symlink("z-file", path.join(store, snapshot, "a-link"));
    const catalog = await readFile(path.join(store, "index.db"));
    const values = [
      ["", "default", "ace"],
      ["access", "default", "ace"],
      ["access", "changed", "ace"],
      ["access", "changed", "changed"],
    ];
    const digests: string[] = [];
    for (const [access, defaults, ace] of values) {
      const result = await withArchive(
        parent,
        managedArchive(access!, defaults!, ace!),
        () => backupMigrationStore(2, [source]),
        directories,
      );
      assert.equal(result.closed, 2);
      assert.equal(result.synced, 0);
      assert.ok(result.reads.some(([length]) => length! > 512));
      const manifest = JSON.parse(await readFile(path.join(result.value, "manifest.json"), "utf8")) as { inventorySha256: string };
      const encoded = [access!, defaults!, ace!].map((value) => Buffer.from(value).toString("base64"));
      const acl = directories.map((name) => [name, ...(name === snapshot ? encoded : [null, null, null])]);
      assert.equal(manifest.inventorySha256, await expectedDigest(store, acl));
      digests.push(manifest.inventorySha256);
    }
    assert.equal(new Set(digests).size, values.length);
    assert.deepEqual(await readFile(path.join(store, "index.db")), catalog);
    assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-tmp-")).length, 0);
  });
});

test("migration backup metadata direct rejects malformed archives and removes staging", async () => {
  const badSize = member(".", "5");
  badSize.write("00000000008", 124, 11);
  const badSizePrefix = member(".", "5");
  badSizePrefix.write("80000000000", 124, 11);
  const shortPayload = member("pax", "x", Buffer.from("12 path=x\n")).subarray(0, 515);
  const cases: [string, Buffer, string][] = [
    ["truncated header", Buffer.alloc(12, 1), "truncated metadata archive"],
    ["truncated payload", shortPayload, "truncated metadata archive"],
    ["octal size", archive(badSize), "invalid metadata archive size"],
    ["octal size prefix", archive(badSizePrefix), "invalid metadata archive size"],
    ["unsupported type", archive(member(".", "0")), "unexpected metadata archive member"],
    ["wrong name", archive(member("wrong", "5")), "metadata archive members do not match"],
    ["missing member", archive(), "metadata archive members do not match"],
    ["extra member", archive(member(".", "5"), member("extra", "5")), "metadata archive members do not match"],
    ...[
      ["missing space", "123"],
      ["nondecimal length", "x a=b\n"],
      ["signed length", "+7 a=b\n"],
      ["decimal length", "8.0 a=b\n"],
      ["unsafe length", "9007199254740992 a=b\n"],
      ["out of range length", "99 a=b\n"],
      ["too short", "2 a=b\n"],
      ["missing equals", "6 abc\n"],
      ["equals in following record", "6 abc\n6 a=b\n"],
      ["missing newline", "7 a=bc!"],
    ].map(([name, payload]): [string, Buffer, string] => [name!, archive(member("pax", "x", Buffer.from(payload!))), "invalid pax record"]),
  ];
  await withStore(async (parent, store) => {
    const catalog = await readFile(path.join(store, "index.db"));
    for (const [name, bytes, suffix] of cases) {
      const result = await withArchive(parent, bytes, async () => {
        await assert.rejects(backupMigrationStore(2, []), (error: Error) => {
          assert.ok(error.message.endsWith(`: ${suffix}`), `${name}: ${error.message}`);
          return true;
        });
      });
      assert.equal(result.closed, 1, name);
      assert.equal(result.synced, 0, name);
      assert.deepEqual(await readdir(parent), ["store"], name);
      assert.deepEqual(await readFile(path.join(store, "index.db")), catalog, name);
    }
  });
});

test("migration backup metadata direct rejects managed directories out of order", async () => {
  await withStore(async (parent, store) => {
    await mkdir(path.join(store, snapshot, "nested"), { recursive: true });
    const catalog = await readFile(path.join(store, "index.db"));
    for (const bytes of [
      archive(member(".", "5"), member(source.id, "5", Buffer.alloc(0), "snapshots")),
      archive(
        member(".", "5"),
        member("./snapshots/", "5"),
        member(`snapshots/./${source.id}`, "5"),
        member(source.snapshot, "5", Buffer.alloc(0), `snapshots/${source.id}`),
        member("nested", "5", Buffer.alloc(0), snapshot),
      ),
    ]) {
      const result = await withArchive(
        parent,
        bytes,
        async () => {
          await assert.rejects(backupMigrationStore(2, [source]), /: metadata archive members do not match$/u);
        },
        directories,
      );
      assert.equal(result.closed, 1);
      assert.equal(result.synced, 0);
      assert.deepEqual(await readdir(parent), ["store"]);
      assert.deepEqual(await readFile(path.join(store, "index.db")), catalog);
    }
  });
});
