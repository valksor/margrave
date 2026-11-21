// The margrave store: MARGRAVE_HOME, sources.json (atomic rename), index.db (SQLite transactions).
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, lstat, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { z } from "zod";
import type { TokenStrings } from "./bm25.ts";
import type { ScanOutcome } from "./safety.ts";

/** An error whose message is meant for the user. The CLI prints it and exits 1. */
export class MargraveError extends Error {}
/** A usage error. The CLI prints it and exits 2. */
export class UsageError extends Error {}
/** An error caused by the caller's input. Its message holds no server path, so a remote client may see it. */
export class RequestError extends MargraveError {}

export type SourceKind = "git" | "local";

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  spec: string;
  /** Git sources only. */
  url?: string;
  /** Local sources only: the absolute real path. */
  path?: string;
  /** Subdirectory inside the clone. Empty string for none. */
  subpath: string;
  ref: string | null;
  commit: string | null;
  installedAt: string;
  /** Managed Git snapshot key. */
  snapshot?: string;
  scan?: ScanOutcome;
  selection?: string[];
}

export interface IndexEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  dir: string;
  revision: string;
  manifest: string;
  frontmatter: string;
}

/** An entry to write: the row plus the token strings for the FTS columns. */
export interface NewEntry extends IndexEntry {
  tokens: TokenStrings;
}

export function home(): string {
  const env = process.env["MARGRAVE_HOME"];
  return path.resolve(env !== undefined && env !== "" ? env : path.join(homedir(), ".margrave"));
}

export const sourcesRoot = (): string => path.join(home(), "sources");
export const stagingRoot = (): string => path.join(home(), "staging");
export const reportsRoot = (): string => path.join(home(), "reports");
export const sourcesFile = (): string => path.join(home(), "sources.json");
export const indexDbFile = (): string => path.join(home(), "index.db");
const publishedMarker = (): string => path.join(home(), "catalog-published");

export async function ensureDirs(): Promise<void> {
  await mkdir(sourcesRoot(), { recursive: true });
  await mkdir(stagingRoot(), { recursive: true });
}

/** Write a file by writing a temp file in the same directory, then renaming it. */
export async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function validSourceLocation(v: Record<string, unknown>): boolean {
  if (typeof v["id"] !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u.test(v["id"])) return false;
  if (v["kind"] === "local") return v["snapshot"] === undefined && typeof v["path"] === "string" && path.isAbsolute(v["path"]);
  return (
    v["kind"] === "git" &&
    typeof v["snapshot"] === "string" &&
    typeof v["commit"] === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}$/u.test(v["snapshot"]) &&
    v["snapshot"].startsWith(`${v["commit"]}-`)
  );
}

function validSourceFields(v: Record<string, unknown>): boolean {
  if (v["selection"] !== undefined && !validSelection(v["selection"])) return false;
  if (typeof v["id"] !== "string" || typeof v["spec"] !== "string") return false;
  if (v["kind"] !== "git" && v["kind"] !== "local") return false;
  if (typeof v["subpath"] !== "string") return false;
  if (v["ref"] !== null && typeof v["ref"] !== "string") return false;
  if (v["commit"] !== null && typeof v["commit"] !== "string") return false;
  if (typeof v["installedAt"] !== "string") return false;
  if (!validSourceLocation(v)) return false;
  if (v["kind"] === "git")
    return typeof v["url"] === "string" && typeof v["ref"] === "string" && /^refs\/(?:heads|tags)\/.+/u.test(v["ref"]);
  return true;
}

export function validSelection(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((name, i) => typeof name === "string" && name !== "" && name.trim() === name && (i === 0 || value[i - 1] < name))
  );
}

function validSource(v: unknown): v is SourceRecord {
  return isRecord(v) && validSourceFields(v) && (v["scan"] === undefined || (v["kind"] === "git" && validScan(v["scan"])));
}

