// ripwire scan wrapper. Syntax checked against `ripwire --help`: `ripwire security --scan-skills=<dir>`.
// Exit codes: 0 clean, 1 WARN, 2 CRITICAL, 3 could not read.
import { execFile } from "node:child_process";
import { MargraveError } from "./store.ts";

export interface ScanOutcome {
  /** ripwire exit code, or null when ripwire could not run. */
  code: number | null;
  output: string;
  /** True when --allow-unsafe overrode a refusal. */
  overridden: boolean;
}

interface Execed {
  code: number | string | null;
  stdout: string;
  stderr: string;
  missing: boolean;
}

function run(dir: string): Promise<Execed> {
  return new Promise((resolve) => {
    execFile(
      "ripwire",
      ["security", `--scan-skills=${dir}`],
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ code: 0, stdout, stderr, missing: false });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        resolve({ code: e.code ?? null, stdout: stdout ?? "", stderr: stderr ?? "", missing: e.code === "ENOENT" });
      },
    );
  });
}

/**
 * Scan `dir` with ripwire. Exit 0 continues. Exit 1 reports the findings and continues.
 * Exit 2, 3, any other code, or ripwire missing refuses, unless `allowUnsafe` is set.
 */
export async function scanWithRipwire(
  dir: string,
  opts: { allowUnsafe: boolean; log: (msg: string) => void },
): Promise<ScanOutcome> {
  const r = await run(dir);
  const output = `${r.stdout}${r.stderr}`.trim();
  if (r.code === 0) return { code: 0, output, overridden: false };
  if (r.code === 1) {
    opts.log(`ripwire WARN for ${dir}:\n${output}`);
    return { code: 1, output, overridden: false };
  }

  let reason: string;
  if (r.missing) {
    reason = "ripwire was not found on PATH";
  } else if (r.code === 2) {
    reason = "ripwire found CRITICAL findings (exit 2)";
  } else if (r.code === 3) {
    reason = "ripwire could not read the files (exit 3)";
  } else {
    reason = `ripwire failed (exit ${String(r.code)})`;
  }
  const detail = output === "" ? "" : `\n${output}`;
  if (opts.allowUnsafe) {
    opts.log(`--allow-unsafe: overriding refusal (${reason})${detail}`);
    return { code: typeof r.code === "number" ? r.code : null, output, overridden: true };
  }
  throw new MargraveError(`refused: ${reason}${detail}\nre-run with --allow-unsafe to override for this one command`);
}
