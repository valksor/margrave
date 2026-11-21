// Source specs, git (execFile, no shell), staging, swap, local registration, reindex.
import { lstat, readlink, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scanWithRipwire } from "./safety.ts";
import { scanSource } from "./scan.ts";
import type { Ctx } from "./source-files.ts";
import {
  checkIndex,
  commit,
  diffEntries,
  findSource,
  logWarnings,
  prepareSnapshot,
  resolveScanRoot,
  scanLocal,
  selectSkills,
  sourceDir,
  toEntries,
  withStaging,
} from "./source-files.ts";
import type { ParsedSpec } from "./source-git.ts";
import { checkRef, gitClone, installedRef, localId, parseSpec, qualifiedRef, validateGitRef, validateUpdateRef } from "./source-git.ts";
import { migrateStore } from "./source-migration.ts";
import type { NewEntry, SourceRecord } from "./store-files.ts";
import { MargraveError, UsageError, ensureDirs, home } from "./store-files.ts";
import { deleteSourceSkills, insertSkills, readSources, skillHashes } from "./catalog.ts";
export type { Ctx } from "./source-files.ts";
export { checkId, checkRef, localId, parseSpec, sanitizeId, validateUpdateRefSyntax } from "./source-git.ts";

export interface InstallResult {
  id: string;
  skills: string[];
}

export async function installSource(spec: string, refArg: string | null, ctx: Ctx, selection?: string[]): Promise<InstallResult> {
  const parsed = parseSpec(spec);
  const ref = refArg === null ? null : checkRef(refArg);
  if (parsed.kind === "local") {
    if (ref !== null) throw new UsageError("--ref is not allowed with a local source");
    await migrateStore();
    return installLocal(spec, parsed.path, ctx, selection);
  }
  if (qualifiedRef(ref)) await validateGitRef(ref);
  await migrateStore();
  return installGit(spec, parsed, ref, ctx, selection);
}

async function verifyStagedScan(id: string, root: string, clone: string, scan: Awaited<ReturnType<typeof scanSource>>): Promise<void> {
  const checked = await scanSource(root, { followSymlinks: false, boundary: clone, strict: true });
  if (
    JSON.stringify(toEntries(id, checked.skills, (d) => path.relative(clone, d))) !==
      JSON.stringify(toEntries(id, scan.skills, (d) => path.relative(clone, d))) ||
    JSON.stringify(checked.duplicates) !== JSON.stringify(scan.duplicates)
  )
    throw new MargraveError("staged skills changed during scan");
}

function duplicate(id: string): MargraveError {
  return new MargraveError(`source ${id} is already installed; run: margrave update ${id} (or margrave remove ${id})`);
}

async function installLocal(spec: string, dir: string, ctx: Ctx, selection?: string[]): Promise<InstallResult> {
  const real = await realpath(dir)
    .then(async (resolved) => ((await stat(resolved)).isDirectory() ? resolved : null))
    .catch(() => null);
  if (real === null) throw new MargraveError(`${dir} is not a directory that exists`);
  const id = localId(real);
  await ensureDirs();
  const sources = await readSources();
  if (sources.some((s) => s.id === id)) throw duplicate(id);
  await checkIndex(sources);

  const scan = await scanSource(real, { followSymlinks: true, strict: true });
  logWarnings(ctx, scan.warnings);
  const skills = selectSkills(id, scan, selection);
  if (scan.skills.length === 0) throw new MargraveError(`no valid skills (SKILL.md with name and description) found in ${real}`);
  await scanWithRipwire(real, { ...ctx, sourceId: id, skills: scan.skills });

  const entries = toEntries(id, skills, (d) => d);
  const record: SourceRecord = {
    id,
    kind: "local",
    spec,
    path: real,
    subpath: "",
    ref: null,
    commit: null,
    installedAt: new Date().toISOString(),
    selection,
  };
  await commit(addSource(record, entries));
  return { id, skills: entries.map((e) => e.id) };
}

/** The change for an install: another install may have added the same source while this one waited for the lock. */
function addSource(record: SourceRecord, entries: readonly NewEntry[]): (fresh: SourceRecord[], db: DatabaseSync) => SourceRecord[] {
  return (fresh, db) => {
    if (fresh.some((s) => s.id === record.id)) throw duplicate(record.id);
    insertSkills(db, entries);
    return [...fresh, record];
  };
}

