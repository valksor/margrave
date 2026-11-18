// Source specs, git (execFile, no shell), staging, swap, local registration, reindex.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isInside, scanSource } from "./scan.ts";
import type { ScannedSkill } from "./scan.ts";
import { esc, scanWithRipwire } from "./safety.ts";
import {
  MargraveError,
  UsageError,
  deleteAllSkills,
  deleteSourceSkills,
  ensureDirs,
  insertSkills,
  openIndexRead,
  openIndexWrite,
  readSources,
  removeLegacyIndex,
  skillHashes,
  sourcesRoot,
  stagingRoot,
  writeSources,
} from "./store.ts";
import type { NewEntry, SourceRecord } from "./store.ts";

export interface Ctx {
  /** Progress and warnings. The CLI writes these to stderr. */
  log: (msg: string) => void;
  allowUnsafe: boolean;
}

const ID_RE = /^[A-Za-z0-9._-]+$/u;

/** Replace every character outside [A-Za-z0-9._-] with "-". */
export function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/gu, "-");
}

function checkId(id: string): string {
  if (id === "" || id === "." || id === ".." || !ID_RE.test(id)) {
    throw new UsageError(`cannot derive a valid source id (got "${id}")`);
  }
  return id;
}

export type ParsedSpec = { kind: "local"; path: string } | { kind: "git"; url: string; subpath: string; id: string };

export function checkRef(ref: string): string {
  if (ref === "" || ref.startsWith("-")) throw new UsageError(`refused --ref "${ref}": must not be empty or start with "-"`);
  return ref;
}

function stripGit(s: string): string {
  return s.endsWith(".git") ? s.slice(0, -4) : s;
}

function gitUrlId(spec: string): string {
  let host = "";
  let rawPath: string;
  if (spec.startsWith("git@")) {
    const m = /^git@([^:/]+):(.+)$/u.exec(spec);
    if (m === null) throw new UsageError(`cannot parse git URL "${spec}"`);
    // Both groups take part in every match.
    host = m[1] as string;
    rawPath = m[2] as string;
  } else {
    let u: URL;
    try {
      u = new URL(spec);
    } catch {
      throw new UsageError(`cannot parse git URL "${spec}"`);
    }
    host = u.hostname;
    rawPath = u.pathname;
  }
  const segs = rawPath.split("/").filter((s) => s !== "");
  const last = segs.length - 1;
  if (last >= 0) segs[last] = stripGit(segs[last] as string);
  const id = [host, ...segs]
    .filter((s) => s !== "")
    .map(sanitizeId)
    .join("__");
  return checkId(id);
}

/**
 * Parse a source spec. Checked in this order:
 * 1. ./ ../ / ~ : local path. 2. https:// git@ file:// : git URL. 3. owner/repo[/sub/path] : GitHub.
 */
export function parseSpec(spec: string): ParsedSpec {
  if (spec === "") throw new UsageError("source spec is empty");
  if (spec.startsWith("-")) throw new UsageError(`refused spec "${spec}": must not start with "-"`);

  if (/^(\.\/|\.\.\/|\/|~)/u.test(spec)) {
    let p = spec;
    if (p === "~" || p.startsWith("~/")) p = path.join(homedir(), p.slice(1));
    else if (p.startsWith("~")) throw new UsageError(`unsupported spec "${spec}": only ~ and ~/path are expanded`);
    return { kind: "local", path: path.resolve(p) };
  }

  if (/^(https:\/\/|git@|file:\/\/)/u.test(spec)) {
    return { kind: "git", url: spec, subpath: "", id: gitUrlId(spec) };
  }

  const segs = spec.replace(/\/+$/u, "").split("/");
  if (segs.length < 2 || segs.some((s) => s === "")) {
    throw new UsageError(
      `unrecognized source "${spec}": use owner/repo, a git URL (https://, git@, file://), or a path starting with ./ ../ / or ~`,
    );
  }
  if (segs.some((s) => s === "..")) throw new UsageError(`refused spec "${spec}": ".." is not allowed`);
  if (segs.some((s) => s === "." || !ID_RE.test(s))) {
    throw new UsageError(`unrecognized source "${spec}": use owner/repo[/sub/path] with letters, digits, ".", "_", "-"`);
  }
  // At least two segments, none empty: checked above.
  const owner = segs[0] as string;
  const repo = stripGit(segs[1] as string);
  if (repo === "") throw new UsageError(`unrecognized source "${spec}"`);
  const sub = segs.slice(2);
  const id = checkId([owner, repo, ...sub].map(sanitizeId).join("__"));
  return {
    kind: "git",
    url: `https://github.com/${owner}/${repo}.git`,
    subpath: sub.join("/"),
    id,
  };
}

