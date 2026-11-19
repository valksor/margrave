// find / load / read-file, id resolution, path guard, terminal-safe text.
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FIELDS, FIELD_WEIGHTS, NAME_BONUS, clampLimit, hasRecommendationEvidence, queryTerms } from "./bm25.ts";
import type { Field, MatchedTerms } from "./bm25.ts";
import { READ_NO_FOLLOW, splitSkillMd } from "./scan.ts";
import { MargraveError, RequestError, openIndexRead, readSources } from "./store.ts";
import type { IndexEntry, SourceRecord } from "./store.ts";

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

/** The sources and one read-only handle on index.db. The caller closes `db` in `finally`. */
export interface Context {
  sources: SourceRecord[];
  db: DatabaseSync;
}

/** Returns null when no sources are installed. */
export async function loadContext(): Promise<Context | null> {
  const sources = await readSources();
  if (sources.length === 0) return null;
  return { sources, db: await openIndexRead() };
}

const SKILL_COLUMNS = "id, name, description, source, dir, hash";

/** Find a skill by qualified id, or by bare name when exactly one source has it. */
export function resolveSkill(db: DatabaseSync, input: string): IndexEntry {
  const exact = db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id = ?`).get(input) as IndexEntry | undefined;
  if (exact !== undefined) return exact;
  const byName = db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE name = ?`).all(input) as unknown as IndexEntry[];
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];
  if (byName.length > 1) {
    const ids = byName
      .map((s) => `  ${clean(s.id)}`)
      .sort()
      .join("\n");
    throw new RequestError(`"${clean(input)}" is ambiguous; use one of these ids:\n${ids}`);
  }
  throw new RequestError(`no skill "${clean(input)}"; run: margrave find "<task>" or margrave list --skills`);
}

export interface FindHit {
  id: string;
  name: string;
  description: string;
  score: number;
  recommended?: boolean;
  exact?: boolean;
  matchedTerms?: MatchedTerms;
}

// The FTS part is MATERIALIZED: without it SQLite re-runs the FTS query per row (4.4 s per call at 8k skills).
// Numbers in the SQL are the constants above; text only ever arrives as bound parameters.
const FIND_FTS = `WITH hits AS MATERIALIZED (
  SELECT rowid, -bm25(fts, ${FIELD_WEIGHTS.name}, ${FIELD_WEIGHTS.description}, ${FIELD_WEIGHTS.headings}, ${FIELD_WEIGHTS.body}) AS s
  FROM fts WHERE fts MATCH ?
), cand AS (
  SELECT rowid, s FROM hits
  UNION ALL SELECT rowid, 0 FROM skills WHERE (name_lc = ? OR id_lc = ?) AND rowid NOT IN (SELECT rowid FROM hits)
)`;
const FIND_EXACT_ONLY = "WITH cand AS (SELECT rowid, 0 AS s FROM skills WHERE name_lc = ? OR id_lc = ?)";
const FIND_TAIL = `SELECT k.rowid, k.id, k.name, k.description, (k.name_lc = ? OR k.id_lc = ?) AS exact,
  c.s + CASE WHEN k.name_lc = ? OR k.id_lc = ? THEN ${NAME_BONUS} ELSE 0 END AS score
FROM cand c JOIN skills k ON k.rowid = c.rowid`;