export function validScan(value: unknown): value is ScanOutcome {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "code,files,keys,overridden,tree,verdict,version") return false;
  if (value["tree"] !== null && (typeof value["tree"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["tree"]))) return false;
  if (!(value["version"] === null || typeof value["version"] === "string") || typeof value["overridden"] !== "boolean") return false;
  const verdict = value["verdict"];
  if (!(["clean", "warn", "critical", "failed"] as unknown[]).includes(verdict)) return false;
  if (
    (verdict === "clean" && value["code"] !== 0) ||
    (verdict === "warn" && value["code"] !== 1) ||
    (verdict === "critical" && value["code"] !== 2)
  )
    return false;
  if (verdict === "failed" && value["code"] !== null && typeof value["code"] !== "number") return false;
  const relative = (s: unknown): s is string =>
    typeof s === "string" && s !== "" && !path.isAbsolute(s) && !s.split(path.sep).some((p) => p === ".." || p === "");
  if (!Array.isArray(value["keys"]) || !Array.isArray(value["files"])) return false;
  for (const item of value["keys"]) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !Number.isSafeInteger(item[1]) || item[1] < 1)
      return false;
    try {
      const key: unknown = JSON.parse(item[0]);
      if (
        !Array.isArray(key) ||
        key.length !== 4 ||
        !relative(key[0]) ||
        typeof key[1] !== "string" ||
        !["warn", "critical"].includes(key[2]) ||
        typeof key[3] !== "string" ||
        !/^[0-9a-f]{64}$/u.test(key[3])
      )
        return false;
    } catch {
      return false;
    }
  }
  return value["files"].every(
    (item: unknown) =>
      Array.isArray(item) && item.length === 2 && relative(item[0]) && typeof item[1] === "string" && /^[0-9a-f]{64}$/u.test(item[1]),
  );
}

/** A missing file is an empty list. A malformed file is an error. */
export async function readLegacySources(raw?: string): Promise<SourceRecord[]> {
  const file = sourcesFile();
  raw ??= (await readIfExists(file)) ?? undefined;
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MargraveError(`${file} is not valid JSON (${(err as Error).message}); fix or delete it`);
  }
  if (Array.isArray(parsed)) {
    for (const record of parsed) {
      if (isRecord(record) && typeof record["id"] === "string" && (Object.hasOwn(record, "scan") || Object.hasOwn(record, "selection")))
        throw new MargraveError(
          `cannot upgrade source "${record["id"]}" because its source record, index, or files disagree. Restore a known-good backup or recover the source from a verified lock`,
        );
    }
  }
  if (!Array.isArray(parsed) || !parsed.every(validSource)) {
    throw new MargraveError(`${file} is malformed (expected a list of source records); fix or delete it`);
  }
  return parsed;
}

const execFileAsync = promisify(execFile);
const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

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
const migrationRecordSchema = z.strictObject({
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
type MigrationRecord = z.infer<typeof migrationRecordSchema>;

function parseBackupManifest(value: unknown): z.infer<typeof backupManifestSchema> | null {
  const result = backupManifestSchema.safeParse(value);
  return result.success ? result.data : null;
}

async function verifyBackupFiles(backup: string): Promise<{ manifest: z.infer<typeof backupManifestSchema>; owner: number } | null> {
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

async function hashFile(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function hashLiveCatalog(file: string): Promise<string> {
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

async function extractBackupMember(archive: string, member: string, destination: string): Promise<void> {
  const output = await open(destination, "wx", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/tar", ["-xOf", archive, `./${member}`], {
        stdio: ["ignore", output.fd, "pipe"],
        env: { ...process.env, TAR_OPTIONS: undefined },
      });
      let error = "";
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        error += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(error))));
    });
  } finally {
    await output.close();
  }
}

