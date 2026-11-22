import assert from "node:assert/strict";
import { readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "node:util";
import { renderWrap } from "../src/wrap.ts";
import { copyLegacyStoreFixture, ROOT, runCli, tmp } from "./helpers.ts";

const usage = `usage: margrave <command>

  install <spec> [--ref R] [--allow-unsafe] [--skill NAME ...]   add a skill source (owner/repo[/sub/path], git URL, or local path)
  update [source] [--ref R] [--allow-unsafe] [--skill NAME ...]  refresh one source, or all
  check [source] [--json]                     check for updates and installed-file drift
  lock export [--source <id> ...]             export installed Git sources
  lock restore <file>                         restore locked Git sources
  remove <source>                             remove a source (never deletes a local directory)
  list [--skills] [--json]                    list sources, and with --skills every skill
  find "<task>" [--limit N] [--json] [--explain] [--browse] [--catalog-query QUERY]  rank installed skills for a task
  load <id> [--json] [--revision <hash>]      print one skill
  load <id> --file <path> [--revision <hash>] print one file inside a skill directory
  reindex                                     rescan all sources
  migrate                                    upgrade the skill catalog
  mcp                                         run the stdio MCP server
  serve --http [--host IP] [--port N]         run the HTTP MCP server
  wrap <claude|codex|bb|generic>              print setup text for an agent
  version                                     print the version
`;

const usageError = (message: string) => ({ code: 2, stdout: "", stderr: `margrave: ${message}\nrun: margrave --help\n` });

function parseError(args: string[], options: NonNullable<Parameters<typeof parseArgs>[0]>["options"]): string {
  try {
    parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail("expected parseArgs to reject the input");
}

test("CLI direct missing and unknown commands", async (t) => {
  const home = await tmp("mg-cli-");
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await runCli([], { home }), usageError("missing command"));
  assert.deepEqual(await runCli(["unknown\u0001command"], { home }), usageError('unknown command "unknowncommand"'));
  assert.deepEqual(await readdir(home), []);
});

test("CLI direct Node option diagnostics", async (t) => {
  const home = await tmp("mg-cli-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { ref: { type: "string" }, "allow-unsafe": { type: "boolean" }, skill: { type: "string", multiple: true } } as const;
  for (const args of [["--unknown"], ["--ref"], ["--ref", "--allow-unsafe"]]) {
    assert.deepEqual(await runCli(["install", ...args], { home }), usageError(parseError(args, options)));
  }
  assert.deepEqual(await readdir(home), []);
});

test("CLI direct help aliases", async (t) => {
  const home = await tmp("mg-cli-");
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const alias of ["help", "--help", "-h"]) {
    assert.deepEqual(await runCli([alias], { home }), { code: 0, stdout: usage, stderr: "" });
  }
  assert.ok(usage.endsWith("\n") && !usage.endsWith("\n\n"));
});

test("CLI direct version aliases", async (t) => {
  const home = await tmp("mg-cli-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  for (const alias of ["version", "--version", "-v"]) {
    assert.deepEqual(await runCli([alias], { home }), { code: 0, stdout: `margrave ${pkg.version}\n`, stderr: "" });
  }
});

const invalidPositionals: [string[], string][] = [
  [["install"], "install <spec>"],
  [["remove"], "remove <source>"],
  [["update", "one", "two"], "update [source]"],
  [["check", "one", "two"], "check [source] [--json]"],
  [["list", "extra"], "list [--skills] [--json]"],
  [["lock", "export", "extra"], "lock export [--source <id> ...]"],
  [["lock", "restore"], "lock restore <file>"],
  [["lock", "invalid"], "lock export or lock restore"],
  [["find"], 'find "<task>"'],
  [["load"], "load <id>"],
  [["reindex", "extra"], "reindex"],
  [["migrate", "extra"], "migrate"],
  [["mcp", "extra"], "mcp"],
  [["wrap"], "wrap <claude|codex|bb|generic>"],
  [["install", "--", "--reserved", "extra"], "install <spec>"],
];

for (const [args, expected] of invalidPositionals) {
  test(`CLI direct rejects positionals: ${args.join(" ")}`, async (t) => {
    const home = await tmp("mg-cli-");
    t.after(() => rm(home, { recursive: true, force: true }));
    assert.deepEqual(await runCli(args, { home }), usageError(`expected ${expected}`));
    assert.deepEqual(await readdir(home), []);
  });
}

for (const [args, message] of [
  [["install", "source", "--skill", "name", "--skill", "name"], 'skill "name" was selected more than once'],
  [["install", "source", "--skill", ""], "invalid skill name"],
  [["update", "source", "--skill", " name "], "invalid skill name"],
  [["update", "--ref", "main"], "update --ref requires one Git source"],
] as [string[], string][]) {
  test(`CLI direct rejects selection or ref: ${JSON.stringify(args)}`, async (t) => {
    const home = await tmp("mg-cli-");
    t.after(() => rm(home, { recursive: true, force: true }));
    assert.deepEqual(await runCli(args, { home }), usageError(message));
    assert.deepEqual(await readdir(home), []);
  });
}

for (const code of ["EPIPE", "EIO"]) {
  test(`CLI direct stdout ${code} event`, async (t) => {
    const fixture = await tmp("mg-cli-");
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const preload = path.join(fixture, "stdout.mjs");
    await writeFile(
      preload,
      `
const write = process.stdout.write;
process.stdout.write = function (...args) {
  process.stdout.write = write;
  const error = Object.assign(new Error("synthetic stdout failure"), { code: ${JSON.stringify(code)} });
  process.stdout.emit("error", error);
  return write.apply(this, args);
};
`,
    );
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { version: string };
    assert.deepEqual(
      await runCli(["version"], { home: path.join(fixture, "home"), nodeArgs: ["--import", preload] }),
      code === "EPIPE"
        ? { code: 0, stdout: `margrave ${pkg.version}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "margrave: synthetic stdout failure\n" },
    );
  });
}

test("CLI direct converts a primitive thrown by stdout write", async (t) => {
  const fixture = await tmp("mg-cli-");
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const preload = path.join(fixture, "primitive.mjs");
  await writeFile(
    preload,
    `
const write = process.stdout.write;
process.stdout.write = function () {
  process.stdout.write = write;
  throw "synthetic primitive\\n";
};
`,
  );
  assert.deepEqual(await runCli(["version"], { home: path.join(fixture, "home"), nodeArgs: ["--import", preload] }), {
    code: 1,
    stdout: "",
    stderr: "margrave: synthetic primitive\n",
  });
});

test("CLI direct migrates the released store once", async (t) => {
  const parent = await tmp("mg-cli-migrate-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  const migrated = await runCli(["migrate"], { home });
  const marker = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { kind: string; backup: string };
  assert.equal(marker.kind, "margrave-store-migration");
  const backup = path.join(path.dirname(await realpath(home)), marker.backup);
  assert.ok((await stat(backup)).isDirectory());
  assert.deepEqual(migrated, { code: 0, stdout: "store upgraded\n", stderr: `margrave: store upgraded. Backup: ${backup}\n` });
  const backups = (await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-")).sort();
  assert.deepEqual(backups, [marker.backup]);
  assert.deepEqual(await runCli(["migrate"], { home }), { code: 0, stdout: "store is current\n", stderr: "" });
  assert.deepEqual((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-")).sort(), backups);
});

test("CLI direct load validates revision and reports an empty store", async (t) => {
  const home = await tmp("mg-cli-load-");
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await runCli(["load", "missing"], { home }), {
    code: 1,
    stdout: "",
    stderr: "margrave: no skill sources installed; run: margrave install <owner/repo|path>\n",
  });
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await runCli(["load", "missing", "--revision", "invalid"], { home }), {
    code: 1,
    stdout: "",
    stderr: "margrave: revision must be a SHA-256 digest\n",
  });
  assert.deepEqual(await readdir(home), []);
});

test("CLI direct wrap uses the present build path", async (t) => {
  const fixture = await tmp("mg-cli-wrap-");
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, "home");
  const build = path.join(ROOT, "dist", "cli.js");
  const preload = path.join(fixture, "exists.mjs");
  await writeFile(
    preload,
    `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const exists = fs.existsSync;
fs.existsSync = function (file) { return file === ${JSON.stringify(build)} || exists.call(this, file); };
syncBuiltinESMExports();
`,
  );
  const expected = renderWrap("generic", { command: process.execPath, args: [build], home });
  assert.ok(expected.endsWith("\n") && !expected.endsWith("\n\n"));
  assert.deepEqual(await runCli(["wrap", "generic"], { home, nodeArgs: ["--import", preload] }), {
    code: 0,
    stdout: expected,
    stderr: "",
  });
});

test("serve argument errors", async (t) => {
  const home = await tmp("mg-serve-cli-");
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const [args, message] of [
    [["serve"], "expected serve --http [--host IP] [--port N]"],
    [["serve", "--http", "extra"], "expected serve --http [--host IP] [--port N]"],
    [["serve", "--http", "--host", "localhost"], "--host must be an IP address"],
    [["serve", "--http", "--host", "fe80::1%lo0"], "--host must be an IP address"],
    [["serve", "--http", "--host", "::ffff:0.127.0.1"], "MARGRAVE_ALLOWED_HOSTS is required for a non-loopback bind"],
    ...["-1", "65536", "1.5", ""].map((port): [string[], string] => [
      ["serve", "--http", `--port=${port}`],
      "--port must be an integer from 0 to 65535",
    ]),
    [["serve", "--http", "--host", "0.0.0.0"], "MARGRAVE_ALLOWED_HOSTS is required for a non-loopback bind"],
  ] as [string[], string][])
    assert.deepEqual(await runCli(args, { home, extra: { MARGRAVE_ALLOWED_HOSTS: "" } }), usageError(message));
});
