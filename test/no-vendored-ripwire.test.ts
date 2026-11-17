import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { VENDORED_RIPWIRE } from "../src/safety.ts";
import { runCli, tmp } from "./helpers.ts";

// These tests prove that the preload (test/no-vendored-ripwire.ts) is active, whether or not vendor/ exists.
// CI never builds vendor/, so a check against VENDORED_RIPWIRE alone would pass there without the preload.

/** A file at `<tmp>/vendor/ripwire/ripwire` and a file with another name next to it. */
async function files(): Promise<{ hidden: string; visible: string }> {
  const dir = path.join(await tmp("mg-vendorguard-"), "vendor", "ripwire");
  await mkdir(dir, { recursive: true });
  const hidden = path.join(dir, "ripwire");
  const visible = path.join(dir, "VERSION");
  await writeFile(hidden, "");
  await writeFile(visible, "");
  return { hidden, visible };
}

test("in this process, a file at .../vendor/ripwire/ripwire does not exist, and other files do", async () => {
  const { hidden, visible } = await files();
  assert.equal(existsSync(hidden), false);
  assert.equal(existsSync(visible), true);
  assert.equal(existsSync(VENDORED_RIPWIRE), false);
});

test("runCli children load the preload too, and a caller's own preload runs after it", async () => {
  const { hidden, visible } = await files();
  const probe = `import fs from "node:fs";
process.stderr.write("probe: " + fs.existsSync(${JSON.stringify(hidden)}) + " " + fs.existsSync(${JSON.stringify(visible)}) + " " + fs.existsSync(${JSON.stringify(VENDORED_RIPWIRE)}) + "\\n");`;
  const r = await runCli(["list"], {
    home: await tmp("mg-home-"),
    nodeArgs: ["--import", `data:text/javascript,${encodeURIComponent(probe)}`],
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^probe: false true false\n/u);
});
