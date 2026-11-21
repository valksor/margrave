// SKILL.md discovery, frontmatter parsing, headings.
import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { buildFieldTokens } from "./bm25.ts";
import { READ_NO_FOLLOW, listFiles, readSkillFileBytes } from "./skill-files.ts";
import type { TokenStrings } from "./bm25.ts";

const SKIP_DIRS = new Set(["node_modules"]);

export { READ_NO_FOLLOW } from "./skill-files.ts";

export interface ScannedSkill {
  name: string;
  description: string;
  /** Absolute path of the skill directory as walked (under the scan root). */
  dir: string;
  revision: string;
  manifest: ManifestEntry[];
  frontmatter: string;
  /** Token strings for the FTS columns, built from name, description, headings, and body. */
  tokens: TokenStrings;
}

export interface ManifestEntry {
  path: string;
  digest: string;
  size: number;
}

export interface ScanResult {
  skills: ScannedSkill[];
  warnings: string[];
  duplicates: string[];
}

export interface ScanOptions {
  /** Local sources follow directory symlinks. Git sources follow none. */
  followSymlinks: boolean;
  /**
   * Git sources only: the directory that every skill must stay inside, by realpath.
   * Defaults to the scan root. A git source with a subpath passes the clone root.
   */
  boundary?: string;
  strict?: boolean;
}

/** True when `child` is `parent` or inside it. Compares with a trailing separator. */
export function isInside(child: string, parent: string): boolean {
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(prefix);
}

export interface ParsedSkillMd {
  /** Raw frontmatter text between the fences, or null when there is none. */
  rawFrontmatter: string | null;
  body: string;
}

/** Split SKILL.md into the raw frontmatter block and the body. */
export function splitSkillMd(text: string): ParsedSkillMd {
  const src = text.replace(/^﻿/u, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(src);
  if (m === null) {
    const empty = /^---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/u.exec(src);
    if (empty !== null) return { rawFrontmatter: "", body: src.slice(empty[0].length) };
    return { rawFrontmatter: null, body: src };
  }
  // Group 1 always takes part in a match, so it is a string here.
  return { rawFrontmatter: m[1] as string, body: src.slice(m[0].length) };
}

/** Markdown headings outside fenced code blocks. */
export function extractHeadings(body: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/u)) {
    // Backtick info strings cannot contain backticks; group 2 marks a whitespace-only suffix.
    const f = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})(?:([ \t]*$)|)/u.exec(line);
    if (f !== null) {
      const marker = f[1] as string;
      if (fence === null) fence = marker;
      else if (f[2] !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (h !== null) out.push(h[1] as string);
  }
  return out;
}

type Parsed = { ok: true; skill: Omit<ScannedSkill, "dir" | "manifest" | "frontmatter" | "revision"> } | { ok: false; reason: string };

export function parseFrontmatter(raw: string): unknown {
  return YAML.parse(raw);
}

export function parseSkillMd(text: string): Parsed {
  const { rawFrontmatter, body } = splitSkillMd(text);
  if (rawFrontmatter === null) return { ok: false, reason: "no frontmatter" };
  let fm: unknown;
  try {
    fm = parseFrontmatter(rawFrontmatter);
  } catch (err) {
    return { ok: false, reason: `frontmatter is not valid YAML (${(err as Error).message.split("\n")[0]})` };
  }
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) {
    return { ok: false, reason: "frontmatter is not a mapping" };
  }
  const rec = fm as Record<string, unknown>;
  const name = rec["name"];
  const description = rec["description"];
  if (typeof name !== "string" || name.trim() === "") return { ok: false, reason: "missing name" };
  if (typeof description !== "string" || description.trim() === "") {
    return { ok: false, reason: "missing description" };
  }
  const headings = extractHeadings(body);
  return {
    ok: true,
    skill: {
      name: name.trim(),
      description: description.trim(),
      tokens: buildFieldTokens({ name, description, headings, body }),
    },
  };
}

interface ScanState {
  opts: ScanOptions;
  boundary: string;
  visited: Set<string>;
  duplicates: Set<string>;
  skills: Map<string, ScannedSkill>;
  warnings: string[];
}

