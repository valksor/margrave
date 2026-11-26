import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { isUsableReport, readStamp, testInputsFingerprint } from "../scripts/mutation-cache.mjs";

const INPUT_FILES = [
  "scripts/run-mutation-tests.mjs",
  "scripts/ensure-ripwire.mjs",
  "examples/hosted-mcp.mjs",
  "package.json",
  "pnpm-lock.yaml",
];

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "margrave-mutation-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of INPUT_FILES) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), `content of ${file}\n`);
  }
  mkdirSync(join(root, "test", "fixtures"), { recursive: true });
  writeFileSync(join(root, "test", "a.test.ts"), "one\n");
  writeFileSync(join(root, "outside.ts"), "outside\n");
  symlinkSync(join("..", "outside.ts"), join(root, "test", "linked.ts"));
  return root;
}

test("the test-input fingerprint is deterministic for the same inputs", (t) => {
  const root = fixture(t);
  assert.equal(testInputsFingerprint("cmd", {}, root), testInputsFingerprint("cmd", {}, root));
});

test("the fingerprint changes when a test file changes by one byte", (t) => {
  const root = fixture(t);
  const before = testInputsFingerprint("cmd", {}, root);
  writeFileSync(join(root, "test", "a.test.ts"), "one\nx");
  assert.notEqual(testInputsFingerprint("cmd", {}, root), before);
});

test("the fingerprint follows symlinked test inputs", (t) => {
  const root = fixture(t);
  const before = testInputsFingerprint("cmd", {}, root);
  writeFileSync(join(root, "outside.ts"), "changed\n");
  assert.notEqual(testInputsFingerprint("cmd", {}, root), before);
});

test("the fingerprint covers the lockfile", (t) => {
  const root = fixture(t);
  const before = testInputsFingerprint("cmd", {}, root);
  writeFileSync(join(root, "pnpm-lock.yaml"), "changed\n");
  assert.notEqual(testInputsFingerprint("cmd", {}, root), before);
});

test("the fingerprint covers the command and the target overrides", (t) => {
  const root = fixture(t);
  const before = testInputsFingerprint("cmd", {}, root);
  assert.notEqual(testInputsFingerprint("cmd --test-timeout=1", {}, root), before);
  assert.notEqual(testInputsFingerprint("cmd", { timeoutMS: 1 }, root), before);
});

test("readStamp returns undefined for a missing file and the trimmed value otherwise", (t) => {
  const root = fixture(t);
  assert.equal(readStamp(join(root, "missing.stamp")), undefined);
  writeFileSync(join(root, "b.stamp"), " abc \n");
  assert.equal(readStamp(join(root, "b.stamp")), "abc");
});

test("isUsableReport rejects a missing or truncated report", (t) => {
  const root = fixture(t);
  assert.equal(isUsableReport(join(root, "missing.json")), false);
  writeFileSync(join(root, "truncated.json"), '{"files":');
  assert.equal(isUsableReport(join(root, "truncated.json")), false);
});

test("isUsableReport rejects parseable reports Stryker would throw on", (t) => {
  const root = fixture(t);
  const cases: [string, string][] = [
    ["null.json", "null"],
    ["no-files.json", "{}"],
    ["null-files.json", '{"files":null}'],
    ["no-source.json", '{"files":{"a.ts":{"mutants":[]}}}'],
    ["no-mutants.json", '{"files":{"a.ts":{"source":"x"}}}'],
    ["bad-mutant.json", '{"files":{"a.ts":{"source":"x","mutants":[{}]}}}'],
    ["no-location.json", '{"files":{"a.ts":{"source":"x","mutants":[{"location":null}]}}}'],
    ["bad-test-files.json", '{"files":{},"testFiles":null}'],
    ["no-tests.json", '{"files":{},"testFiles":{"a.test.ts":{}}}'],
  ];
  for (const [name, report] of cases) {
    writeFileSync(join(root, name), report);
    assert.equal(isUsableReport(join(root, name)), false, name);
  }
});

test("isUsableReport accepts an empty or populated report", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "empty.json"), '{"files":{}}');
  assert.equal(isUsableReport(join(root, "empty.json")), true);
  const start = { line: 1, column: 0 };
  const populated = {
    files: { "a.ts": { source: "x", mutants: [{ location: { start, end: start } }] } },
    testFiles: { "a.test.ts": { tests: [{ location: null }] } },
  };
  writeFileSync(join(root, "populated.json"), JSON.stringify(populated));
  assert.equal(isUsableReport(join(root, "populated.json")), true);
});
