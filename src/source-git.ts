import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { MargraveError, UsageError } from "./store-files.ts";
import type { SourceRecord } from "./store-files.ts";

const ID_RE = /^[A-Za-z0-9._-]+$/u;

/** Replace every character outside [A-Za-z0-9._-] with "-". */
export function sanitizeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/gu, "-");
}

export function checkId(id: string): string {
  if (id === "." || id === ".." || !ID_RE.test(id)) {
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
  let host: string;
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

const GIT_ENV_PROTOCOLS = "https:ssh:git:file";
export const qualifiedRef = (ref: string | null): ref is `refs/heads/${string}` | `refs/tags/${string}` =>
  /^refs\/(heads|tags)\//u.test(String(ref));

export function git(args: string[]): Promise<string> {
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

export async function gitClone(url: string, ref: string | null, dest: string): Promise<string> {
  const qualified = qualifiedRef(ref);
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

export async function installedRef(clone: string, ref: string | null): Promise<string> {
  if (qualifiedRef(ref)) return ref;
  if (ref === null) return (await git(["-C", clone, "symbolic-ref", "HEAD"])).trim();
  return git(["-C", clone, "symbolic-ref", "-q", "HEAD"])
    .then((head) => head.trim())
    .catch(() => `refs/tags/${ref}`);
}

export async function validateUpdateRef(ref: string | null, source: SourceRecord | undefined): Promise<void> {
  if (ref === null) return;
  if (source?.kind !== "git") throw new UsageError("update --ref requires one Git source");
  await validateUpdateRefSyntax(ref);
}

export async function validateUpdateRefSyntax(ref: string): Promise<void> {
  if (!qualifiedRef(ref)) throw new UsageError("update --ref requires a fully qualified Git branch or tag");
  await validateGitRef(ref, "update --ref requires a fully qualified Git branch or tag");
}

export async function validateGitRef(ref: string, message?: string): Promise<void> {
  try {
    await git(["check-ref-format", ref]);
  } catch (err) {
    if (err instanceof MargraveError && (err.cause as { code?: string | number } | undefined)?.code === 1) {
      throw new UsageError(message ?? err.message);
    }
    throw err;
  }
}

export async function remoteRefs(url: string, ref: string): Promise<Map<string, string>> {
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
    const [sha, name] = line.split("\t") as [string, string?];
    if (name === undefined) continue;
    if (name.endsWith("^{}")) peeled.set(name.slice(0, -3), sha);
    else if (names.includes(name)) found.set(name, sha);
  }
  for (const [name, sha] of peeled) if (found.has(name)) found.set(name, sha);
  return found;
}

export async function trackingRef(rec: SourceRecord): Promise<string> {
  const ref = rec.ref as string;
  await validateGitRef(ref);
  const refs = await remoteRefs(rec.url as string, ref);
  const sha = refs.get(ref);
  if (sha === undefined) throw new MargraveError("remote tracking ref was not found");
  return sha;
}
