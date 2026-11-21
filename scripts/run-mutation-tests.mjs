import { resolve } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    "test-name-pattern": { type: "string" },
    "test-timeout": { type: "string" },
    "test-force-exit": { type: "boolean" },
    import: { type: "string", multiple: true },
  },
  allowPositionals: true,
  strict: true,
});

if (positionals.length === 0) throw new Error("At least one test file is required");

const control = new AbortController();
run({
  files: positionals.map((file) => resolve(file)),
  concurrency: 1,
  isolation: "process",
  testNamePatterns: values["test-name-pattern"],
  timeout: values["test-timeout"] === undefined ? undefined : Number(values["test-timeout"]),
  forceExit: values["test-force-exit"],
  execArgv: [
    ...process.execArgv,
    "--import",
    "./test/isolate-store.ts",
    "--import",
    "./test/no-vendored-ripwire.ts",
    ...(values.import ?? []).flatMap((value) => ["--import", value]),
  ],
  signal: control.signal,
})
  .on("test:fail", () => {
    process.exitCode = 1;
    control.abort();
  })
  .compose(spec)
  .pipe(process.stdout);
