import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const INPUT_FILES = [
  "scripts/run-mutation-tests.mjs",
  "scripts/ensure-ripwire.mjs",
  "examples/hosted-mcp.mjs",
  "package.json",
  "pnpm-lock.yaml",
];

export function testInputsFingerprint(command, overrides, root = process.cwd()) {
  const hash = createHash("sha256");
  for (const part of [command, JSON.stringify(overrides), process.version]) {
    hash.update(part);
    hash.update("\0");
  }
  for (const file of inputFiles(root)) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function readStamp(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

// Mirrors what Stryker 10.1.1's readIncrementalReport and incremental differ dereference,
// so a parseable but malformed report is treated as unusable and never read by Stryker.
export function isUsableReport(file) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
  if (typeof report !== "object" || report === null) return false;
  if (typeof report.files !== "object" || report.files === null) return false;
  for (const entry of Object.values(report.files)) {
    if (typeof entry !== "object" || entry === null || typeof entry.source !== "string" || !Array.isArray(entry.mutants)) return false;
    for (const mutant of entry.mutants) {
      if (typeof mutant !== "object" || mutant === null) return false;
      if (typeof mutant.location !== "object" || mutant.location === null) return false;
      if (typeof mutant.location.start !== "object" || mutant.location.start === null) return false;
    }
  }
  if (report.testFiles !== undefined) {
    if (typeof report.testFiles !== "object" || report.testFiles === null) return false;
    for (const entry of Object.values(report.testFiles)) {
      if (typeof entry !== "object" || entry === null || !Array.isArray(entry.tests)) return false;
      for (const test of entry.tests) {
        if (typeof test !== "object" || test === null) return false;
        if (test.location !== undefined && test.location !== null && typeof test.location !== "object") return false;
      }
    }
  }
  return true;
}

function inputFiles(root) {
  const tests = readdirSync(join(root, "test"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() || (entry.isSymbolicLink() && statSync(join(entry.parentPath, entry.name)).isFile()))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
  return [...INPUT_FILES, ...tests].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
