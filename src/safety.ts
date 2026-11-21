// ripwire scan wrapper. Syntax checked against `ripwire --help`: `ripwire security --scan-skills=<dir>`.
// Exit codes: 0 clean, 1 WARN, 2 CRITICAL, 3 could not read.
// stdout is `<skillscan files= findings= verdict=><f p="<abs path>:<line>" rule= sev=/>…</skillscan>`.
//
// ripwire lookup: the vendored `vendor/ripwire/ripwire` (the pinned version; ensure-ripwire.mjs checks its SHA-256
// at build, and this module checks only the VERSION stamp it writes) runs when it exists and its VERSION stamp matches. Only without one does `ripwire` from PATH run, and then only at the
// pinned version or newer.
//
// Git updates compare new findings with the accepted scan recorded in the catalog.
import { createHash } from "node:crypto";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { READ_NO_FOLLOW, isInside } from "./scan.ts";
import { MargraveError, atomicWrite, reportsRoot } from "./store.ts";
import { esc, parseScanXml, runRipwire, VENDORED_RIPWIRE } from "./safety-runner.ts";
import type { Row } from "./safety-runner.ts";
export { esc, parseScanXml, runRipwire, VENDORED_RIPWIRE, PINNED_RIPWIRE, VERSION_TIMEOUT_MS } from "./safety-runner.ts";

export interface ScanOutcome {
  /** ripwire exit code, or null when ripwire could not run. */
  code: number | null;
  /** True when --allow-unsafe overrode a refusal. */
  overridden: boolean;
  version: string | null;
  verdict: "clean" | "warn" | "critical" | "failed";
  keys: [string, number][];
  files: [string, string][];
  tree: string | null;
}

