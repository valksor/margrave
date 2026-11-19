import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { scanSource } from "./scan.ts";
import { scanWithRipwire } from "./safety.ts";
import {
  commit,
  git,
  gitDir,
  installMode,
  logWarnings,
  parseSpec,
  qualifiedRef,
  resolveScanRoot,
  scanInstalledSource,
  sourceDir,
  switchAlias,
  toEntries,
  trackingRef,
} from "./sources.ts";
import type { Ctx } from "./sources.ts";
import {
  MargraveError,
  atomicWrite,
  deleteSourceSkills,
  ensureDirs,
  home,
  insertSkills,
  isRecord,
  openIndexRead,
  openIndexWrite,
  readSources,
  stagingRoot,
} from "./store.ts";
import type { NewEntry, SourceRecord } from "./store.ts";

export interface LockedSkill {
  id: string;
  revision: string;
}
export interface LockedSource {
  spec: string;
  id: string;
  url: string;
  subpath: string;
  ref: string;
  commit: string;
  skills: LockedSkill[];
}
export interface LockFile {
  version: 1;
  sources: LockedSource[];
}

const malformed = (): never => {
  throw new MargraveError("lock file is malformed");
};
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).sort().join(",") === expected.sort().join(",");
const digest = (s: string): boolean => /^sha256:[0-9a-f]{64}$/u.test(s);
const commitHash = (s: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(s);
const refValid = (s: string): boolean =>
  /^refs\/(heads|tags)\/.+/u.test(s) &&
  !s.split("").some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || "~^:?*[\\".includes(char)) &&
  !s.includes("..") &&
  !s.includes("@{") &&
  !s.includes("//") &&
  !s.endsWith("/") &&
  !s.endsWith(".") &&
  s.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));

