// Preload for every test process (`node --import`): fs.existsSync says that a vendored ripwire does not exist.
// A dev checkout has vendor/ripwire/ripwire, and margrave runs it before the fake ripwire on PATH, which these
// tests use. CI never builds vendor/, so without this guard the two environments would test different code.
// The `test` script loads it in-process, and `runCli` (test/helpers.ts) loads it in every spawned CLI.
// A later `mock.method(fs, "existsSync")` composes with it: the mock wraps this function, and this function wraps the real one.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const real = fs.existsSync;
(fs as { existsSync: typeof fs.existsSync }).existsSync = (p) => (String(p).endsWith("/vendor/ripwire/ripwire") ? false : real(p));
syncBuiltinESMExports();