export function localId(realPath: string): string {
  const hash = createHash("sha1").update(realPath).digest("hex").slice(0, 6);
  return checkId(`local__${sanitizeId(path.basename(realPath))}-${hash}`);
}

/** The directory of a git source. Checks that it is a direct child of sources/. */
export function sourceDir(id: string): string {
  checkId(id);
  const root = path.resolve(sourcesRoot());
  const dir = path.join(root, id);
  // Defence in depth in front of every `rm -rf`. checkId() already limits `id` to one safe path segment,
  // so no test can make this fire; the guard stays so a later change to checkId() cannot make it unsafe.
  /* node:coverage ignore next 3 */
  if (path.dirname(dir) !== root || path.basename(dir) !== id) {
    throw new MargraveError(`refused: ${dir} is not a direct child of ${root}`);
  }
  return dir;
}

/** Find a source by id, or by its original spec. */
export function findSource(sources: readonly SourceRecord[], arg: string): SourceRecord {
  const byId = sources.find((s) => s.id === arg);
  if (byId !== undefined) return byId;
  const bySpec = sources.filter((s) => s.spec === arg);
  if (bySpec.length === 1 && bySpec[0] !== undefined) return bySpec[0];
  if (bySpec.length > 1) {
    throw new MargraveError(`"${arg}" matches several sources; use an id:\n${bySpec.map((s) => `  ${s.id}`).join("\n")}`);
  }
  throw new MargraveError(`no source "${arg}"; run: margrave list`);
}

// ---- git ----

const GIT_ENV_PROTOCOLS = "https:ssh:git:file";

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        // Never prompt: a missing credential must fail, not hang.
        env: { ...process.env, GIT_ALLOW_PROTOCOL: GIT_ENV_PROTOCOLS, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve(stdout);
          return;
        }
        const cmd = `git ${args.join(" ")}`;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new MargraveError(`git was not found on PATH (command: ${cmd})`));
          return;
        }
        reject(new MargraveError(`command failed: ${cmd}\n${stderr.trim() || err.message}`));
      },
    );
  });
}

async function gitClone(url: string, ref: string | null, dest: string): Promise<string> {
  const args = ["clone", "--depth", "1"];
  if (ref !== null) args.push("--branch", ref);
  args.push("--", url, dest);
  await git(args);
  return (await git(["-C", dest, "rev-parse", "HEAD"])).trim();
}

