// The margrave store: MARGRAVE_HOME, sources.json, index.json. Writes are atomic.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CorpusStats, FieldTokens } from "./bm25.ts";

/** An error whose message is meant for the user. The CLI prints it and exits 1. */
export class MargraveError extends Error {}
/** A usage error. The CLI prints it and exits 2. */
export class UsageError extends Error {}
/** An error caused by the caller's input. Its message holds no server path, so a remote client may see it. */
export class RequestError extends MargraveError {}

export type SourceKind = "git" | "local";

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  spec: string;
  /** Git sources only. */
  url?: string;
  /** Local sources only: the absolute real path. */
  path?: string;
  /** Subdirectory inside the clone. Empty string for none. */
  subpath: string;
  ref: string | null;
  commit: string | null;
  installedAt: string;
}

export interface IndexEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  dir: string;
  /** Hash of SKILL.md, used by `update` to report changed skills. */
  hash: string;
  frontmatter: Record<string, unknown>;
  headings: string[];
  fieldTokens: FieldTokens;
}

export interface IndexFile {
  version: 1;
  skills: IndexEntry[];
  stats: CorpusStats;
}

export function home(): string {
  const env = process.env["MARGRAVE_HOME"];
  return path.resolve(env !== undefined && env !== "" ? env : path.join(homedir(), ".margrave"));
}

export const sourcesRoot = (): string => path.join(home(), "sources");
export const stagingRoot = (): string => path.join(home(), "staging");
export const reportsRoot = (): string => path.join(home(), "reports");
export const sourcesFile = (): string => path.join(home(), "sources.json");
export const indexFile = (): string => path.join(home(), "index.json");

export async function ensureDirs(): Promise<void> {
  await mkdir(sourcesRoot(), { recursive: true });
  await mkdir(stagingRoot(), { recursive: true });
}

/** Write a file by writing a temp file in the same directory, then renaming it. */
export async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validSource(v: unknown): v is SourceRecord {
  if (!isRecord(v)) return false;
  if (typeof v["id"] !== "string" || typeof v["spec"] !== "string") return false;
  if (v["kind"] !== "git" && v["kind"] !== "local") return false;
  if (typeof v["subpath"] !== "string") return false;
  if (v["ref"] !== null && typeof v["ref"] !== "string") return false;
  if (v["commit"] !== null && typeof v["commit"] !== "string") return false;
  if (typeof v["installedAt"] !== "string") return false;
  if (v["kind"] === "git") return typeof v["url"] === "string";
  return typeof v["path"] === "string";
}

/** A missing file is an empty list. A malformed file is an error. */
export async function readSources(): Promise<SourceRecord[]> {
  const file = sourcesFile();
  const raw = await readIfExists(file);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MargraveError(`${file} is not valid JSON (${(err as Error).message}); fix or delete it`);
  }
  if (!Array.isArray(parsed) || !parsed.every(validSource)) {
    throw new MargraveError(`${file} is malformed (expected a list of source records); fix or delete it`);
  }
  return parsed;
}

export async function writeSources(sources: readonly SourceRecord[]): Promise<void> {
  await atomicWrite(sourcesFile(), `${JSON.stringify(sources, null, 2)}\n`);
}

/** Returns null when index.json does not exist. A malformed file is an error. */
export async function readIndex(): Promise<IndexFile | null> {
  const file = indexFile();
  const raw = await readIfExists(file);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MargraveError(`${file} is not valid JSON; run: margrave reindex`);
  }
  if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["skills"]) || !isRecord(parsed["stats"])) {
    throw new MargraveError(`${file} is malformed; run: margrave reindex`);
  }
  return parsed as unknown as IndexFile;
}

export async function writeIndex(index: IndexFile): Promise<void> {
  await atomicWrite(indexFile(), JSON.stringify(index));
}
