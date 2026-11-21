import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { SourceRecord } from "./store-files.ts";
import { MargraveError, atomicWrite, home, indexDbFile, isSha256, lstatIfExists, sourcesFile, validSource } from "./store-files.ts";
export const execFileAsync = promisify(execFile);
export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

const sha256Schema = z.string().refine(isSha256);
const backupManifestSchema = z.strictObject({
  kind: z.literal("margrave-store-backup"),
  version: z.literal(1),
  store: z.string(),
  from: z.union([z.literal(2), z.literal(3)]),
  indexSha256: sha256Schema,
  inventorySha256: sha256Schema,
  archiveSha256: sha256Schema,
  sourcesSha256: sha256Schema.nullable(),
});
export const migrationRecordSchema = z.strictObject({
  kind: z.literal("margrave-store-migration"),
  version: z.literal(1),
  phase: z.literal("prepared"),
  from: z.literal(2),
  store: z.string(),
  catalogDevice: z.string().regex(/^[0-9]+$/u),
  catalogInode: z.string().regex(/^[0-9]+$/u),
  backup: z.string().regex(/^\.margrave-upgrade-v2-[0-9a-f]{64}-[A-Za-z0-9]{6}$/u),
  indexSha256: sha256Schema,
  sourcesSha256: sha256Schema,
});
export type MigrationRecord = z.infer<typeof migrationRecordSchema>;

function parseBackupManifest(value: unknown): z.infer<typeof backupManifestSchema> | null {
  const result = backupManifestSchema.safeParse(value);
  return result.success ? result.data : null;
}

export async function verifyBackupFiles(backup: string): Promise<{ manifest: z.infer<typeof backupManifestSchema>; owner: number } | null> {
  const invalid = (): Error => new Error(`invalid backup: ${backup}`);
  const dir = await lstat(backup);
  if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()) throw invalid();
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/ls", ["-lde", backup]);
    if (stdout.trimEnd().includes("\n")) throw invalid();
  }
  const manifestFile = path.join(backup, "manifest.json");
  const archiveFile = path.join(backup, "store.tar");
  if ((await lstatIfExists(manifestFile)) === null) return null;
  const stats = await Promise.all([lstat(manifestFile), lstat(archiveFile)]);
  if (stats.some((st) => !st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())) throw invalid();
  const [catalog, manifestStat, archiveStat] = await Promise.all([
    lstat(indexDbFile(), { bigint: true }),
    lstat(manifestFile, { bigint: true }),
    lstat(archiveFile, { bigint: true }),
  ]);
  if (manifestStat.dev === catalog.dev && manifestStat.ino === catalog.ino) throw invalid();
  const manifest = parseBackupManifest(JSON.parse(await readFile(manifestFile, "utf8")) as unknown);
  const archiveHash = await (archiveStat.dev === catalog.dev && archiveStat.ino === catalog.ino
    ? hashLiveCatalog(archiveFile)
    : hashFile(archiveFile));
  if (manifest === null || manifest.archiveSha256 !== archiveHash) throw invalid();
  return { manifest, owner: dir.uid };
}

export async function hashFile(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

export async function hashLiveCatalog(file: string): Promise<string> {
  const digest = createHash("sha256");
  const child = spawn("/bin/cat", [file], { stdio: ["ignore", "pipe", "pipe"] });
  let error = "";
  child.stdout.on("data", (chunk: Buffer) => digest.update(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    error += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(error))));
  });
  return digest.digest("hex");
}

