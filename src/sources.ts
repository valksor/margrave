// Source specs, git (execFile, no shell), staging, swap, local registration, reindex.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isInside, scanSource } from "./scan.ts";
import type { ScannedSkill } from "./scan.ts";
import { esc, scanWithRipwire } from "./safety.ts";
import {
  MargraveError,
  UsageError,
  FTS_SCHEMA,
  SCHEMA_VERSION,
  deleteAllSkills,
  deleteSourceSkills,
  ensureDirs,
  insertSkills,
  home,
  openIndexRead,
  openCatalogReadOptional,
  catalogSources,
  cleanupCatalogTemps,
  copyLegacyCatalog,
  indexDbFile,
  openLegacyCatalog,
  putCatalogSources,
  publishCatalog,
  temporaryCatalog,
  writerLock,
  readSources,
  readLegacySources,
  skillHashes,
  sourcesRoot,
  sourcesFile,
  stagingRoot,
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

export function checkId(id: string): string {
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

/** Resolve a record only within its own snapshot directory. */
function gitDir(rec: SourceRecord): string {
  sourceDir(rec.id);
  return path.join(home(), "snapshots", rec.id, rec.snapshot as string);
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
const qualifiedRef = (ref: string): boolean => /^refs\/(heads|tags)\//u.test(ref);

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
          reject(new MargraveError(`git was not found on PATH (command: ${cmd})`, { cause: err }));
          return;
        }
        reject(new MargraveError(`command failed: ${cmd}\n${stderr.trim() || err.message}`, { cause: err }));
      },
    );
  });
}

async function gitClone(url: string, ref: string | null, dest: string): Promise<string> {
  const qualified = ref !== null && qualifiedRef(ref);
  const args = ["clone", "--depth", "1"];
  if (ref !== null && !qualified) args.push("--branch", ref);
  args.push("--", url, dest);
  await git(args);
  if (qualified) {
    await git(["-C", dest, "fetch", "--depth", "1", "origin", ref]);
    await git(["-C", dest, "checkout", "--detach", "FETCH_HEAD"]);
  }
  return (await git(["-C", dest, "rev-parse", "HEAD"])).trim();
}

async function installedRef(clone: string, ref: string | null): Promise<string> {
  if (ref !== null && qualifiedRef(ref)) return ref;
  if (ref === null) return (await git(["-C", clone, "symbolic-ref", "HEAD"])).trim();
  return git(["-C", clone, "symbolic-ref", "-q", "HEAD"])
    .then((head) => head.trim())
    .catch(() => `refs/tags/${ref}`);
}

async function validateUpdateRef(ref: string | null, source: SourceRecord | undefined): Promise<void> {
  if (ref === null) return;
  if (source?.kind !== "git") throw new UsageError("update --ref requires one Git source");
  if (!qualifiedRef(ref)) throw new UsageError("update --ref requires a fully qualified Git branch or tag");
  await validateGitRef(ref, "update --ref requires a fully qualified Git branch or tag");
}

async function validateGitRef(ref: string, message?: string): Promise<void> {
  try {
    await git(["check-ref-format", ref]);
  } catch (err) {
    if (err instanceof MargraveError && (err.cause as { code?: string | number } | undefined)?.code === 1) {
      throw new UsageError(message ?? err.message);
    }
    throw err;
  }
}

async function remoteRefs(url: string, ref: string): Promise<Map<string, string>> {
  const names = [ref];
  let output: string;
  try {
    output = await git(["ls-remote", "--", url, ...names, ...names.map((name) => `${name}^{}`)]);
  } catch {
    throw new MargraveError("cannot read remote tracking ref");
  }
  const found = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of output.trim().split("\n")) {
    const [sha, name] = line.split("\t");
    if (sha === undefined || name === undefined) continue;
    if (name.endsWith("^{}")) peeled.set(name.slice(0, -3), sha);
    else if (names.includes(name)) found.set(name, sha);
  }
  for (const [name, sha] of peeled) if (found.has(name)) found.set(name, sha);
  return found;
}

async function trackingRef(rec: SourceRecord): Promise<string> {
  const ref = rec.ref as string;
  await validateGitRef(ref);
  const refs = await remoteRefs(rec.url as string, ref);
  const sha = refs.get(ref);
  if (sha === undefined) throw new MargraveError("remote tracking ref was not found");
  return sha;
}

