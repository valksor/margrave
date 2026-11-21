import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Sev = "warn" | "critical";

/** Show C0 and C1 control characters and DEL as \xNN. For terminal output only. */
export function esc(s: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional: this escapes control characters
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

interface Execed {
  code: number | string | null;
  stdout: string;
  stderr: string;
  missing: boolean;
  /** Set instead of a scan: the vendored copy is not the pinned version, or ripwire on PATH is older than it or reports none. */
  refusal?: string;
  version?: string;
}

/**
 * The ripwire that `pnpm build` (scripts/ensure-ripwire.mjs) and the release bundles put in the package root.
 * It runs first, so a weaker ripwire on PATH cannot gate an install.
 */
export const VENDORED_RIPWIRE = fileURLToPath(new URL("../vendor/ripwire/ripwire", import.meta.url));

/** The ripwire version that scripts/ensure-ripwire.mjs vendors. A ripwire on PATH must be at least this version. */
export const PINNED_RIPWIRE = "0.6.10";

/** How long `ripwire --version` on PATH may run. */
export const VERSION_TIMEOUT_MS = 10_000;

const ENSURE_RIPWIRE = fileURLToPath(new URL("../scripts/ensure-ripwire.mjs", import.meta.url));
/** The first line of `ripwire --version`: `ripwire <X.Y.Z>`, optionally with a `-<pre-release>` suffix, then a space or the end. */
const VERSION_RE = /^ripwire (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/u;

function exec(bin: string, dir: string): Promise<Execed> {
  return new Promise((resolve) => {
    execFile(bin, ["security", `--scan-skills=${dir}`], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err === null) {
        resolve({ code: 0, stdout, stderr, missing: false });
        return;
      }
      const e = err as NodeJS.ErrnoException & { code?: number | string };
      resolve({ code: e.code ?? null, stdout, stderr, missing: e.code === "ENOENT" });
    });
  });
}

/**
 * True when version `found` is older than `pinned`. `found` is `<major>.<minor>.<patch>` with an optional `-<pre-release>`.
 * A pre-release is older than the same `<major>.<minor>.<patch>` without one. `pinned` has no suffix.
 */
function isOlder(found: string, pinned: string): boolean {
  const dash = found.indexOf("-");
  const a = (dash < 0 ? found : found.slice(0, dash)).split(".").map(Number);
  const b = pinned.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  }
  return dash >= 0;
}

type PathVersion =
  /** PATH has no ripwire. */
  | { status: "missing" }
  /** `--version` could not run, exited non-zero, or timed out. `why` names the cause. */
  | { status: "failed"; why: string }
  /** `--version` ran. `version` is null when its first line is not `ripwire <version>`. */
  | { status: "ran"; version: string | null };

/** What `ripwire --version` on PATH reports. */
function pathVersion(timeoutMs: number): Promise<PathVersion> {
  return new Promise((resolve) => {
    execFile("ripwire", ["--version"], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => {
      if (err === null) {
        resolve({ status: "ran", version: VERSION_RE.exec(stdout.split(/\r?\n/u, 1)[0] as string)?.[1] ?? null });
        return;
      }
      const e = err;
      if (e.code === "ENOENT") resolve({ status: "missing" });
      else if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") resolve({ status: "failed", why: "output too large" });
      else if (e.killed === true) resolve({ status: "failed", why: "timed out" });
      else resolve({ status: "failed", why: typeof e.code === "number" ? `exit ${e.code}` : String(e.code ?? e.signal) });
    });
  });
}

/**
 * The vendored binary when it exists and its VERSION stamp (written by scripts/ensure-ripwire.mjs) is PINNED_RIPWIRE,
 * refused (`refusal`) otherwise. A vendored binary that cannot run is not replaced by PATH: it fails like any ripwire failure.
 * Without one, `ripwire` from PATH, refused (`refusal`) when older than PINNED_RIPWIRE. `missing` is true when both are absent.
 * `versionTimeoutMs` limits `ripwire --version` on PATH. Tests only.
 */
