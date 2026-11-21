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
    search: ["test/skills-sh.test.ts"],
  };

  for (const [target, tests] of Object.entries(targets)) {
    const stryker = new Stryker({
      mutate: [`src/${target}.ts`],
      commandRunner: {
        command: `node --import ./test/no-vendored-ripwire.ts --test --test-concurrency=1 ${tests.join(" ")}`,
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