async function installGit(
  spec: string,
  parsed: Extract<ParsedSpec, { kind: "git" }>,
  ref: string | null,
  ctx: Ctx,
  selection?: string[],
): Promise<InstallResult> {
  const id = parsed.id;
  const final = sourceDir(id);
  await ensureDirs();
  const sources = await readSources();
  if (sources.some((s) => s.id === id)) throw duplicate(id);
  const existing = await lstat(final).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (existing !== null) {
    if (!existing.isSymbolicLink()) throw duplicate(id);
    const target = path.resolve(path.dirname(final), await readlink(final));
    const rel = path.relative(path.join(home(), "snapshots", id), target);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}$/u.test(rel)) throw duplicate(id);
  }
  await checkIndex(sources);

  return withStaging(async (stage) => {
    const clone = path.join(stage, "repo");
    const sha = await gitClone(parsed.url, ref, clone);
    // No --ref: pin the branch the remote's default resolved to, so a later
    // `update` stays on it even if the remote changes its default branch.
    const pinned = await installedRef(clone, ref);
    // The store serves files from here; clone metadata holds the remote URL and the operator's identity.
    await rm(path.join(clone, ".git"), { recursive: true, force: true });
    const realClone = await realpath(clone);
    const scanRoot = await realpath(await resolveScanRoot(realClone, parsed.subpath));
    const scan = await scanSource(scanRoot, { followSymlinks: false, boundary: realClone, strict: true });
    logWarnings(ctx, scan.warnings);
    const skills = selectSkills(id, scan, selection);
    if (scan.skills.length === 0) {
      throw new MargraveError(`no valid skills (SKILL.md with name and description) found in ${spec}`);
    }
    const acceptedScan = await scanWithRipwire(scanRoot, { ...ctx, sourceId: id, skills: scan.skills, verifyContent: true });
    await verifyStagedScan(id, scanRoot, realClone, scan);
    const { snapshot, entries } = await prepareSnapshot(id, sha, clone, realClone, skills);
    const record: SourceRecord = {
      id,
      kind: "git",
      spec,
      url: parsed.url,
      subpath: parsed.subpath,
      ref: pinned,
      commit: sha,
      snapshot,
      scan: acceptedScan,
      installedAt: new Date().toISOString(),
      selection,
    };

    await commit(addSource(record, entries));
    return { id, skills: entries.map((e) => e.id) };
  });
}

export interface UpdateResult {
  id: string;
  kind: "git" | "local";
  oldCommit: string | null;
  newCommit: string | null;
  added: string[];
  changed: string[];
  removed: string[];
}

