import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { esc } from "./safety.ts";
import type { ScannedSkill } from "./scan.ts";
import { isInside, scanSource } from "./scan.ts";
import { checkId } from "./source-git.ts";
import type { NewEntry, SourceRecord } from "./store-files.ts";
import { MargraveError, ensureDirs, home, sourcesRoot, stagingRoot } from "./store-files.ts";
import {
  catalogSources,
  cleanupCatalogTemps,
  openIndexRead,
  publishCatalog,
  putCatalogSources,
  temporaryCatalog,
  writerLock,
} from "./catalog.ts";

export interface Ctx {
  /** Progress and warnings. The CLI writes these to stderr. */
  log: (msg: string) => void;
  allowUnsafe: boolean;
}

/** The directory of a git source. Checks that it is a direct child of sources/. */
export function sourceDir(id: string): string {
  checkId(id);
  const root = path.resolve(sourcesRoot());
  const dir = path.join(root, id);
  // Keep both path checks as independent defenses before recursive removal, even if checkId() changes.
  if (path.dirname(dir) !== root || path.basename(dir) !== id) {
    throw new MargraveError(`refused: ${dir} is not a direct child of ${root}`);
  }
  return dir;
}

/** Resolve a record only within its own snapshot directory. */
export function gitDir(rec: SourceRecord): string {
  sourceDir(rec.id);
  return path.join(home(), "snapshots", rec.id, rec.snapshot as string);
}

/** Find a source by id, or by its original spec. */
export function findSource(sources: readonly SourceRecord[], arg: string): SourceRecord {
  const byId = sources.find((s) => s.id === arg);
  if (byId !== undefined) return byId;
  const bySpec = sources.filter((s) => s.spec === arg);
  if (bySpec.length === 1) return bySpec[0]!;
  if (bySpec.length !== 0) {
    throw new MargraveError(`"${arg}" matches several sources; use an id:\n${bySpec.map((s) => `  ${s.id}`).join("\n")}`);
  }
  throw new MargraveError(`no source "${arg}"; run: margrave list`);
}

export async function withStaging<T>(fn: (stage: string) => Promise<T>): Promise<T> {
  const stage = await ownedStage("s-");
  try {
    return await fn(stage.dir);
  } finally {
    await stage.close();
  }
}

export async function ownedStage(prefix: "s-" | "restore-"): Promise<{ dir: string; close: () => Promise<void> }> {
  await ensureDirs();
  const lock = await writerLock();
  let dir: string | undefined;
  let owner: DatabaseSync | undefined;
  let result: { dir: string; close: () => Promise<void> };
  try {
    dir = await mkdtemp(path.join(stagingRoot(), prefix));
    owner = new DatabaseSync(path.join(dir, ".margrave-owner.db"));
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
      owner = new DatabaseSync(file);
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
          owner!.close();
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

export function toEntries(sourceId: string, skills: readonly ScannedSkill[], mapDir: (dir: string) => string): NewEntry[] {
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

export async function prepareSnapshot(
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

export async function syncSnapshot(destination: string): Promise<void> {
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

export async function repairAliases(before: readonly SourceRecord[], after: readonly SourceRecord[]): Promise<void> {
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
export async function checkIndex(sources: readonly SourceRecord[]): Promise<void> {
  if (sources.length > 0) (await openIndexRead()).close();
}

/** Build and publish the next catalog while holding the separate writer lock. */
export async function commit(
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

export function logWarnings(ctx: Pick<Ctx, "log">, warnings: readonly string[]): void {
  for (const w of warnings) ctx.log(`warning: ${esc(w)}`);
}

export function diffEntries(before: ReadonlyMap<string, string>, next: readonly NewEntry[]) {
  const after = new Map(next.map((e) => [e.id, e.revision]));
  return {
    added: [...after.keys()].filter((k) => !before.has(k)).sort(),
    removed: [...before.keys()].filter((k) => !after.has(k)).sort(),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)).sort(),
  };
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

export async function scanLocal(rec: SourceRecord, ctx: Pick<Ctx, "log">): Promise<NewEntry[]> {
  // readSources() only returns a local record with a path.
  const root = await realpath(rec.path as string).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new MargraveError(`${rec.path} is not readable; remove the source or restore the directory`);
    throw err;
  });
  const scan = await scanSource(root, { followSymlinks: true, strict: true });
  logWarnings(ctx, scan.warnings);
  return toEntries(rec.id, selectSkills(rec.id, scan, rec.selection, true), (d) => d);
}

export async function scanInstalledSource(rec: SourceRecord, ctx: Pick<Ctx, "log">): Promise<NewEntry[]> {
  if (rec.kind === "local") return scanLocal(rec, ctx);
  const dir = gitDir(rec);
  const root = await resolveScanRoot(dir, rec.subpath);
  const scan = await scanSource(root, { followSymlinks: false, boundary: dir, strict: true });
  logWarnings(ctx, scan.warnings);
  return toEntries(rec.id, selectSkills(rec.id, scan, rec.selection, true), (d) => path.relative(dir, d));
}
