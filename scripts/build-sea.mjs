// Build a Node single executable application (SEA) of dist/cli.js.
// Run pnpm run build:sea for the development binary.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dev = process.argv.includes("--dev");
const config = path.join(root, ...(dev ? ["build", "dev", "sea-config.json"] : ["sea-config.json"]));
let version;

if (dev) {
  const dir = path.join(root, "build", "dev");
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  const seaConfig = JSON.parse(readFileSync(path.join(root, "sea-config.json"), "utf8"));
  seaConfig.main = "build/dev/margrave.mjs";
  seaConfig.output = "build/dev/bin/margrave-dev";
  writeFileSync(config, JSON.stringify(seaConfig, null, 2));
  ({ version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")));
  try {
    symlinkSync(path.join(root, "vendor"), path.join(dir, "vendor"), "dir");
  } catch (error) {
    if (error.code !== "EEXIST" || readlinkSync(path.join(dir, "vendor")) !== path.join(root, "vendor")) throw error;
  }
}

await build({
  entryPoints: [path.join(root, "dist", "cli.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  outfile: path.join(root, "build", ...(dev ? ["dev", "margrave.mjs"] : ["margrave.mjs"])),
  banner: {
    js: "import { createRequire as __mgCreateRequire } from 'node:module'; const require = __mgCreateRequire(import.meta.url);",
  },
});

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

const executable = path.join(root, "build", ...(dev ? ["dev", "bin", "margrave-dev"] : ["margrave"]));

// Apple Silicon kills an unsigned arm64 binary, so sign ad hoc.
if (process.platform === "darwin") {
  execFileSync("strip", ["-S", "-x", executable], { stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", "-", executable], { stdio: "inherit" });
}

if (dev) {
  writeFileSync(path.join(root, "build", "dev", "package.json"), JSON.stringify({ version: `${version}-dirty` }, null, 2));
}
