import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const privateHome = mkdtempSync(path.join(tmpdir(), "margrave-test-home-"));
process.env["HOME"] = privateHome;
process.env["USERPROFILE"] = privateHome;
process.env["MARGRAVE_HOME"] = path.join(privateHome, ".margrave");
process.on("exit", () => rmSync(privateHome, { recursive: true, force: true }));