async function buildSkillManifest(dir: string, skillBytes: Buffer): Promise<{ manifest: ManifestEntry[]; revision: string }> {
  const manifest: ManifestEntry[] = [];
  for (const rel of await listFiles(dir, true)) {
    const data = rel === "SKILL.md" ? skillBytes : await readSkillFileBytes(dir, rel, true, true);
    manifest.push({ path: rel, digest: `sha256:${createHash("sha256").update(data).digest("hex")}`, size: data.length });
  }
  if (!manifest.some((entry) => entry.path === "SKILL.md")) throw new Error("SKILL.md disappeared during manifest construction");
  const revision = `sha256:${createHash("sha256")
    .update(JSON.stringify(manifest.map((e) => [e.path, e.digest, e.size])))
    .digest("hex")}`;
  return { manifest, revision };
}

async function ingestSkill(state: ScanState, dir: string, skillMdIsSymlink: boolean): Promise<void> {
  const file = path.join(dir, "SKILL.md");
  if (skillMdIsSymlink) {
    state.warnings.push(`skipped ${file}: SKILL.md is a symlink`);
    return;
  }
  const realDir = await realpath(dir);
  if (!state.opts.followSymlinks && !isInside(realDir, state.boundary)) {
    state.warnings.push(`skipped ${dir}: resolves outside the source`);
    return;
  }
  let bytes: Buffer;
  try {
    const fh = await open(file, READ_NO_FOLLOW);
    try {
      if (!(await fh.stat()).isFile()) {
        state.warnings.push(`skipped ${file}: not a regular file`);
        return;
      }
      bytes = await fh.readFile();
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (state.opts.strict) throw err;
    state.warnings.push(`skipped ${file}: ${(err as Error).message}`);
    return;
  }
  const text = bytes.toString("utf8");
  const parsed = parseSkillMd(text);
  if (!parsed.ok) {
    state.warnings.push(`skipped ${file}: ${parsed.reason}`);
    return;
  }
  if (state.skills.has(parsed.skill.name)) {
    state.duplicates.add(parsed.skill.name);
    state.warnings.push(`skipped ${file}: duplicate skill name "${parsed.skill.name}" in this source`);
    return;
  }
  let collected: { manifest: ManifestEntry[]; revision: string };
  try {
    collected = await buildSkillManifest(dir, bytes);
  } catch (err) {
    if (state.opts.strict) throw err;
    state.warnings.push(`skipped ${file}: ${(err as Error).message}`);
    return;
  }
  state.skills.set(parsed.skill.name, { ...parsed.skill, ...collected, frontmatter: splitSkillMd(text).rawFrontmatter as string, dir });
}

async function walkSource(state: ScanState, dir: string): Promise<void> {
  const realDir = await realpath(dir).catch((err: NodeJS.ErrnoException) => {
    if (state.opts.strict) throw err;
    return null;
  });
  if (realDir === null || state.visited.has(realDir)) return;
  state.visited.add(realDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (state.opts.strict) throw err;
    state.warnings.push(`cannot read ${dir}: ${(err as Error).message}`);
    return;
  }
  const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
  const skillMd = entriesByName.get("SKILL.md");
  if (skillMd !== undefined) {
    await ingestSkill(state, dir, skillMd.isSymbolicLink());
    return;
  }
  for (const name of [...entriesByName.keys()].sort()) {
    const entry = entriesByName.get(name)!;
    if (name.toLowerCase() === ".git" || SKIP_DIRS.has(name)) continue;
    const child = path.join(dir, name);
    if (entry.isDirectory()) {
      await walkSource(state, child);
    } else if (entry.isSymbolicLink()) {
      const st = await stat(child).catch((err: NodeJS.ErrnoException) => {
        if (state.opts.strict && err.code !== "ENOENT") throw err;
        return null;
      });
      if (st === null || !st.isDirectory()) continue;
      if (state.opts.followSymlinks) await walkSource(state, child);
      else state.warnings.push(`skipped symlink ${child} (git sources follow no symlinks)`);
    }
  }
}

/** Walk `root` for skill directories (a directory that holds a SKILL.md). */
export async function scanSource(root: string, opts: ScanOptions): Promise<ScanResult> {
  const realRoot = await realpath(root);
  const state: ScanState = {
    opts,
    boundary: opts.boundary !== undefined ? await realpath(opts.boundary) : realRoot,
    visited: new Set(),
    duplicates: new Set(),
    skills: new Map(),
    warnings: [],
  };
  await walkSource(state, root);
  const skills = [...state.skills.keys()].sort().map((name) => state.skills.get(name)!);
  return { skills, warnings: state.warnings, duplicates: [...state.duplicates].sort() };
}
