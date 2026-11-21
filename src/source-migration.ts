import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gitDir, repairAliases, scanInstalledSource } from "./source-files.ts";
import { parseSpec } from "./source-git.ts";
import type { NewEntry, SourceRecord } from "./store-files.ts";
import { backupMigrationStore, writeMigrationRecord } from "./migration-backup.ts";
import {
  catalogSources,
  cleanupCatalogTemps,
  MIGRATION_COMMIT_SQL,
  MIGRATION_FTS_SQL,
  publishCatalog,
  putCatalogSources,
  readSources,
  SCHEMA_VERSION,
  writerLock,
} from "./catalog.ts";
import {
  checkLegacyJournalMode,
  copyLegacyCatalog,
  lockLegacyCatalog,
  openLegacyCatalog,
  probeMigrationCatalog,
} from "./catalog-legacy.ts";
import { home, indexDbFile, isRecord, lstatIfExists, MargraveError, readLegacySources, sourcesFile } from "./store-files.ts";
import { recoverMigrationRecord } from "./migration-recovery.ts";

async function openMigrationLegacy(state: "legacy" | "journal", journalHash?: string): Promise<{ db: DatabaseSync; version: number }> {
  if (state === "journal") return lockLegacyCatalog(journalHash);
  let legacy: Awaited<ReturnType<typeof openLegacyCatalog>>;
  try {
    legacy = await openLegacyCatalog();
  } catch (err) {
    if ((await lstatIfExists(`${indexDbFile()}-journal`)) === null) throw err;
    return lockLegacyCatalog(journalHash);
  }
  if (legacy === null)
    throw new MargraveError(`cannot upgrade the store because ${indexDbFile()} is missing. Restore the complete v0.2.1 backup`);
  if (legacy.version !== 2) return legacy;
  legacy.db.close();
  return lockLegacyCatalog(journalHash);
}

