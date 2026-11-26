import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Stats } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { text } from "node:stream/consumers";
import { checkLegacyJournalMode } from "./catalog-legacy.ts";
import { WRITE_TIMEOUT_MS, readProbe } from "./catalog.ts";
import type { MigrationRecord } from "./migration-backup.ts";
import {
  execFileAsync,
  hashFile,
  hashLiveCatalog,
  migrationRecordSchema,
  sameFileIdentity,
  sha256,
  verifyBackupFiles,
} from "./migration-backup.ts";
import { MargraveError, home, indexDbFile, isRecord, lstatIfExists, readIfExists, sourcesFile } from "./store-files.ts";
function recoveryVerificationError(subject: string): MargraveError {
  return new MargraveError(`cannot verify ${subject}. Restore a complete backup. See Upgrading in the README.`);
}

function invalidRecovery(store: string): MargraveError {
  return recoveryVerificationError(`the interrupted Margrave upgrade at ${store}`);
}

function preparedMarker(raw: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(String(raw));
    return isRecord(value) && value["kind"] === "margrave-store-migration" ? value : null;
  } catch {
    return null;
  }
}

function journalOwnerMatches(uid: number, owner: number, catalog: { uid: bigint }): boolean {
  return uid === owner || BigInt(uid) === catalog.uid;
}

async function isVerifiedJournal(
  stat: Stats,
  expectedHash: string,
  journal: string,
  owner: number,
  catalog: { uid: bigint },
): Promise<boolean> {
  return stat.isFile() && journalOwnerMatches(stat.uid, owner, catalog) && (await hashFile(journal)) === expectedHash;
}

async function extractBackupMember(archive: string, member: "./index.db" | "./sources.json", destination: string): Promise<void> {
  const output = await open(destination, "wx", 0o600);
  try {
    const child = spawn("/usr/bin/tar", ["-xOf", archive, member], {
      stdio: ["ignore", output.fd, "pipe"],
      env: { ...process.env, TAR_OPTIONS: undefined },
    });
    const [[code], stderr] = await Promise.all([once(child, "close") as Promise<[number | null]>, text(child.stderr!)]);
    if (code !== 0) throw new Error(stderr);
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
  const journalError = (): MargraveError => recoveryVerificationError(`the Margrave upgrade journal at ${journal}`);
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
      !sameFileIdentity(locked, catalog) ||
      (await hashLiveCatalog(file)) !== expectedHash ||
      (afterJournal !== null &&
        (journalHash === undefined || !(await isVerifiedJournal(afterJournal, journalHash, journal, owner, catalog))))
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
): Promise<{ journalHash: string | undefined; db: DatabaseSync | undefined }> {
  const journalError = (): MargraveError => recoveryVerificationError(`the Margrave upgrade journal at ${indexDbFile()}-journal`);
  let held: DatabaseSync | undefined;
  const journal = `${indexDbFile()}-journal`;
  const journalStat = await lstatIfExists(journal);
  let verifiedJournal: string | undefined;
  if (journalStat !== null) {
    try {
      if (!journalStat.isFile() || journalStat.size < 28 || !journalOwnerMatches(journalStat.uid, owner, catalog)) throw journalError();
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
        !sameFileIdentity(current, catalog) ||
        (remaining === null
          ? currentHash !== record.indexSha256
          : currentHash !== liveHash || !(await isVerifiedJournal(remaining, journalHash, journal, owner, catalog)))
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
      if (!sameFileIdentity(current, catalog) || (await hashFile(indexDbFile())) !== record.indexSha256) throw journalError();
      held = await lockRecoveredCatalog(catalog, record.indexSha256, undefined, owner);
    }
  } else if ((await hashFile(indexDbFile())) !== record.indexSha256) throw invalidRecovery(record.store);
  return { journalHash: verifiedJournal, db: held };
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
  if (sourceStat !== null && !sourceStat.isFile()) throw invalidRecovery(store);
  let raw: string | null;
  try {
    raw = await readIfExists(sourcesFile());
  } catch (err) {
    throw new MargraveError(`cannot upgrade the v0.2.1 catalog: ${err instanceof Error ? err.message : String(err)}`);
  }
  const value = preparedMarker(raw);
  if (value === null) return null;
  const invalid = (): MargraveError => invalidRecovery(store);
  const normalize = (err: unknown): MargraveError => (err instanceof MargraveError ? err : invalid());
  const parsed = migrationRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.store !== store) throw invalid();
  const record = parsed.data;
  const backup = path.join(path.dirname(store), record.backup);
  let scratch: string | undefined;
  let held: DatabaseSync | undefined;
  try {
    scratch = await mkdtemp(path.join(path.dirname(store), ".margrave-upgrade-tmp-"));
    if (process.platform === "darwin") await execFileAsync("/bin/chmod", ["-N", scratch]);
    const catalog = await lstat(indexDbFile(), { bigint: true });
    if (!catalog.isFile() || catalog.dev.toString() !== record.catalogDevice || catalog.ino.toString() !== record.catalogInode)
      throw invalid();
    const archive = path.join(scratch, "store.tar");
    const checked = await verifyBackupFiles(backup, archive);
    // A missing manifest destructures to a TypeError below, which the catch normalizes to invalidRecovery.
    const { manifest, owner } = checked!;
    if (
      manifest.store !== store ||
      manifest.from !== 2 ||
      manifest.indexSha256 !== record.indexSha256 ||
      manifest.sourcesSha256 !== record.sourcesSha256
    )
      throw invalid();
    const key = sha256(JSON.stringify([store, 2, record.indexSha256, record.sourcesSha256, manifest.inventorySha256]));
    if (!record.backup.startsWith(`.margrave-upgrade-v2-${key}-`)) throw invalid();
    await extractBackupMember(archive, "./index.db", path.join(scratch, "original.db"));
    await extractBackupMember(archive, "./sources.json", path.join(scratch, "sources.json"));
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
      throw normalize(err);
    } finally {
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    }
  }
}