export interface ScanOptions {
  allowUnsafe: boolean;
  log: (msg: string) => void;
  /** Names the report file: <home>/reports/<sourceId>.xml. */
  sourceId: string;
  /** Skill directories under the scan root. Findings are grouped by them. */
  skills: readonly { name: string; dir: string }[];
  /**
   * `update` of a git source only. The accepted scan, or null when it is unavailable.
   * Left out for `install`, which has nothing to compare against.
   */
  baseline?: ScanOutcome | null;
  verifyContent?: boolean;
  /** The vendored ripwire to run first. Tests only: the default is the vendored binary in the package root. */
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

type ScanResult = (
  | { status: "clean" }
  | { status: "findings"; code: 1 | 2; findings: Finding[]; xml: string }
  /** ripwire missing, exit 3, another exit code, or output that cannot be trusted. */
  | { status: "failed"; code: number | null; reason: string; detail: string; xml: string | null }
) & { version: string | null };

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
  // `has` says the entry exists, so get() does not return undefined.
  if (cache.has(rel)) return cache.get(rel) as FileInfo | null;
  let info: FileInfo | null = null;
  try {
    const abs = path.join(realRoot, rel);
    const fh = await open(abs, READ_NO_FOLLOW);
    try {
      if ((await fh.stat()).isFile() && (await realpath(abs)) === abs && isInside(abs, realRoot)) {
        const buf = await fh.readFile();
        const lines = utf8.decode(buf).split("\n");
        if (lines.at(-1) === "") lines.pop();
        info = { hash: sha256(buf), lines };
      }
    } finally {
      await fh.close();
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
    return { status: "failed", code: null, reason: `cannot resolve the scan root ${dir}`, detail: "", xml: null, version: null };
  }
  const r = await runRipwire(realRoot, vendored);
  const version = r.version ?? null;
  const stderr = r.stderr.trim();
  const detail = stderr !== "" ? stderr : r.stdout.trim();
  if (r.refusal !== undefined) return { status: "failed", code: null, reason: r.refusal, detail: "", xml: null, version };
  if (r.code === 0) return { status: "clean", version };
  if (r.missing)
    return { status: "failed", code: null, reason: `ripwire was not found on PATH or at ${vendored}`, detail, xml: null, version };
  if (r.code === 3) return { status: "failed", code: 3, reason: "ripwire could not read the files (exit 3)", detail, xml: null, version };
  if (r.code !== 1 && r.code !== 2) {
    return {
      status: "failed",
      code: typeof r.code === "number" ? r.code : null,
      reason: `ripwire failed (exit ${String(r.code)})`,
      detail,
      xml: null,
      version,
    };
  }
  const parsed = parseScanXml(r.stdout, r.code);
  if (!parsed.ok) {
    return { status: "failed", code: r.code, reason: `${parsed.reason} (exit ${r.code})`, detail, xml: r.stdout, version };
  }
  const cache = new Map<string, FileInfo | null>();
  const findings: Finding[] = [];
  for (const row of parsed.rows) findings.push(await toFinding(row, realRoot, cache));
  return { status: "findings", code: r.code, findings, xml: r.stdout, version };
}

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

const OUTSIDE = "(outside skills)";
const MAX_RULES = 10;
const MAX_SKILLS = 10;
const MAX_NEW = 20;
const MAX_CHANGED = 10;
const MAX_DETAIL_LINES = 40;
const MAX_DETAIL_WIDTH = 500;

function ranked(counts: Map<string, number>): [string, number][] {
  // Map keys are unique, so two keys are never equal.
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
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
  lines.push(
    `  by rule:   ${rules
      .slice(0, MAX_RULES)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ")}${rules.length > MAX_RULES ? " · …" : ""}`,
  );
  const skills = ranked(new Map([...perSkill].map(([k, n]) => [esc(k), n] as [string, number])));
  lines.push(
    `  top skills: ${skills
      .slice(0, MAX_SKILLS)
      .map(([k, n]) => `${k} ${n}`)
      .join(" · ")}`,
  );

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

/**
 * Scan `dir` with ripwire. A clean scan continues silently and a WARN scan continues after a summary.
 * With a baseline (`update`), only new critical or unreadable findings refuse. Without one, exit 2,
 * exit 3, any other code, output that cannot be parsed, or ripwire missing refuses.
 * `allowUnsafe` overrides a refusal.
 */
export async function scanWithRipwire(dir: string, opts: ScanOptions): Promise<ScanOutcome> {
  const before = opts.verifyContent === true ? await scanInventory(dir) : null;
  const res = await runScan(dir, opts.vendored ?? VENDORED_RIPWIRE);
  if (before !== null && before !== (await scanInventory(dir))) throw new MargraveError("staged skills changed during scan");
  if (opts.baseline === null || opts.baseline?.verdict === "failed" || opts.baseline?.tree === null)
    opts.log("scan: no accepted baseline. Applying install rules");
  const base = res.status === "findings" ? toBaseline(res.findings) : toBaseline([]);
  const outcome: ScanOutcome = {
    code: res.status === "clean" ? 0 : res.code,
    overridden: false,
    version: res.version,
    verdict: res.status === "clean" ? "clean" : res.status === "failed" ? "failed" : res.code === 1 ? "warn" : "critical",
    keys: [...base.keys],
    files: [...base.files],
    tree: before,
  };
  if (res.status === "clean") return outcome;

  const reportFile = path.join(reportsRoot(), `${opts.sourceId}.xml`);
  if (res.status === "failed") {
    if (res.xml !== null) await atomicWrite(reportFile, res.xml);
    return refuseOrOverride(res.reason + clipDetail(res.detail), outcome, opts);
  }
  await atomicWrite(reportFile, res.xml);

  // Compare with the recorded accepted scan, never with mutable installed files.
  let cmp: Compared | null = null;
  if (opts.baseline !== undefined && opts.baseline !== null && opts.baseline.verdict !== "failed" && opts.baseline.tree !== null) {
    const baseline = { keys: new Map(opts.baseline.keys), files: new Map(opts.baseline.files) };
    cmp = { ...diff(res.findings, baseline), baseline };
  }

  const summary = summarize(res.findings, opts, reportFile, cmp);
  if (cmp === null) {
    if (res.code === 1) {
      opts.log(summary);
      return outcome;
    }
    return refuseOrOverride(`ripwire found CRITICAL findings (exit 2)\n${summary}`, outcome, opts);
  }
  if (cmp.fresh.some((f) => f.sev === "critical" || f.key === null)) {
    return refuseOrOverride(`new critical or unreadable findings that the installed copy does not have\n${summary}`, outcome, opts);
  }
  opts.log(summary);
  return outcome;
}

export async function scanInventory(dir: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(root: string, rel: string): Promise<void> {
    for (const name of (await readdir(root)).sort()) {
      const file = path.join(root, name);
      const child = rel === "" ? name : `${rel}/${name}`;
      const info = await lstat(file);
      if (info.isDirectory()) {
        hash.update(JSON.stringify([child, "dir"]));
        await visit(file, child);
      } else if (info.isSymbolicLink()) hash.update(JSON.stringify([child, "link", await readlink(file)]));
      else if (info.isFile()) {
        const handle = await open(file, READ_NO_FOLLOW);
        try {
          const content = createHash("sha256");
          for await (const chunk of handle.createReadStream({ autoClose: false })) content.update(chunk as Buffer);
          hash.update(JSON.stringify([child, "file", content.digest("hex")]));
        } finally {
          await handle.close();
        }
      } else throw new MargraveError("staged skills changed during scan");
    }
  }
  await visit(dir, "");
  return hash.digest("hex");
}

function refuseOrOverride(message: string, outcome: ScanOutcome, opts: ScanOptions): ScanOutcome {
  if (opts.allowUnsafe) {
    opts.log(`--allow-unsafe: overriding refusal (${message})`);
    return { ...outcome, overridden: true };
  }
  throw new MargraveError(`refused: ${message}\nre-run with --allow-unsafe to override for this one command`);
}