async function verifyMigrationContents(
  legacy: { db: DatabaseSync; version: number },
  live: DatabaseSync | undefined,
  preparedSources: string | undefined,
): Promise<{ version: number; sources: SourceRecord[]; paths: Map<string, string>; entries: NewEntry[] }> {
  let version: number;
  let sources: SourceRecord[] | undefined;
  let rows: {
    id: string;
    name: string;
    description: string;
    source: string;
    dir: string;
    revision: string;
    manifest: string;
    frontmatter: string;
  }[];
  try {
    if (legacy.version !== 2 && legacy.version !== 3) throw new MargraveError(`${indexDbFile()} is not a supported margrave catalog`);
    version = legacy.version;
    await checkLegacyJournalMode(legacy.db);
    if (version === 3) {
      const records = legacy.db.prepare("SELECT id, record FROM sources").all() as { id: string; record: string }[];
      for (const row of records) {
        const record: unknown = JSON.parse(row.record);
        if (isRecord(record) && Object.hasOwn(record, "selection"))
          throw new MargraveError(
            `cannot upgrade source "${row.id}" because its source record, index, or files disagree. Restore a known-good backup or restore a verified lock into a new MARGRAVE_HOME. See Upgrading in the README.`,
          );
      }
      sources = catalogSources(legacy.db);
    }
    rows = legacy.db
      .prepare("SELECT id, name, description, source, dir, hash AS revision, manifest, frontmatter FROM skills ORDER BY id")
      .all() as typeof rows;
  } finally {
    if (legacy.db !== live) legacy.db.close();
  }
  if (
    version === 2 &&
    (await lstat(sourcesFile()).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    })) === null
  )
    throw new MargraveError(`cannot upgrade the store because ${sourcesFile()} is missing. Restore the complete v0.2.1 backup`);
  if (sources === undefined) {
    try {
      sources = await readLegacySources(preparedSources);
    } catch (err) {
      throw new MargraveError(`cannot upgrade the v0.2.1 catalog: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const ids = new Set<string>();
  const paths = new Map<string, string>();
  const entries: NewEntry[] = [];
  for (const rec of sources) {
    const conflict = (): MargraveError =>
      new MargraveError(
        `cannot upgrade source "${rec.id}" because its source record, index, or files disagree. Restore a known-good backup or restore a verified lock into a new MARGRAVE_HOME. See Upgrading in the README.`,
      );
    try {
      if (ids.has(rec.id)) throw conflict();
      ids.add(rec.id);
      if (rec.kind === "git") {
        const parsed: { kind: "git" | "local"; id?: string; url?: string; subpath?: string } = parseSpec(rec.spec);
        if (parsed.id !== rec.id || parsed.url !== rec.url || parsed.subpath !== rec.subpath) throw conflict();
        const snapshot = gitDir(rec);
        const st = await lstat(snapshot);
        const expected = path.join(await realpath(home()), "snapshots", rec.id, rec.snapshot as string);
        if (!st.isDirectory() || (await realpath(snapshot)) !== expected) throw conflict();
      }
      const scanned = await scanInstalledSource(rec, { log: () => {} });
      const indexed = rows.filter((row) => row.source === rec.id);
      if (indexed.length !== scanned.length) throw conflict();
      for (const entry of scanned) {
        const matches = indexed.some((row) => {
          if (
            row.id !== entry.id ||
            row.revision !== entry.revision ||
            row.manifest !== entry.manifest ||
            row.name !== entry.name ||
            row.description !== entry.description ||
            row.frontmatter !== entry.frontmatter
          )
            return false;
          let indexedDir = row.dir;
          if (rec.kind === "git" && version === 2) {
            const marker = `${path.sep}snapshots${path.sep}${rec.id}${path.sep}${rec.snapshot}`;
            const at = row.dir.lastIndexOf(marker);
            if (!path.isAbsolute(row.dir) || at < 0) return false;
            const suffix = row.dir.slice(at + marker.length);
            if (suffix !== "" && !suffix.startsWith(path.sep)) return false;
            indexedDir = suffix.slice(1);
          }
          return indexedDir === entry.dir;
        });
        if (!matches) throw conflict();
        paths.set(entry.id, entry.dir);
        entries.push(entry);
      }
    } catch {
      throw conflict();
    }
  }
  if (rows.some((row) => !ids.has(row.source)))
    throw new MargraveError("cannot upgrade the v0.2.1 catalog: index contains an unknown source");
  return { version, sources, paths, entries };
}

export async function migrateStore(): Promise<boolean> {
  const first = await probeMigrationCatalog();
  if (first === "current") return false;
  if (first === "missing" && (await lstatIfExists(sourcesFile())) === null) {
    await readSources();
    return false;
  }
  const lock = await writerLock();
  let temp: { db: DatabaseSync; file: string } | undefined;
  let live: DatabaseSync | undefined;
  try {
    const state = await probeMigrationCatalog();
    if (state === "current") return false;
    if (state === "missing") {
      if ((await lstatIfExists(sourcesFile())) !== null)
        throw new MargraveError(`cannot upgrade the store because ${indexDbFile()} is missing. Restore the complete v0.2.1 backup`);
      await readSources();
      return false;
    }
    const prepared = await recoverMigrationRecord();
    live = prepared?.db;
    await cleanupCatalogTemps();
    const legacy = live === undefined ? await openMigrationLegacy(state, prepared?.journalHash) : { db: live, version: 2 };
    if (legacy.version === 2) live = legacy.db;
    if (legacy.version === SCHEMA_VERSION) {
      legacy.db.close();
      return false;
    }
    const { version, sources, paths, entries } = await verifyMigrationContents(legacy, live, prepared?.sources);
    const backup = prepared?.backup ?? (await backupMigrationStore(version as 2 | 3, sources));
    if (version === 2 && prepared === null) await writeMigrationRecord(backup);
    if (version === 2) {
      temp = { db: live!, file: indexDbFile() };
    } else {
      temp = await copyLegacyCatalog();
      temp.db.exec("BEGIN IMMEDIATE");
    }
    if (version === 2) {
      temp.db.exec("CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL)");
      putCatalogSources(temp.db, sources);
    }
    const update = temp.db.prepare("UPDATE skills SET dir = ? WHERE id = ?");
    for (const [id, dir] of paths) update.run(dir, id);
    temp.db.exec(MIGRATION_FTS_SQL);
    const insert = temp.db.prepare(
      "INSERT INTO fts(rowid, name, description, headings, body) SELECT rowid, ?, ?, ?, ? FROM skills WHERE id = ?",
    );
    for (const entry of entries)
      insert.run(entry.tokens.name, entry.tokens.description, entry.tokens.headings, entry.tokens.body, entry.id);
    temp.db.exec(MIGRATION_COMMIT_SQL);
    temp.db.close();
    if (version === 3) await publishCatalog(temp.file);
    await repairAliases(sources, sources);
    process.stderr.write(`margrave: store upgraded. Backup: ${backup}\n`);
    return true;
  } finally {
    try {
      if (temp?.db.isOpen === true) temp.db.close();
      if (temp !== undefined && temp.file !== indexDbFile()) {
        await cleanupCatalogTemps();
      }
      if (live?.isOpen === true) live.close();
    } finally {
      lock.close();
    }
  }
}
