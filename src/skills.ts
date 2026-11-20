// find / load / read-file, id resolution, path guard, terminal-safe text.
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FIELDS, FIELD_WEIGHTS, NAME_BONUS, clampLimit, hasRecommendationEvidence, queryTerms } from "./bm25.ts";
import type { Field, MatchedTerms } from "./bm25.ts";
import { splitSkillMd } from "./scan.ts";
import { listFiles, readSkillFile, readSkillFileBytes } from "./skill-files.ts";
import type { ManifestEntry } from "./scan.ts";
import { clean, cleanBlock, shellQuote } from "./text.ts";
export { listFiles, readSkillFile } from "./skill-files.ts";
export { clean, cleanBlock, shellQuote } from "./text.ts";
import { MargraveError, RequestError, catalogSources, home, openCatalogReadOptional } from "./store.ts";
import type { IndexEntry, SourceRecord } from "./store.ts";

export const NO_SOURCES_MESSAGE = "no skill sources installed; run: margrave install <owner/repo|path>";

/** The sources and one read-only handle on index.db. The caller closes `db` in `finally`. */
export interface Context {
  sources: SourceRecord[];
  db: DatabaseSync;
}

/** Returns null when no sources are installed. */
export async function loadContext(): Promise<Context | null> {
  const db = await openCatalogReadOptional();
  if (db === null) return null;
  try {
    const sources = catalogSources(db);
    if (sources.length === 0) {
      db.close();
      return null;
    }
    return { sources, db };
  } catch (err) {
    db.close();
    throw err;
  }
}

const SKILL_COLUMNS = "id, name, description, source, dir, hash AS revision, manifest, frontmatter";

export function validateRevision(revision: string | undefined): void {
  if (revision !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(revision)) throw new RequestError("revision must be a SHA-256 digest");
}

/** Find a skill by qualified id, or by bare name when exactly one source has it. */
export function resolveSkill(
  db: DatabaseSync,
  input: string,
  revision?: string,
  allowedSources?: ReadonlySet<string>,
  mcp = false,
): IndexEntry {
  validateRevision(revision);
  const exact = db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id = ?`).get(input) as IndexEntry | undefined;
  if (exact !== undefined && (allowedSources === undefined || allowedSources.has(exact.source))) return resolveDirectory(db, exact, mcp);
  const byName = (db.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE name = ?`).all(input) as unknown as IndexEntry[]).filter(
    (entry) => allowedSources === undefined || allowedSources.has(entry.source),
  );
  if (byName.length === 1 && byName[0] !== undefined) return resolveDirectory(db, byName[0], mcp);
  if (byName.length > 1) {
    const ids = byName
      .map((s) => `  ${clean(s.id)}`)
      .sort()
      .join("\n");
    throw new RequestError(`"${clean(input)}" is ambiguous; use one of these ids:\n${ids}`);
  }
  if (revision !== undefined) throw new RequestError("skill revision changed; search again");
  throw new RequestError(`no skill "${clean(input)}"; run: margrave find "<task>" or margrave list --skills`);
}

function resolveDirectory(db: DatabaseSync, entry: IndexEntry, mcp: boolean): IndexEntry {
  const source = catalogSources(db).find((s) => s.id === entry.source);
  if (source === undefined) throw new MargraveError(`invalid snapshot path for source "${entry.source}"`);
  if (source.kind !== "git") return entry;
  const id = source.id;
  if (path.isAbsolute(entry.dir)) throw new MargraveError(`invalid snapshot path for source "${id}"`);
  const root = path.resolve(home(), "snapshots", id, source.snapshot as string);
  const dir = path.resolve(root, entry.dir);
  const rel = path.relative(root, dir);
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) throw new MargraveError(`invalid snapshot path for source "${id}"`);
  try {
    const realRoot = path.join(realpathSync(home()), "snapshots", id, source.snapshot as string);
    if (realpathSync(root) !== realRoot || realpathSync(dir) !== path.join(realRoot, rel)) throw new Error("snapshot path differs");
  } catch (err) {
    if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? ""))
      throw new RequestError(gitDriftMessage(mcp ? "mcp" : "cli"));
    throw new MargraveError(`invalid snapshot path for source "${id}"`);
  }
  return { ...entry, dir };
}

