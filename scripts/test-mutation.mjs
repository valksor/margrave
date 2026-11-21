import { globSync } from "node:fs";
import { sep } from "node:path";
import { Stryker, StrykerCli } from "@stryker-mutator/core";

const targets = {
  bm25: ["test/bm25.test.ts"],
  text: ["test/text.test.ts"],
  wrap: ["test/wrap.test.ts"],
  scan: ["test/scan.test.ts"],
  "skill-files": ["test/guard.test.ts"],
  "safety-runner": ["test/safety-runner.test.ts", "test/no-vendored-ripwire.test.ts"],
  safety: ["test/safety.test.ts"],
  "catalog-legacy": ["--test-timeout=2000", "--test-name-pattern='^catalog legacy direct '", "test/catalog-legacy.test.ts"],
  catalog: [
    "--test-timeout=2000",
    "--test-name-pattern='^(catalog (read|write|rows) direct |catalog legacy direct locks a read-only reader)'",
    "test/catalog.test.ts",
    "test/catalog-legacy.test.ts",
  ],
  search: ["test/skills-sh.test.ts"],
  skills: ["test/index.test.ts", "test/guard.test.ts", "test/text.test.ts"],
  "lock-format": [
    "--test-name-pattern='^lock (validation|identity|parsing|inventory|export API|verification)'",
    "test/lock-format.test.ts",
    "test/lock.test.ts",
  ],
  lock: [
    "--test-name-pattern='^(lock pending direct |lock restore direct |an empty store exports and restores|version 2 restores selected skills|restore syncs an interrupted snapshot|restore resumes a pending snapshot|restore keeps a competing source record|recovery refuses a competing source update|lock restore refuses staged edits|restore refuses a source installed after preflight|restore retains competing index changes|restore recreates the pending marker|restore keeps a competing marker|restore rejects a staged commit|lock round trips a SHA-256 Git repository|lock restore reports publication when marker cleanup fails)'",
    "test/lock.test.ts",
    "test/integration.test.ts",
  ],
  "store-files": [
    "--test-name-pattern='^(store files |a missing sources|home|a sources.json that cannot be read|every field of a source record|atomic writes)'",
    "test/store-files.test.ts",
  ],
  store: [
    "--test-name-pattern='^(a store directory that cannot be inspected|writer lock timeout and unexpected SQLite errors|a missing sources.json is an empty list)'",
    "test/catalog.test.ts",
    "test/store-files.test.ts",
  ],
  "source-git": [
    "--test-name-pattern='^(source Git direct |spec parsing|owner/repo|a spec or --ref|a subpath segment|malformed specs|source ids|a git URL)'",
    "test/source-git.test.ts",
  ],
  "source-files": [
    "--test-timeout=2000",
    "--test-name-pattern='^source files (snapshot|ownership|publication|scan) direct '",
    "test/source-files.test.ts",
    "test/source-files-publication.test.ts",
    "test/source-files-scan.test.ts",
  ],
  "source-maintenance": [
    "--test-name-pattern='^(source maintenance direct |check reports a source record|check reports a metadata read|check scans valid skills|check reports an unavailable local Git remote|reindex: control characters|a reindex whose sources|a remove whose source)'",
    "test/source-maintenance.test.ts",
  ],
  sources: [
    "--test-name-pattern='^(sources (install|update) direct |Git install and update refuse staged changes|Git update preserves a source record|local selections expand and reject competing source changes|selection expansion rejects a source replaced between reads|Git update preserves another writer|update of all sources: a rejection|Git install preserves a competing record or alias|update proceeds when every finding is known|update applies install rules when the accepted scan is unknown)'",
    "test/sources-install.test.ts",
    "test/sources-update.test.ts",
    "test/sources.test.ts",
    "test/source-files.test.ts",
    "test/integration.test.ts",
  ],
  "migration-backup": [
    "--import ./test/bounded-metadata-reads.ts",
    "--test-timeout=3000",
    "--test-name-pattern='^(migration backup (verify|metadata|publication) direct |legacy backup validates selected file types|backup cleanup handles non-Error failures|backup rejects a snapshot changed during archiving|backup does not release the catalog lock|backup and record hashing preserve the catalog|prepared record refuses backup files linked|backup reports an unreadable catalog)'",
    "test/migration-backup-verification.test.ts",
    "test/migration-backup-acl.test.ts",
    "test/migration-backup-publication.test.ts",
    "test/migration-backup.test.ts",
  ],
  "migration-recovery": [
    "--test-timeout=3000",
    "--test-force-exit",
    "--test-name-pattern='^migration recovery (record|journal|locked) direct '",
    "test/migration-recovery-record.test.ts",
    "test/migration-recovery-journal.test.ts",
    "test/migration-recovery-locked.test.ts",
  ],
  "source-migration": [
    "--test-timeout=3000",
    "--test-force-exit",
    "--test-name-pattern='^source migration (direct |preflight direct |publication direct )'",
    "test/source-migration-publication.test.ts",
    "test/source-migration-preflight.test.ts",
    "test/source-migration-direct.test.ts",
  ],
  mcp: [
    "--test-name-pattern='^(MCP server direct |MCP smoke|MCP server version|a tool whose work rejects|MCP in-process|stdio source allowlists|stdio serves|hosted tools have|hosted: with no sources|hosted: find, load, read|hosted: a store failure|hosted source options|hosted file reads|CLI, stdio and hosted opt in)'",
    "test/mcp.test.ts",
    "test/hosted.test.ts",
    "test/skills-sh.test.ts",
  ],
  "mcp-skills": ["--test-timeout=2000", "--test-name-pattern='^MCP Skills direct '", "test/mcp.test.ts", "test/hosted.test.ts"],
  hosted: ["test/hosted.test.ts"],
  cli: [
    "--test-name-pattern='^(CLI (direct |output direct |Git direct )|CLI, stdio and hosted opt in|empty stores reject explicit source checks|with no sources: update|wrap adds a build note on stderr|lock export and restore pins|stdio serves a client|reference-only updates change revision|a Git skill at the snapshot root reports drift|usage and setup commands do not upgrade a legacy store|released v0.2.1 store remains)'",
    "test/cli.test.ts",
    "test/cli-output.test.ts",
    "test/cli-git.test.ts",
    "test/integration.test.ts",
    "test/skills-sh.test.ts",
    "test/source-migration.test.ts",
    "test/mcp.test.ts",
  ],
};