/** BM25 over the FTS columns. An exact name or id match ranks first. Ties break by id in byte order. */
export function findSkills(db: DatabaseSync, task: string, limit: unknown, explain = false): FindHit[] {
  // The MATCH text comes only from tokenize() output, never from the raw task.
  const terms = queryTerms(task);
  const q = task.trim().toLowerCase();
  const exact = [q, q, q, q, q, q];
  type Row = {
    rowid: number;
    id: string | null;
    name: string | null;
    description: string | null;
    score: number;
    exact: number;
    col: Field | null;
    term: string | null;
  };
  let rows: Row[];
  if (terms.length === 0) {
    rows = db
      .prepare(
        `${FIND_EXACT_ONLY} SELECT ranked.*, NULL AS col, NULL AS term FROM (${FIND_TAIL}) ranked ORDER BY exact DESC, score DESC, id`,
      )
      .all(q, q, q, q, q, q) as unknown as Row[];
  } else {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.find_vocab USING fts5vocab(main, fts, instance)");
    const sql = `${FIND_FTS}, ranked AS MATERIALIZED (${FIND_TAIL}), evidence AS MATERIALIZED (
      SELECT doc, col, term FROM temp.find_vocab WHERE term IN (${terms.map(() => "?").join(",")}) GROUP BY doc, col, term
    ) SELECT rowid, id, name, description, exact, score, NULL AS col, NULL AS term, 0 AS kind FROM ranked
      UNION ALL SELECT doc, NULL, NULL, NULL, 0, 0, col, term, 1 FROM evidence
      ORDER BY kind, exact DESC, score DESC, id, col, term`;
    rows = db.prepare(sql).all(terms.map((t) => `"${t}"`).join(" OR "), ...exact, ...terms) as unknown as Row[];
  }
  const hits = new Map<number, FindHit & { recommended: boolean; exact: boolean; matchedTerms: MatchedTerms }>();
  for (const row of rows) {
    let hit = hits.get(row.rowid);
    if (hit === undefined && row.id !== null && row.name !== null && row.description !== null) {
      hit = {
        id: row.id,
        name: row.name,
        description: row.description,
        score: row.score,
        recommended: false,
        exact: Boolean(row.exact),
        matchedTerms: { name: [], description: [], headings: [], body: [] },
      };
      hits.set(row.rowid, hit);
    }
    if (hit !== undefined && row.col !== null && row.term !== null) hit.matchedTerms[row.col].push(row.term);
  }
  const ranked = [...hits.values()];
  for (const hit of ranked) hit.recommended = hit.exact || hasRecommendationEvidence(terms, hit.matchedTerms);
  const selected = [...ranked.filter((hit) => hit.recommended), ...(explain ? ranked.filter((hit) => !hit.recommended) : [])].slice(
    0,
    clampLimit(limit),
  );
  return explain ? selected : selected.map(({ id, name, description, score }) => ({ id, name, description, score }));
}

export interface FindText {
  /** Last line under the hits. */
  loadHint: (id: string) => string;
  /** Full text when there is no hit. */
  noMatch: string;
}

const CLI_FIND_TEXT: FindText = {
  loadHint: (id) => `load: margrave load ${shellQuote(id)}`,
  noMatch: "no match\ntry other words, or list everything with: margrave list --skills",
};

export function formatFind(hits: readonly FindHit[], text: FindText = CLI_FIND_TEXT): string {
  if (hits.length === 0) return text.noMatch;
  const lines: string[] = [];
  hits.forEach((h, i) => {
    lines.push(`${i + 1}. ${clean(h.id)}  (score ${h.score.toFixed(3)}${h.recommended === false ? ", weak match" : ""})`);
    lines.push(`   ${clean(h.description)}`);
    if (h.exact === true) lines.push("   exact name or id");
    if (h.matchedTerms !== undefined) {
      const matched = h.matchedTerms;
      const fields = FIELDS.filter((field) => matched[field].length > 0).map((field) => `${field} (${matched[field].join(", ")})`);
      if (fields.length > 0) lines.push(`   matches in ${fields.join(", ")}`);
    }
  });
  const top = hits[0];
  if (top !== undefined && top.recommended !== false) lines.push(text.loadHint(clean(top.id)));
  return lines.join("\n");
}

const MAX_LISTED_FILES = 200;
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** True when a path relative to the skill dir has a component named .git (case-insensitive, for APFS). HFS+ ignorable code points are not covered. */
function isGitPath(rel: string): boolean {
  return rel.split(path.sep).some((s) => s.toLowerCase() === ".git");
}

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
  if (rel === "") throw new RequestError("path is empty");
  if (path.isAbsolute(rel)) throw new RequestError("path must be relative to the skill directory");
  let realDir: string;
  try {
    realDir = await realpath(dir);
  } catch {
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
  } catch {
    throw new RequestError(`no such file in the skill directory: ${clean(rel)}`);
  }
  if (!realFile.startsWith(prefix)) {
    throw new RequestError(`path ${clean(rel)} is outside the skill directory`);
  }
  if (isGitPath(path.relative(realDir, realFile))) throw new RequestError(`path ${clean(rel)} is inside .git, which is not served`);
  const fh = await open(realFile, READ_NO_FOLLOW);
  try {
    if (!(await fh.stat()).isFile()) throw new RequestError(`not a file: ${clean(rel)}`);
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
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
export function formatLoad(r: LoadResult, opts: { hostPaths?: boolean } = {}): string {
  const shown = r.files.slice(0, MAX_LISTED_FILES).map((f) => `- ${clean(f)}`);
  if (r.files.length > MAX_LISTED_FILES) shown.push(`- ... ${r.files.length - MAX_LISTED_FILES} more`);
  const header = [
    `skill: ${clean(r.id)}`,
    `source: ${clean(r.source)}${r.spec === "" || opts.hostPaths === false ? "" : ` (${clean(r.spec)})`}`,
    `commit: ${r.commit === null ? "none (local directory)" : clean(r.commit)}`,
    ...(opts.hostPaths === false ? [] : [`base: ${clean(r.base)}`]),
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