export interface FindHit {
  id: string;
  name: string;
  description: string;
  revision: string;
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
const FIND_TAIL = `SELECT k.rowid, k.id, k.name, k.description, k.hash AS revision, (k.name_lc = ? OR k.id_lc = ?) AS exact,
  c.s + CASE WHEN k.name_lc = ? OR k.id_lc = ? THEN ${NAME_BONUS} ELSE 0 END AS score
FROM cand c JOIN skills k ON k.rowid = c.rowid
WHERE (? IS NULL OR k.source IN (SELECT value FROM json_each(?)))`;

function rankEvidence(
  ranked: (FindHit & { recommended: boolean; exact: boolean; matchedTerms: MatchedTerms })[],
  terms: string[],
  limit: unknown,
  explain: boolean,
): FindHit[] {
  const uniqueDescription =
    terms.length === 1 &&
    !ranked.some((hit) => hit.matchedTerms.name.length > 0) &&
    ranked.filter((hit) => hit.matchedTerms.description.length > 0).length === 1;
  for (const hit of ranked)
    hit.recommended =
      hit.exact || hasRecommendationEvidence(terms, hit.matchedTerms) || (uniqueDescription && hit.matchedTerms.description.length > 0);
  const selected = [...ranked.filter((hit) => hit.recommended), ...(explain ? ranked.filter((hit) => !hit.recommended) : [])].slice(
    0,
    clampLimit(limit),
  );
  return explain ? selected : selected.map(({ id, name, description, revision, score }) => ({ id, name, description, revision, score }));
}

/** BM25 over the FTS columns. An exact name or id match ranks first. Ties break by id in byte order. */
export function findSkills(db: DatabaseSync, task: string, limit: unknown, explain = false, scope?: ReadonlySet<string>): FindHit[] {
  // The MATCH text comes only from tokenize() output, never from the raw task.
  const terms = queryTerms(task);
  const q = task.trim().toLowerCase();
  const exact = [q, q, q, q, q, q];
  const scopeJson = scope === undefined ? null : JSON.stringify([...scope]);
  type Row = {
    rowid: number;
    id: string | null;
    name: string | null;
    description: string | null;
    revision: string | null;
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
      .all(q, q, q, q, q, q, scopeJson, scopeJson) as unknown as Row[];
  } else {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.find_vocab USING fts5vocab(main, fts, instance)");
    const sql = `${FIND_FTS}, ranked AS MATERIALIZED (${FIND_TAIL}), evidence AS MATERIALIZED (
      SELECT doc, col, term FROM temp.find_vocab WHERE term IN (${terms.map(() => "?").join(",")}) GROUP BY doc, col, term
    ) SELECT rowid, id, name, description, revision, exact, score, NULL AS col, NULL AS term, 0 AS kind FROM ranked
      UNION ALL SELECT doc, NULL, NULL, NULL, NULL, 0, 0, col, term, 1 FROM evidence
      ORDER BY kind, exact DESC, score DESC, id, col, term`;
    rows = db.prepare(sql).all(terms.map((t) => `"${t}"`).join(" OR "), ...exact, scopeJson, scopeJson, ...terms) as unknown as Row[];
  }
  const hits = new Map<number, FindHit & { recommended: boolean; exact: boolean; matchedTerms: MatchedTerms }>();
  for (const row of rows) {
    let hit = hits.get(row.rowid);
    if (hit === undefined && row.id !== null && row.name !== null && row.description !== null && row.revision !== null) {
      hit = {
        id: row.id,
        name: row.name,
        description: row.description,
        revision: row.revision,
        score: row.score,
        recommended: false,
        exact: Boolean(row.exact),
        matchedTerms: { name: [], description: [], headings: [], body: [] },
      };
      hits.set(row.rowid, hit);
    }
    if (hit !== undefined && row.col !== null && row.term !== null) hit.matchedTerms[row.col].push(row.term);
  }
  return rankEvidence([...hits.values()], terms, limit, explain);
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
    lines.push(`   revision: ${h.revision}`);
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

function gitDriftMessage(surface: "cli" | "mcp"): string {
  return surface === "cli"
    ? "installed Git files differ from the accepted revision. Restore a verified lock or a known-good backup"
    : "skill files differ from the accepted revision. Ask the store operator to restore a verified copy";
}

export async function readSelectedFile(entry: IndexEntry, rel: string, revision?: string, gitDrift?: "cli" | "mcp"): Promise<string> {
  if (revision === undefined) return readSkillFile(entry.dir, rel);
  validateRevision(revision);
  if (entry.revision !== revision) throw new RequestError("skill revision changed; search again");
  const item = (JSON.parse(entry.manifest) as ManifestEntry[]).find((f) => f.path === rel);
  if (item === undefined) throw new RequestError("file is not in the selected skill revision");
  let bytes: Buffer | undefined;
  try {
    bytes = await readSkillFileBytes(entry.dir, rel, true);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!(err instanceof RequestError) && code !== "ENOENT" && code !== "ENOTDIR") throw err;
  }
  const mismatch =
    bytes === undefined || bytes.length !== item.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== item.digest;
  if (mismatch || bytes === undefined) {
    if (gitDrift !== undefined) throw new RequestError(gitDriftMessage(gitDrift));
    throw new RequestError("skill files changed since indexing; ask the store operator to run margrave reindex, then search again");
  }
  return bytes.toString("utf8");
}

export async function loadSkill(
  entry: IndexEntry,
  sources: readonly SourceRecord[],
  revision?: string,
  gitDrift?: "cli" | "mcp",
): Promise<LoadResult> {
  const st = revision === undefined ? await lstat(entry.dir).catch(() => null) : true;
  if (st === null) throw new MargraveError(`skill directory ${clean(entry.dir)} is gone; run: margrave reindex`);
  const text = await readSelectedFile(entry, "SKILL.md", revision, gitDrift);
  const { rawFrontmatter, body } = splitSkillMd(text);
  const src = sources.find((s) => s.id === entry.source);
  const snapshotRoot = path.join(home(), "snapshots", entry.source);
  const key = path.relative(snapshotRoot, entry.dir).split(path.sep)[0]!;
  const selectedCommit = /^([0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}$/u.exec(key)?.[1];
  return {
    id: entry.id,
    source: entry.source,
    spec: src?.spec ?? "",
    commit: (src?.kind === "git" ? selectedCommit : undefined) ?? src?.commit ?? null,
    base: entry.dir,
    frontmatter: rawFrontmatter ?? "",
    files: revision === undefined ? await listFiles(entry.dir) : (JSON.parse(entry.manifest) as ManifestEntry[]).map((f) => f.path),
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