const aggregateOptions = new Set(["concurrency", "maxConcurrentTestRunners", "logLevel", "fileLogLevel", "allowConsoleColors"]);
if (process.argv.length === 3 && (process.argv[2] === "--help" || process.argv[2] === "-h")) {
  console.log(
    `pnpm run test:mutation runs the whole-source gate. Allowed options: ${[...aggregateOptions].map((option) => `--${option}`).join(", ")}.`,
  );
  console.log("Use --mutate, --dryRunOnly, or a config file for a Stryker diagnostic.\n");
}

new StrykerCli([...process.argv.slice(0, 2), "run", ...process.argv.slice(2)], undefined, async (options) => {
  if (options.mutate !== undefined || options.configFile !== undefined || options.dryRunOnly !== undefined) {
    return new Stryker(options).runMutationTest();
  }

  const unsupported = Object.keys(options).find((option) => !aggregateOptions.has(option));
  if (unsupported) {
    console.error(`Unsupported option for the whole-source mutation gate: --${unsupported}. Use pnpm exec stryker run for diagnostics.`);
    process.exitCode = 1;
    return [];
  }

  await runAll(options);
  return [];
}).run();

async function runAll(options) {
  const discovered = new Set(globSync("src/**/*.ts").map((file) => file.replaceAll(sep, "/")));
  const mapped = new Set(Object.keys(targets).map((target) => `src/${target}.ts`));
  const missing = [...discovered].filter((file) => !mapped.has(file)).sort((a, b) => a.localeCompare(b));
  const stale = [...mapped].filter((file) => !discovered.has(file)).sort((a, b) => a.localeCompare(b));
  if (missing.length > 0) console.error(`Missing mutation targets: ${missing.join(", ")}`);
  if (stale.length > 0) console.error(`Stale mutation targets: ${stale.join(", ")}`);
  if (missing.length > 0 || stale.length > 0) process.exit(1);

  for (const [target, testArgs] of Object.entries(targets)) {
    const stryker = new Stryker({
      ...options,
      mutate: [`src/${target}.ts`],
      ...(target === "migration-backup" || target === "source-migration" ? { timeoutMS: 16_000 } : {}),
      ...(target === "migration-recovery" ? { timeoutMS: 75_000 } : {}),
      commandRunner: {
        command: `node scripts/run-mutation-tests.mjs ${testArgs.join(" ")}`,
      },
      reporters: ["clear-text", "progress", "html", "json"],
      htmlReporter: { fileName: `coverage/mutation/${target}.html` },
      jsonReporter: { fileName: `coverage/mutation/${target}.json` },
    });
    const mutants = await stryker.runMutationTest();
    if ((target !== "store" && mutants.length === 0) || mutants.some((mutant) => mutant.status !== "Killed")) {
      console.error(`${target}: each generated mutant must be killed by a test`);
      process.exitCode = 1;
    }
  }
}
