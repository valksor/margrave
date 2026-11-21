import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const originalOpen = fs.open;
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  const [file, flags] = args;
  if (
    typeof file === "string" &&
    flags === "r" &&
    path.basename(file) === "directories.tar" &&
    path.basename(path.dirname(file)).startsWith(".margrave-upgrade-tmp-")
  ) {
    const originalRead = handle.read.bind(handle);
    let previous: number | bigint | undefined;
    handle.read = (...readArgs: unknown[]) => {
      const [, , length, position] = readArgs;
      if ((typeof position === "number" || typeof position === "bigint") && typeof length === "number" && length > 0) {
        assert.ok(previous === undefined || position > previous, "metadata archive read positions must strictly increase");
        previous = position;
      }
      return Reflect.apply(originalRead, handle, readArgs) as ReturnType<typeof originalRead>;
    };
  }
  return handle;
};
syncBuiltinESMExports();
