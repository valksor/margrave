import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { scanSource } from "./scan.ts";
import { scanInventory, scanWithRipwire } from "./safety.ts";
import type { ScanOutcome } from "./safety.ts";
import { git } from "./source-git.ts";
import { commit, gitDir, logWarnings, ownedStage, resolveScanRoot, selectSkills, syncSnapshot, toEntries } from "./source-files.ts";
import type { Ctx } from "./source-files.ts";
import { MargraveError, atomicWrite, ensureDirs, home, isRecord, validScan, validSelection } from "./store-files.ts";
import { catalogSources, deleteSourceSkills, insertSkills, openCatalogReadOptional } from "./catalog.ts";
import type { NewEntry, SourceRecord } from "./store-files.ts";

import { parseLock, sameInventory, matchesLock, indexedEntries, verifyInstalled } from "./lock-format.ts";
import type { LockFile, LockedSource } from "./lock-format.ts";
export { checkLockUrl, parseLock, readLock, exportLock } from "./lock-format.ts";
export type { LockFile } from "./lock-format.ts";

type PendingRestore = { source: LockedSource; record: SourceRecord; original?: string };
const recoveryIdentity = (rec: SourceRecord, rows: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify([rec, rows]))
    .digest("hex");
const pendingPath = (id: string): string => path.join(home(), "restore-pending", `${id}.json`);