async function withStaging<T>(fn: (stage: string) => Promise<T>): Promise<T> {
  await ensureDirs();
  const stage = await mkdtemp(path.join(stagingRoot(), "s-"));
  try {
    return await fn(stage);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** subpath inside a clone: no "..", must exist, and its realpath must stay inside the clone. */
export async function resolveScanRoot(clone: string, subpath: string): Promise<string> {
  if (subpath === "") return clone;
  if (subpath.split("/").some((s) => s === ".." || s === "")) {
    throw new MargraveError(`refused subpath "${subpath}"`);
  }
  const target = path.join(clone, subpath);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new MargraveError(`subpath "${subpath}" does not exist in the repository`);
  }
  if (!isInside(real, await realpath(clone))) throw new MargraveError(`refused subpath "${subpath}": resolves outside the clone`);
  if (!(await stat(real)).isDirectory()) throw new MargraveError(`subpath "${subpath}" is not a directory`);
  return target;
}

// ---- index writes ----

function toEntries(sourceId: string, skills: readonly ScannedSkill[], mapDir: (dir: string) => string): NewEntry[] {
  return skills.map((s) => ({
    id: `${sourceId}/${s.name}`,
    name: s.name,
    description: s.description,
    source: sourceId,
    dir: mapDir(s.dir),
    hash: s.hash,
    tokens: s.tokens,
  }));
}

/** The index must be usable before the slow work (clone, scan) starts. A store with no sources has no index to check. */
async function checkIndex(sources: readonly SourceRecord[]): Promise<void> {
  if (sources.length > 0) (await openIndexWrite("existing")).close();
}

/**
 * The one write path. Takes the write lock, re-reads sources.json, lets `change` edit the rows and return the next
 * source list, writes sources.json, then commits. Any failure leaves the index as it was.
 * `mode` is "create" for a store with no sources or a reindex: a missing index, or one with user_version 0, is initialized.
 */
async function commit(mode: "existing" | "create", change: (fresh: SourceRecord[], db: DatabaseSync) => SourceRecord[]): Promise<void> {
  const db = await openIndexWrite(mode);
  try {
    db.exec("BEGIN IMMEDIATE");
    const fresh = await readSources();
    const next = change(fresh, db);
    await writeSources(next);
    try {
      db.exec("COMMIT");
    } catch (err) {
      await writeSources(fresh).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    if (db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is the one to report. close() below rolls the transaction back as well.
      }
    }
    throw err;
  } finally {
    db.close();
  }
}

/** The write mode for an install: a store with no sources has no index to keep. */
async function installMode(): Promise<"existing" | "create"> {
  return (await readSources()).length === 0 ? "create" : "existing";
}

function logWarnings(ctx: Ctx, warnings: readonly string[]): void {
  for (const w of warnings) ctx.log(`warning: ${esc(w)}`);
}

// ---- install ----

export interface InstallResult {
  id: string;
  skills: string[];
}

export async function installSource(spec: string, refArg: string | null, ctx: Ctx): Promise<InstallResult> {
  const parsed = parseSpec(spec);
  const ref = refArg === null ? null : checkRef(refArg);
  if (parsed.kind === "local") {
    if (ref !== null) throw new UsageError("--ref is not allowed with a local source");
    return installLocal(spec, parsed.path, ctx);
  }
  return installGit(spec, parsed, ref, ctx);
}

function duplicate(id: string): MargraveError {
  return new MargraveError(`source ${id} is already installed; run: margrave update ${id} (or margrave remove ${id})`);
}

async function installLocal(spec: string, dir: string, ctx: Ctx): Promise<InstallResult> {
  let real: string;
  try {
    real = await realpath(dir);
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new MargraveError(`${dir} is not a directory that exists`);
  }
  const id = localId(real);
  await ensureDirs();
  const sources = await readSources();
  if (sources.some((s) => s.id === id)) throw duplicate(id);
  await checkIndex(sources);

  const scan = await scanSource(real, { followSymlinks: true });
  logWarnings(ctx, scan.warnings);
  if (scan.skills.length === 0) throw new MargraveError(`no valid skills (SKILL.md with name and description) found in ${real}`);
  await scanWithRipwire(real, { ...ctx, sourceId: id, skills: scan.skills });

  const entries = toEntries(id, scan.skills, (d) => d);
  const record: SourceRecord = {
    id,
    kind: "local",
    spec,
    path: real,
    subpath: "",
    ref: null,
    commit: null,
    installedAt: new Date().toISOString(),
  };
  await commit(await installMode(), addSource(record, entries));
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
): Promise<InstallResult> {
  const id = parsed.id;
  const final = sourceDir(id);
  await ensureDirs();
  const sources = await readSources();
  if (sources.some((s) => s.id === id) || (await lstat(final).catch(() => null)) !== null) throw duplicate(id);
  await checkIndex(sources);

  return withStaging(async (stage) => {
    const clone = path.join(stage, "repo");
    const sha = await gitClone(parsed.url, ref, clone);
    // No --ref: pin the branch the remote's default resolved to, so a later
    // `update` stays on it even if the remote changes its default branch.
    const pinned = ref ?? (await git(["-C", clone, "symbolic-ref", "--short", "HEAD"])).trim();
    // The store serves files from here; clone metadata holds the remote URL and the operator's identity.
    await rm(path.join(clone, ".git"), { recursive: true, force: true });
    const realClone = await realpath(clone);
    const scanRoot = await realpath(await resolveScanRoot(realClone, parsed.subpath));
    const scan = await scanSource(scanRoot, { followSymlinks: false, boundary: realClone });
    logWarnings(ctx, scan.warnings);
    if (scan.skills.length === 0) {
      throw new MargraveError(`no valid skills (SKILL.md with name and description) found in ${spec}`);
    }
    await scanWithRipwire(scanRoot, { ...ctx, sourceId: id, skills: scan.skills });
    const entries = toEntries(id, scan.skills, (d) => path.join(final, path.relative(realClone, d)));
    const record: SourceRecord = {
      id,
      kind: "git",
      spec,
      url: parsed.url,
      subpath: parsed.subpath,
      ref: pinned,
      commit: sha,
      installedAt: new Date().toISOString(),
    };

    await rename(clone, final);
    try {
      await commit(await installMode(), addSource(record, entries));
    } catch (err) {
      await rm(final, { recursive: true, force: true });
      throw err;
    }
    return { id, skills: entries.map((e) => e.id) };
  });
}

// ---- update ----

export interface UpdateResult {
  id: string;
  kind: "git" | "local";
  oldCommit: string | null;
  newCommit: string | null;
  added: string[];
  changed: string[];
  removed: string[];
}

function diffEntries(before: ReadonlyMap<string, string>, next: readonly NewEntry[]) {
  const after = new Map(next.map((e) => [e.id, e.hash]));
  return {
    added: [...after.keys()].filter((k) => !before.has(k)).sort(),
    removed: [...before.keys()].filter((k) => !after.has(k)).sort(),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)).sort(),
  };
}

