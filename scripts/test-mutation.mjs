import { Stryker, StrykerCli } from "@stryker-mutator/core";

if (process.argv.length > 2) {
  new StrykerCli([...process.argv.slice(0, 2), "run", ...process.argv.slice(2)]).run();
} else {
  const targets = {
    bm25: ["test/bm25.test.ts"],
    text: ["test/text.test.ts"],
    wrap: ["test/wrap.test.ts"],
    scan: ["test/scan.test.ts"],
    "skill-files": ["test/guard.test.ts"],
    "safety-runner": ["test/safety-runner.test.ts", "test/no-vendored-ripwire.test.ts"],
    safety: ["test/safety.test.ts"],
    "catalog-legacy": ["--test-timeout=2000", "--test-name-pattern='^catalog legacy direct '", "test/catalog-legacy.test.ts"],
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
    "source-git": [
      "--test-name-pattern='^(source Git direct |spec parsing|owner/repo|a spec or --ref|a subpath segment|malformed specs|source ids|a git URL)'",
      "test/source-git.test.ts",
    ],
    mcp: [
      "--test-name-pattern='^(MCP server direct |MCP smoke|MCP server version|a tool whose work rejects|MCP in-process|stdio source allowlists|stdio serves|hosted tools have|hosted: with no sources|hosted: find, load, read|hosted: a store failure|hosted source options|hosted file reads|CLI, stdio and hosted opt in)'",
      "test/mcp.test.ts",
      "test/hosted.test.ts",
      "test/skills-sh.test.ts",
    ],
    "mcp-skills": ["--test-timeout=2000", "--test-name-pattern='^MCP Skills direct '", "test/mcp.test.ts", "test/hosted.test.ts"],
    hosted: ["test/hosted.test.ts"],
  };

  for (const [target, testArgs] of Object.entries(targets)) {
    const stryker = new Stryker({
      mutate: [`src/${target}.ts`],
      commandRunner: {
        command: `node --import ./test/no-vendored-ripwire.ts --test --test-concurrency=1 ${testArgs.join(" ")}`,
      },
      reporters: ["clear-text", "progress", "html", "json"],
      htmlReporter: { fileName: `coverage/mutation/${target}.html` },
      jsonReporter: { fileName: `coverage/mutation/${target}.json` },
    });
    const mutants = await stryker.runMutationTest();
    if (mutants.length === 0 || mutants.some((mutant) => mutant.status !== "Killed")) {
      console.error(`${target}: each generated mutant must be killed by a test`);
      process.exitCode = 1;
    }
  }
}