async function lockRecoveredCatalog(
  catalog: { dev: bigint; ino: bigint; uid: bigint },
  expectedHash: string,
  journalHash: string | undefined,
  owner: number,
): Promise<DatabaseSync> {
  const file = indexDbFile();
  const journal = `${file}-journal`;
  const journalError = (): MargraveError =>
    new MargraveError(`cannot verify the Margrave upgrade journal at ${journal}. Restore a complete backup. See Upgrading in the README.`);
  if ((await lstatIfExists(`${file}-wal`)) !== null || (await lstatIfExists(`${file}-shm`)) !== null) throw journalError();
  // The prepared record makes legacy writers reject application writes after they take the SQLite lock.
  // A legacy connection can still complete SQLite rollback while this connection waits for that lock.
  const db = new DatabaseSync(file, { readBigInts: true, timeout: WRITE_TIMEOUT_MS });
  try {
    try {
      db.exec("BEGIN EXCLUSIVE");
    } catch (err) {
      if ((err as { errcode?: number }).errcode === 5)
        throw new MargraveError("another Margrave writer holds the legacy catalog lock. Try the command again");
      throw err;
    }
    const locked = await lstat(file, { bigint: true });
    const afterJournal = await lstatIfExists(journal);
    if (
      locked.dev !== catalog.dev ||
      locked.ino !== catalog.ino ||
      (await hashLiveCatalog(file)) !== expectedHash ||
      (afterJournal !== null &&
        (journalHash === undefined ||
          !afterJournal.isFile() ||
          (afterJournal.uid !== owner && BigInt(afterJournal.uid) !== catalog.uid) ||
          (await hashFile(journal)) !== journalHash))
    )
      throw journalError();
    if (readProbe(db, file).version !== 2) throw journalError();
    await checkLegacyJournalMode(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

async function validateMigrationJournal(
  scratch: string,
  catalog: { dev: bigint; ino: bigint; uid: bigint },
  record: MigrationRecord,
  owner: number,
): Promise<{ journalHash?: string; db?: DatabaseSync }> {
  const invalid = (): MargraveError =>
    new MargraveError(
      `cannot verify the interrupted Margrave upgrade at ${record.store}. Restore a complete backup. See Upgrading in the README.`,
    );
  const journalError = (): MargraveError =>
    new MargraveError(
      `cannot verify the Margrave upgrade journal at ${indexDbFile()}-journal. Restore a complete backup. See Upgrading in the README.`,
    );
  let held: DatabaseSync | undefined;
  const journal = `${indexDbFile()}-journal`;
  const journalStat = await lstatIfExists(journal);
  let verifiedJournal: string | undefined;
  if (journalStat !== null) {
    try {
      if (!journalStat.isFile() || journalStat.size < 28 || (journalStat.uid !== owner && BigInt(journalStat.uid) !== catalog.uid))
        throw journalError();
      const headerFile = await open(journal, "r");
      const header = Buffer.alloc(28);
      try {
        if ((await headerFile.read(header, 0, header.length, 0)).bytesRead !== header.length) throw journalError();
      } finally {
        await headerFile.close();
      }
      const magic = header.subarray(0, 8);
      const sectorSize = header.readUInt32BE(20);
      const pageSize = header.readUInt32BE(24);
      if (
        (!magic.equals(Buffer.alloc(8)) && !magic.equals(Buffer.from("d9d505f920a163d7", "hex"))) ||
        sectorSize < 512 ||
        (sectorSize & (sectorSize - 1)) !== 0 ||
        pageSize < 512 ||
        pageSize > 65536 ||
        (pageSize & (pageSize - 1)) !== 0 ||
        journalStat.size < sectorSize
      )
        throw journalError();
      const liveHash = await hashFile(indexDbFile());
      const journalHash = await hashFile(journal);
      await copyFile(indexDbFile(), path.join(scratch, "index.db"));
      await copyFile(journal, path.join(scratch, "index.db-journal"));
      try {
        const db = new DatabaseSync(path.join(scratch, "index.db"));
        try {
          db.prepare("PRAGMA user_version").get();
        } finally {
          db.close();
        }
      } catch {
        throw journalError();
      }
      if ((await hashFile(path.join(scratch, "index.db"))) !== record.indexSha256) throw journalError();
      const current = await lstat(indexDbFile(), { bigint: true });
      const currentHash = await hashFile(indexDbFile());
      const remaining = await lstatIfExists(journal);
      if (
        current.dev !== catalog.dev ||
        current.ino !== catalog.ino ||
        (remaining === null
          ? currentHash !== record.indexSha256
          : currentHash !== liveHash ||
            !remaining.isFile() ||
            (remaining.uid !== owner && BigInt(remaining.uid) !== catalog.uid) ||
            (await hashFile(journal)) !== journalHash)
      )
        throw journalError();
      if (magic.equals(Buffer.from("d9d505f920a163d7", "hex"))) {
        held = await lockRecoveredCatalog(catalog, record.indexSha256, journalHash, owner);
      } else {
        if (currentHash !== record.indexSha256) throw journalError();
        if (remaining !== null) verifiedJournal = journalHash;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || (await lstatIfExists(journal)) !== null) throw err;
      const current = await lstat(indexDbFile(), { bigint: true });
      if (current.dev !== catalog.dev || current.ino !== catalog.ino || (await hashFile(indexDbFile())) !== record.indexSha256)
        throw journalError();
      held = await lockRecoveredCatalog(catalog, record.indexSha256, undefined, owner);
    }
  } else if ((await hashFile(indexDbFile())) !== record.indexSha256) throw invalid();
  return { ...(verifiedJournal === undefined ? {} : { journalHash: verifiedJournal }), ...(held === undefined ? {} : { db: held }) };
}

/** Verify a prepared record and its archive before allowing SQLite to recover the live file. */
export async function recoverMigrationRecord(): Promise<{
  backup: string;
  sources: string;
  journalHash?: string;
  db?: DatabaseSync;
} | null> {
  const store = await realpath(home());
  const sourceStat = await lstatIfExists(sourcesFile());
  if (sourceStat !== null && !sourceStat.isFile())
    throw new MargraveError(
      `cannot verify the interrupted Margrave upgrade at ${store}. Restore a complete backup. See Upgrading in the README.`,
    );
  let raw: string | null;
  try {
    raw = await readIfExists(sourcesFile());
  } catch (err) {
    throw new MargraveError(`cannot upgrade the v0.2.1 catalog: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value["kind"] !== "margrave-store-migration") return null;
  const invalid = (): MargraveError =>
    new MargraveError(
      `cannot verify the interrupted Margrave upgrade at ${store}. Restore a complete backup. See Upgrading in the README.`,
    );
  const parsed = migrationRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.store !== store) throw invalid();
  const record = parsed.data;
  const backup = path.join(path.dirname(store), record.backup);
  let scratch: string | undefined;
  let held: DatabaseSync | undefined;
  try {
    const catalog = await lstat(indexDbFile(), { bigint: true });
    if (!catalog.isFile() || catalog.dev.toString() !== record.catalogDevice || catalog.ino.toString() !== record.catalogInode)
      throw invalid();
    const archive = path.join(backup, "store.tar");
    const checked = await verifyBackupFiles(backup);
    if (checked === null) throw invalid();
    const { manifest, owner } = checked;
    if (
      manifest.store !== store ||
      manifest.from !== 2 ||
      manifest.indexSha256 !== record.indexSha256 ||
      manifest.sourcesSha256 !== record.sourcesSha256
    )
      throw invalid();
    const key = sha256(JSON.stringify([store, 2, record.indexSha256, record.sourcesSha256, manifest.inventorySha256]));
    if (!record.backup.startsWith(`.margrave-upgrade-v2-${key}-`)) throw invalid();
    scratch = await mkdtemp(path.join(path.dirname(store), ".margrave-upgrade-tmp-"));
    if (process.platform === "darwin") await execFileAsync("/bin/chmod", ["-N", scratch]);
    await extractBackupMember(archive, "index.db", path.join(scratch, "original.db"));
    await extractBackupMember(archive, "sources.json", path.join(scratch, "sources.json"));
    if (
      (await hashFile(path.join(scratch, "original.db"))) !== record.indexSha256 ||
      (await hashFile(path.join(scratch, "sources.json"))) !== record.sourcesSha256
    )
      throw invalid();
    const sources = await readFile(path.join(scratch, "sources.json"), "utf8");
    const journal = await validateMigrationJournal(scratch, catalog, record, owner);
    held = journal.db;
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
    const db = held;
    held = undefined;
    return {
      backup,
      sources,
      ...(journal.journalHash === undefined ? {} : { journalHash: journal.journalHash }),
      ...(db === undefined ? {} : { db }),
    };
  } catch (err) {
    try {
      if (held?.isOpen === true) held.close();
      if (err instanceof MargraveError) throw err;
      throw invalid();
    } finally {
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    }
  }
}

// ---- index.db ----

export const SCHEMA_VERSION = 4;
export const FTS_SCHEMA =
  "CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='ascii')";
const READ_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 30000;
const SQLITE_NOTADB = 26;
// A hot rollback journal that a read-only connection cannot roll back.
const SQLITE_READONLY_ROLLBACK = 776;

// Idempotent, so a second creator that waited for the lock changes nothing. The caller owns the transaction.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills(
  rowid INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  id_lc TEXT NOT NULL,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  dir TEXT NOT NULL,
  hash TEXT NOT NULL,
  manifest TEXT NOT NULL,
  frontmatter TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skills_name_lc ON skills(name_lc);
CREATE INDEX IF NOT EXISTS skills_id_lc ON skills(id_lc);
CREATE INDEX IF NOT EXISTS skills_source ON skills(source);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL);
${FTS_SCHEMA};
PRAGMA user_version = ${SCHEMA_VERSION};
`;

// A schema-less file (user_version 0, no tables): reindex can fill it.
// Foreign or damaged indexes are never deleted; the user moves them aside.
const foreignMessage = (file: string): string => `${file} is not a supported margrave catalog`;
const unfinishedWriteMessage = (file: string): string =>
  `${file} has an unfinished v0.2.1 write. Restore a complete backup before migrating`;

/** lstat that reads only ENOENT as "not there". Any other error (EACCES, EIO) is reported, never taken as absence. */
export async function lstatIfExists(file: string): Promise<Stats | null> {
  return lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw new MargraveError(`cannot read ${file}: ${err.message}`);
  });
}

/** lstat of index.db: null when missing. Anything that is not a regular file (a planted symlink, a directory) is refused. */
async function statIndexDb(file: string): Promise<Stats | null> {
  const st = await lstatIfExists(file);
  if (st !== null && !st.isFile()) throw new MargraveError(`${file} is not a regular catalog file`);
  return st;
}

/** The guard for a store that has sources: the index must exist. */
function requireCurrentIndex(st: Stats | null): void {
  if (st === null) throw new MargraveError("index.db is missing. Restore the complete store backup");
}

interface OpenOptions {
  readOnly?: boolean;
  readBigInts?: boolean;
  timeout: number;
}

interface Probe {
  version: number;
}

/**
 * Reads the version and schema of an open database. Recognizes empty, legacy, and current catalogs.
 * So is user_version 0 with any schema object: margrave creates its schema in one transaction, so another program wrote it.
 */
function readProbe(db: DatabaseSync, file: string): Probe {
  const counts = db
    .prepare(
      "SELECT (SELECT user_version FROM pragma_user_version) AS user_version, count(*) AS total, count(CASE WHEN type = 'table' AND name IN ('skills', 'fts') THEN 1 END) AS ours, count(CASE WHEN type = 'index' AND tbl_name = 'skills' AND name IN ('skills_name_lc','skills_id_lc','skills_source') THEN 1 END) AS indexes, (SELECT count(*) FROM pragma_table_info('skills') WHERE name IN ('rowid','id','id_lc','name','name_lc','description','source','dir','hash')) AS base_columns, (SELECT count(*) FROM pragma_table_info('skills') WHERE name IN ('manifest','frontmatter')) AS extra_columns, (SELECT count(*) FROM pragma_table_info('fts') WHERE name IN ('name','description','headings','body')) AS fts_columns, count(CASE WHEN type = 'table' AND name = 'fts' AND lower(sql) LIKE '%using fts5%' THEN 1 END) AS fts FROM sqlite_master",
    )
    .get() as {
    user_version: number | bigint;
    total: number | bigint;
    ours: number | bigint;
    indexes: number | bigint;
    base_columns: number | bigint;
    extra_columns: number | bigint;
    fts_columns: number | bigint;
    fts: number | bigint;
  };
  const version = Number(counts.user_version);
  if (version !== 0 && version !== 2 && version !== 3 && version !== SCHEMA_VERSION) throw new MargraveError(foreignMessage(file));
  if (version === 0 && Number(counts.total) > 0) throw new MargraveError(foreignMessage(file));
  if (
    version !== 0 &&
    (Number(counts.ours) !== 2 ||
      Number(counts.indexes) !== 3 ||
      Number(counts.base_columns) !== 9 ||
      Number(counts.fts) !== 1 ||
      Number(counts.fts_columns) !== 4 ||
      Number(counts.extra_columns) !== 2)
  )
    throw new MargraveError(foreignMessage(file));
  if (
    version >= 3 &&
    Number(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sources'").get()?.["n"]) !== 1
  )
    throw new MargraveError(foreignMessage(file));
  return { version };
}

/**
 * Names the SQLite error. NOTADB means "not ours", and 776 means a hot journal. Nothing here leads to a delete.
 */
function openError(file: string, err: unknown, action: "open" | "create"): MargraveError {
  const code = (err as { errcode?: unknown }).errcode;
  if (code === SQLITE_NOTADB) return new MargraveError(foreignMessage(file));
  if (code === SQLITE_READONLY_ROLLBACK) return new MargraveError(unfinishedWriteMessage(file));
  return new MargraveError(`cannot ${action} ${file}: ${(err as Error).message}`);
}

/** Opens a database and probes it. Throws for a file that is not ours and for any other SQLite error. */
function openProbed(file: string, options: OpenOptions): { db: DatabaseSync; probe: Probe } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, options);
    return { db, probe: readProbe(db, file) };
  } catch (err) {
    if (db?.isOpen === true) db.close();
    throw err instanceof MargraveError ? err : openError(file, err, "open");
  }
}

/** Opens a database that must be a complete current margrave index. */
function openCurrent(file: string, options: OpenOptions): DatabaseSync {
  const { db, probe } = openProbed(file, options);
  if (probe.version === SCHEMA_VERSION) return db;
  db.close();
  if (probe.version === 2 || probe.version === 3)
    throw new MargraveError("store upgrade required. Open the store with the current Margrave CLI. See Upgrading in the README.");
  throw new MargraveError(foreignMessage(file));
}

export function catalogSources(db: DatabaseSync): SourceRecord[] {
  const rows = db.prepare("SELECT id, record FROM sources ORDER BY position").all() as { id: string; record: string }[];
  const values: unknown[] = rows.map((row) => JSON.parse(row.record) as unknown);
  if (!values.every(validSource) || values.some((value, index) => value.id !== rows[index]?.id))
    throw new MargraveError("cannot upgrade the v0.2.1 catalog: malformed source records");
  return values;
}

async function pendingCatalogChanged(file: string): Promise<boolean> {
  const markerStat = await lstatIfExists(publishedMarker());
  if (markerStat !== null && !markerStat.isFile()) throw new MargraveError("index.db is missing. Restore the complete store backup");
  const marker = await readIfExists(publishedMarker());
  if (marker === null) return false;
  const match = /^pending (\.catalog-\d+-[0-9a-f]{24}\.tmp)\n$/u.exec(marker);
  const pending = match?.[1];
  const temp = pending === undefined ? null : await lstatIfExists(path.join(home(), pending));
  const ownerFile = pending === undefined ? null : path.join(home(), `${pending}.owner`);
  const ownerStat = ownerFile === null ? null : await lstatIfExists(ownerFile);
  const owner = ownerStat?.isFile() === true ? await readIfExists(ownerFile as string) : null;
  if ((await statIndexDb(file)) !== null) return true;
  if (temp === null || !temp.isFile() || owner !== "margrave-catalog-v1\n") {
    if ((await readIfExists(publishedMarker())) === null) return true;
    throw new MargraveError("index.db is missing. Restore the complete store backup");
  }
  return false;
}

export async function readSources(): Promise<SourceRecord[]> {
  const file = indexDbFile();
  if ((await statIndexDb(file)) === null) {
    if (await pendingCatalogChanged(file)) return readSources();
    if ((await lstatIfExists(sourcesFile())) !== null)
      throw new MargraveError("store upgrade required. Open the store with the current Margrave CLI. See Upgrading in the README.");
    return [];
  }
  const db = await openIndexRead();
  try {
    return catalogSources(db);
  } finally {
    db.close();
  }
}

export function putCatalogSources(db: DatabaseSync, sources: readonly SourceRecord[]): void {
  db.exec("DELETE FROM sources");
  const insert = db.prepare("INSERT INTO sources(id, record, position) VALUES (?, ?, ?)");
  for (const [position, source] of sources.entries()) insert.run(source.id, JSON.stringify(source), position);
}

export async function writerLock(): Promise<DatabaseSync> {
  await mkdir(home(), { recursive: true });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path.join(home(), "writer-lock.db"), { timeout: 0 });
  } catch (err) {
    throw new MargraveError(`cannot complete the store operation: ${(err as Error).message}`);
  }
  const deadline = Date.now() + WRITE_TIMEOUT_MS;
  try {
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        return db;
      } catch (err) {
        if ((err as { errcode?: number }).errcode !== 5) throw err;
        if (Date.now() >= deadline) throw new MargraveError("another Margrave writer holds the store lock. Try the command again");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } catch (err) {
    db.close();
    throw err;
  }
}

