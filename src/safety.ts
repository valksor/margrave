// ripwire scan wrapper. Syntax checked against `ripwire --help`: `ripwire security --scan-skills=<dir>`.
// Exit codes: 0 clean, 1 WARN, 2 CRITICAL, 3 could not read.
// stdout is `<skillscan files= findings= verdict=><f p="<abs path>:<line>" rule= sev=/>…</skillscan>`.
//
// `update` of a git source compares the new copy's findings with the installed copy's findings and
// refuses only on findings that the installed copy does not have.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./scan.ts";
import { MargraveError, atomicWrite, reportsRoot } from "./store.ts";

export interface ScanOutcome {
  /** ripwire exit code, or null when ripwire could not run. */
  code: number | null;
  /** True when --allow-unsafe overrode a refusal. */
  overridden: boolean;
}

export interface ScanOptions {
  allowUnsafe: boolean;
  log: (msg: string) => void;
  /** Names the report file: <home>/reports/<sourceId>.xml. */
  sourceId: string;
  /** Skill directories under the scan root. Findings are grouped by them. */
  skills: readonly { name: string; dir: string }[];
  /**
   * `update` of a git source only. The installed copy's scan root, or null when there is no installed copy.
   * Left out for `install`, which has nothing to compare against.
   */
  baselineDir?: string | null;
  /** Where to look for ripwire when PATH has none. Tests only: the default is the vendored binary in the package root. */
  vendored?: string;
}

type Sev = "warn" | "critical";

interface Finding {
  /** Path relative to the real scan root. The path as reported when it is outside the root. */
  rel: string;
  /** Absolute path as reported by ripwire. */
  abs: string;
  line: number;
  rule: string;
  sev: Sev;
  /** (rel, rule, sev, sha256 of the trimmed flagged line). Null when the line cannot be read safely. */
  key: string | null;
  /** sha256 of the whole file, when it could be read. */
  fileHash: string | null;
}

type ScanResult =
  | { status: "clean" }
  | { status: "findings"; code: 1 | 2; findings: Finding[]; xml: string }
  /** ripwire missing, exit 3, another exit code, or output that cannot be trusted. */
  | { status: "failed"; code: number | null; reason: string; detail: string; xml: string | null };

// ---- running ripwire ----

interface Execed {
  code: number | string | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

/** The ripwire that `pnpm build` (scripts/ensure-ripwire.mjs) and the release bundles put in the package root. */
export const VENDORED_RIPWIRE = fileURLToPath(new URL("../vendor/ripwire/ripwire", import.meta.url));

function exec(bin: string, dir: string): Promise<Execed> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["security", `--scan-skills=${dir}`],
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ code: 0, stdout, stderr, missing: false });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        resolve({ code: e.code ?? null, stdout: stdout ?? "", stderr: stderr ?? "", missing: e.code === "ENOENT" });
      },
    );
  });
}

/** `ripwire` from PATH first. The vendored binary only when PATH has none. `missing` is true when both are absent. */
export async function runRipwire(dir: string, vendored: string = VENDORED_RIPWIRE): Promise<Execed> {
  const r = await exec("ripwire", dir);
  if (!r.missing || !existsSync(vendored)) return r;
  return exec(vendored, dir);
}

// ---- parsing ----

interface Row {
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
    if (named !== undefined) return NAMED[named] ?? whole;
    const n = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
    try {
      return String.fromCodePoint(n);
    } catch {
      return whole;
    }
  });
}

function attrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR_RE)) out.set(m[1] ?? "", unescapeXml(m[2] ?? m[3] ?? ""));
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
    if (m[1] === "skillscan" && root === null) root = attrs(m[2] ?? "");
    else if (m[1] === "f") {
      const a = attrs(m[2] ?? "");
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

// ---- finding keys ----

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });

interface FileInfo {
  hash: string;
  lines: string[];
}

/**
 * Read a flagged file. Null unless it is a regular file (not a symlink) with no symlink in its path,
 * inside the real scan root, and valid UTF-8.
 */
async function readFlagged(realRoot: string, rel: string, cache: Map<string, FileInfo | null>): Promise<FileInfo | null> {
  if (cache.has(rel)) return cache.get(rel) ?? null;
  let info: FileInfo | null = null;
  try {
    const abs = path.join(realRoot, rel);
    const st = await lstat(abs);
    if (st.isFile() && (await realpath(abs)) === abs && isInside(abs, realRoot)) {
      const buf = await readFile(abs);
      const lines = utf8.decode(buf).split("\n");
      if (lines.at(-1) === "") lines.pop();
      info = { hash: sha256(buf), lines };
    }
  } catch {
    info = null;
  }
  cache.set(rel, info);
  return info;
}

