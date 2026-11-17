// Tokenizer and BM25F ranking. Pure and deterministic: no I/O, no clock, no randomness.
import { stemmer } from "stemmer";

export const FIELDS = ["name", "description", "headings", "body"] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_WEIGHTS: Readonly<Record<Field, number>> = {
  name: 3,
  description: 2,
  headings: 1,
  body: 0.3,
};

export const K1 = 1.2;
export const B = 0.75;
export const BODY_TOKEN_LIMIT = 2000;
export const NAME_BONUS = 10;
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 25;

// Two-letter tech tokens (go, js, ci, db) are meaningful, so the minimum token
// length is 2. These grammar words are dropped instead.
const STOPWORDS = new Set([
  "is",
  "in",
  "on",
  "at",
  "to",
  "of",
  "or",
  "if",
  "it",
  "be",
  "as",
  "by",
  "we",
  "do",
  "no",
  "so",
  "up",
  "an",
  "my",
  "me",
  "us",
  "the",
  "and",
  "for",
  "with",
  "use",
  "used",
  "using",
  "when",
  "into",
  "from",
  "your",
  "that",
  "this",
  "you",
  "are",
  "not",
  "any",
  "its",
  "how",
  "why",
  "what",
  "which",
  "will",
  "can",
  "get",
  "set",
  "via",
  "per",
  "out",
  "new",
  "one",
  "two",
  "all",
  "but",
  "has",
  "have",
  "had",
  "was",
  "were",
  "them",
  "then",
  "than",
  "over",
  "under",
  "before",
  "after",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords, Porter-stem. Keeps duplicates. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const word = stemmer(raw);
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    out.push(word);
  }
  return out;
}

/** Term frequencies for one field. */
export type TermFreqs = Record<string, number>;
export type FieldTokens = Record<Field, TermFreqs>;

export function countTerms(tokens: readonly string[]): TermFreqs {
  const tf: TermFreqs = Object.create(null) as TermFreqs;
  for (const t of tokens) tf[t] = own(tf, t) + 1;
  return tf;
}

/** Build the per-field term frequencies for one skill. Body is cut to its first 2000 tokens. */
export function buildFieldTokens(parts: { name: string; description: string; headings: readonly string[]; body: string }): FieldTokens {
  return {
    name: countTerms(tokenize(parts.name)),
    description: countTerms(tokenize(parts.description)),
    headings: countTerms(tokenize(parts.headings.join("\n"))),
    body: countTerms(tokenize(parts.body).slice(0, BODY_TOKEN_LIMIT)),
  };
}

/** Own-property lookup: after a JSON round trip, "constructor" must not resolve to Object.prototype. */
function own(map: Record<string, number>, key: string): number {
  // hasOwn says the key is there, so the value is a number.
  return Object.hasOwn(map, key) ? (map[key] as number) : 0;
}

function fieldLength(tf: TermFreqs): number {
  let n = 0;
  for (const k of Object.keys(tf)) n += own(tf, k);
  return n;
}

export interface CorpusStats {
  docCount: number;
  avgLength: Record<Field, number>;
  /** Number of documents containing the term in any field. */
  docFreq: Record<string, number>;
}

export interface Doc {
  id: string;
  name: string;
  fieldTokens: FieldTokens;
}

export function buildStats(docs: readonly { fieldTokens: FieldTokens }[]): CorpusStats {
  const totals: Record<Field, number> = { name: 0, description: 0, headings: 0, body: 0 };
  const docFreq: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const d of docs) {
    const seen = new Set<string>();
    for (const f of FIELDS) {
      const tf = d.fieldTokens[f];
      totals[f] += fieldLength(tf);
      for (const t of Object.keys(tf)) seen.add(t);
    }
    for (const t of seen) docFreq[t] = own(docFreq, t) + 1;
  }
  const n = docs.length;
  const avgLength = {} as Record<Field, number>;
  for (const f of FIELDS) avgLength[f] = n === 0 ? 0 : totals[f] / n;
  return { docCount: n, avgLength, docFreq };
}

export function clampLimit(limit: unknown): number {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

export interface Ranked {
  id: string;
  score: number;
}

/** BM25F over name, description, headings, and body. Ties break by id ascending. */
export function rank(docs: readonly Doc[], stats: CorpusStats, query: string, limit: number): Ranked[] {
  const terms = [...new Set(tokenize(query))];
  const q = query.trim().toLowerCase();
  const scored: Ranked[] = [];
  for (const d of docs) {
    let score = 0;
    for (const t of terms) {
      const df = own(stats.docFreq, t);
      if (df === 0) continue;
      let weighted = 0;
      for (const f of FIELDS) {
        const tf = own(d.fieldTokens[f], t);
        if (tf === 0) continue;
        const avg = stats.avgLength[f];
        const len = fieldLength(d.fieldTokens[f]);
        const norm = avg > 0 ? 1 - B + (B * len) / avg : 1;
        weighted += (FIELD_WEIGHTS[f] * tf) / norm;
      }
      if (weighted === 0) continue;
      const idf = Math.log(1 + (stats.docCount - df + 0.5) / (df + 0.5));
      score += (idf * weighted) / (K1 + weighted);
    }
    if (q !== "" && (q === d.name.toLowerCase() || q === d.id.toLowerCase())) score += NAME_BONUS;
    if (score > 0) scored.push({ id: d.id, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.slice(0, limit);
}
