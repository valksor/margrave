import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  BODY_TOKEN_LIMIT,
  FIELD_WEIGHTS,
  MAX_QUERY_TERMS,
  buildFieldTokens,
  clampLimit,
  hasRecommendationEvidence,
  queryTerms,
  tokenize,
} from "../src/bm25.ts";

test("ranking weights match the documented BM25 policy", () => {
  assert.deepEqual(FIELD_WEIGHTS, { name: 3, description: 2, headings: 1, body: 0.3 });
});

test("Unicode terms normalize identically in the query and FTS vocabulary", () => {
  const terms = queryTerms("pieturzīmes हिन्दी 資料 TESTING");
  assert.deepEqual(terms, ["pieturzīmes", "हिन्दी", "資料", "test"]);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE fts USING fts5(text, tokenize='ascii'); CREATE VIRTUAL TABLE vocab USING fts5vocab(fts, 'row')");
    db.prepare("INSERT INTO fts VALUES (?)").run(terms.join(" "));
    const vocabulary = db.prepare("SELECT term FROM vocab ORDER BY term").all() as { term: string }[];
    assert.deepEqual(vocabulary.map((row) => row.term).sort(), [...terms].sort());
  } finally {
    db.close();
  }
});

test("single Unicode words and leading combining marks", () => {
  assert.deepEqual(tokenize("火 a \u0301b"), ["火"]);
});

test("tokenizer lowercases, splits on non-alphanumerics, drops stopwords", () => {
  assert.deepEqual(tokenize("The Quick-Brown FOX, and the dog!"), ["quick", "brown", "fox", "dog"]);
});

test("tokenizer drops common search filler words", () => {
  const words = [
    "Is in on at to of or if it be as by we do no so up an my me us",
    "The and for with use used using when into from your that this you are not any its",
    "How why what which will can get set via per out new one two all but",
    "Has have had was were them then than over under before after",
  ].join(" ");
  assert.deepEqual(tokenize(words), []);
});

test("tokenizer keeps two-letter tech tokens and drops one-letter tokens", () => {
  assert.deepEqual(tokenize("go js x ci"), ["go", "js", "ci"]);
});

test("tokenizer drops a one-letter ASCII stem", () => {
  assert.deepEqual(tokenize("AED"), []);
});

test("tokenizer maps e-final and y-final base words to the same stem as their inflections", () => {
  for (const group of [
    ["compromise", "compromised", "compromising", "compromises"],
    ["analyze", "analyzed", "analyzing", "analyzes"],
    ["image", "imaging", "images"],
    ["policy", "policies"],
    ["query", "queried", "queries"],
  ]) {
    const stems = new Set(group.map((w) => tokenize(w).join(" ")));
    assert.equal(stems.size, 1, `${group.join(", ")} -> ${[...stems].join(" | ")}`);
  }
});

test("tokenizer keeps unrelated words apart (Porter does not strip a final e after a consonant-vowel-consonant)", () => {
  for (const [a, b] of [
    ["care", "car"],
    ["hope", "hop"],
    ["rate", "rat"],
    ["node", "nod"],
  ] as const) {
    assert.notDeepEqual(tokenize(a), tokenize(b), `${a} and ${b} must not share a stem`);
  }
});

test("note and noted keep a token that is not a stopword", () => {
  assert.deepEqual(tokenize("note"), ["note"]);
  assert.deepEqual(tokenize("noted"), ["note"]);
});

test("a stopword is dropped before stemming and again after it", () => {
  assert.deepEqual(tokenize("used using use"), [], "stopword before stemming");
  assert.deepEqual(tokenize("uses gets setting usedness usee"), [], "stem is a stopword: us, get, set, used, use");
});

test("tokenizer stems -ing, -ed, -es, -s consistently", () => {
  assert.deepEqual(tokenize("testing"), ["test"]);
  assert.deepEqual(tokenize("tested"), ["test"]);
  assert.deepEqual(tokenize("tests"), ["test"]);
  assert.deepEqual(tokenize("boxes"), ["box"]);
  assert.deepEqual(tokenize("files"), tokenize("file"));
  assert.deepEqual(tokenize("string strings"), tokenize("strings string"));
  assert.deepEqual(tokenize("class"), ["class"]);
});

test("tokenizer is deterministic and keeps duplicates for term frequency", () => {
  assert.deepEqual(tokenize("react React REACT"), ["react", "react", "react"]);
  assert.deepEqual(tokenize("a b c"), []);
});

test("body is cut to its first 2000 tokens; duplicates stay, so term frequency is kept", () => {
  const body = `${"alpha ".repeat(BODY_TOKEN_LIMIT)}omega`;
  const ft = buildFieldTokens({ name: "n", description: "d", headings: [], body });
  assert.equal(ft.body, Array<string>(BODY_TOKEN_LIMIT).fill("alpha").join(" "));
});

test("buildFieldTokens returns one space-joined token string per FTS column", () => {
  const ft = buildFieldTokens({
    name: "React-Perf",
    description: "Optimize the rendering",
    headings: ["Setup tips", "Rules"],
    body: "see the docs",
  });
  assert.deepEqual(ft, { name: "react perf", description: "optim render", headings: "setup tip rule", body: "see doc" });
});

test("queryTerms keeps unique tokens in first-seen order and caps them at 32", () => {
  assert.deepEqual(queryTerms("React the react Docker"), ["react", "docker"]);
  assert.deepEqual(queryTerms("the and of"), []);
  const many = Array.from({ length: 10_000 }, (_, i) => `word${i}`).join(" ");
  const terms = queryTerms(many);
  assert.equal(terms.length, MAX_QUERY_TERMS);
  assert.equal(MAX_QUERY_TERMS, 32);
  assert.deepEqual(terms.slice(0, 2), ["word0", "word1"]);
});

test("clampLimit defaults to 5 and clamps to 1..25", () => {
  assert.equal(clampLimit(undefined), 5);
  assert.equal(clampLimit("abc"), 5);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-3), 1);
  assert.equal(clampLimit(10), 10);
  assert.equal(clampLimit("100"), 25);
});

test("a single query term requires a name match in the recommendation rule", () => {
  const matched = { name: [], description: ["react"], headings: ["react"], body: ["react"] };
  assert.equal(hasRecommendationEvidence(["react"], matched), false);
  assert.equal(hasRecommendationEvidence(["react"], { ...matched, name: ["react"] }), true);
});

test("matching all query terms qualifies even when all matches are in the body", () => {
  const terms = ["react", "docker", "sqlite", "git"];
  const matched = { name: [], description: [], headings: [], body: terms };
  assert.equal(hasRecommendationEvidence(terms, matched), true);
  assert.equal(hasRecommendationEvidence(terms, { ...matched, body: terms.slice(0, 3) }), false);
});

test("a partial recommendation needs two prominent terms and one third of the query", () => {
  const terms = ["react", "docker", "sqlite", "git", "json", "yaml", "node"];
  const matched = { name: [], description: ["react"], headings: ["docker"], body: [] };
  assert.equal(hasRecommendationEvidence(terms.slice(0, 5), matched), true);
  assert.equal(hasRecommendationEvidence(terms.slice(0, 6), matched), true);
  assert.equal(hasRecommendationEvidence(terms, matched), false);
});

test("duplicate field hits and body hits do not count as distinct prominent terms", () => {
  const matched = { name: ["react"], description: ["react"], headings: [], body: ["docker"] };
  assert.equal(hasRecommendationEvidence(["react", "docker", "sqlite"], matched), false);
});
