// Build build/margrave: a Node single executable application (SEA) of dist/cli.js.
// Run `pnpm run build` first (or use `pnpm run build:sea`).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "dist", "cli.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: path.join(root, "build", "margrave.mjs"),
  banner: {
    js: "import { createRequire as __mgCreateRequire } from 'node:module'; const require = __mgCreateRequire(import.meta.url);",
  },
});

const config = path.join(root, "sea-config.json");
const tempDir = process.platform === "linux" ? mkdtempSync(path.join(tmpdir(), "margrave-sea-")) : undefined;
try {
  let seaConfigPath = config;
  if (tempDir) {
    const seaConfig = JSON.parse(readFileSync(config, "utf8"));
    const temporaryNode = path.join(tempDir, "node");
    // Strip Node before it adds the SEA note and its ELF load segment.
    execFileSync("strip", ["--strip-unneeded", "-o", temporaryNode, process.execPath], { stdio: "inherit" });
    seaConfig.executable = temporaryNode;
    seaConfigPath = path.join(tempDir, "sea-config.json");
    writeFileSync(seaConfigPath, JSON.stringify(seaConfig));
  }
  execFileSync(process.execPath, ["--build-sea", seaConfigPath], { cwd: root, stdio: "inherit" });
} finally {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

const executable = path.join(root, "build", "margrave");

// Apple Silicon kills an unsigned arm64 binary, so sign ad hoc.
if (process.platform === "darwin") {
  execFileSync("strip", ["-S", "-x", executable], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", "-", executable], { stdio: "inherit" });
}
