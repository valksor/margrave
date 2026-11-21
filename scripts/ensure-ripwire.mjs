// Makes sure vendor/ripwire/ holds the pinned ripwire. margrave runs that copy first for the skill scan
// of `install` and `update`, and `ripwire` from PATH only when there is none. A ripwire on PATH does not skip this.
//
// 1. vendor/ripwire/ already holds the pinned version: nothing to do.
// 2. Otherwise download the pinned release, check its SHA-256 before it is unpacked, and vendor the
//    binary and its LICENSE into vendor/ripwire/. Interrupted runs never leave a half-written vendor/ripwire/.
//
// Unsupported platform: warning, exit 0 (PATH is the only scanner there). Download or checksum failure: exit 1.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.6.10";
const REPO = "redhat-et/ripwire";
// SHA-256 of ripwire-<VERSION>-<platform>.tar.gz. Update together with VERSION.
const SHA256 = {
  "linux-x64": "84346e9d487d94c1021810ecb3169ae125bc15529d1662a3463070e851f3be87",
  "linux-arm64": "c30c28df31357b648d58d2796d64a5c63e5f1e71d0940bafd007b2dd7c8d15f2",
  "macos-arm64": "0a75a214477cd6e294fa67c93d9cde7aa05031bf94720c25fb425ead6391c8df",
};
const PLATFORMS = { "darwin-arm64": "macos-arm64", "linux-x64": "linux-x64", "linux-arm64": "linux-arm64" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(root, "vendor");
const target = path.join(vendorRoot, "ripwire");

function fail(message) {
  throw new Error(message);
}

function versionOf(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const stamp = path.join(target, "VERSION");
if (existsSync(path.join(target, "ripwire")) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION) {
  console.log(`ensure-ripwire: vendor/ripwire is already ${VERSION}`);
  process.exit(0);
}

const platform = PLATFORMS[`${process.platform}-${process.arch}`];
if (platform === undefined) {
  console.warn(
    `ensure-ripwire: no prebuilt ripwire for ${process.platform}-${process.arch}. ` +
      `Install ripwire yourself (see INSTALL.md at https://github.com/${REPO}) and put it on PATH.`,
  );
  process.exit(0);
}

const name = `ripwire-${VERSION}-${platform}`;
const url = `https://github.com/${REPO}/releases/download/v${VERSION}/${name}.tar.gz`;

mkdirSync(vendorRoot, { recursive: true });
const work = mkdtempSync(path.join(vendorRoot, ".ripwire-"));
try {
  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) fail(`HTTP ${res.status}`);
    if (!res.url.startsWith("https://")) fail("the download ended on a non-https URL");
    data = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    fail(`download of ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== SHA256[platform]) {
    fail(`checksum mismatch for ${url}: expected ${SHA256[platform]}, got ${actual}`);
  }

  const out = path.join(work, "out");
  mkdirSync(out);
  const tar = spawnSync("tar", ["-xzf", "-", "-C", out, "--strip-components=1", `${name}/ripwire`, `${name}/LICENSE`], {
    encoding: "utf8",
    input: data,
  });
  if (tar.status !== 0) fail(`could not unpack ${url}: ${tar.stderr.trim() || `tar exited ${tar.status}`}`);

  chmodSync(path.join(out, "ripwire"), 0o755);
  const reported = versionOf(path.join(out, "ripwire"));
  if (reported === null || !reported.includes(VERSION)) {
    fail(`the unpacked ripwire does not report ${VERSION} (got ${reported ?? "no output"})`);
  }

  writeFileSync(path.join(out, "VERSION"), VERSION);
  rmSync(target, { recursive: true, force: true });
  renameSync(out, target);
  console.log(`ensure-ripwire: vendored ${reported} into vendor/ripwire/`);
} catch (err) {
  console.error(`ensure-ripwire: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
