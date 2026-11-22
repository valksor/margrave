import type { DatabaseSync } from "node:sqlite";
import { esc } from "./safety.ts";
import type { Ctx } from "./source-files.ts";
import { checkIndex, commit, diffEntries, findSource, scanInstalledSource } from "./source-files.ts";
import { trackingRef } from "./source-git.ts";
import type { NewEntry, SourceRecord } from "./store-files.ts";
import {
  catalogSources,
  deleteAllSkills,
  deleteSourceSkills,
  insertSkills,
  openCatalogReadOptional,
  readSources,
  skillHashes,
} from "./catalog.ts";
import { MargraveError } from "./store-files.ts";

export interface CheckResult {
  id: string;
  updateAvailable: boolean;
  added: string[];
  changed: string[];
  removed: string[];
  error: string | null;
  oldCommit: string | null;
  newCommit: string | null;
}

export async function checkSources(arg: string | null): Promise<CheckResult[]> {
  const db = await openCatalogReadOptional();
  if (db === null) {
    if (arg !== null) throw new MargraveError(`no source "${arg}"; run: margrave list`);
    return [];
  }
  try {
    const sources = catalogSources(db);
    const targets = arg === null ? sources : [findSource(sources, arg)];
    const results: CheckResult[] = [];
    for (const rec of targets) {
      const result: CheckResult = {
        id: rec.id,
        updateAvailable: false,
        added: [],
        changed: [],
        removed: [],
        error: null,
        oldCommit: rec.commit,
        newCommit: null,
      };
      try {
        const before = skillHashes(db, rec.id);
        const entries = await scanInstalledSource(rec, { log: () => {} });
        Object.assign(result, diffEntries(before, entries));
        if (rec.kind === "git") {
          const remote = await trackingRef(rec);
          result.newCommit = remote;
          result.updateAvailable = remote !== rec.commit;
        }
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
      try {
        const current = (await readSources()).find((source) => source.id === rec.id);
        if (JSON.stringify(current) !== JSON.stringify(rec)) result.error = "source changed during check; run margrave check again";
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
      }
      results.push(result);
    }
    return results;
  } finally {
    db.close();
  }
}

export async function removeSource(arg: string): Promise<SourceRecord> {
  const sources = await readSources();
  const rec = findSource(sources, arg);
  await checkIndex(sources);

  let removed: SourceRecord | undefined;
  await commit((fresh, db) => {
    removed = fresh.find((s) => s.id === rec.id);
    if (removed === undefined) throw new MargraveError(`no source "${rec.id}"; run: margrave list`);
    deleteSourceSkills(db, rec.id);
    return fresh.filter((s) => s.id !== rec.id);
  });

  return removed as SourceRecord;
}

interface ReindexScan {
  entries: NewEntry[];
  failed: Set<string>;
}

async function scanInstalledSources(sources: readonly SourceRecord[], ctx: Ctx): Promise<ReindexScan> {
  const entries: NewEntry[] = [];
  const failed = new Set<string>();
  for (const rec of sources) {
    try {
      entries.push(...(await scanInstalledSource(rec, ctx)));
    } catch (err) {
      failed.add(rec.id);
      const code = (err as NodeJS.ErrnoException)?.code;
      const missing = code === "ENOENT" || code === "ENOTDIR" || (err instanceof MargraveError && err.message.startsWith("subpath "));
      const message =
        rec.kind === "git" && missing
          ? "installed Git files differ from the accepted revision. Restore a verified lock or a known-good backup"
          : esc(err instanceof Error ? err.message : String(err));
      ctx.log(`warning: ${rec.id}: ${message}; skipped`);
    }
  }
  return { entries, failed };
}

function verifyReindex(sources: readonly SourceRecord[], scan: ReindexScan, db: DatabaseSync, ctx: Ctx): void {
  for (const rec of sources) {
    if (rec.kind !== "git" || scan.failed.has(rec.id)) continue;
    const indexed = db.prepare("SELECT id, hash AS revision, dir, manifest FROM skills WHERE source = ? ORDER BY id").all(rec.id);
    const observed = scan.entries
      .filter((entry) => entry.source === rec.id)
      .map(({ id, revision, dir, manifest }) => ({ id, revision, dir, manifest }));
    if (JSON.stringify(indexed) !== JSON.stringify(observed)) {
      scan.failed.add(rec.id);
      ctx.log(
        `warning: ${rec.id}: installed Git files differ from the accepted revision. Restore a verified lock or a known-good backup; skipped`,
      );
    }
  }
}

function applyReindex(
  sources: readonly SourceRecord[],
  scan: ReindexScan,
  fresh: SourceRecord[],
  db: DatabaseSync,
  ctx: Ctx,
): SourceRecord[] {
  if (JSON.stringify(fresh) !== JSON.stringify(sources)) {
    throw new MargraveError("sources changed during reindex; run: margrave reindex");
  }
  verifyReindex(sources, scan, db, ctx);
  if (scan.failed.size === 0) deleteAllSkills(db);
  else for (const rec of sources) if (!scan.failed.has(rec.id)) deleteSourceSkills(db, rec.id);
  insertSkills(
    db,
    scan.entries.filter((entry) => !scan.failed.has(entry.source)),
  );
  return fresh;
}

export async function reindexAll(ctx: Ctx): Promise<{ skills: number; sources: number }> {
  const sources = await readSources();
  const scan = await scanInstalledSources(sources, ctx);
  await commit((fresh, db) => applyReindex(sources, scan, fresh, db, ctx));
  return { skills: scan.entries.filter((entry) => !scan.failed.has(entry.source)).length, sources: sources.length };
}

export type ListedSkill = {
  id: string;
  name: string;
  description: string;
  source: string;
};

export async function listSources(
  withSkills: boolean,
): Promise<{ sources: (SourceRecord & { skillCount: number })[]; skills: ListedSkill[] }> {
  const db = await openCatalogReadOptional();
  if (db === null) return { sources: [], skills: [] };
  try {
    const sources = catalogSources(db);
    const counts = new Map<string, number>();
    for (const r of db.prepare("SELECT source, count(*) AS n FROM skills GROUP BY source").all() as { source: string; n: number }[]) {
      counts.set(r.source, r.n);
    }
    const skills = withSkills ? (db.prepare("SELECT id, name, description, source FROM skills ORDER BY id").all() as ListedSkill[]) : [];
    return { sources: sources.map((s) => ({ ...s, skillCount: counts.get(s.id) ?? 0 })), skills };
  } finally {
    db.close();
  }
}

export async function listSkillCatalog(): Promise<{
  sources: (Pick<SourceRecord, "id" | "kind" | "ref" | "commit"> & { skillCount: number })[];
  skills: ListedSkill[];
}> {
  const { sources, skills } = await listSources(true);
  return { sources: sources.map(({ id, kind, ref, commit: sha, skillCount }) => ({ id, kind, ref, commit: sha, skillCount })), skills };
}