async function withStaging<T>(fn: (stage: string) => Promise<T>): Promise<T> {
  const stage = await ownedStage("s-");
  try {
    return await fn(stage.dir);
  } finally {
    await stage.close();
  }
}

async function ownedStage(prefix: "s-" | "restore-"): Promise<{ dir: string; close: () => Promise<void> }> {
  await ensureDirs();
  const lock = await writerLock();
  let dir: string | undefined;
  let owner: DatabaseSync | undefined;
  let result: { dir: string; close: () => Promise<void> };
  try {
    dir = await mkdtemp(path.join(stagingRoot(), prefix));
    owner = new DatabaseSync(path.join(dir, ".margrave-owner.db"), { timeout: 0 });
    owner.exec("CREATE TABLE owner(name TEXT NOT NULL)");
    owner.prepare("INSERT INTO owner(name) VALUES (?)").run(path.basename(dir));
    owner.exec("BEGIN IMMEDIATE");
    const held = owner;
    const stage = dir;
    result = {
      dir: stage,
      close: async () => {
        held.close();
        await rm(stage, { recursive: true, force: true });
      },
    };
  } catch (err) {
    owner?.close();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    throw err;
  } finally {
    lock.close();
  }
  return result;
}

async function cleanupStages(): Promise<void> {
  const entries = await readdir(stagingRoot(), { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(?:s-|restore-)[A-Za-z0-9]{6}$/u.test(entry.name)) continue;
    const dir = path.join(stagingRoot(), entry.name);
    const file = path.join(dir, ".margrave-owner.db");
    const st = await lstat(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (st === null || !st.isFile()) continue;
    let owner: DatabaseSync | undefined;
    let abandoned = false;
    try {
      owner = new DatabaseSync(file, { timeout: 0 });
      const marker = owner.prepare("SELECT name FROM owner").get();
      if (marker?.["name"] !== entry.name) continue;
      owner.exec("BEGIN IMMEDIATE");
      abandoned = true;
    } catch (err) {
      const code = (err as { errcode?: number }).errcode;
      const missingOwner = code === 1 && err instanceof Error && /no such table: owner/u.test(err.message);
      if (code !== 5 && code !== 26 && !missingOwner) throw err;
      // A live owner, or an unrecognized SQLite file, is not ours to remove.
    } finally {
      if (abandoned) {
        try {
          await rm(dir, { recursive: true, force: true });
        } finally {
          owner?.close();
        }
      } else owner?.close();
    }
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
    revision: s.revision,
    manifest: JSON.stringify(s.manifest),
    frontmatter: s.frontmatter,
    tokens: s.tokens,
  }));
}

async function prepareSnapshot(
  id: string,
  sha: string,
  clone: string,
  realClone: string,
  skills: readonly ScannedSkill[],
): Promise<{
  snapshot: string;
  destination: string;
  entries: NewEntry[];
}> {
  const snapshot = `${sha}-${randomBytes(8).toString("hex")}`;
  const destination = path.join(home(), "snapshots", id, snapshot);
  const entries = toEntries(id, skills, (d) => path.relative(realClone, d));
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(clone, destination);
  await syncSnapshot(destination);
  return { snapshot, destination, entries };
}

