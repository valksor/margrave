import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { parseSpec } from "./source-git.ts";
import { scanInstalledSource } from "./source-files.ts";
import { MargraveError, isRecord, isSha256, validSelection } from "./store-files.ts";
import { catalogSources, openCatalogReadOptional } from "./catalog.ts";
import type { SourceRecord } from "./store-files.ts";

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
  selection?: string[] | null;
}
export interface LockFile {
  version: 1 | 2;
  sources: LockedSource[];
}

const malformed = (): never => {
  throw new MargraveError("lock file is malformed");
};
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).sort().join(",") === expected.sort().join(",");
const digest = (s: string): boolean => s.startsWith("sha256:") && isSha256(s.slice(7));
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
    const authority = value.slice(8).split(/[/?#]/u, 1)[0]!;
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
  if (
    !isRecord(value) ||
    !keys(value, ["version", "sources"]) ||
    (value["version"] !== 1 && value["version"] !== 2) ||
    !Array.isArray(value["sources"])
  )
    return malformed();
  const version = value["version"];
  // Check every URL first so no identity error can expose credentials.
  for (const source of value["sources"])
    if (isRecord(source)) {
      if (typeof source["spec"] === "string") checkLockUrl(source["spec"]);
      if (typeof source["url"] === "string") checkLockUrl(source["url"]);
    }
  const sources: LockedSource[] = [];
  const ids = new Set<string>();
  for (const source of value["sources"]) sources.push(parseLockedSource(source, version, ids));
  sources.sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
  return { version, sources };
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

function parseLockedSource(source: unknown, version: 1 | 2, ids: Set<string>): LockedSource {
  if (
    !isRecord(source) ||
    !keys(source, ["spec", "id", "url", "subpath", "ref", "commit", "skills", ...(version === 2 ? ["selection"] : [])])
  )
    return malformed();
  if (version === 2 && source["selection"] !== null && !validSelection(source["selection"])) return malformed();
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
      (version === 1 && skill["id"].slice(id.length + 1).includes("/")) ||
      skill["id"].length === id.length + 1 ||
      typeof skill["revision"] !== "string" ||
      !digest(skill["revision"]) ||
      skillIds.has(skill["id"])
    )
      return malformed();
    skillIds.add(skill["id"]);
    entries.push({ id: skill["id"], revision: skill["revision"] });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : Number(a.id > b.id)));
  const selection = source["selection"] as string[] | null | undefined;
  if (
    Array.isArray(selection) &&
    JSON.stringify(selection.map((name) => `${id}/${name}`).sort()) !== JSON.stringify(entries.map((entry) => entry.id))
  )
    return malformed();
  return {
    spec,
    id,
    url,
    subpath,
    ref,
    commit: lockedCommit,
    skills: entries,
    ...(version === 2 ? { selection } : {}),
  };
}

function lockInventory(entries: readonly { id: string; revision: string }[]): { id: string; revision: string }[] {
  return entries.map(({ id, revision }) => ({ id, revision })).sort((a, b) => Number(a.id > b.id) - Number(a.id < b.id));
}

export function sameInventory(entries: readonly { id: string; revision: string }[], locked: LockedSource): boolean {
  return JSON.stringify(lockInventory(entries)) === JSON.stringify(locked.skills);
}

export function matchesLock(rec: SourceRecord, locked: LockedSource): boolean {
  return (
    rec.kind === "git" &&
    rec.id === locked.id &&
    rec.spec === locked.spec &&
    rec.url === locked.url &&
    rec.subpath === locked.subpath &&
    rec.ref === locked.ref &&
    rec.commit === locked.commit &&
    JSON.stringify(rec.selection ?? null) === JSON.stringify(locked.selection ?? null)
  );
}

export function indexedEntries(db: DatabaseSync, id: string): { id: string; revision: string; manifest: string; dir: string }[] {
  return db.prepare("SELECT id, hash AS revision, manifest, dir FROM skills WHERE source = ? ORDER BY id").all(id) as {
    id: string;
    revision: string;
    manifest: string;
    dir: string;
  }[];
}

export async function verifyInstalled(rec: SourceRecord, locked: LockedSource, db: DatabaseSync): Promise<void> {
  try {
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
  const db = await openCatalogReadOptional();
  if (db === null && selected.length === 0) return { version: 2, sources: [] };
  if (db === null) throw new MargraveError("--source must be an installed Git source ID");
  try {
    const sources = catalogSources(db);
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
    if (targets.length === 0) return { version: 2, sources: [] };
    const locked: LockedSource[] = [];
    for (const rec of targets) {
      locked.push({
        spec: rec.spec,
        id: rec.id,
        url: rec.url as string,
        subpath: rec.subpath,
        ref: rec.ref as string,
        commit: rec.commit as string,
        skills: lockInventory(indexedEntries(db, rec.id)),
        selection: rec.selection ?? null,
      });
    }
    return parseLock({ version: 2, sources: locked });
  } finally {
    db.close();
  }
}
