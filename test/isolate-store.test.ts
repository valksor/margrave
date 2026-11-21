import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("test preload isolates the default store and replacement child environments", () => {
  const canary = mkdtempSync(path.join(tmpdir(), "margrave-account-canary-"));
  try {
    const store = path.join(canary, ".margrave");
    mkdirSync(store);
    const catalog = path.join(store, "index.db");
    writeFileSync(catalog, "account catalog canary");
    const probe = `
      import { execFileSync } from "node:child_process";
      import { homedir } from "node:os";
      import { home } from "./src/store-files.ts";
      import { stdioTestEnv } from "./test/helpers.ts";
      import { privateHome } from "./test/isolate-store.ts";
      const initial = { os: homedir(), store: home(), env: process.env.MARGRAVE_HOME };
      delete process.env.MARGRAVE_HOME;
      const fallback = home();
      const replacement = stdioTestEnv({});
      const childProbe = \`
        import { homedir } from "node:os";
        import { home } from "./src/store-files.ts";
        const initial = { os: homedir(), store: home(), profile: process.env.USERPROFILE, env: process.env.MARGRAVE_HOME };
        delete process.env.MARGRAVE_HOME;
        console.log(JSON.stringify({ initial, fallback: home() }));
      \`;
      const child = execFileSync(process.execPath, ["--input-type=module", "-e", childProbe], { env: replacement, encoding: "utf8" });
      const explicit = stdioTestEnv({ HOME: "wrong", USERPROFILE: "wrong", MARGRAVE_HOME: "fixture" });
      // Node can add coverage settings to the environment passed to execFileSync.
      const explicitChild = execFileSync(process.execPath, ["--input-type=module", "-e", childProbe], { env: { ...explicit }, encoding: "utf8" });
      console.log(JSON.stringify({ privateHome, initial, fallback, replacement, child: JSON.parse(child), explicit, explicitChild: JSON.parse(explicitChild) }));
    `;
    const output = execFileSync(process.execPath, ["--import", "./test/isolate-store.ts", "--input-type=module", "-e", probe], {
      env: { ...process.env, HOME: canary, USERPROFILE: canary, MARGRAVE_HOME: store, __STRYKER_ACTIVE_MUTANT__: "fixture-mutant" },
      encoding: "utf8",
    });
    const result = JSON.parse(output) as {
      privateHome: string;
      initial: { os: string; store: string; env: string };
      fallback: string;
      replacement: Record<string, string>;
      child: { initial: { os: string; store: string; profile: string; env?: string }; fallback: string };
      explicit: Record<string, string>;
      explicitChild: { initial: { os: string; store: string; profile: string; env: string }; fallback: string };
    };
    const privateStore = path.join(result.privateHome, ".margrave");
    assert.notEqual(result.privateHome, canary);
    assert.deepEqual(result.initial, { os: result.privateHome, store: privateStore, env: privateStore });
    assert.equal(result.fallback, privateStore);
    assert.deepEqual(result.child, {
      initial: { os: result.privateHome, store: privateStore, profile: result.privateHome },
      fallback: privateStore,
    });
    assert.equal(result.replacement["__STRYKER_ACTIVE_MUTANT__"], "fixture-mutant");
    assert.deepEqual(result.explicit, {
      HOME: result.privateHome,
      USERPROFILE: result.privateHome,
      MARGRAVE_HOME: "fixture",
      __STRYKER_ACTIVE_MUTANT__: "fixture-mutant",
    });
    assert.deepEqual(result.explicitChild, {
      initial: { os: result.privateHome, store: path.resolve("fixture"), profile: result.privateHome, env: "fixture" },
      fallback: privateStore,
    });
    assert.equal(existsSync(result.privateHome), false);
    assert.deepEqual(readdirSync(store), ["index.db"]);
    assert.equal(readFileSync(catalog, "utf8"), "account catalog canary");
  } finally {
    rmSync(canary, { recursive: true, force: true });
  }
});
