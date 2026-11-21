import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TokenStrings } from "./bm25.ts";
import type { ScanOutcome } from "./safety.ts";

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
  /** Managed Git snapshot key. */
  snapshot?: string;
  scan?: ScanOutcome;
  selection?: string[];
}

export type IndexEntry = {
  id: string;
  name: string;
  description: string;
  source: string;
  dir: string;
  revision: string;
  manifest: string;
  frontmatter: string;
};

/** An entry to write: the row plus the token strings for the FTS columns. */
export interface NewEntry extends IndexEntry {
  tokens: TokenStrings;
}

export function home(): string {
  const env = process.env["MARGRAVE_HOME"];
  return path.resolve(env !== undefined && env !== "" ? env : path.join(homedir(), ".margrave"));
}

export const sourcesRoot = (): string => path.join(home(), "sources");
export const stagingRoot = (): string => path.join(home(), "staging");
export const reportsRoot = (): string => path.join(home(), "reports");
export const sourcesFile = (): string => path.join(home(), "sources.json");
export const indexDbFile = (): string => path.join(home(), "index.db");
export const publishedMarker = (): string => path.join(home(), "catalog-published");

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

export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function validSourceLocation(v: Record<string, unknown>): boolean {
  if (typeof v["id"] !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]+$/u.test(v["id"])) return false;
  if (v["kind"] === "local") return v["snapshot"] === undefined && typeof v["path"] === "string" && path.isAbsolute(v["path"]);
  return (
    v["kind"] === "git" &&
    typeof v["snapshot"] === "string" &&
    typeof v["commit"] === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}$/u.test(v["snapshot"]) &&
    v["snapshot"].startsWith(`${v["commit"]}-`)
  );
}

function validSourceFields(v: Record<string, unknown>): boolean {
  if (v["selection"] !== undefined && !validSelection(v["selection"])) return false;
  if (typeof v["id"] !== "string" || typeof v["spec"] !== "string") return false;
  if (v["kind"] !== "git" && v["kind"] !== "local") return false;
  if (typeof v["subpath"] !== "string") return false;
  if (v["ref"] !== null && typeof v["ref"] !== "string") return false;
  if (v["commit"] !== null && typeof v["commit"] !== "string") return false;
  if (typeof v["installedAt"] !== "string") return false;
  if (!validSourceLocation(v)) return false;
  if (v["kind"] === "git")
    return typeof v["url"] === "string" && typeof v["ref"] === "string" && /^refs\/(?:heads|tags)\/.+/u.test(v["ref"]);
  return true;
}

export function validSelection(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((name, i) => typeof name === "string" && name !== "" && name.trim() === name && (i === 0 || value[i - 1] < name))
  );
}

export function validSource(v: unknown): v is SourceRecord {
  return isRecord(v) && validSourceFields(v) && (v["scan"] === undefined || (v["kind"] === "git" && validScan(v["scan"])));
}

export function validScan(value: unknown): value is ScanOutcome {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "code,files,keys,overridden,tree,verdict,version") return false;
  if (value["tree"] !== null && (typeof value["tree"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["tree"]))) return false;
  if (!(value["version"] === null || typeof value["version"] === "string") || typeof value["overridden"] !== "boolean") return false;
  const verdict = value["verdict"];
  if (!(["clean", "warn", "critical", "failed"] as unknown[]).includes(verdict)) return false;
  if (
    (verdict === "clean" && value["code"] !== 0) ||
    (verdict === "warn" && value["code"] !== 1) ||
    (verdict === "critical" && value["code"] !== 2)
  )
    return false;
  if (verdict === "failed" && value["code"] !== null && typeof value["code"] !== "number") return false;
  const relative = (s: unknown): s is string =>
    typeof s === "string" && s !== "" && !path.isAbsolute(s) && !s.split(path.sep).some((p) => p === ".." || p === "");
  if (!Array.isArray(value["keys"]) || !Array.isArray(value["files"])) return false;
  for (const item of value["keys"]) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !Number.isSafeInteger(item[1]) || item[1] < 1)
      return false;
    try {
      const key: unknown = JSON.parse(item[0]);
      if (
        !Array.isArray(key) ||
        key.length !== 4 ||
        !relative(key[0]) ||
        typeof key[1] !== "string" ||
        !["warn", "critical"].includes(key[2]) ||
        typeof key[3] !== "string" ||
        !/^[0-9a-f]{64}$/u.test(key[3])
      )
        return false;
    } catch {
      return false;
    }
  }
  return value["files"].every(
    (item: unknown) =>
      Array.isArray(item) && item.length === 2 && relative(item[0]) && typeof item[1] === "string" && /^[0-9a-f]{64}$/u.test(item[1]),
  );
}

/** A missing file is an empty list. A malformed file is an error. */
export async function readLegacySources(raw?: string): Promise<SourceRecord[]> {
  const file = sourcesFile();
  raw ??= (await readIfExists(file)) ?? undefined;
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MargraveError(`${file} is not valid JSON (${(err as Error).message}); fix or delete it`);
  }
  if (Array.isArray(parsed)) {
    for (const record of parsed) {
      if (isRecord(record) && typeof record["id"] === "string" && (Object.hasOwn(record, "scan") || Object.hasOwn(record, "selection")))
        throw new MargraveError(
          `cannot upgrade source "${record["id"]}" because its source record, index, or files disagree. Restore a known-good backup or recover the source from a verified lock`,
        );
    }
  }
  if (!Array.isArray(parsed) || !parsed.every(validSource)) {
    throw new MargraveError(`${file} is malformed (expected a list of source records); fix or delete it`);
  }
  return parsed;
}

export async function lstatIfExists(file: string): Promise<Stats | null> {
  return lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw new MargraveError(`cannot read ${file}: ${err.message}`);
  });
}