export async function runRipwire(dir: string, vendored: string = VENDORED_RIPWIRE, versionTimeoutMs = VERSION_TIMEOUT_MS): Promise<Execed> {
  const refuse = (refusal: string): Execed => ({ code: null, stdout: "", stderr: "", missing: false, refusal });
  if (existsSync(vendored)) {
    const stamp = (await readFile(path.join(path.dirname(vendored), "VERSION"), "utf8").catch(() => "")).trim();
    if (stamp !== PINNED_RIPWIRE) {
      return refuse(
        `vendored ripwire at ${vendored} is ${stamp === "" ? "unstamped" : esc(stamp)}, not the pinned ${PINNED_RIPWIRE}; run: node ${ENSURE_RIPWIRE}`,
      );
    }
    // A vendored binary that cannot start (a broken interpreter line, for example) is a failure, not an absent ripwire.
    return { ...(await exec(vendored, dir)), missing: false, version: PINNED_RIPWIRE };
  }
  const found = await pathVersion(versionTimeoutMs);
  if (found.status === "missing") return { code: "ENOENT", stdout: "", stderr: "", missing: true };
  if (found.status === "failed") {
    return refuse(`ripwire on PATH could not report its version (${found.why}); run: node ${ENSURE_RIPWIRE}, or update ripwire`);
  }
  if (found.version === null || isOlder(found.version, PINNED_RIPWIRE)) {
    return refuse(
      `ripwire on PATH reports ${found.version ?? "no version"}, older than the pinned ${PINNED_RIPWIRE}; run: node ${ENSURE_RIPWIRE}, or update ripwire`,
    );
  }
  return { ...(await exec("ripwire", dir)), version: found.version };
}

export interface Row {
  p: string;
  rule: string;
  sev: Sev;
}

const TAG_RE = /<([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/gu;
const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
const ENTITY_RE = /&(?:(quot|amp|lt|gt|apos)|#(\d+)|#[xX]([0-9a-fA-F]+));/gu;
const NAMED: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(ENTITY_RE, (whole: string, named: string | undefined, dec: string | undefined, hex: string | undefined) => {
    // ENTITY_RE only matches the names in NAMED, and `hex` is set whenever `named` and `dec` are not.
    if (named !== undefined) return NAMED[named] as string;
    const n = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex as string, 16);
    try {
      return String.fromCodePoint(n);
    } catch {
      return whole;
    }
  });
}

function attrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  // ATTR_RE always sets group 1, and one of groups 2 and 3.
  for (const m of raw.matchAll(ATTR_RE)) out.set(m[1] as string, unescapeXml((m[2] ?? m[3]) as string));
  return out;
}

/** Any severity other than "warn" counts as critical. */
function normSev(sev: string | undefined): Sev {
  return sev === "warn" ? "warn" : "critical";
}

export type Parsed = { ok: true; rows: Row[] } | { ok: false; reason: string };

/** Parse ripwire's XML. Fails closed: output that does not add up is not trusted. */
export function parseScanXml(xml: string, code: number): Parsed {
  let root: Map<string, string> | null = null;
  const rows: Row[] = [];
  for (const m of xml.matchAll(TAG_RE)) {
    // TAG_RE always sets group 2 (the attribute text, possibly empty).
    if (m[1] === "skillscan" && root === null) root = attrs(m[2] as string);
    else if (m[1] === "f") {
      const a = attrs(m[2] as string);
      rows.push({ p: a.get("p") ?? "", rule: a.get("rule") ?? "", sev: normSev(a.get("sev")) });
    }
  }
  if (root === null) return { ok: false, reason: "ripwire output has no <skillscan> element" };
  const declared = Number(root.get("findings"));
  if (!Number.isInteger(declared) || declared !== rows.length) {
    return {
      ok: false,
      reason: `ripwire declared findings="${root.get("findings") ?? ""}" but ${rows.length} finding row(s) were parsed`,
    };
  }
  const anyCritical = rows.some((r) => r.sev === "critical");
  if ((code === 2 || root.get("verdict") === "critical") && !anyCritical) {
    return { ok: false, reason: "ripwire reported CRITICAL but no critical finding row was parsed" };
  }
  if (code === 1 && rows.length === 0) return { ok: false, reason: "ripwire exited 1 (WARN) but no finding row was parsed" };
  return { ok: true, rows };
}