export function checkLockUrl(value: string): void {
  if (/^https:\/\//iu.test(value)) {
    const authority = value.slice(8).split(/[/?#]/u, 1)[0] ?? "";
    let credentials = false;
    try {
      const url = new URL(value);
      credentials = url.username !== "" || url.password !== "";
    } catch {
      /* Identity validation handles malformed URLs. */
    }
    if (credentials || authority.includes("@") || value.includes("?") || value.includes("#"))
      throw new MargraveError("lock source URL must not contain credentials, a query, or a fragment");
  }
}

export function parseLock(value: unknown): LockFile {
  if (!isRecord(value) || !keys(value, ["version", "sources"]) || value["version"] !== 1 || !Array.isArray(value["sources"]))
    return malformed();
  // Check every URL first so no identity error can expose credentials.
  for (const source of value["sources"])
    if (isRecord(source)) {
      if (typeof source["spec"] === "string") checkLockUrl(source["spec"]);
      if (typeof source["url"] === "string") checkLockUrl(source["url"]);
    }
  const sources: LockedSource[] = [];
  const ids = new Set<string>();
  for (const source of value["sources"]) {
    if (!isRecord(source) || !keys(source, ["spec", "id", "url", "subpath", "ref", "commit", "skills"])) return malformed();
    const { spec, id, url, subpath, ref, commit: lockedCommit, skills } = source;
    if (
      typeof spec !== "string" ||
      typeof id !== "string" ||
      typeof url !== "string" ||
      typeof subpath !== "string" ||
      typeof ref !== "string" ||
      typeof lockedCommit !== "string" ||
      !Array.isArray(skills) ||
      !refValid(ref) ||
      !commitHash(lockedCommit) ||
      ids.has(id)
    )
      return malformed();
    let parsed;
    try {
      parsed = parseSpec(spec);
    } catch {
      throw new MargraveError("lock source does not match its install spec");
    }
    if (parsed.kind !== "git" || parsed.id !== id || parsed.url !== url || parsed.subpath !== subpath)
      throw new MargraveError("lock source does not match its install spec");
    ids.add(id);
    const entries: LockedSkill[] = [];
    const skillIds = new Set<string>();
    for (const skill of skills) {
      if (
        !isRecord(skill) ||
        !keys(skill, ["id", "revision"]) ||
        typeof skill["id"] !== "string" ||
        !skill["id"].startsWith(`${id}/`) ||
        skill["id"].slice(id.length + 1).includes("/") ||
        skill["id"].length === id.length + 1 ||
        typeof skill["revision"] !== "string" ||
        !digest(skill["revision"]) ||
        skillIds.has(skill["id"])
      )
        return malformed();
      skillIds.add(skill["id"]);
      entries.push({ id: skill["id"], revision: skill["revision"] });
    }
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    sources.push({ spec, id, url, subpath, ref, commit: lockedCommit, skills: entries });
  }
  sources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: 1, sources };
}

export async function readLock(file: string): Promise<LockFile> {
  const data = await readFile(file, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return malformed();
  }
  return parseLock(value);
}

// ---- lock export and restore ----

function lockInventory(entries: readonly { id: string; revision: string }[]): { id: string; revision: string }[] {
  return entries.map(({ id, revision }) => ({ id, revision })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sameInventory(entries: readonly { id: string; revision: string }[], locked: LockedSource): boolean {
  return JSON.stringify(lockInventory(entries)) === JSON.stringify(locked.skills);
}

function matchesLock(rec: SourceRecord, locked: LockedSource): boolean {
  return (
    rec.kind === "git" &&
    rec.id === locked.id &&
    rec.spec === locked.spec &&
    rec.url === locked.url &&
    rec.subpath === locked.subpath &&
    rec.ref === locked.ref &&
    rec.commit === locked.commit
  );
}

function indexedEntries(db: DatabaseSync, id: string): { id: string; revision: string; manifest: string; dir: string }[] {
  return db.prepare("SELECT id, hash AS revision, manifest, dir FROM skills WHERE source = ? ORDER BY id").all(id) as {
    id: string;
    revision: string;
    manifest: string;
    dir: string;
  }[];
}

async function verifyInstalled(rec: SourceRecord, locked: LockedSource, db: DatabaseSync): Promise<void> {
  try {
    if (!matchesLock(rec, locked)) throw new Error();
    const scanned = await scanInstalledSource(rec, { log: () => {}, allowUnsafe: false });
    const indexed = indexedEntries(db, rec.id);
    if (!sameInventory(scanned, locked) || !sameInventory(indexed, locked)) throw new Error();
    const manifests = new Map(indexed.map((e) => [e.id, JSON.stringify([e.manifest, e.dir])]));
    if (scanned.some((e) => manifests.get(e.id) !== JSON.stringify([e.manifest, e.dir]))) throw new Error();
  } catch {
    throw new MargraveError(`installed source differs from the lock: ${locked.id}`);
  }
}

export async function exportLock(selected: string[]): Promise<LockFile> {
  const sources = await readSources();
  if (selected.length === 0 && sources.some((s) => s.kind !== "git"))
    throw new MargraveError("select Git sources with --source when the store contains local directories");
  const targets =
    selected.length === 0
      ? sources
      : selected.map((id) => {
          const source = sources.find((s) => s.id === id && s.kind === "git");
          if (source === undefined) throw new MargraveError("--source must be an installed Git source ID");
          return source;
        });
  for (const rec of targets) {
    checkLockUrl(rec.spec);
    checkLockUrl(rec.url as string);
  }
  if (targets.length === 0) return { version: 1, sources: [] };
  const db = await openIndexRead();
  try {
    const locked: LockedSource[] = [];
    for (const rec of targets) {
      const ref = rec.ref !== null && qualifiedRef(rec.ref) ? rec.ref : (await trackingRef(rec, true)).ref;
      locked.push({
        spec: rec.spec,
        id: rec.id,
        url: rec.url as string,
        subpath: rec.subpath,
        ref,
        commit: rec.commit as string,
        skills: lockInventory(indexedEntries(db, rec.id)),
      });
    }
    return parseLock({ version: 1, sources: locked });
  } finally {
    db.close();
  }
}

type PendingRestore = { source: LockedSource; record: SourceRecord };
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
    if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== "record,source") throw new Error();
    const locked = parseLock({ version: 1, sources: [raw["source"]] }).sources[0];
    const record = raw["record"] as SourceRecord;
    if (
      locked === undefined ||
      locked.id !== source.id ||
      typeof record !== "object" ||
      record === null ||
      Object.keys(record).sort().join(",") !== "commit,id,installedAt,kind,ref,snapshot,spec,subpath,url" ||
      typeof record.installedAt !== "string" ||
      typeof record.snapshot !== "string" ||
      !new RegExp(`^${locked.commit}-[0-9a-f]{16}$`, "u").test(record.snapshot) ||
      !matchesLock(record, locked)
    )
      throw new Error();
    pending = { source: locked, record };
  } catch {
    throw new MargraveError(`pending restore record is malformed: ${source.id}`);
  }
  if (JSON.stringify(source) !== JSON.stringify(pending.source))
    throw new MargraveError(`restore is pending for a different lock source: ${source.id}`);
  return pending;
}