async function syncPath(file: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Read only the directory ACL records from a pax archive, in member order. */
async function directoryAcls(archive: string, directories: readonly string[]): Promise<unknown[]> {
  const handle = await open(archive, "r");
  const result: unknown[] = [];
  let offset = 0;
  let pax = new Map<string, Buffer>();
  const read = async (length: number, position: number): Promise<Buffer> => {
    const bytes = Buffer.alloc(length);
    if ((await handle.read(bytes, 0, length, position)).bytesRead !== length) throw new Error("truncated metadata archive");
    return bytes;
  };
  const text = (bytes: Buffer): string => bytes.toString("utf8").replace(/\0.*$/su, "");
  try {
    for (;;) {
      const header = await read(512, offset);
      offset += 512;
      if (header.every((byte) => byte === 0)) break;
      const sizeText = text(header.subarray(124, 136)).trim();
      if (!/^[0-7]+$/u.test(sizeText)) throw new Error("invalid metadata archive size");
      const size = Number.parseInt(sizeText, 8);
      const type = header[156];
      if (type === 120) {
        const payload = await read(size, offset);
        pax = new Map();
        for (let at = 0; at < payload.length;) {
          const space = payload.indexOf(32, at);
          if (space < 0) throw new Error("invalid pax record");
          const lengthText = payload.subarray(at, space).toString("ascii");
          if (!/^[0-9]+$/u.test(lengthText)) throw new Error("invalid pax record");
          const length = Number(lengthText);
          const end = at + length;
          const equals = payload.indexOf(61, space + 1);
          if (
            !Number.isSafeInteger(length) ||
            end > payload.length ||
            end <= space + 2 ||
            equals < 0 ||
            equals >= end - 1 ||
            payload[end - 1] !== 10
          )
            throw new Error("invalid pax record");
          pax.set(payload.subarray(space + 1, equals).toString("utf8"), payload.subarray(equals + 1, end - 1));
          at = end;
        }
      } else if (type === 53) {
        const prefix = text(header.subarray(345, 500));
        const name = pax.get("path")?.toString("utf8") ?? `${prefix === "" ? "" : `${prefix}/`}${text(header.subarray(0, 100))}`;
        const normalized = name.replace(/^\.\//u, "").replace(/\/$/u, "") || ".";
        if (normalized !== directories[result.length]) throw new Error("metadata archive members do not match");
        result.push([
          normalized,
          ...["SCHILY.acl.access", "SCHILY.acl.default", "SCHILY.acl.ace"].map((key) => pax.get(key)?.toString("base64") ?? null),
        ]);
        pax = new Map();
      } else throw new Error("unexpected metadata archive member");
      offset += Math.ceil(size / 512) * 512;
    }
    if (result.length !== directories.length) throw new Error("metadata archive members do not match");
    return result;
  } finally {
    await handle.close();
  }
}

async function directoryAclInventory(store: string, directories: readonly string[]): Promise<unknown[]> {
  const stage = await mkdtemp(path.join(path.dirname(store), ".margrave-upgrade-tmp-"));
  try {
    if (process.platform === "darwin") await execFileAsync("/bin/chmod", ["-N", stage]);
    const list = path.join(stage, "members");
    const archive = path.join(stage, "directories.tar");
    await writeFile(list, `${directories.map((name) => (name === "." ? "." : `./${name}`)).join("\0")}\0`, { mode: 0o600 });
    await execFileAsync(
      "/usr/bin/tar",
      ["--acls", "--no-xattrs", "--format", "pax", "--no-recursion", "-cf", archive, "-C", store, "--null", "-T", list],
      {
        env: { ...process.env, TAR_OPTIONS: undefined, COPYFILE_DISABLE: "1" },
      },
    );
    return await directoryAcls(archive, directories);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Build an explicit inventory without following managed snapshot symlinks. */
async function backupInventory(store: string, sources: readonly SourceRecord[]): Promise<{ paths: string[]; digest: string }> {
  const members = new Set<string>([".", "index.db"]);
  for (const name of ["sources.json", "catalog-published"]) {
    if (await lstatIfExists(path.join(store, name))) members.add(name);
  }
  async function add(name: string, descend: boolean): Promise<void> {
    const full = path.join(store, name);
    const st = await lstat(full);
    if (!st.isDirectory() && !st.isFile() && !st.isSymbolicLink()) throw new Error(`unsupported file type: ${full}`);
    members.add(name);
    if (descend && st.isDirectory()) {
      for (const child of await readdir(full)) await add(path.join(name, child), true);
    }
  }
  for (const source of sources) {
    if (source.kind !== "git") continue;
    if (!validSource(source)) throw new Error("invalid source record");
    for (const dir of ["snapshots", path.join("snapshots", source.id)]) {
      const st = await lstat(path.join(store, dir));
      if (!st.isDirectory()) throw new Error(`not a directory: ${path.join(store, dir)}`);
      members.add(dir);
    }
    await add(path.join("snapshots", source.id, source.snapshot as string), true);
    const alias = path.join("sources", source.id);
    const sourceDir = await lstatIfExists(path.join(store, "sources"));
    if (sourceDir !== null) {
      if (!sourceDir.isDirectory()) throw new Error(`not a directory: ${path.join(store, "sources")}`);
      members.add("sources");
      const aliasStat = await lstatIfExists(path.join(store, alias));
      if (aliasStat !== null) {
        if (!aliasStat.isSymbolicLink()) throw new Error(`not a symbolic link: ${path.join(store, alias)}`);
        await add(alias, false);
      }
    }
  }
  const paths = [...members].sort();
  const inventory: unknown[] = [];
  const directories: string[] = [];
  const catalog = await lstat(path.join(store, "index.db"), { bigint: true });
  for (const name of paths) {
    const file = path.join(store, name);
    const st = await lstat(file, { bigint: true });
    const type = st.isDirectory() ? "directory" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : "special";
    if (type === "special") throw new Error(`unsupported file type: ${file}`);
    if (type === "directory") directories.push(name);
    if ((name === "index.db" || name === "sources.json" || name === "catalog-published") && type !== "file")
      throw new Error(`not a regular file: ${file}`);
    inventory.push([
      name,
      type,
      st.uid.toString(),
      st.gid.toString(),
      st.mode.toString(),
      ...(type === "directory" ? [] : [st.mtimeNs.toString(), st.ctimeNs.toString()]),
      type === "file"
        ? await (st.dev === catalog.dev && st.ino === catalog.ino ? hashLiveCatalog(file) : hashFile(file))
        : type === "symlink"
          ? await readlink(file)
          : null,
    ]);
  }
  const acls = await directoryAclInventory(store, directories);
  return { paths, digest: sha256(JSON.stringify([inventory, acls])) };
}

/** Back up only the verified catalog and its registered managed files. */
export async function backupMigrationStore(from: 2 | 3, sources: readonly SourceRecord[]): Promise<string> {
  const store = await realpath(home());
  let stage: string | undefined;
  try {
    const inventory = await backupInventory(store, sources);
    const catalogPath = path.join(store, "index.db");
    const catalogStat = await lstat(catalogPath, { bigint: true });
    const indexSha256 = await hashLiveCatalog(catalogPath);
    const sourcesPath = path.join(store, "sources.json");
    const sourceStat = (await lstatIfExists(sourcesPath)) === null ? null : await lstat(sourcesPath, { bigint: true });
    const sourcesSha256 =
      sourceStat === null
        ? null
        : await (sourceStat.dev === catalogStat.dev && sourceStat.ino === catalogStat.ino
            ? hashLiveCatalog(sourcesPath)
            : hashFile(sourcesPath));
    const key = sha256(JSON.stringify([store, from, indexSha256, sourcesSha256, inventory.digest]));
    const parent = path.dirname(store);
    const prefix = `.margrave-upgrade-v${from}-${key}-`;
    const verify = async (backup: string): Promise<boolean> => {
      const checked = await verifyBackupFiles(backup);
      if (checked === null) return false;
      const { manifest } = checked;
      if (
        manifest.store !== store ||
        manifest.from !== from ||
        manifest.indexSha256 !== indexSha256 ||
        manifest.sourcesSha256 !== sourcesSha256 ||
        manifest.inventorySha256 !== inventory.digest
      )
        throw new Error(`invalid backup: ${backup}`);
      return true;
    };
    let completed: string | undefined;
    for (const name of (await readdir(parent)).filter((item) => item.startsWith(prefix)).sort()) {
      const backup = path.join(parent, name);
      if (await verify(backup)) completed ??= backup;
    }
    if (completed !== undefined) {
      await syncPath(completed);
      await syncPath(parent);
      return completed;
    }
    stage = await mkdtemp(path.join(parent, prefix));
    if (process.platform === "darwin") await execFileAsync("/bin/chmod", ["-N", stage]);
    const list = path.join(stage, "members");
    const archive = path.join(stage, "store.tar");
    await writeFile(list, `${inventory.paths.map((name) => (name === "." ? "." : `./${name}`)).join("\0")}\0`, { mode: 0o600 });
    await execFileAsync(
      "/usr/bin/tar",
      ["--acls", "--xattrs", "--format", "pax", "--no-recursion", "-cf", archive, "-C", store, "--null", "-T", list],
      { env: { ...process.env, TAR_OPTIONS: undefined } },
    );
    const archiveSha256 = await hashFile(archive);
    const after = await backupInventory(store, sources);
    if (inventory.digest !== after.digest) throw new Error("store changed during backup");
    await rm(list);
    const manifestTemp = path.join(stage, "manifest.tmp");
    await writeFile(
      manifestTemp,
      `${JSON.stringify({ kind: "margrave-store-backup", version: 1, store, from, indexSha256, inventorySha256: inventory.digest, archiveSha256, sourcesSha256 })}\n`,
      { mode: 0o600 },
    );
    // tar follows the process umask; make the archive private before publishing it.
    const archiveHandle = await open(archive, "r+");
    try {
      await archiveHandle.chmod(0o600);
      await archiveHandle.sync();
    } finally {
      await archiveHandle.close();
    }
    await syncPath(manifestTemp);
    await rename(manifestTemp, path.join(stage, "manifest.json"));
    const backup = stage;
    stage = undefined;
    await syncPath(backup);
    await syncPath(parent);
    return backup;
  } catch (err) {
    if (stage !== undefined) await rm(stage, { recursive: true, force: true });
    throw new MargraveError(`cannot back up the Margrave store at ${store}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function writeMigrationRecord(backup: string): Promise<void> {
  const store = await realpath(home());
  const catalog = await lstat(indexDbFile(), { bigint: true });
  const indexSha256 = await hashLiveCatalog(indexDbFile());
  const sourceStat = await lstat(sourcesFile(), { bigint: true });
  const sourcesSha256 = await (sourceStat.dev === catalog.dev && sourceStat.ino === catalog.ino
    ? hashLiveCatalog(sourcesFile())
    : hashFile(sourcesFile()));
  const manifest = (await verifyBackupFiles(backup).catch(() => null))?.manifest ?? null;
  if (
    manifest === null ||
    manifest.store !== store ||
    manifest.from !== 2 ||
    manifest.indexSha256 !== indexSha256 ||
    manifest.sourcesSha256 !== sourcesSha256
  )
    throw new MargraveError(
      `cannot verify the interrupted Margrave upgrade at ${store}. Restore a complete backup. See Upgrading in the README.`,
    );
  const record: MigrationRecord = {
    kind: "margrave-store-migration",
    version: 1,
    phase: "prepared",
    from: 2,
    store,
    catalogDevice: catalog.dev.toString(),
    catalogInode: catalog.ino.toString(),
    backup: path.basename(backup),
    indexSha256,
    sourcesSha256,
  };
  await atomicWrite(sourcesFile(), `${JSON.stringify(record)}\n`);
  await syncPath(store);
}