/** Update one source, or all when `arg` is null. A failing source does not stop the others. */
export async function updateSources(
  arg: string | null,
  ctx: Ctx,
  ref: string | null = null,
  expansion?: string[],
): Promise<{ results: UpdateResult[]; errors: { id: string; message: string }[] }> {
  if (ref !== null && arg === null) throw new UsageError("update --ref requires one Git source");
  const sources = await readSources();
  // A missing or invalid index fails once here, not once per source.
  if (arg === null) await checkIndex(sources);
  const targets = updateTargets(sources, arg, expansion);
  await validateUpdateRef(ref, targets[0]);
  const results: UpdateResult[] = [];
  const errors: { id: string; message: string }[] = [];
  for (const t of targets) {
    try {
      results.push(await updateOne(t.id, ctx, ref, expansion));
    } catch (err) {
      if (arg !== null) throw err;
      errors.push({ id: t.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, errors };
}

function updateTargets(sources: SourceRecord[], arg: string | null, expansion?: string[]): SourceRecord[] {
  if (expansion !== undefined && !sources.some((s) => s.id === arg)) throw new UsageError("skill selection requires an explicit source ID");
  const targets = arg === null ? sources : [findSource(sources, arg)];
  if (expansion !== undefined && targets[0]!.selection === undefined)
    throw new MargraveError(`source "${arg}" already installs all skills`);
  return targets;
}

/**
 * The change for a local update: replace the rows of one source.
 * The old hashes are read inside the transaction, so the diff matches what the update replaced.
 */
function replaceSource(
  id: string,
  entries: readonly NewEntry[],
  diff: { value?: ReturnType<typeof diffEntries> },
): (fresh: SourceRecord[], db: DatabaseSync) => SourceRecord[] {
  return (fresh, db) => {
    const before = skillHashes(db, id);
    deleteSourceSkills(db, id);
    insertSkills(db, entries);
    diff.value = diffEntries(before, entries);
    return fresh;
  };
}

async function updateOne(id: string, ctx: Ctx, ref: string | null, expansion?: string[]): Promise<UpdateResult> {
  // Re-read state so that several updates in a row see each other's writes.
  const sources = await readSources();
  const rec = sources.find((s) => s.id === id);
  // A `remove` that runs between updateSources() reading the list and this read makes this fire.
  if (rec === undefined) throw new MargraveError(`no source "${id}"`);
  if (expansion !== undefined && rec.selection === undefined) throw new MargraveError(`source "${id}" already installs all skills`);
  const selection = rec.selection === undefined ? undefined : [...new Set([...rec.selection, ...(expansion ?? [])])].sort();
  await checkIndex(sources);
  if (rec.kind === "local") return updateLocal(rec, ctx, selection);
  return updateGit(rec, ctx, ref, selection);
}

async function updateLocal(rec: SourceRecord, ctx: Ctx, selection?: string[]): Promise<UpdateResult> {
  const id = rec.id;
  const diff: { value?: ReturnType<typeof diffEntries> } = {};
  const entries = await scanLocal({ ...rec, selection }, ctx);
  await commit((fresh, db) => {
    const current = fresh.find((s) => s.id === id);
    if (current === undefined) throw new MargraveError(`no source "${id}"`);
    if (JSON.stringify(current) !== JSON.stringify(rec)) throw new MargraveError("source changed during update; run margrave update again");
    return replaceSource(id, entries, diff)(fresh, db).map((s) => (s.id === id ? { ...s, selection } : s));
  });
  return { id, kind: "local", oldCommit: null, newCommit: null, ...(diff.value as ReturnType<typeof diffEntries>) };
}

async function updateGit(rec: SourceRecord, ctx: Ctx, ref: string | null, selection?: string[]): Promise<UpdateResult> {
  const id = rec.id;
  const diff: { value?: ReturnType<typeof diffEntries> } = {};
  // readSources() only returns a git record with a url.
  const url = rec.url as string;

  const selected = (ref ?? rec.ref) as string;
  await validateGitRef(selected);
  return withStaging(async (stage) => {
    const clone = path.join(stage, "repo");
    const sha = await gitClone(url, selected, clone);
    // The store serves files from here; clone metadata holds the remote URL and the operator's identity.
    await rm(path.join(clone, ".git"), { recursive: true, force: true });
    const realClone = await realpath(clone);
    const scanRoot = await realpath(await resolveScanRoot(realClone, rec.subpath));
    const scan = await scanSource(scanRoot, { followSymlinks: false, boundary: realClone, strict: true });
    logWarnings(ctx, scan.warnings);
    const skills = selectSkills(id, scan, selection, true);
    if (scan.skills.length === 0) throw new MargraveError(`no valid skills found in the new revision of ${id}; kept the old copy`);
    // Compare against the accepted scan stored with the current snapshot.
    const acceptedScan = await scanWithRipwire(scanRoot, {
      ...ctx,
      sourceId: id,
      skills: scan.skills,
      baseline: rec.scan ?? null,
      verifyContent: true,
    });
    await verifyStagedScan(id, scanRoot, realClone, scan);
    const { snapshot, entries } = await prepareSnapshot(id, sha, clone, realClone, skills);
    await commit((fresh, db) => {
      const current = fresh.find((s) => s.id === id);
      if (current === undefined) throw new MargraveError(`no source "${id}"`);
      if (JSON.stringify(current) !== JSON.stringify(rec)) {
        throw new MargraveError("source changed during update; run margrave update again");
      }
      const before = skillHashes(db, id);
      deleteSourceSkills(db, id);
      insertSkills(db, entries);
      diff.value = diffEntries(before, entries);
      return fresh.map((s) => (s.id === id ? { ...s, commit: sha, snapshot, ref: selected, scan: acceptedScan, selection } : s));
    });
    return { id, kind: "git" as const, oldCommit: rec.commit, newCommit: sha, ...(diff.value as ReturnType<typeof diffEntries>) };
  });
}

export { findSource, resolveScanRoot, sourceDir } from "./source-files.ts";
export { checkSources, listSources, reindexAll, removeSource } from "./source-maintenance.ts";

export { migrateStore } from "./source-migration.ts";