async function scanLockedDirectory(dir: string, source: LockedSource, ctx: Ctx): Promise<NewEntry[]> {
  const root = await resolveScanRoot(dir, source.subpath);
  const scan = await scanSource(root, { followSymlinks: false, boundary: await realpath(dir), strict: true });
  logWarnings(ctx, scan.warnings);
  if (scan.skills.length === 0) throw new MargraveError(`staged skills differ from the lock: ${source.id}`);
  await scanWithRipwire(root, { ...ctx, sourceId: source.id, skills: scan.skills });
  const entries = toEntries(source.id, scan.skills, (d) => d);
  if (!sameInventory(entries, source)) throw new MargraveError(`staged skills differ from the lock: ${source.id}`);
  return entries;
}

async function ensureRestoreAlias(rec: SourceRecord, destination: string): Promise<void> {
  const alias = sourceDir(rec.id);
  const existing = await lstat(alias).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (rec.snapshot === undefined) {
    if (existing?.isDirectory()) return;
    throw new MargraveError(`installed source differs from the lock: ${rec.id}`);
  }
  if (existing === null) {
    await switchAlias(rec.id, null, destination);
    return;
  }
  if (!existing.isSymbolicLink() || (await readlink(alias)) !== path.relative(path.dirname(alias), destination))
    throw new MargraveError(`installed source differs from the lock: ${rec.id}`);
}

interface RestorePlan {
  dir: string | null;
  record: SourceRecord;
  entries: NewEntry[];
  marker: PendingRestore | undefined;
  verified: boolean;
  indexed: string;
}

async function stageLockedCommit(source: LockedSource, stage: string, ctx: Ctx): Promise<{ dir: string; entries: NewEntry[] }> {
  const clone = path.join(stage, source.id);
  try {
    await git(["init", "--quiet", ...(source.commit.length === 64 ? ["--object-format=sha256"] : []), clone]);
    await git(["-C", clone, "remote", "add", "origin", source.url]);
    await git(["-C", clone, "fetch", "--depth", "1", "origin", source.commit]);
    await git(["-C", clone, "checkout", "--detach", "FETCH_HEAD"]);
    if ((await git(["-C", clone, "rev-parse", "HEAD"])).trim() !== source.commit) throw new Error();
  } catch {
    throw new MargraveError(`locked commit is unavailable for ${source.id}`);
  }
  await rm(path.join(clone, ".git"), { recursive: true, force: true });
  return { dir: clone, entries: await scanLockedDirectory(clone, source, ctx) };
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
    const destination = gitDir(marker.record);
    const exists = await lstat(destination).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (rec !== undefined && (!matchesLock(rec, source) || rec.snapshot !== marker.record.snapshot))
      throw new MargraveError(`installed source differs from the lock: ${source.id}`);
    if (exists !== null) {
      if (!exists.isDirectory() || exists.isSymbolicLink()) throw new MargraveError(`pending restore record is malformed: ${source.id}`);
      const entries = await scanLockedDirectory(destination, source, ctx);
      let verified = false;
      if (rec !== undefined && db !== null) {
        try {
          await verifyInstalled(rec, source, db);
          verified = true;
        } catch {
          /* A pending publication can have incomplete index rows. */
        }
      }
      return {
        dir: destination,
        record: marker.record,
        entries,
        marker,
        verified,
        indexed: JSON.stringify(db === null ? [] : indexedEntries(db, source.id)),
      };
    }
    if (rec !== undefined) throw new MargraveError(`installed source differs from the lock: ${source.id}`);
  } else if (rec !== undefined && db !== null) {
    await verifyInstalled(rec, source, db);
    return { dir: null, record: rec, entries: [], marker, verified: true, indexed: JSON.stringify(indexedEntries(db, source.id)) };
  }
  const staged = await stageLockedCommit(source, stage, ctx);
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
  };
  return { ...staged, record, marker, verified: false, indexed: "" };
}