async function toFinding(row: Row, realRoot: string, cache: Map<string, FileInfo | null>): Promise<Finding> {
  const cut = row.p.lastIndexOf(":");
  const pathPart = cut < 0 ? row.p : row.p.slice(0, cut);
  const line = cut < 0 ? 0 : Number(row.p.slice(cut + 1));
  const base = { abs: pathPart, line, rule: row.rule, sev: row.sev };
  const rel = path.isAbsolute(pathPart) ? path.relative(realRoot, pathPart) : "";
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return { ...base, rel: pathPart, key: null, fileHash: null };
  }
  const info = await readFlagged(realRoot, rel, cache);
  const text = Number.isInteger(line) && line >= 1 ? info?.lines[line - 1] : undefined;
  if (info === null || text === undefined) return { ...base, rel, key: null, fileHash: info?.hash ?? null };
  return { ...base, rel, key: JSON.stringify([rel, row.rule, row.sev, sha256(text.trim())]), fileHash: info.hash };
}

/** Run ripwire on `dir` and sort the result into clean, findings, or failed. */
async function runScan(dir: string, vendored: string): Promise<ScanResult> {
  let realRoot: string;
  try {
    realRoot = await realpath(dir);
  } catch {
    return { status: "failed", code: null, reason: `cannot resolve the scan root ${dir}`, detail: "", xml: null };
  }
  const r = await runRipwire(realRoot, vendored);
  const stderr = r.stderr.trim();
  const detail = stderr !== "" ? stderr : r.stdout.trim();
  if (r.code === 0) return { status: "clean" };
  if (r.missing) return { status: "failed", code: null, reason: `ripwire was not found on PATH or at ${vendored}`, detail, xml: null };
  if (r.code === 3) return { status: "failed", code: 3, reason: "ripwire could not read the files (exit 3)", detail, xml: null };
  if (r.code !== 1 && r.code !== 2) {
    return { status: "failed", code: typeof r.code === "number" ? r.code : null, reason: `ripwire failed (exit ${String(r.code)})`, detail, xml: null };
  }
  const parsed = parseScanXml(r.stdout, r.code);
  if (!parsed.ok) {
    return { status: "failed", code: r.code, reason: `${parsed.reason} (exit ${r.code})`, detail, xml: r.stdout };
  }
  const cache = new Map<string, FileInfo | null>();
  const findings: Finding[] = [];
  for (const row of parsed.rows) findings.push(await toFinding(row, realRoot, cache));
  return { status: "findings", code: r.code, findings, xml: r.stdout };
}

// ---- comparing ----

/** Multiset of readable finding keys, and the hash of every readable flagged file. */
interface Baseline {
  keys: Map<string, number>;
  files: Map<string, string>;
}

function toBaseline(findings: readonly Finding[]): Baseline {
  const keys = new Map<string, number>();
  const files = new Map<string, string>();
  for (const f of findings) {
    if (f.key === null) continue;
    keys.set(f.key, (keys.get(f.key) ?? 0) + 1);
    if (f.fileHash !== null) files.set(f.rel, f.fileHash);
  }
  return { keys, files };
}

/** Split `findings` into new and known. A key is used up once per baseline occurrence. */
function diff(findings: readonly Finding[], base: Baseline): { fresh: Finding[]; known: Finding[] } {
  const left = new Map(base.keys);
  const fresh: Finding[] = [];
  const known: Finding[] = [];
  for (const f of findings) {
    const n = f.key === null ? 0 : (left.get(f.key) ?? 0);
    if (f.key !== null && n > 0) {
      left.set(f.key, n - 1);
      known.push(f);
    } else {
      fresh.push(f);
    }
  }
  return { fresh, known };
}

// ---- display ----