/** Update one source, or all when `arg` is null. A failing source does not stop the others. */
export async function updateSources(
  arg: string | null,
  ctx: Ctx,
): Promise<{ results: UpdateResult[]; errors: { id: string; message: string }[] }> {
  const sources = await readSources();
  // A missing, legacy, or invalid index fails once here, not once per source.
  if (arg === null) await checkIndex(sources);
  const targets = arg === null ? sources : [findSource(sources, arg)];
  const results: UpdateResult[] = [];
  const errors: { id: string; message: string }[] = [];
  for (const t of targets) {
    try {
      results.push(await updateOne(t.id, ctx));
    } catch (err) {
      if (arg !== null) throw err;
      errors.push({ id: t.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, errors };
}

/**
 * The change for an update: replace the rows of one source and, for a git source, set its commit.
 * The old hashes are read inside the transaction, so the diff matches what the update replaced.
 */
function replaceSource(
  id: string,
  entries: readonly NewEntry[],
  sha: string | null,
  diff: { value?: ReturnType<typeof diffEntries> },
): (fresh: SourceRecord[], db: DatabaseSync) => SourceRecord[] {
  return (fresh, db) => {
    // A `remove` that ran while this update waited for the lock makes this fire.
    if (!fresh.some((s) => s.id === id)) throw new MargraveError(`no source "${id}"`);
    const before = skillHashes(db, id);
    deleteSourceSkills(db, id);
    insertSkills(db, entries);
    diff.value = diffEntries(before, entries);
    return sha === null ? fresh : fresh.map((s) => (s.id === id ? { ...s, commit: sha } : s));
  };
}

async function updateOne(id: string, ctx: Ctx): Promise<UpdateResult> {
  // Re-read state so that several updates in a row see each other's writes.
  const sources = await readSources();
  const rec = sources.find((s) => s.id === id);
  // A `remove` that runs between updateSources() reading the list and this read makes this fire.
  if (rec === undefined) throw new MargraveError(`no source "${id}"`);
  await checkIndex(sources);
  const diff: { value?: ReturnType<typeof diffEntries> } = {};

  if (rec.kind === "local") {
    const entries = await scanLocal(rec, ctx);
    await commit("existing", replaceSource(id, entries, null, diff));
    return { id, kind: "local", oldCommit: null, newCommit: null, ...(diff.value as ReturnType<typeof diffEntries>) };
  }
  // readSources() only returns a git record with a url.
  const url = rec.url as string;
  const final = sourceDir(id);

  return withStaging(async (stage) => {
    const clone = path.join(stage, "repo");
    const sha = await gitClone(url, rec.ref, clone);
    // The store serves files from here; clone metadata holds the remote URL and the operator's identity.
    await rm(path.join(clone, ".git"), { recursive: true, force: true });
    const realClone = await realpath(clone);
    const scanRoot = await realpath(await resolveScanRoot(realClone, rec.subpath));
    const scan = await scanSource(scanRoot, { followSymlinks: false, boundary: realClone });
    logWarnings(ctx, scan.warnings);
    if (scan.skills.length === 0) throw new MargraveError(`no valid skills found in the new revision of ${id}; kept the old copy`);
    // The baseline: the installed copy, scanned before the swap. It is what the user accepted.
    const baselineDir = await installedScanRoot(final, rec.subpath);
    await scanWithRipwire(scanRoot, { ...ctx, sourceId: id, skills: scan.skills, baselineDir });
    const entries = toEntries(id, scan.skills, (d) => path.join(final, path.relative(realClone, d)));

    // Swap: old dir aside, new dir in, then write. Roll back on failure.
    const aside = path.join(stage, "old");
    const hadOld = (await lstat(final).catch(() => null)) !== null;
    if (hadOld) await rename(final, aside);
    try {
      await rename(clone, final);
    } catch (err) {
      if (hadOld) await rename(aside, final);
      throw err;
    }
    try {
      await commit("existing", replaceSource(id, entries, sha, diff));
    } catch (err) {
      await rm(final, { recursive: true, force: true });
      if (hadOld) await rename(aside, final);
      throw err;
    }
    return { id, kind: "git" as const, oldCommit: rec.commit, newCommit: sha, ...(diff.value as ReturnType<typeof diffEntries>) };
  });
}

/** The real scan root inside the installed copy of a git source, or null when it is not there. */
async function installedScanRoot(final: string, subpath: string): Promise<string | null> {
  if ((await lstat(final).catch(() => null)) === null) return null;
  try {
    return await realpath(await resolveScanRoot(await realpath(final), subpath));
  } catch {
    return null;
  }
}

async function scanLocal(rec: SourceRecord, ctx: Ctx): Promise<NewEntry[]> {
  // readSources() only returns a local record with a path.
  const scan = await scanSource(rec.path as string, { followSymlinks: true }).catch(() => {
    throw new MargraveError(`${rec.path} is not readable; remove the source or restore the directory`);
  });
  logWarnings(ctx, scan.warnings);
  return toEntries(rec.id, scan.skills, (d) => d);
}

// ---- remove ----

export async function removeSource(arg: string): Promise<SourceRecord> {
  const sources = await readSources();
  const rec = findSource(sources, arg);
  await checkIndex(sources);

  await commit("existing", (fresh, db) => {
    // Another `remove` that ran while this one waited for the lock makes this fire.
    if (!fresh.some((s) => s.id === rec.id)) throw new MargraveError(`no source "${rec.id}"; run: margrave list`);
    deleteSourceSkills(db, rec.id);
    return fresh.filter((s) => s.id !== rec.id);
  });
  // Local sources are only unregistered. The user's directory is never deleted.
  if (rec.kind === "git") {
    // Deletes only sources/<id>, after sourceDir() checked it is a direct child of sources/.
    await rm(sourceDir(rec.id), { recursive: true, force: true });
  }
  return rec;
}

// ---- reindex ----

export async function reindexAll(ctx: Ctx): Promise<{ skills: number; sources: number }> {
  const sources = await readSources();
  const entries: NewEntry[] = [];
  for (const rec of sources) {
    try {
      if (rec.kind === "local") {
        entries.push(...(await scanLocal(rec, ctx)));
      } else {
        const dir = sourceDir(rec.id);
        const root = await resolveScanRoot(dir, rec.subpath);
        const scan = await scanSource(root, { followSymlinks: false, boundary: dir });
        logWarnings(ctx, scan.warnings);
        entries.push(...toEntries(rec.id, scan.skills, (d) => d));
      }
    } catch (err) {
      ctx.log(`warning: ${rec.id}: ${esc(err instanceof Error ? err.message : String(err))}; skipped`);
    }
  }
  const scanned = sources.map((s) => s.id).sort();
  await commit("create", (fresh, db) => {
    // A source that was added or removed while this reindex scanned or waited would be lost or kept without rows.
    const now = fresh.map((s) => s.id).sort();
    if (now.length !== scanned.length || now.some((id, i) => id !== scanned[i])) {
      throw new MargraveError("sources changed during reindex; run: margrave reindex");
    }
    deleteAllSkills(db);
    insertSkills(db, entries);
    return fresh;
  });
  // After the commit only: if the reindex fails, the old index stays.
  await removeLegacyIndex();
  return { skills: entries.length, sources: sources.length };
}

// ---- list ----

export interface ListedSkill {
  id: string;
  name: string;
  description: string;
  source: string;
}

export async function listSources(
  withSkills: boolean,
): Promise<{ sources: (SourceRecord & { skillCount: number })[]; skills: ListedSkill[] }> {
  const sources = await readSources();
  if (sources.length === 0) return { sources: [], skills: [] };
  const db = await openIndexRead();
  try {
    const counts = new Map<string, number>();
    for (const r of db.prepare("SELECT source, count(*) AS n FROM skills GROUP BY source").all() as { source: string; n: number }[]) {
      counts.set(r.source, r.n);
    }
    const skills = withSkills
      ? (db.prepare("SELECT id, name, description, source FROM skills ORDER BY id").all() as unknown as ListedSkill[])
      : [];
    return { sources: sources.map((s) => ({ ...s, skillCount: counts.get(s.id) ?? 0 })), skills };
  } finally {
    db.close();
  }
}