async function publishSource(source: LockedSource, plan: RestorePlan): Promise<void> {
  const destination = gitDir(plan.record);
  await commit(await installMode(), async (fresh, writer) => {
    const currentMarker = await readPending(source);
    if (JSON.stringify(currentMarker) !== JSON.stringify(plan.marker))
      throw new MargraveError(`restore is pending for a different lock source: ${source.id}`);
    const current = fresh.find((s) => s.id === source.id);
    if (plan.verified) {
      if (
        current === undefined ||
        JSON.stringify(current) !== JSON.stringify(plan.record) ||
        JSON.stringify(indexedEntries(writer, source.id)) !== plan.indexed
      )
        throw new MargraveError(`installed source differs from the lock: ${source.id}`);
      await ensureRestoreAlias(current, destination);
      return undefined;
    }
    if (current !== undefined && (plan.marker === undefined || !matchesLock(current, source) || current.snapshot !== plan.record.snapshot))
      throw new MargraveError(`installed source differs from the lock: ${source.id}`);
    if (plan.marker === undefined)
      await atomicWrite(pendingPath(source.id), `${JSON.stringify({ source, record: plan.record }, null, 2)}\n`);
    if (plan.dir !== destination) {
      await mkdir(path.dirname(destination), { recursive: true });
      if (
        (await lstat(destination).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return null;
          throw err;
        })) !== null
      )
        throw new MargraveError(`pending restore record is malformed: ${source.id}`);
      await rename(plan.dir as string, destination);
    }
    const entries = plan.entries.map((entry) => ({ ...entry, dir: path.join(destination, path.relative(plan.dir as string, entry.dir)) }));
    await ensureRestoreAlias(plan.record, destination);
    deleteSourceSkills(writer, source.id);
    insertSkills(writer, entries);
    return [...fresh.filter((s) => s.id !== source.id), plan.record];
  });
}

async function clearMarker(source: LockedSource, expected: PendingRestore): Promise<void> {
  let removed = false;
  await commit(
    await installMode(),
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
  const initial = await readSources();
  if ([...pending.values()].some((marker) => marker !== undefined)) (await openIndexWrite(await installMode())).close();
  await ensureDirs();
  const stage = await mkdtemp(path.join(stagingRoot(), "restore-"));
  let completed = 0;
  try {
    const plans = new Map<string, RestorePlan>();
    const db = initial.length > 0 ? await openIndexRead() : null;
    try {
      for (const source of lock.sources) {
        plans.set(
          source.id,
          await preflightSource(
            source,
            pending.get(source.id),
            initial.find((s) => s.id === source.id),
            db,
            stage,
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
      if (plan.marker !== undefined || !plan.verified) await clearMarker(source, plan.marker ?? { source, record: plan.record });
    }
  } catch (err) {
    if (completed > 0) throw new MargraveError(`restore partially completed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
