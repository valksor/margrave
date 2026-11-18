// Build build/margrave: a Node single executable application (SEA) of dist/cli.js.
// Run `pnpm run build` first (or use `pnpm run build:sea`).
import { execFileSync } from "node:child_process";
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

execFileSync(process.execPath, ["--build-sea", path.join(root, "sea-config.json")], { cwd: root, stdio: "inherit" });

// Apple Silicon kills an unsigned arm64 binary, so sign ad hoc.
if (process.platform === "darwin") {
  execFileSync("codesign", ["--force", "--sign", "-", path.join(root, "build", "margrave")], { stdio: "inherit" });
}