async function syncTree(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await syncTree(file);
    else if (entry.isFile()) {
      const handle = await open(file, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncSnapshot(destination: string): Promise<void> {
  await syncTree(destination);
  for (const dir of [path.dirname(destination), path.dirname(path.dirname(destination)), home()]) {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function repairAliases(before: readonly SourceRecord[], after: readonly SourceRecord[]): Promise<void> {
  const ids = new Set([...before, ...after].filter((s) => s.kind === "git").map((s) => s.id));
  await mkdir(sourcesRoot(), { recursive: true });
  for (const entry of await readdir(sourcesRoot(), { withFileTypes: true })) {
    if (entry.isSymbolicLink() && /^[A-Za-z0-9._-]+$/u.test(entry.name)) {
      const target = await readlink(path.join(sourcesRoot(), entry.name));
      const root = path.join(home(), "snapshots", entry.name);
      const rel = path.relative(root, path.resolve(sourcesRoot(), target));
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}$/u.test(rel)) ids.add(entry.name);
    }
  }
  for (const id of ids) {
    const alias = sourceDir(id);
    const desired = after.find((s) => s.id === id && s.kind === "git");
    try {
      const existing = await lstat(alias).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      const target = desired === undefined ? null : path.relative(path.dirname(alias), gitDir(desired));
      if (existing !== null) {
        if (!existing.isSymbolicLink()) throw new Error("unexpected path");
        const old = await readlink(alias);
        if (old === target) continue;
        const root = path.join(home(), "snapshots", id);
        const relative = path.relative(root, path.resolve(path.dirname(alias), old));
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}$/u.test(relative)) throw new Error("unexpected link");
      }
      if (target === null) {
        if (existing !== null) await rm(alias);
      } else {
        const temp = `${alias}.${randomBytes(8).toString("hex")}.new`;
        try {
          await symlink(target, temp);
          await rename(temp, alias);
        } finally {
          await rm(temp, { force: true });
        }
      }
    } catch (err) {
      console.error(
        `warning: source "${id}" was published, but its compatibility link could not be updated: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** The index must be usable before the slow work (clone, scan) starts. A store with no sources has no index to check. */
async function checkIndex(sources: readonly SourceRecord[]): Promise<void> {
  if (sources.length > 0) (await openIndexRead()).close();
}

/** Build and publish the next catalog while holding the separate writer lock. */
async function commit(
  change: (fresh: SourceRecord[], db: DatabaseSync) => SourceRecord[] | undefined | Promise<SourceRecord[] | undefined>,
  rollback?: () => Promise<void>,
): Promise<void> {
  const lock = await writerLock();
  let db: DatabaseSync | undefined;
  let file: string | undefined;
  try {
    await cleanupCatalogTemps();
    await cleanupStages();
    const temporary = await temporaryCatalog();
    db = temporary.db;
    file = temporary.file;
    db.exec("BEGIN IMMEDIATE");
    const fresh = catalogSources(db);
    await repairAliases(fresh, fresh);
    const next = await change(fresh, db);
    if (next === undefined) {
      db.exec("ROLLBACK");
      return;
    }
    putCatalogSources(db, next);
    db.exec("COMMIT");
    db.close();
    await publishCatalog(file);
    await repairAliases(fresh, next);
  } catch (err) {
    if (rollback !== undefined) await rollback();
    if (db?.isOpen === true && db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is the one to report. close() below rolls the transaction back as well.
      }
    }
    throw err;
  } finally {
    try {
      if (db?.isOpen === true) db.close();
      if (file !== undefined) {
        await cleanupCatalogTemps();
      }
    } finally {
      lock.close();
    }
  }
}

function logWarnings(ctx: Ctx, warnings: readonly string[]): void {
  for (const w of warnings) ctx.log(`warning: ${esc(w)}`);
}

// ---- install ----

export interface InstallResult {
  id: string;
  skills: string[];
}

export async function installSource(spec: string, refArg: string | null, ctx: Ctx, selection?: string[]): Promise<InstallResult> {
  const parsed = parseSpec(spec);
  const ref = refArg === null ? null : checkRef(refArg);
  if (parsed.kind === "local") {
    if (ref !== null) throw new UsageError("--ref is not allowed with a local source");
    return installLocal(spec, parsed.path, ctx, selection);
  }
  if (ref !== null && qualifiedRef(ref)) await validateGitRef(ref);
  return installGit(spec, parsed, ref, ctx, selection);
}

export function selectSkills(
  id: string,
  scan: Awaited<ReturnType<typeof scanSource>>,
  selection?: readonly string[],
  updating = false,
): ScannedSkill[] {
  if (selection === undefined) return scan.skills;
  for (const name of selection) {
    if (scan.duplicates.includes(name)) throw new MargraveError(`skill "${name}" is ambiguous in source "${id}"`);
    if (!scan.skills.some((skill) => skill.name === name)) {
      if (updating) throw new MargraveError(`selected skill "${name}" is missing from the new revision. The installed source is unchanged`);
      throw new MargraveError(`skill "${name}" does not exist in source "${id}"`);
    }
  }
  return scan.skills.filter((skill) => selection.includes(skill.name));
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
    ...(selection === undefined ? {} : { selection }),
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
      ...(selection === undefined ? {} : { selection }),
    };

    await commit(addSource(record, entries));
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
  const after = new Map(next.map((e) => [e.id, e.revision]));
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
  if (expansion !== undefined && (arg === null || !sources.some((s) => s.id === arg)))
    throw new UsageError("skill selection requires an explicit source ID");
  const targets = arg === null ? sources : [findSource(sources, arg)];
  if (expansion !== undefined && targets[0]?.selection === undefined)
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
  const entries = await scanLocal({ ...rec, ...(selection === undefined ? {} : { selection }) }, ctx);
  await commit((fresh, db) => {
    const current = fresh.find((s) => s.id === id);
    if (current === undefined) throw new MargraveError(`no source "${id}"`);
    if (JSON.stringify(current) !== JSON.stringify(rec)) throw new MargraveError("source changed during update; run margrave update again");
    return replaceSource(id, entries, diff)(fresh, db).map((s) => (s.id === id && selection !== undefined ? { ...s, selection } : s));
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
      return fresh.map((s) =>
        s.id === id
          ? { ...s, commit: sha, snapshot, ref: selected, scan: acceptedScan, ...(selection === undefined ? {} : { selection }) }
          : s,
      );
    });
    return { id, kind: "git" as const, oldCommit: rec.commit, newCommit: sha, ...(diff.value as ReturnType<typeof diffEntries>) };
  });
}

async function scanLocal(rec: SourceRecord, ctx: Ctx): Promise<NewEntry[]> {
  // readSources() only returns a local record with a path.
  const root = await realpath(rec.path as string).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new MargraveError(`${rec.path} is not readable; remove the source or restore the directory`);
    throw err;
  });
  const scan = await scanSource(root, { followSymlinks: true, strict: true });
  logWarnings(ctx, scan.warnings);
  return toEntries(rec.id, selectSkills(rec.id, scan, rec.selection, true), (d) => d);
}

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
    if (arg !== null) findSource([], arg);
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
        const entries = await scanInstalledSource(rec, { log: () => {}, allowUnsafe: false });
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

// ---- remove ----

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

// ---- reindex ----

interface ReindexScan {
  entries: NewEntry[];
  failed: Set<string>;
}

async function scanInstalledSource(rec: SourceRecord, ctx: Ctx): Promise<NewEntry[]> {
  if (rec.kind === "local") return scanLocal(rec, ctx);
  const dir = gitDir(rec);
  const root = await resolveScanRoot(dir, rec.subpath);
  const scan = await scanSource(root, { followSymlinks: false, boundary: dir, strict: true });
  logWarnings(ctx, scan.warnings);
  return toEntries(rec.id, selectSkills(rec.id, scan, rec.selection, true), (d) => path.relative(dir, d));
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
      .map(({ id, revision, dir, manifest }) => ({ id, revision, dir, manifest }))
      .sort((a, b) => Number(a.id > b.id) - Number(a.id < b.id));
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

export async function migrateStore(): Promise<boolean> {
  const current = await openLegacyCatalog();
  if (current !== null) {
    current.db.close();
    if (current.version === SCHEMA_VERSION) return false;
  }
  const lock = await writerLock();
  let temp: { db: DatabaseSync; file: string } | undefined;
  try {
    await cleanupCatalogTemps();
    const legacy = await openLegacyCatalog();
    if (legacy === null) {
      if (
        (await lstat(sourcesFile()).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return null;
          throw err;
        })) !== null
      )
        throw new MargraveError(`cannot upgrade the store because ${indexDbFile()} is missing. Restore the complete v0.2.1 backup`);
      await readSources();
      return false;
    }
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
      if (legacy.version === SCHEMA_VERSION) return false;
      if (legacy.version !== 2 && legacy.version !== 3) throw new MargraveError(`${indexDbFile()} is not a supported margrave catalog`);
      version = legacy.version;
      if (version === 3) {
        const records = legacy.db.prepare("SELECT id, record FROM sources").all() as { id: string; record: string }[];
        for (const row of records) {
          const record: unknown = JSON.parse(row.record);
          if (typeof record === "object" && record !== null && Object.hasOwn(record, "selection"))
            throw new MargraveError(
              `cannot upgrade source "${row.id}" because its source record, index, or files disagree. Restore a known-good backup or recover the source from a verified lock`,
            );
        }
        sources = catalogSources(legacy.db);
      }
      rows = legacy.db
        .prepare("SELECT id, name, description, source, dir, hash AS revision, manifest, frontmatter FROM skills ORDER BY id")
        .all() as typeof rows;
    } finally {
      legacy.db.close();
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
        sources = await readLegacySources();
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
          `cannot upgrade source "${rec.id}" because its source record, index, or files disagree. Restore a known-good backup or recover the source from a verified lock`,
        );
      try {
        if (ids.has(rec.id)) throw conflict();
        ids.add(rec.id);
        if (rec.kind === "git") {
          const parsed = parseSpec(rec.spec);
          if (parsed.kind !== "git" || parsed.id !== rec.id || parsed.url !== rec.url || parsed.subpath !== rec.subpath) throw conflict();
          const snapshot = gitDir(rec);
          const st = await lstat(snapshot);
          const expected = path.join(await realpath(home()), "snapshots", rec.id, rec.snapshot as string);
          if (!st.isDirectory() || st.isSymbolicLink() || (await realpath(snapshot)) !== expected) throw conflict();
        }
        const scanned = await scanInstalledSource(rec, { log: () => {}, allowUnsafe: false });
        const indexed = rows.filter((row) => row.source === rec.id);
        if (indexed.length !== scanned.length) throw conflict();
        for (const entry of scanned) {
          const row = indexed.find((item) => item.id === entry.id);
          if (
            row === undefined ||
            row.revision !== entry.revision ||
            row.manifest !== entry.manifest ||
            row.name !== entry.name ||
            row.description !== entry.description ||
            row.frontmatter !== entry.frontmatter
          )
            throw conflict();
          let indexedDir = row.dir;
          if (rec.kind === "git" && version === 2) {
            const marker = `${path.sep}snapshots${path.sep}${rec.id}${path.sep}${rec.snapshot}`;
            const at = row.dir.lastIndexOf(marker);
            if (!path.isAbsolute(row.dir) || at < 0) throw conflict();
            const suffix = row.dir.slice(at + marker.length);
            if (suffix !== "" && !suffix.startsWith(path.sep)) throw conflict();
            indexedDir = suffix.slice(1);
            if (path.normalize(indexedDir) !== (indexedDir || ".")) throw conflict();
          }
          if (indexedDir !== entry.dir) throw conflict();
          paths.set(row.id, indexedDir);
          entries.push(entry);
        }
      } catch {
        throw conflict();
      }
    }
    if (rows.some((row) => !ids.has(row.source)) || paths.size !== rows.length)
      throw new MargraveError("cannot upgrade the v0.2.1 catalog: index contains an unknown source");
    temp = await copyLegacyCatalog();
    temp.db.exec("BEGIN IMMEDIATE");
    if (version === 2) {
      temp.db.exec("CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL)");
      putCatalogSources(temp.db, sources);
    }
    const update = temp.db.prepare("UPDATE skills SET dir = ? WHERE id = ?");
    for (const [id, dir] of paths) update.run(dir, id);
    temp.db.exec(`DROP TABLE fts; ${FTS_SCHEMA}`);
    const insert = temp.db.prepare(
      "INSERT INTO fts(rowid, name, description, headings, body) SELECT rowid, ?, ?, ?, ? FROM skills WHERE id = ?",
    );
    for (const entry of entries)
      insert.run(entry.tokens.name, entry.tokens.description, entry.tokens.headings, entry.tokens.body, entry.id);
    temp.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT`);
    temp.db.close();
    await publishCatalog(temp.file);
    await repairAliases(sources, sources);
    return true;
  } finally {
    try {
      if (temp?.db.isOpen === true) temp.db.close();
      if (temp !== undefined) {
        await cleanupCatalogTemps();
      }
    } finally {
      lock.close();
    }
  }
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
  const db = await openCatalogReadOptional();
  if (db === null) return { sources: [], skills: [] };
  try {
    const sources = catalogSources(db);
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

export { commit, git, gitDir, logWarnings, ownedStage, scanInstalledSource, syncSnapshot, toEntries };
