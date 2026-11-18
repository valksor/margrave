// Tokenizer and query terms for the FTS5 index. Pure and deterministic: no I/O, no clock, no randomness.
import { stemmer } from "stemmer";

export const FIELDS = ["name", "description", "headings", "body"] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_WEIGHTS: Readonly<Record<Field, number>> = {
  name: 3,
  description: 2,
  headings: 1,
  body: 0.3,
};

export const BODY_TOKEN_LIMIT = 2000;
export const NAME_BONUS = 10;
export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 25;
/** Cap on OR terms in one FTS query: 20k terms took 33 s, which would block a hosted event loop. */
export const MAX_QUERY_TERMS = 32;

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

/** The four space-joined token strings of one skill, one per FTS column. */
export type TokenStrings = Record<Field, string>;

/** Build the token strings for one skill. Body is cut to its first 2000 tokens; duplicates stay, so term frequency is kept. */
export function buildFieldTokens(parts: { name: string; description: string; headings: readonly string[]; body: string }): TokenStrings {
  return {
    name: tokenize(parts.name).join(" "),
    description: tokenize(parts.description).join(" "),
    headings: tokenize(parts.headings.join("\n")).join(" "),
    body: tokenize(parts.body).slice(0, BODY_TOKEN_LIMIT).join(" "),
  };
}

/** The unique query tokens in first-seen order, at most MAX_QUERY_TERMS. The only source of the FTS MATCH text. */
export function queryTerms(task: string): string[] {
  return [...new Set(tokenize(task))].slice(0, MAX_QUERY_TERMS);
}

export function clampLimit(limit: unknown): number {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}