async function readPending(source: LockedSource): Promise<PendingRestore | undefined> {
  let data: string;
  try {
    data = await readFile(pendingPath(source.id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let pending: PendingRestore;
  try {
    const raw: unknown = JSON.parse(data);
    pending = validatePending(raw, source);
  } catch {
    throw new MargraveError(`pending restore record is malformed: ${source.id}`);
  }
  if (JSON.stringify(source) !== JSON.stringify(pending.source))
    throw new MargraveError(`restore is pending for a different lock source: ${source.id}`);
  return pending;
}

function validatePending(raw: unknown, source: LockedSource): PendingRestore {
  if (!isRecord(raw) || !["record,source", "original,record,source"].includes(Object.keys(raw).sort().join(","))) throw new Error();
  if (raw["original"] !== undefined && (typeof raw["original"] !== "string" || !/^[0-9a-f]{64}$/u.test(raw["original"]))) throw new Error();
  const locked = parseLock({
    version: isRecord(raw["source"]) && Object.hasOwn(raw["source"], "selection") ? 2 : 1,
    sources: [raw["source"]],
  }).sources[0];
  const record = raw["record"] as SourceRecord;
  if (
    locked === undefined ||
    locked.id !== source.id ||
    typeof record !== "object" ||
    record === null ||
    ![
      "commit,id,installedAt,kind,ref,snapshot,spec,subpath,url",
      "commit,id,installedAt,kind,ref,scan,snapshot,spec,subpath,url",
      "commit,id,installedAt,kind,ref,scan,selection,snapshot,spec,subpath,url",
      "commit,id,installedAt,kind,ref,selection,snapshot,spec,subpath,url",
    ].includes(Object.keys(record).sort().join(",")) ||
    (record.selection !== undefined && !validSelection(record.selection)) ||
    (record.scan !== undefined && !validScan(record.scan)) ||
    typeof record.installedAt !== "string" ||
    typeof record.snapshot !== "string" ||
    !new RegExp(`^${locked.commit}-[0-9a-f]{16}$`, "u").test(record.snapshot) ||
    !matchesLock(record, locked)
  ) {
    throw new Error();
  }
  return { source: locked, record, ...(typeof raw["original"] === "string" ? { original: raw["original"] } : {}) };
}

async function scanLockedDirectory(
  dir: string,
  source: LockedSource,
  ctx: Ctx,
  prior?: ScanOutcome,
): Promise<{ entries: NewEntry[]; scan: Awaited<ReturnType<typeof scanWithRipwire>> }> {
  const root = await resolveScanRoot(dir, source.subpath);
  const scan = await scanSource(root, { followSymlinks: false, boundary: await realpath(dir), strict: true });
  logWarnings(ctx, scan.warnings);
  if (scan.skills.length === 0) throw new MargraveError(`staged skills differ from the lock: ${source.id}`);
  let accepted: ScanOutcome;
  if (prior?.tree !== undefined && prior.tree !== null && (await scanInventory(root)) !== prior.tree)
    throw new MargraveError(`installed source differs from the lock: ${source.id}`);
  if (prior !== undefined && prior.verdict !== "failed" && prior.tree !== null) {
    accepted = prior;
  } else accepted = await scanWithRipwire(root, { ...ctx, sourceId: source.id, skills: scan.skills, verifyContent: true });
  const checked = await scanSource(root, { followSymlinks: false, boundary: await realpath(dir), strict: true });
  const entries = toEntries(source.id, selectSkills(source.id, scan, source.selection ?? undefined), (d) => d);
  if (accepted.tree !== null && (await scanInventory(root)) !== accepted.tree)
    throw new MargraveError(`installed source differs from the lock: ${source.id}`);
  if (
    JSON.stringify(toEntries(source.id, scan.skills, (d) => d)) !== JSON.stringify(toEntries(source.id, checked.skills, (d) => d)) ||
    JSON.stringify(scan.duplicates) !== JSON.stringify(checked.duplicates)
  )
    throw new MargraveError(`staged skills differ from the lock: ${source.id}`);
  if (!sameInventory(entries, source)) throw new MargraveError(`staged skills differ from the lock: ${source.id}`);
  return { entries, scan: accepted };
}

interface RestorePlan {
  dir: string | null;
  record: SourceRecord;
  entries: NewEntry[];
  marker: PendingRestore | undefined;
  verified: boolean;
  indexed: string;
  original?: SourceRecord;
}

async function stageLockedCommit(
  source: LockedSource,
  stage: string,
  ctx: Ctx,
  prior?: ScanOutcome,
): Promise<{ dir: string; entries: NewEntry[]; scan: Awaited<ReturnType<typeof scanWithRipwire>> }> {
  const clone = path.join(stage, source.id);
  try {
    await git(["init", "--quiet", ...(source.commit.length === 64 ? ["--object-format=sha256"] : []), clone]);
    await git(["-C", clone, "remote", "add", "origin", source.url]);
    await git(["-C", clone, "fetch", "--depth", "1", "origin", source.commit]);
    await git(["-C", clone, "checkout", "--detach", "FETCH_HEAD"]);
    if ((await git(["-C", clone, "rev-parse", "HEAD"])).trim() !== source.commit) throw new Error();
  } catch {
    throw new MargraveError(`locked commit is unavailable for ${source.id}; restore a known-good backup`);
  }
  await rm(path.join(clone, ".git"), { recursive: true, force: true });
  return { dir: clone, ...(await scanLockedDirectory(clone, source, ctx, prior)) };
}

function verifyStagedRows(source: LockedSource, staged: { dir: string; entries: NewEntry[] }, indexed: string): void {
  const rows = staged.entries
    .map(({ id, revision, manifest, dir }) => ({ id, revision, manifest, dir: path.relative(staged.dir, dir) }))
    .sort((a, b) => Number(a.id > b.id) - Number(a.id < b.id));
  if (JSON.stringify(rows) !== indexed) throw new MargraveError(`installed source differs from the lock: ${source.id}`);
}

async function preflightPending(
  source: LockedSource,
  marker: PendingRestore,
  rec: SourceRecord | undefined,
  db: DatabaseSync | null,
  stage: string,
  ctx: Ctx,
): Promise<RestorePlan | undefined> {
  const destination = gitDir(marker.record);
  const exists = await lstat(destination).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  const originalMatches =
    rec !== undefined &&
    db !== null &&
    marker.original !== undefined &&
    recoveryIdentity(rec, indexedEntries(db, source.id)) === marker.original;
  if (marker.original !== undefined && rec === undefined) throw new MargraveError(`installed source differs from the lock: ${source.id}`);
  if (rec !== undefined && (!matchesLock(rec, source) || (rec.snapshot !== marker.record.snapshot && !originalMatches)))
    throw new MargraveError(`installed source differs from the lock: ${source.id}`);
  if (exists !== null) {
    if (!exists.isDirectory() || exists.isSymbolicLink()) throw new MargraveError(`pending restore record is malformed: ${source.id}`);
    const { entries } = await scanLockedDirectory(destination, source, ctx, marker.record.scan);
    let verified = false;
    if (rec !== undefined && db !== null && rec.snapshot === marker.record.snapshot) {
      try {
        await verifyInstalled(rec, source, db);
        verified = true;
      } catch {
        /* A pending publication can have incomplete index rows. */
      }
    }
    if (originalMatches && db !== null) {
      verifyStagedRows(source, { dir: destination, entries }, JSON.stringify(indexedEntries(db, source.id)));
    }
    return {
      dir: destination,
      record: marker.record,
      entries,
      marker,
      verified,
      indexed: JSON.stringify(db === null ? [] : indexedEntries(db, source.id)),
      ...(originalMatches ? { original: rec } : {}),
    };
  }
  if (rec !== undefined && !originalMatches) throw new MargraveError(`installed source differs from the lock: ${source.id}`);
  if (originalMatches && db !== null) {
    const staged = await stageLockedCommit(source, stage, ctx, marker.record.scan);
    const indexed = JSON.stringify(indexedEntries(db, source.id));
    verifyStagedRows(source, staged, indexed);
    return { dir: staged.dir, entries: staged.entries, record: marker.record, marker, verified: false, indexed, original: rec };
  }
  return undefined;
}

async function preflightInstalled(
  source: LockedSource,
  rec: SourceRecord,
  db: DatabaseSync,
  stage: string,
  ctx: Ctx,
): Promise<RestorePlan> {
  if (!matchesLock(rec, source) || !sameInventory(indexedEntries(db, source.id), source))
    throw new MargraveError(`installed source differs from the lock: ${source.id}`);
  const indexed = JSON.stringify(indexedEntries(db, source.id));
  try {
    await verifyInstalled(rec, source, db);
    return { dir: null, record: rec, entries: [], marker: undefined, verified: true, indexed };
  } catch {
    const staged = await stageLockedCommit(source, stage, ctx, rec.scan);
    verifyStagedRows(source, staged, indexed);
    return {
      dir: staged.dir,
      entries: staged.entries,
      record: { ...rec, snapshot: `${source.commit}-${randomBytes(8).toString("hex")}`, scan: staged.scan },
      marker: undefined,
      verified: false,
      indexed,
      original: rec,
    };
  }
}

async function preflightSource(
  source: LockedSource,
  marker: PendingRestore | undefined,
  rec: SourceRecord | undefined,
  db: DatabaseSync | null,
  stage: string,
  ctx: Ctx,
): Promise<RestorePlan> {
  if (marker !== undefined) {
    const pending = await preflightPending(source, marker, rec, db, stage, ctx);
    if (pending !== undefined) return pending;
  } else if (rec !== undefined && db !== null) return preflightInstalled(source, rec, db, stage, ctx);
  const staged = await stageLockedCommit(source, stage, ctx, marker?.record.scan);
  const record: SourceRecord = marker?.record ?? {
    id: source.id,
    kind: "git",
    spec: source.spec,
    url: source.url,
    subpath: source.subpath,
    ref: source.ref,
    commit: source.commit,
    snapshot: `${source.commit}-${randomBytes(8).toString("hex")}`,
    installedAt: new Date().toISOString(),
    scan: staged.scan,
    ...(source.selection == null ? {} : { selection: source.selection }),
  };
  return { ...staged, record, marker, verified: false, indexed: "" };
}

async function checkPublication(source: LockedSource, plan: RestorePlan, fresh: SourceRecord[], writer: DatabaseSync): Promise<void> {
  const currentMarker = await readPending(source);
  if (JSON.stringify(currentMarker) !== JSON.stringify(plan.marker))
    throw new MargraveError(`restore is pending for a different lock source: ${source.id}`);
  const current = fresh.find((s) => s.id === source.id);
  const sameRows = (): boolean => JSON.stringify(indexedEntries(writer, source.id)) === plan.indexed;
  if (plan.verified && (current === undefined || JSON.stringify(current) !== JSON.stringify(plan.record) || !sameRows()))
    throw new MargraveError(`installed source differs from the lock: ${source.id}`);
  if (plan.original !== undefined && (JSON.stringify(current) !== JSON.stringify(plan.original) || !sameRows()))
    throw new MargraveError(`installed source differs from the lock: ${source.id}`);
  if (
    !plan.verified &&
    current !== undefined &&
    plan.original === undefined &&
    (plan.marker === undefined || !matchesLock(current, source) || current.snapshot !== plan.record.snapshot)
  )
    throw new MargraveError(`installed source differs from the lock: ${source.id}`);
}

function markerFor(source: LockedSource, plan: RestorePlan): PendingRestore {
  return {
    source,
    record: plan.record,
    ...(plan.original === undefined ? {} : { original: recoveryIdentity(plan.original, JSON.parse(plan.indexed) as unknown) }),
  };
}

async function publishSource(source: LockedSource, plan: RestorePlan): Promise<void> {
  const destination = gitDir(plan.record);
  await commit(async (fresh, writer) => {
    await checkPublication(source, plan, fresh, writer);
    if (plan.verified) return undefined;
    if (plan.marker === undefined) await atomicWrite(pendingPath(source.id), `${JSON.stringify(markerFor(source, plan), null, 2)}\n`);
    if (plan.dir !== destination) {
      await mkdir(path.dirname(destination), { recursive: true });
      if (
        (await lstat(destination).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return null;
          throw err;
        })) !== null
      ) {
        throw new MargraveError(`pending restore record is malformed: ${source.id}`);
      }
      await rename(plan.dir as string, destination);
    }
    await syncSnapshot(destination);
    const entries = plan.entries.map((entry) => ({ ...entry, dir: path.relative(plan.dir as string, entry.dir) }));
    deleteSourceSkills(writer, source.id);
    insertSkills(writer, entries);
    return [...fresh.filter((s) => s.id !== source.id), plan.record];
  });
}

async function clearMarker(source: LockedSource, expected: PendingRestore): Promise<void> {
  let removed = false;
  await commit(
    async () => {
      const marker = await readPending(source);
      if (JSON.stringify(marker) !== JSON.stringify(expected))
        throw new MargraveError(`restore is pending for a different lock source: ${source.id}`);
      await rm(pendingPath(source.id));
      removed = true;
      return undefined;
    },
    async () => {
      if (removed) await atomicWrite(pendingPath(source.id), `${JSON.stringify(expected, null, 2)}\n`);
    },
  );
}

export async function restoreLock(lock: LockFile, ctx: Ctx, report: (line: string) => void): Promise<void> {
  const pending = new Map<string, PendingRestore | undefined>();
  for (const source of lock.sources) pending.set(source.id, await readPending(source));
  if (lock.sources.length === 0) return;
  await ensureDirs();
  const stage = await ownedStage("restore-");
  let completed = 0;
  try {
    const plans = new Map<string, RestorePlan>();
    const db = await openCatalogReadOptional();
    try {
      const initial = db === null ? [] : catalogSources(db);
      for (const source of lock.sources) {
        plans.set(
          source.id,
          await preflightSource(
            source,
            pending.get(source.id),
            initial.find((s) => s.id === source.id),
            db,
            stage.dir,
            ctx,
          ),
        );
      }
    } finally {
      db?.close();
    }
    for (const source of lock.sources) {
      const plan = plans.get(source.id) as RestorePlan;
      await publishSource(source, plan);
      report(`${plan.verified ? "already restored" : "restored"} ${source.id}`);
      completed++;
      if (plan.marker !== undefined || !plan.verified) await clearMarker(source, plan.marker ?? markerFor(source, plan));
    }
  } catch (err) {
    if (completed > 0) throw new MargraveError(`restore partially completed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    await stage.close();
  }
}
