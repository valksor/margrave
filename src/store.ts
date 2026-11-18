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
}

export interface IndexEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  dir: string;
  /** Hash of SKILL.md, used by `update` to report changed skills. */
  hash: string;
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
const legacyIndexFile = (): string => path.join(home(), "index.json");

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validSource(v: unknown): v is SourceRecord {
  if (!isRecord(v)) return false;
  if (typeof v["id"] !== "string" || typeof v["spec"] !== "string") return false;
  if (v["kind"] !== "git" && v["kind"] !== "local") return false;
  if (typeof v["subpath"] !== "string") return false;
  if (v["ref"] !== null && typeof v["ref"] !== "string") return false;
  if (v["commit"] !== null && typeof v["commit"] !== "string") return false;
  if (typeof v["installedAt"] !== "string") return false;
  if (v["kind"] === "git") return typeof v["url"] === "string";
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

const SCHEMA_VERSION = 1;
const READ_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 30000;
const SQLITE_NOTADB = 26;

const SCHEMA = `
BEGIN;
CREATE TABLE skills(
  rowid INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  id_lc TEXT NOT NULL,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  dir TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX skills_name_lc ON skills(name_lc);
CREATE INDEX skills_id_lc ON skills(id_lc);
CREATE INDEX skills_source ON skills(source);
CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='unicode61');
PRAGMA user_version = ${SCHEMA_VERSION};
COMMIT;
`;

const legacyMessage = (): string => "index.json is from an older margrave; run: margrave reindex";
const invalidMessage = (file: string): string => `${file} is not a valid margrave index; run: margrave reindex`;

/** lstat of index.db: null when missing. Anything that is not a regular file (a planted symlink, a directory) is refused. */
async function statIndexDb(file: string): Promise<Stats | null> {
  const st = await lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw new MargraveError(`cannot read ${file}: ${err.message}`);
  });
  if (st !== null && !st.isFile()) throw new MargraveError(`${file} is not a regular file; remove it and run: margrave reindex`);
  return st;
}

/** The guard for a store that has sources: the index must exist and must not be older than a legacy index.json. */
async function requireCurrentIndex(file: string, st: Stats | null): Promise<void> {
  const legacy = await lstat(legacyIndexFile()).catch(() => null);
  if (st === null) {
    throw new MargraveError(legacy === null ? "index.db is missing; run: margrave reindex" : legacyMessage());
  }
  // An older margrave wrote index.json after the upgrade: its skills are not in index.db.
  if (legacy !== null && legacy.mtimeMs > st.mtimeMs) throw new MargraveError(legacyMessage());
}

/** Only these cases count as an invalid index. Any other SQLite error (busy, I/O, permissions) must never lead to a delete. */
function isNotADb(err: unknown): boolean {
  return (err as { errcode?: unknown }).errcode === SQLITE_NOTADB;
}

/** Opens and checks a database. Returns null when it is not a valid margrave index (NOTADB, wrong user_version, no schema). */
function openChecked(file: string, options: { readOnly?: boolean; readBigInts?: boolean; timeout: number }): DatabaseSync | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, options);
    const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number | bigint }).user_version);
    const tables = Number(
      (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('skills', 'fts')").get() as { n: number | bigint }).n,
    );
    if (version === SCHEMA_VERSION && tables === 2) return db;
    db.close();
    return null;
  } catch (err) {
    if (db?.isOpen === true) db.close();
    if (isNotADb(err)) return null;
    throw new MargraveError(`cannot open ${file}: ${(err as Error).message}`);
  }
}

/**
 * Open index.db for reading: read-only, one connection per call. The caller closes it.
 * Throws a MargraveError for a missing, legacy, or invalid index.
 */
export async function openIndexRead(): Promise<DatabaseSync> {
  const file = indexDbFile();
  await requireCurrentIndex(file, await statIndexDb(file));
  const db = openChecked(file, { readOnly: true, timeout: READ_TIMEOUT_MS });
  if (db === null) throw new MargraveError(invalidMessage(file));
  return db;
}

/**
 * Open index.db for writing. The caller closes it.
 * "existing": the index must exist and be valid (a store that has sources).
 * "create": a missing or invalid index is replaced by a fresh schema (reindex, or a write into a store with no sources).
 */
export async function openIndexWrite(mode: "existing" | "create"): Promise<DatabaseSync> {
  const file = indexDbFile();
  const st = await statIndexDb(file);
  if (mode === "existing") await requireCurrentIndex(file, st);
  // The first open waits as long as a reader would. Then the busy timeout goes up for the write lock.
  const options = { readBigInts: true, timeout: READ_TIMEOUT_MS };
  let db = st === null ? null : openChecked(file, options);
  if (db === null) {
    if (mode === "existing") throw new MargraveError(invalidMessage(file));
    await rm(file, { force: true });
    await rm(`${file}-journal`, { force: true });
    let created: DatabaseSync | undefined;
    try {
      created = new DatabaseSync(file, options);
      created.exec(SCHEMA);
    } catch (err) {
      created?.close();
      throw new MargraveError(`cannot create ${file}: ${(err as Error).message}`);
    }
    db = created;
  }
  // cache_spill=OFF keeps the rows in memory, so the exclusive lock is held only during COMMIT.
  db.exec(`PRAGMA cache_spill = OFF; PRAGMA busy_timeout = ${WRITE_TIMEOUT_MS}`);
  return db;
}

/** Remove a legacy index.json. Called after a reindex COMMIT. */
export async function removeLegacyIndex(): Promise<void> {
  await rm(legacyIndexFile(), { force: true });
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
  const skill = db.prepare("INSERT INTO skills(id, id_lc, name, name_lc, description, source, dir, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const fts = db.prepare("INSERT INTO fts(rowid, name, description, headings, body) VALUES (?, ?, ?, ?, ?)");
  for (const e of entries) {
    // lastInsertRowid is a bigint on the writer connection (readBigInts); it binds as is.
    const { lastInsertRowid } = skill.run(e.id, e.id.toLowerCase(), e.name, e.name.toLowerCase(), e.description, e.source, e.dir, e.hash);
    fts.run(lastInsertRowid, e.tokens.name, e.tokens.description, e.tokens.headings, e.tokens.body);
  }
}
