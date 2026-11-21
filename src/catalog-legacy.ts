import { lstat, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  READ_TIMEOUT_MS,
  SCHEMA_VERSION,
  SQLITE_READONLY_ROLLBACK,
  WRITE_TIMEOUT_MS,
  WRITE_TIMEOUT_SQL,
  catalogTempPath,
  openError,
  openProbed,
  readProbe,
  statIndexDb,
  unfinishedWriteMessage,
} from "./catalog.ts";
import { execFileAsync, hashFile } from "./migration-backup.ts";
import { MargraveError, indexDbFile, lstatIfExists } from "./store-files.ts";
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
      writer.exec(WRITE_TIMEOUT_SQL);
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
