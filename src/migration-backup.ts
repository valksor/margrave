import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { SourceRecord } from "./store-files.ts";
import { MargraveError, atomicWrite, home, indexDbFile, isSha256, lstatIfExists, sourcesFile, validSource } from "./store-files.ts";
import { READ_NO_FOLLOW } from "./skill-files.ts";
import { directoryAclInventory } from "./migration-backup-acl.ts";
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

export function sameFileIdentity(a: Pick<BigIntStats, "dev" | "ino">, b: Pick<BigIntStats, "dev" | "ino">): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function hashCatalogIdentity(
  file: string,
  stat: Pick<BigIntStats, "dev" | "ino">,
  catalog: Pick<BigIntStats, "dev" | "ino">,
): Promise<string> {
  return sameFileIdentity(stat, catalog) ? hashLiveCatalog(file) : hashFile(file);
}

export async function verifyBackupFiles(
  backup: string,
  copy?: string,
): Promise<{ manifest: z.infer<typeof backupManifestSchema>; owner: number } | null> {
  const invalid = (): Error => new Error(`invalid backup: ${backup}`);
  const dir = await lstat(backup, { bigint: true });
  if (!dir.isDirectory() || (dir.mode & 0o077n) !== 0n || dir.uid !== BigInt(process.getuid?.() ?? -1)) throw invalid();
  const args = ["--internal-verify-backup", dir.dev.toString(), dir.ino.toString(), path.resolve(indexDbFile()), copy ?? ""];
  const executable = process.execPath;
  if (!isSea()) args.unshift(fileURLToPath(import.meta.url));
  const env: NodeJS.ProcessEnv = { MARGRAVE_HOME: home() };
  if (process.env["NODE_V8_COVERAGE"] !== undefined) env["NODE_V8_COVERAGE"] = process.env["NODE_V8_COVERAGE"];
  let value: unknown;
  try {
    const result = await execFileAsync(executable, args, { cwd: path.resolve(backup), env });
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw invalid();
  }
  const result = z
    .union([
      z.strictObject({ kind: z.literal("missing") }),
      z.strictObject({ kind: z.literal("syntax"), message: z.string() }),
      z.strictObject({ kind: z.literal("catalog-missing") }),
      z.strictObject({ kind: z.literal("error"), code: z.literal("ENOENT"), file: z.literal("store.tar") }),
      z.strictObject({ kind: z.literal("ok"), manifest: backupManifestSchema, owner: z.number() }),
    ])
    .safeParse(value);
  if (!result.success) throw invalid();
  if (result.data.kind === "missing") return null;
  if (result.data.kind === "syntax") throw new SyntaxError(result.data.message);
  if (result.data.kind === "catalog-missing") {
    const err = new Error(`ENOENT: no such file or directory, lstat '${indexDbFile()}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  if (result.data.kind === "error") {
    const err = new Error(`ENOENT: no such file or directory, open '${path.join(backup, result.data.file)}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  return { manifest: result.data.manifest, owner: result.data.owner };
}

async function verifyBackupArchive(archive: FileHandle, expected: string, copy: string | undefined): Promise<void> {
  const destination = copy ? await open(copy, "wx", 0o600) : undefined;
  try {
    const digest = createHash("sha256");
    for await (const chunk of archive.createReadStream({ autoClose: false })) {
      digest.update(chunk as Buffer);
      if (destination !== undefined) await destination.writeFile(chunk as Buffer);
    }
    if (digest.digest("hex") !== expected) throw new Error("invalid archive digest");
  } finally {
    await destination?.close();
  }
}

export async function verifyBackupChild(args: string[]): Promise<void> {
  const [device, inode, catalogPath, copy] = args;
  if (args.length !== 4 || catalogPath !== indexDbFile()) throw new Error("invalid directory");
  const dir = await lstat(".", { bigint: true });
  if (
    !dir.isDirectory() ||
    dir.dev.toString() !== device ||
    dir.ino.toString() !== inode ||
    (dir.mode & 0o077n) !== 0n ||
    dir.uid !== BigInt(process.getuid?.() ?? -1)
  )
    throw new Error("invalid directory");
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/bin/ls", ["-lde", "."], { env: {} });
    if (stdout.trimEnd().includes("\n")) throw new Error("invalid directory ACL");
  }
  let manifestHandle;
  try {
    manifestHandle = await open("manifest.json", READ_NO_FOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stdout.write(JSON.stringify({ kind: "missing" }));
      return;
    }
    throw err;
  }
  try {
    const stat = await manifestHandle.stat({ bigint: true });
    if (!stat.isFile() || (stat.mode & 0o077n) !== 0n || stat.uid !== dir.uid) throw new Error("invalid manifest");
    let archive;
    try {
      archive = await open("store.tar", READ_NO_FOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      process.stdout.write(JSON.stringify({ kind: "error", code: "ENOENT", file: "store.tar" }));
      return;
    }
    try {
      const archiveStat = await archive.stat({ bigint: true });
      if (!archiveStat.isFile() || (archiveStat.mode & 0o077n) !== 0n || archiveStat.uid !== dir.uid) throw new Error("invalid archive");
      let catalog;
      try {
        catalog = await lstat(catalogPath, { bigint: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        process.stdout.write(JSON.stringify({ kind: "catalog-missing" }));
        return;
      }
      if (sameFileIdentity(stat, catalog)) throw new Error("invalid manifest");
      let raw: unknown;
      try {
        raw = JSON.parse(await manifestHandle.readFile("utf8")) as unknown;
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        process.stdout.write(JSON.stringify({ kind: "syntax", message: err.message }));
        return;
      }
      const manifest = parseBackupManifest(raw);
      if (manifest === null) throw new Error("invalid manifest");
      await verifyBackupArchive(archive, manifest.archiveSha256, copy);
      process.stdout.write(JSON.stringify({ kind: "ok", manifest, owner: Number(dir.uid) }));
    } finally {
      await archive.close();
    }
  } finally {
    await manifestHandle.close();
  }
}

if (!isSea() && import.meta.main && process.argv[2] === "--internal-verify-backup") {
  await verifyBackupChild(process.argv.slice(3));
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
      type === "file" ? await hashCatalogIdentity(file, st, catalog) : type === "symlink" ? await readlink(file) : null,
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
    const sourcesSha256 = sourceStat === null ? null : await hashCatalogIdentity(sourcesPath, sourceStat, catalogStat);
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
  const sourcesSha256 = await hashCatalogIdentity(sourcesFile(), sourceStat, catalog);
  let checked: Awaited<ReturnType<typeof verifyBackupFiles>>;
  try {
    checked = await verifyBackupFiles(backup);
  } catch {
    checked = null;
  }
  if (
    checked === null ||
    checked.manifest.store !== store ||
    checked.manifest.from !== 2 ||
    checked.manifest.indexSha256 !== indexSha256 ||
    checked.manifest.sourcesSha256 !== sourcesSha256
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
