import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { MargraveError, RequestError } from "./store.ts";
import { clean } from "./text.ts";

export const READ_NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export class HostedSizeError extends RequestError {
  constructor() {
    super("skill file exceeds the hosted size limit");
  }
}

const SKIP_DIRS = new Set(["node_modules"]);

async function readOpenedFile(fh: FileHandle, rel: string, limit?: number): Promise<Buffer> {
  const stat = await fh.stat();
  if (!stat.isFile()) throw new RequestError(`not a file: ${clean(rel)}`);
  if (limit === undefined) return fh.readFile();
  if (stat.size > limit) throw new HostedSizeError();
  const bytes = Buffer.allocUnsafe(limit + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await fh.read(bytes, offset, bytes.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > limit) throw new HostedSizeError();
  return bytes.subarray(0, offset);
}

/** True when a path relative to the skill dir has a component named .git (case-insensitive, for APFS). HFS+ ignorable code points are not covered. */
function isGitPath(rel: string): boolean {
  return rel.split(path.sep).some((s) => s.toLowerCase() === ".git");
}

/** Regular files inside a skill dir, relative, sorted. Follows no symlink. */
export async function listFiles(dir: string, strict = false): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (err) {
      if (strict) throw err;
      return;
    }
    for (const e of entries) {
      if (e.name.toLowerCase() === ".git") continue;
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
export async function readSkillFileBytes(dir: string, rel: string, rawMissing = false, canonical = false, limit?: number): Promise<Buffer> {
  if (rel === "") throw new RequestError("path is empty");
  if (rel.includes("\0")) throw new RequestError(`no such file in the skill directory: ${clean(rel)}`);
  if (path.isAbsolute(rel)) throw new RequestError("path must be relative to the skill directory");
  let realDir: string;
  try {
    realDir = await realpath(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (rawMissing) throw err;
    throw new MargraveError(`skill directory ${clean(dir)} is gone; run: margrave reindex`);
  }
  const prefix = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
  const joined = path.resolve(realDir, rel);
  // Lexical check first, so a path outside the directory never reveals whether it exists.
  if (!joined.startsWith(prefix)) throw new RequestError(`path ${clean(rel)} is outside the skill directory`);
  if (isGitPath(path.relative(realDir, joined))) throw new RequestError(`path ${clean(rel)} is inside .git, which is not served`);
  let realFile: string;
  try {
    realFile = await realpath(joined);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (rawMissing) throw err;
    throw new RequestError(`no such file in the skill directory: ${clean(rel)}`);
  }
  if (!realFile.startsWith(prefix)) {
    throw new RequestError(`path ${clean(rel)} is outside the skill directory`);
  }
  if (canonical && realFile !== joined) throw new Error("file path changed during manifest construction");
  if (isGitPath(path.relative(realDir, realFile))) throw new RequestError(`path ${clean(rel)} is inside .git, which is not served`);
  const fh = await open(realFile, READ_NO_FOLLOW);
  try {
    return await readOpenedFile(fh, rel, limit);
  } finally {
    await fh.close();
  }
}

export async function readSkillFile(dir: string, rel: string): Promise<string> {
  return (await readSkillFileBytes(dir, rel)).toString("utf8");
}
