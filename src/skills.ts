// find / load / read-file, id resolution, path guard, terminal-safe text.
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { clampLimit, rank } from "./bm25.ts";
import { splitSkillMd } from "./scan.ts";
import { MargraveError, readIndex, readSources } from "./store.ts";
import type { IndexEntry, IndexFile, SourceRecord } from "./store.ts";

export const NO_SOURCES_MESSAGE = "no skill sources installed; run: margrave install <owner/repo|path>";

// oxlint-disable-next-line no-control-regex -- intentional: this strips control characters
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/gu;
// C0 and C1 control characters, minus tab and newline.
// oxlint-disable-next-line no-control-regex -- intentional: this strips control characters
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** One-line text for human output: strips ANSI escapes and control characters. */
export function clean(s: string): string {
  return s
    .replace(ANSI, "")
    .replace(/[\t\n]/gu, " ")
    .replace(CONTROL, "");
}

/** Multi-line text for human output: like clean(), but keeps newlines and tabs. */
export function cleanBlock(s: string): string {
  return s.replace(ANSI, "").replace(CONTROL, "");
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/.:=@%+,~-]+$/u.test(s) ? s : `'${s.replace(/'/gu, `'\\''`)}'`;
}

export interface Context {
  sources: SourceRecord[];
  index: IndexFile;
}

/** Returns null when no sources are installed. */
export async function loadContext(): Promise<Context | null> {
  const sources = await readSources();
  if (sources.length === 0) return null;
  const index = await readIndex();
  if (index === null) throw new MargraveError("index.json is missing; run: margrave reindex");
  return { sources, index };
}

/** Find a skill by qualified id, or by bare name when exactly one source has it. */
export function resolveSkill(index: IndexFile, input: string): IndexEntry {
  const exact = index.skills.find((s) => s.id === input);
  if (exact !== undefined) return exact;
  const byName = index.skills.filter((s) => s.name === input);
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];
  if (byName.length > 1) {
    const ids = byName
      .map((s) => `  ${clean(s.id)}`)
      .sort()
      .join("\n");
    throw new MargraveError(`"${clean(input)}" is ambiguous; use one of these ids:\n${ids}`);
  }
  throw new MargraveError(`no skill "${clean(input)}"; run: margrave find "<task>" or margrave list --skills`);
}

export interface FindHit {
  id: string;
  name: string;
  description: string;
  score: number;
}

export function findSkills(index: IndexFile, task: string, limit: unknown): FindHit[] {
  const byId = new Map(index.skills.map((s) => [s.id, s]));
  const ranked = rank(index.skills, index.stats, task, clampLimit(limit));
  const hits: FindHit[] = [];
  for (const r of ranked) {
    const e = byId.get(r.id);
    if (e !== undefined) hits.push({ id: e.id, name: e.name, description: e.description, score: r.score });
  }
  return hits;
}

export function formatFind(hits: readonly FindHit[]): string {
  if (hits.length === 0) {
    return "no match\ntry other words, or list everything with: margrave list --skills";
  }
  const lines: string[] = [];
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${clean(h.id)}  (score ${h.score.toFixed(3)})`);
    lines.push(`   ${clean(h.description)}`);
  });
  const top = hits[0];
  if (top !== undefined) lines.push(`load: margrave load ${shellQuote(clean(top.id))}`);
  return lines.join("\n");
}

const MAX_LISTED_FILES = 200;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Regular files inside a skill dir, relative, sorted. Follows no symlink. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(path.join(d, e.name), `${prefix}${e.name}/`);
      } else if (e.isFile()) {
        out.push(`${prefix}${e.name}`);
      }
    }
  }
  await walk(dir, "");
  out.sort();
  return out;
}

/**
 * Read one file inside a skill directory. realpath(file) must start with
 * realpath(dir) plus a separator. Refuses absolute paths and anything that escapes.
 */
export async function readSkillFile(dir: string, rel: string): Promise<string> {
  if (rel === "") throw new MargraveError("path is empty");
  if (path.isAbsolute(rel)) throw new MargraveError("path must be relative to the skill directory");
  let realDir: string;
  try {
    realDir = await realpath(dir);
  } catch {
    throw new MargraveError(`skill directory ${clean(dir)} is gone; run: margrave reindex`);
  }
  const prefix = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
  const joined = path.resolve(realDir, rel);
  // Lexical check first, so a path outside the directory never reveals whether it exists.
  if (!joined.startsWith(prefix)) throw new MargraveError(`path ${clean(rel)} is outside the skill directory`);
  let realFile: string;
  try {
    realFile = await realpath(joined);
  } catch {
    throw new MargraveError(`no such file in the skill directory: ${clean(rel)}`);
  }
  if (!realFile.startsWith(prefix)) {
    throw new MargraveError(`path ${clean(rel)} is outside the skill directory`);
  }
  const st = await stat(realFile);
  if (!st.isFile()) throw new MargraveError(`not a file: ${clean(rel)}`);
  return readFile(realFile, "utf8");
}

export interface LoadResult {
  id: string;
  source: string;
  spec: string;
  commit: string | null;
  base: string;
  frontmatter: string;
  files: string[];
  body: string;
}

export async function loadSkill(entry: IndexEntry, sources: readonly SourceRecord[]): Promise<LoadResult> {
  const st = await lstat(entry.dir).catch(() => null);
  if (st === null) throw new MargraveError(`skill directory ${clean(entry.dir)} is gone; run: margrave reindex`);
  const text = await readSkillFile(entry.dir, "SKILL.md");
  const { rawFrontmatter, body } = splitSkillMd(text);
  const src = sources.find((s) => s.id === entry.source);
  return {
    id: entry.id,
    source: entry.source,
    spec: src?.spec ?? "",
    commit: src?.commit ?? null,
    base: entry.dir,
    frontmatter: rawFrontmatter ?? "",
    files: await listFiles(entry.dir),
    body,
  };
}

/** The load header is metadata, so it is cleaned. The body is the payload and stays unchanged. */
export function formatLoad(r: LoadResult): string {
  const shown = r.files.slice(0, MAX_LISTED_FILES).map((f) => `- ${clean(f)}`);
  if (r.files.length > MAX_LISTED_FILES) shown.push(`- ... ${r.files.length - MAX_LISTED_FILES} more`);
  const header = [
    `skill: ${clean(r.id)}`,
    `source: ${clean(r.source)}${r.spec === "" ? "" : ` (${clean(r.spec)})`}`,
    `commit: ${r.commit === null ? "none (local directory)" : clean(r.commit)}`,
    `base: ${clean(r.base)}`,
    "frontmatter:",
    "---",
    cleanBlock(r.frontmatter),
    "---",
    "files:",
    ...shown,
    "body:",
  ].join("\n");
  return `${header}\n${r.body}`;
}