/** Show C0 and C1 control characters and DEL as \xNN. For terminal output only. */
export function esc(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

const OUTSIDE = "(outside skills)";
const MAX_RULES = 10;
const MAX_SKILLS = 10;
const MAX_NEW = 20;
const MAX_CHANGED = 10;
const MAX_DETAIL_LINES = 40;
const MAX_DETAIL_WIDTH = 500;

function ranked(counts: Map<string, number>): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function tally(items: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

interface Compared {
  fresh: Finding[];
  known: Finding[];
  baseline: Baseline;
}

function summarize(findings: readonly Finding[], opts: ScanOptions, report: string, cmp: Compared | null): string {
  const crit = findings.filter((f) => f.sev === "critical").length;
  const warn = findings.length - crit;
  const skillOf = (f: Finding): string => opts.skills.find((s) => isInside(f.abs, s.dir))?.name ?? OUTSIDE;
  const perSkill = tally(findings.map(skillOf));
  const inSkills = [...perSkill.keys()].filter((k) => k !== OUTSIDE).length;
  const counts = [crit > 0 ? `${crit} critical` : "", warn > 0 ? `${warn} warn` : ""].filter((s) => s !== "").join(", ");
  const vs = cmp === null ? "" : `; ${cmp.fresh.length} new vs installed copy`;
  const lines = [`scan: ${crit > 0 ? "CRITICAL" : "WARN"} — ${findings.length} finding(s) (${counts}) in ${inSkills} skill(s)${vs}`];

  const rules = ranked(tally(findings.map((f) => esc(f.rule))));
  lines.push(`  by rule:   ${rules.slice(0, MAX_RULES).map(([k, n]) => `${k} ${n}`).join(" · ")}${rules.length > MAX_RULES ? " · …" : ""}`);
  const skills = ranked(new Map([...perSkill].map(([k, n]) => [esc(k), n] as [string, number])));
  lines.push(`  top skills: ${skills.slice(0, MAX_SKILLS).map(([k, n]) => `${k} ${n}`).join(" · ")}`);

  if (cmp !== null && cmp.fresh.length > 0) {
    lines.push("  new findings:");
    for (const f of cmp.fresh.slice(0, MAX_NEW)) {
      lines.push(`    ${esc(f.rel)}:${f.line}  ${esc(f.rule)}  ${f.sev}${f.key === null ? " (unreadable)" : ""}`);
    }
    if (cmp.fresh.length > MAX_NEW) lines.push(`    … ${cmp.fresh.length - MAX_NEW} more`);
  }
  if (cmp !== null) {
    const changed = cmp.known.filter((f) => f.fileHash !== cmp.baseline.files.get(f.rel));
    const groups = ranked(tally(changed.map((f) => JSON.stringify([f.rel, f.rule]))));
    if (groups.length > 0) {
      lines.push("  known findings in changed files:");
      for (const [k, n] of groups.slice(0, MAX_CHANGED)) {
        const [rel, rule] = JSON.parse(k) as [string, string];
        lines.push(`    ${esc(rel)} · ${esc(rule)} · ${n}`);
      }
      if (groups.length > MAX_CHANGED) lines.push(`    … ${groups.length - MAX_CHANGED} more`);
    }
  }
  lines.push(`  full report: ${report}`);
  return lines.join("\n");
}

/** ripwire's own stderr or non-XML output, escaped, up to 40 lines. */
function clipDetail(detail: string): string {
  if (detail === "") return "";
  const all = detail.split("\n");
  const shown = all.slice(0, MAX_DETAIL_LINES).map((l) => {
    const e = esc(l);
    return e.length > MAX_DETAIL_WIDTH ? `${e.slice(0, MAX_DETAIL_WIDTH)}…` : e;
  });
  if (all.length > MAX_DETAIL_LINES) shown.push(`… ${all.length - MAX_DETAIL_LINES} more line(s)`);
  return `\n${shown.join("\n")}`;
}

// ---- entry point ----

/**
 * Scan `dir` with ripwire. A clean scan continues silently and a WARN scan continues after a summary.
 * With a baseline (`update`), only new critical or unreadable findings refuse. Without one, exit 2,
 * exit 3, any other code, output that cannot be parsed, or ripwire missing refuses.
 * `allowUnsafe` overrides a refusal.
 */
export async function scanWithRipwire(dir: string, opts: ScanOptions): Promise<ScanOutcome> {
  const res = await runScan(dir, opts.vendored ?? VENDORED_RIPWIRE);
  if (res.status === "clean") return { code: 0, overridden: false };

  const reportFile = path.join(reportsRoot(), `${opts.sourceId}.xml`);
  if (res.status === "failed") {
    if (res.xml !== null) await atomicWrite(reportFile, res.xml);
    return refuseOrOverride(res.reason + clipDetail(res.detail), res.code, opts);
  }
  await atomicWrite(reportFile, res.xml);

  // The baseline scan runs on the installed copy, before the caller swaps anything.
  let cmp: Compared | null = null;
  if (opts.baselineDir !== undefined) {
    const base = opts.baselineDir === null ? null : await runScan(opts.baselineDir, opts.vendored ?? VENDORED_RIPWIRE);
    let why = "the installed copy is missing";
    if (base?.status === "failed") why = base.reason;
    if (base?.status === "clean" || base?.status === "findings") {
      const baseline = toBaseline(base.status === "clean" ? [] : base.findings);
      cmp = { ...diff(res.findings, baseline), baseline };
    } else {
      opts.log(`scan: no baseline (${why}); every finding counts as new`);
    }
  }

  const summary = summarize(res.findings, opts, reportFile, cmp);
  if (cmp === null) {
    if (res.code === 1) {
      opts.log(summary);
      return { code: 1, overridden: false };
    }
    return refuseOrOverride(`ripwire found CRITICAL findings (exit 2)\n${summary}`, 2, opts);
  }
  if (cmp.fresh.some((f) => f.sev === "critical" || f.key === null)) {
    return refuseOrOverride(`new critical or unreadable findings that the installed copy does not have\n${summary}`, res.code, opts);
  }
  opts.log(summary);
  return { code: res.code, overridden: false };
}

function refuseOrOverride(message: string, code: number | null, opts: ScanOptions): ScanOutcome {
  if (opts.allowUnsafe) {
    opts.log(`--allow-unsafe: overriding refusal (${message})`);
    return { code, overridden: true };
  }
  throw new MargraveError(`refused: ${message}\nre-run with --allow-unsafe to override for this one command`);
}
