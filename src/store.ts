// The margrave store: MARGRAVE_HOME, sources.json (atomic rename), index.db (SQLite transactions).
import { randomBytes } from "node:crypto";
import { mkdir, open, lstat, readFile, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TokenStrings } from "./bm25.ts";

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

function validSnapshot(v: Record<string, unknown>): boolean {
  if (v["kind"] === "local") return v["snapshot"] === undefined;
  return (
    v["kind"] === "git" &&
    typeof v["snapshot"] === "string" &&
    typeof v["commit"] === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}$/u.test(v["snapshot"]) &&
    v["snapshot"].startsWith(`${v["commit"]}-`)
  );
}

function validSource(v: unknown): v is SourceRecord {
  if (!isRecord(v)) return false;
  if (typeof v["id"] !== "string" || typeof v["spec"] !== "string") return false;
  if (v["kind"] !== "git" && v["kind"] !== "local") return false;
  if (typeof v["subpath"] !== "string") return false;
  if (v["ref"] !== null && typeof v["ref"] !== "string") return false;
  if (v["commit"] !== null && typeof v["commit"] !== "string") return false;
  if (typeof v["installedAt"] !== "string") return false;
  if (!validSnapshot(v)) return false;
  if (v["kind"] === "git")
    return typeof v["url"] === "string" && typeof v["ref"] === "string" && /^refs\/(?:heads|tags)\/.+/u.test(v["ref"]);
  return typeof v["path"] === "string";
}

/** A missing file is an empty list. A malformed file is an error. */
export async function readSources(): Promise<SourceRecord[]> {
  const file = sourcesFile();
  const raw = await readIfExists(file);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MargraveError(`${file} is not valid JSON (${(err as Error).message}); fix or delete it`);
  }
  if (!Array.isArray(parsed) || !parsed.every(validSource)) {
    throw new MargraveError(`${file} is malformed (expected a list of source records); fix or delete it`);
  }
  return parsed;
}

export async function writeSources(sources: readonly SourceRecord[]): Promise<void> {
  await atomicWrite(sourcesFile(), `${JSON.stringify(sources, null, 2)}\n`);
}

// ---- index.db ----

const SCHEMA_VERSION = 2;
const READ_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 30000;
const SQLITE_NOTADB = 26;
const SQLITE_CORRUPT = 11;
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
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='unicode61');
PRAGMA user_version = ${SCHEMA_VERSION};
`;

// A schema-less file (user_version 0, no tables): reindex can fill it.
const invalidMessage = (file: string): string => `${file} is not a valid margrave index; run: margrave reindex`;
// Foreign or damaged indexes are never deleted; the user moves them aside.
const foreignMessage = (file: string): string => `${file} is not a margrave index; move it aside, then run: margrave reindex`;
const unfinishedWriteMessage = (file: string): string =>
  `${file} has an unfinished write from a stopped margrave process; run: margrave reindex`;

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
  if (st !== null && !st.isFile()) throw new MargraveError(`${file} is not a regular file; remove it and run: margrave reindex`);
  return st;
}

/** The guard for a store that has sources: the index must exist. */
function requireCurrentIndex(st: Stats | null): void {
  if (st === null) throw new MargraveError("index.db is missing; run: margrave reindex");
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
 * Reads the version and schema of an open database. Only versions 0 and 2 are recognized.
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
  if (version !== 0 && version !== SCHEMA_VERSION) throw new MargraveError(foreignMessage(file));
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
  return { version };
}

/**
 * Names the SQLite error. Only NOTADB means "not ours", and 776 means a hot journal. A corrupt code can be extended
 * (for example 779), so its low byte is tested. Nothing here leads to a delete.
 */
function openError(file: string, err: unknown, action: "open" | "create"): MargraveError {
  const code = (err as { errcode?: unknown }).errcode;
  if (code === SQLITE_NOTADB) return new MargraveError(foreignMessage(file));
  if (code === SQLITE_READONLY_ROLLBACK) return new MargraveError(unfinishedWriteMessage(file));
  const corrupt = typeof code === "number" && (code & 0xff) === SQLITE_CORRUPT;
  const hint = corrupt ? "; if the file is damaged, move it aside, then run: margrave reindex" : "";
  return new MargraveError(`cannot ${action} ${file}: ${(err as Error).message}${hint}`);
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
  // Version 0 has no schema: reindex can fill it.
  throw new MargraveError(invalidMessage(file));
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

/**
 * Open index.db for writing. The caller closes it. margrave never deletes index.db.
 * "existing": the index must exist and be complete (a store that has sources).
 * "create": a write into a store with no sources. A missing file, or a file with user_version 0 and no
 * tables (including 0 bytes), is initialized in place under the write lock. A file that is not ours is refused.
 */
export async function openIndexWrite(mode: "existing" | "create"): Promise<DatabaseSync> {
  const file = indexDbFile();
  const st = await statIndexDb(file);
  if (mode === "existing") requireCurrentIndex(st);
  // The first open waits as long as a reader would. Then the busy timeout goes up for the write lock.
  const options = { readBigInts: true, timeout: READ_TIMEOUT_MS };
  // requireCurrentIndex() threw for a missing file, so the file is there.
  if (mode === "existing") return setWriterPragmas(openCurrent(file, options));
  let db: DatabaseSync | undefined;
  try {
    await mkdir(home(), { recursive: true });
    const opened = st === null ? null : openProbed(file, options);
    db = setWriterPragmas(opened === null ? new DatabaseSync(file, options) : opened.db);
    // The schema is checked again under the lock: a second creator that waited finds it complete and changes nothing.
    db.exec("BEGIN IMMEDIATE");
    const now = readProbe(db, file);
    if (now.version === 0) db.exec(SCHEMA);
    db.exec("COMMIT");
    return db;
  } catch (err) {
    // Closing the connection rolls back an open transaction. There is none to close when the open itself failed.
    db?.close();
    throw err instanceof MargraveError ? err : openError(file, err, "create");
  }
}

/** cache_spill=OFF keeps the rows in memory, so the exclusive lock is held only during COMMIT. */
function setWriterPragmas(db: DatabaseSync): DatabaseSync {
  db.exec(`PRAGMA cache_spill = OFF; PRAGMA busy_timeout = ${WRITE_TIMEOUT_MS}`);
  return db;
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
