// The margrave store: MARGRAVE_HOME, sources.json (atomic rename), index.db (SQLite transactions).
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, open, lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
export async function readLegacySources(): Promise<SourceRecord[]> {
  const file = sourcesFile();
  const raw = await readIfExists(file);
  if (raw === null) return [];
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
async function lstatIfExists(file: string): Promise<Stats | null> {
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
    throw new MargraveError("store upgrade required. Stop Margrave processes, back up the store, and run: margrave migrate");
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
      throw new MargraveError("store upgrade required. Stop Margrave processes, back up the store, and run: margrave migrate");
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

export async function copyLegacyCatalog(): Promise<{ db: DatabaseSync; file: string }> {
  const file = await catalogTempPath();
  let db: DatabaseSync | undefined;
  try {
    await copyFile(indexDbFile(), file, 1);
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
