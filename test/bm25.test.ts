import assert from "node:assert/strict";
import test from "node:test";
import { buildFieldTokens, buildStats, clampLimit, rank, tokenize } from "../src/bm25.ts";
import type { Doc } from "../src/bm25.ts";

function doc(id: string, name: string, description: string, body = "", headings: string[] = []): Doc {
  return { id, name, fieldTokens: buildFieldTokens({ name, description, headings, body }) };
}

function ranked(docs: Doc[], query: string, limit = 10): string[] {
  return rank(docs, buildStats(docs), query, limit).map((r) => r.id);
}

test("tokenizer lowercases, splits on non-alphanumerics, drops stopwords", () => {
  assert.deepEqual(tokenize("The Quick-Brown FOX, and the dog!"), ["quick", "brown", "fox", "dog"]);
});

test("tokenizer keeps two-letter tech tokens and drops one-letter tokens", () => {
  assert.deepEqual(tokenize("go js x ci"), ["go", "js", "ci"]);
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
  assert.deepEqual(tokenize("uses gets setting"), [], "stem is a stopword: us, get, set");
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

test("body is cut to its first 2000 tokens", () => {
  const body = `${"alpha ".repeat(2000)}omega`;
  const ft = buildFieldTokens({ name: "n", description: "d", headings: [], body });
  assert.equal(ft.body["alpha"], 2000);
  assert.equal(ft.body["omega"], undefined);
});

test("BM25 ranks the document that matches the query best first", () => {
  const docs = [
    doc("s/react-perf", "react-perf", "Optimize React rendering performance"),
    doc("s/postgres", "postgres", "Tune PostgreSQL queries and indexes"),
    doc("s/docker", "docker", "Write Docker Compose files"),
  ];
  assert.equal(ranked(docs, "react performance")[0], "s/react-perf");
  assert.equal(ranked(docs, "postgresql index")[0], "s/postgres");
  assert.deepEqual(ranked(docs, "kubernetes"), []);
});

test("a name match outweighs the same word in the body", () => {
  const docs = [
    doc("s/a", "alpha", "Something unrelated", "redis redis redis redis"),
    doc("s/b", "redis", "Something else"),
  ];
  assert.equal(ranked(docs, "redis")[0], "s/b");
});

test("an exact name or id match adds a bonus and wins over a stronger text match", () => {
  const docs = [
    doc("s/deploy-guide", "deploy-guide", "deploy deploy deploy production deploy checklist", "deploy deploy"),
    doc("s/prod", "production", "Short note"),
  ];
  assert.equal(ranked(docs, "production deploy")[0], "s/deploy-guide");
  assert.equal(ranked(docs, "production")[0], "s/prod");
  assert.equal(ranked(docs, "S/PROD")[0], "s/prod");
});

test("equal scores break by id ascending", () => {
  const docs = [
    doc("s/zeta", "same", "identical description text"),
    doc("s/alpha", "same", "identical description text"),
    doc("s/mid", "same", "identical description text"),
  ];
  assert.deepEqual(ranked(docs, "identical description"), ["s/alpha", "s/mid", "s/zeta"]);
});

test("the limit cuts the result list", () => {
  const docs = ["a", "b", "c", "d"].map((x) => doc(`s/${x}`, x, "shared words here"));
  assert.equal(ranked(docs, "shared words", 2).length, 2);
});

test("tokens named like Object.prototype members do not break ranking after a JSON round trip", () => {
  const docs = [doc("s/a", "a-skill", "explains the constructor pattern and toString"), doc("s/b", "b-skill", "other")];
  const round = JSON.parse(JSON.stringify({ docs, stats: buildStats(docs) })) as { docs: Doc[]; stats: ReturnType<typeof buildStats> };
  const result = rank(round.docs, round.stats, "constructor valueOf", 5);
  assert.deepEqual(result.map((r) => r.id), ["s/a"]);
  assert.ok(Number.isFinite(result[0]?.score));
});

test("clampLimit defaults to 5 and clamps to 1..25", () => {
  assert.equal(clampLimit(undefined), 5);
  assert.equal(clampLimit("abc"), 5);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-3), 1);
  assert.equal(clampLimit(10), 10);
  assert.equal(clampLimit("100"), 25);
});
