import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "margrave-codeql-"));
let findings = 0;

try {
  for (const [language, suite] of [
    ["javascript-typescript", "codeql/javascript-queries:codeql-suites/javascript-security-and-quality.qls"],
    ["actions", "codeql/actions-queries:codeql-suites/actions-security-and-quality.qls"],
  ]) {
    const database = join(temporary, language);
    const report = join(temporary, `${language}.sarif`);
    for (const [stage, args] of [
      [
        "database creation",
        [
          "database",
          "create",
          database,
          `--language=${language}`,
          `--source-root=${root}`,
          `--codescanning-config=${join(root, ".github/codeql/local.yml")}`,
          "--threads=2",
        ],
      ],
      ["analysis", ["database", "analyze", database, suite, "--format=sarifv2.1.0", `--output=${report}`, "--threads=2"]],
    ]) {
      const result = spawnSync("codeql", args, { cwd: root, stdio: "inherit" });
      if (result.error?.code === "ENOENT") {
        throw new Error("CodeQL CLI is required. Install the CodeQL bundle and add codeql to PATH.");
      }
      if (result.error || result.status !== 0) {
        if (result.error) console.error(result.error.message);
        throw new Error(`CodeQL ${String(stage)} failed for ${language}.`);
      }
    }

    let results;
    try {
      const sarif = JSON.parse(readFileSync(report, "utf8"));
      if (sarif.version !== "2.1.0" || !Array.isArray(sarif.runs) || sarif.runs.length === 0) throw new Error();
      results = sarif.runs.flatMap((run) => {
        if (!Array.isArray(run.results)) throw new Error();
        return run.results;
      });
      for (const result of results) {
        if (typeof result.ruleId !== "string" || typeof result.message?.text !== "string") throw new Error();
        const physical = result.locations?.[0]?.physicalLocation;
        if (physical && (typeof physical.artifactLocation?.uri !== "string" || !Number.isInteger(physical.region?.startLine)))
          throw new Error();
        if (physical) decodeURI(physical.artifactLocation.uri);
      }
    } catch {
      throw new Error(`CodeQL returned an invalid SARIF report for ${language}.`);
    }
    for (const result of results) {
      const physical = result.locations?.[0]?.physicalLocation;
      const location = physical
        ? `${decodeURI(physical.artifactLocation.uri)}:${physical.region.startLine}:${physical.region.startColumn ?? 1}`
        : "CodeQL";
      console.error(`${location}: error: ${result.message.text.replace(/\s*\r?\n\s*/gu, " ")} [${result.ruleId}]`);
      findings++;
    }
  }
  if (findings) {
    console.error(`CodeQL reported ${findings} finding(s).`);
    process.exitCode = 1;
  } else {
    console.log("CodeQL found no issues.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
