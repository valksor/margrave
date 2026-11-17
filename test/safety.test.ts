import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { scanWithRipwire } from "../src/safety.ts";
import { MargraveError } from "../src/store.ts";
import { tmp } from "./helpers.ts";

async function fakeWithExit(code: number, stdout = "fake findings"): Promise<string> {
  const dir = await tmp("mg-fakebin-");
  const file = path.join(dir, "ripwire");
  await writeFile(file, `#!/bin/sh\necho "${stdout} $*"\nexit ${code}\n`);
  await chmod(file, 0o755);
  return dir;
}

async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["PATH"];
  process.env["PATH"] = dir;
  try {
    return await fn();
  } finally {
    process.env["PATH"] = prev;
  }
}

const scanDir = "/some/staging/dir";

test("exit 0 continues without logging", async () => {
  const bin = await fakeWithExit(0);
  const logs: string[] = [];
  const r = await withPath(bin, () => scanWithRipwire(scanDir, { allowUnsafe: false, log: (m) => logs.push(m) }));
  assert.equal(r.code, 0);
  assert.equal(r.overridden, false);
  assert.deepEqual(logs, []);
  assert.match(r.output, /--scan-skills=\/some\/staging\/dir/u, "uses the checked syntax");
  assert.match(r.output, /security/u);
});

test("exit 1 (WARN) prints the findings and continues", async () => {
  const bin = await fakeWithExit(1);
  const logs: string[] = [];
  const r = await withPath(bin, () => scanWithRipwire(scanDir, { allowUnsafe: false, log: (m) => logs.push(m) }));
  assert.equal(r.code, 1);
  assert.equal(r.overridden, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /WARN.*fake findings/su);
});

for (const code of [2, 3, 7]) {
  test(`exit ${code} refuses; --allow-unsafe overrides and says so`, async () => {
    const bin = await fakeWithExit(code);
    await assert.rejects(
      withPath(bin, () => scanWithRipwire(scanDir, { allowUnsafe: false, log: () => undefined })),
      (e: unknown) => e instanceof MargraveError && /refused/u.test(e.message) && /fake findings/u.test(e.message) && /--allow-unsafe/u.test(e.message),
    );
    const logs: string[] = [];
    const r = await withPath(bin, () => scanWithRipwire(scanDir, { allowUnsafe: true, log: (m) => logs.push(m) }));
    assert.equal(r.overridden, true);
    assert.equal(r.code, code);
    assert.match(logs.join("\n"), /--allow-unsafe: overriding refusal/u);
  });
}

test("ripwire missing from PATH refuses; --allow-unsafe overrides", async () => {
  const empty = await tmp("mg-emptybin-");
  await assert.rejects(
    withPath(empty, () => scanWithRipwire(scanDir, { allowUnsafe: false, log: () => undefined })),
    /ripwire was not found on PATH/u,
  );
  const logs: string[] = [];
  const r = await withPath(empty, () => scanWithRipwire(scanDir, { allowUnsafe: true, log: (m) => logs.push(m) }));
  assert.equal(r.overridden, true);
  assert.equal(r.code, null);
  assert.match(logs.join("\n"), /not found on PATH/u);
});
