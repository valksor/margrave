// SKILL.md discovery, frontmatter parsing, headings.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { buildFieldTokens } from "./bm25.ts";
import type { FieldTokens } from "./bm25.ts";

const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Open flags for reading a file we must not follow: no symlink as the last component, and a FIFO does not block the open. */
export const READ_NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface ScannedSkill {
  name: string;
  description: string;
  /** Absolute path of the skill directory as walked (under the scan root). */
  dir: string;
  hash: string;
  frontmatter: Record<string, unknown>;
  headings: string[];
  fieldTokens: FieldTokens;
}

export interface ScanResult {
  skills: ScannedSkill[];
  warnings: string[];
}

export interface ScanOptions {
  /** Local sources follow directory symlinks. Git sources follow none. */
  followSymlinks: boolean;
  /**
   * Git sources only: the directory that every skill must stay inside, by realpath.
   * Defaults to the scan root. A git source with a subpath passes the clone root.
   */
  boundary?: string;
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
    const f = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (f !== null) {
      // Group 1 is one or more fence characters, so its first character exists.
      const marker = (f[1] as string)[0] as string;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (h !== null && h[1] !== undefined) out.push(h[1]);
  }
  return out;
}

type Parsed = { ok: true; skill: Omit<ScannedSkill, "dir"> } | { ok: false; reason: string };

export function parseSkillMd(text: string): Parsed {
  const { rawFrontmatter, body } = splitSkillMd(text);
  if (rawFrontmatter === null) return { ok: false, reason: "no frontmatter" };
  let fm: unknown;
  try {
    fm = YAML.parse(rawFrontmatter);
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
      hash: createHash("sha256").update(text).digest("hex"),
      frontmatter: rec,
      headings,
      fieldTokens: buildFieldTokens({ name: name.trim(), description: description.trim(), headings, body }),
    },
  };
}

/** Walk `root` for skill directories (a directory that holds a SKILL.md). */
export async function scanSource(root: string, opts: ScanOptions): Promise<ScanResult> {
  const skills: ScannedSkill[] = [];
  const warnings: string[] = [];
  const realRoot = await realpath(root);
  const realBoundary = opts.boundary !== undefined ? await realpath(opts.boundary) : realRoot;
  // Realpaths of every directory walked, so a symlink cycle or a second path to a directory is walked once.
  const visited = new Set<string>();
  const seenNames = new Set<string>();

  async function walk(dir: string): Promise<void> {
    const realDir = await realpath(dir).catch(() => null);
    if (realDir === null || visited.has(realDir)) return;
    visited.add(realDir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`cannot read ${dir}: ${(err as Error).message}`);
      return;
    }
    // Names in one directory are unique, so two names are never equal.
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));

    const skillMd = entries.find((e) => e.name === "SKILL.md");
    if (skillMd !== undefined) {
      await addSkill(dir, skillMd.isSymbolicLink());
      return;
    }

    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const child = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(child);
      } else if (e.isSymbolicLink()) {
        if (!opts.followSymlinks) {
          // Git sources: a symlink might be a skill dir. Report only when it is a directory.
          const st = await stat(child).catch(() => null);
          if (st?.isDirectory()) warnings.push(`skipped symlink ${child} (git sources follow no symlinks)`);
          continue;
        }
        const st = await stat(child).catch(() => null);
        if (st === null || !st.isDirectory()) continue;
        await walk(child);
      }
    }
  }

  async function addSkill(dir: string, skillMdIsSymlink: boolean): Promise<void> {
    const file = path.join(dir, "SKILL.md");
    if (skillMdIsSymlink) {
      warnings.push(`skipped ${file}: SKILL.md is a symlink`);
      return;
    }
    // Local sources follow symlinks on purpose, so only git sources are held to the boundary.
    const realDir = await realpath(dir);
    if (!opts.followSymlinks && !isInside(realDir, realBoundary)) {
      warnings.push(`skipped ${dir}: resolves outside the source`);
      return;
    }
    let text: string;
    try {
      const fh = await open(file, READ_NO_FOLLOW);
      try {
        if (!(await fh.stat()).isFile()) {
          warnings.push(`skipped ${file}: not a regular file`);
          return;
        }
        text = await fh.readFile("utf8");
      } finally {
        await fh.close();
      }
    } catch (err) {
      warnings.push(`skipped ${file}: ${(err as Error).message}`);
      return;
    }
    const parsed = parseSkillMd(text);
    if (!parsed.ok) {
      warnings.push(`skipped ${file}: ${parsed.reason}`);
      return;
    }
    if (seenNames.has(parsed.skill.name)) {
      warnings.push(`skipped ${file}: duplicate skill name "${parsed.skill.name}" in this source`);
      return;
    }
    seenNames.add(parsed.skill.name);
    skills.push({ ...parsed.skill, dir });
  }

  await walk(root);
  // Names are unique within a source (see seenNames), so two names are never equal.
  skills.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { skills, warnings };
}