async function catalogTempPath(): Promise<string> {
  const file = path.join(home(), `.catalog-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
  const marker = await open(`${file}.owner`, "wx");
  try {
    await marker.writeFile("margrave-catalog-v1\n");
    await marker.sync();
  } finally {
    await marker.close();
  }
  const dir = await open(home(), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  return file;
}

export async function cleanupCatalogTemps(): Promise<void> {
  for (const name of await readdir(home())) {
    if (!/^\.catalog-\d+-[0-9a-f]{24}\.tmp\.owner$/u.test(name)) continue;
    const marker = path.join(home(), name);
    const markerStat = await lstatIfExists(marker);
    if (markerStat === null || !markerStat.isFile() || (await readFile(marker, "utf8")) !== "margrave-catalog-v1\n") continue;
    const file = marker.slice(0, -".owner".length);
    const files = [file, `${file}-journal`, `${file}-wal`, `${file}-shm`];
    const stats = await Promise.all(files.map(lstatIfExists));
    if (stats.some((st) => st !== null && !st.isFile())) continue;
    if ((await readIfExists(publishedMarker())) === `pending ${path.basename(file)}\n` && stats[0] !== null) {
      if ((await statIndexDb(indexDbFile())) !== null) continue;
      await rm(publishedMarker());
      const dir = await open(home(), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    for (const item of files) await rm(item, { force: true });
    await rm(marker);
  }
}

export async function temporaryCatalog(): Promise<{ db: DatabaseSync; file: string }> {
  const active = indexDbFile();
  const existing = await statIndexDb(active);
  if (existing !== null) {
    const checked = openCurrent(active, { readOnly: true, timeout: READ_TIMEOUT_MS });
    checked.close();
  } else await readSources();
  const file = await catalogTempPath();
  let db: DatabaseSync | undefined;
  try {
    if (existing !== null) {
      await copyFile(active, file, 1);
      const checked = openCurrent(file, { readOnly: true, timeout: READ_TIMEOUT_MS });
      checked.close();
    }
    db = new DatabaseSync(file, { readBigInts: true, timeout: READ_TIMEOUT_MS });
    db.exec("PRAGMA journal_mode = DELETE");
    if (existing === null) db.exec(SCHEMA);
    return { db, file };
  } catch (err) {
    db?.close();
    await rm(file, { force: true });
    await rm(`${file}.owner`, { force: true });
    throw err;
  }
}

export async function publishCatalog(file: string): Promise<void> {
  const fh = await open(file, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  if ((await statIndexDb(indexDbFile())) === null) {
    await atomicWrite(publishedMarker(), `pending ${path.basename(file)}\n`);
    const pendingDir = await open(home(), "r");
    try {
      await pendingDir.sync();
    } finally {
      await pendingDir.close();
    }
  }
  await rename(file, indexDbFile());
  const dir = await open(home(), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  await atomicWrite(publishedMarker(), "published\n");
  const markerDir = await open(home(), "r");
  try {
    await markerDir.sync();
  } finally {
    await markerDir.close();
  }
}

export async function openLegacyCatalog(): Promise<{ db: DatabaseSync; version: number } | null> {
  const file = indexDbFile();
  if ((await statIndexDb(file)) === null) return null;
  if ((await lstatIfExists(`${file}-journal`)) !== null)
    throw new MargraveError(`${file} has an unfinished v0.2.1 write. Restore a complete backup before migrating`);
  const opened = openProbed(file, { readOnly: true, timeout: READ_TIMEOUT_MS });
  return { db: opened.db, version: opened.probe.version };
}

export async function probeMigrationCatalog(): Promise<"current" | "missing" | "legacy" | "journal"> {
  const file = indexDbFile();
  if ((await statIndexDb(file)) === null) return "missing";
  const journal = await lstatIfExists(`${file}-journal`);
  let db: DatabaseSync | undefined;
  let state: "current" | "legacy" | "journal";
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
    state = readProbe(db, file).version === SCHEMA_VERSION ? "current" : journal === null ? "legacy" : "journal";
  } catch (err) {
    try {
      if (journal !== null || (await lstatIfExists(`${file}-journal`)) !== null) return "journal";
      throw err instanceof MargraveError ? err : openError(file, err, "open");
    } finally {
      db?.close();
    }
  }
  db.close();
  return state;
}

export async function checkLegacyJournalMode(db: DatabaseSync): Promise<void> {
  const file = indexDbFile();
  const mode = db.prepare("PRAGMA journal_mode").get()?.["journal_mode"];
  if (mode !== "delete" || (await lstatIfExists(`${file}-wal`)) !== null || (await lstatIfExists(`${file}-shm`)) !== null)
    throw new MargraveError(unfinishedWriteMessage(file));
}

/** Hold a shared lock while checking the rollback journal under the SQLite writer lock. */
export async function lockLegacyCatalog(verifiedJournal?: string): Promise<{ db: DatabaseSync; version: number }> {
  const file = indexDbFile();
  const deadline = Date.now() + WRITE_TIMEOUT_MS;
  for (;;) {
    let reader: DatabaseSync | undefined;
    let writer: DatabaseSync | undefined;
    try {
      reader = new DatabaseSync(file, { readOnly: true, timeout: 0 });
      reader.exec("BEGIN");
      reader.prepare("PRAGMA user_version").get();
      await checkLegacyJournalMode(reader);
      const beforeJournal = await lstatIfExists(`${file}-journal`);
      if (beforeJournal !== null && !beforeJournal.isFile()) throw new MargraveError(unfinishedWriteMessage(file));
      writer = new DatabaseSync(file, { readBigInts: true, timeout: 0 });
      writer.exec("BEGIN IMMEDIATE");
      const afterJournal = await lstatIfExists(`${file}-journal`);
      const catalogOwner = (await lstat(file)).uid;
      if (
        afterJournal !== null &&
        (verifiedJournal === undefined ||
          !afterJournal.isFile() ||
          (afterJournal.uid !== process.getuid?.() && afterJournal.uid !== catalogOwner) ||
          (await hashFile(`${file}-journal`)) !== verifiedJournal)
      )
        throw new MargraveError(unfinishedWriteMessage(file));
      const version = readProbe(writer, file).version;
      await checkLegacyJournalMode(writer);
      reader.close();
      writer.exec(`PRAGMA busy_timeout = ${WRITE_TIMEOUT_MS}`);
      return { db: writer, version };
    } catch (err) {
      if (writer?.isOpen === true) writer.close();
      if (reader?.isOpen === true) reader.close();
      const code = (err as { errcode?: number }).errcode;
      if (code === SQLITE_READONLY_ROLLBACK) throw new MargraveError(unfinishedWriteMessage(file));
      if (code !== 5) throw err;
      if (Date.now() >= deadline) throw new MargraveError("another Margrave writer holds the legacy catalog lock. Try the command again");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function copyLegacyCatalog(): Promise<{ db: DatabaseSync; file: string }> {
  const file = await catalogTempPath();
  let db: DatabaseSync | undefined;
  try {
    const original = await lstat(indexDbFile());
    await execFileAsync("/bin/cp", ["-p", indexDbFile(), file]);
    const copied = await lstat(file);
    if (!copied.isFile() || copied.uid !== original.uid || copied.gid !== original.gid || copied.mode !== original.mode)
      throw new Error("catalog copy did not preserve access metadata");
    db = new DatabaseSync(file, { readBigInts: true, timeout: READ_TIMEOUT_MS });
    db.exec("PRAGMA journal_mode = DELETE");
    return { db, file };
  } catch (err) {
    if (db?.isOpen === true) db.close();
    await rm(file, { force: true });
    await rm(`${file}.owner`, { force: true });
    throw err;
  }
}

/**
 * Open index.db for reading: read-only, one connection per call. The caller closes it.
 * Throws a MargraveError for a missing or invalid index.
 */
export async function openIndexRead(): Promise<DatabaseSync> {
  const file = indexDbFile();
  requireCurrentIndex(await statIndexDb(file));
  return openCurrent(file, { readOnly: true, timeout: READ_TIMEOUT_MS });
}

export async function openCatalogReadOptional(): Promise<DatabaseSync | null> {
  const file = indexDbFile();
  if ((await statIndexDb(file)) !== null) return openCurrent(file, { readOnly: true, timeout: READ_TIMEOUT_MS });
  await readSources();
  return (await statIndexDb(file)) === null ? null : openCurrent(file, { readOnly: true, timeout: READ_TIMEOUT_MS });
}

export function deleteAllSkills(db: DatabaseSync): void {
  db.exec("DELETE FROM fts; DELETE FROM skills");
}

export function deleteSourceSkills(db: DatabaseSync, source: string): void {
  db.prepare("DELETE FROM fts WHERE rowid IN (SELECT rowid FROM skills WHERE source = ?)").run(source);
  db.prepare("DELETE FROM skills WHERE source = ?").run(source);
}

/** id -> hash of every skill of one source, read inside the write transaction. */
export function skillHashes(db: DatabaseSync, source: string): Map<string, string> {
  const rows = db.prepare("SELECT id, hash FROM skills WHERE source = ?").all(source) as { id: string; hash: string }[];
  return new Map(rows.map((r) => [r.id, r.hash]));
}

export function insertSkills(db: DatabaseSync, entries: readonly NewEntry[]): void {
  const skill = db.prepare(
    "INSERT INTO skills(id, id_lc, name, name_lc, description, source, dir, hash, manifest, frontmatter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const fts = db.prepare("INSERT INTO fts(rowid, name, description, headings, body) VALUES (?, ?, ?, ?, ?)");
  for (const e of entries) {
    // lastInsertRowid is a bigint on the writer connection (readBigInts); it binds as is.
    const { lastInsertRowid } = skill.run(
      e.id,
      e.id.toLowerCase(),
      e.name,
      e.name.toLowerCase(),
      e.description,
      e.source,
      e.dir,
      e.revision,
      e.manifest,
      e.frontmatter,
    );
    fts.run(lastInsertRowid, e.tokens.name, e.tokens.description, e.tokens.headings, e.tokens.body);
  }
}
