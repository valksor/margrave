import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp, { mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS, createMcpHandler } from "@modelcontextprotocol/server";
import { attachMargraveSkills } from "../src/mcp-skills.ts";
import { FIND_DESCRIPTION, LOAD_DESCRIPTION, READ_DESCRIPTION, SERVER_INSTRUCTIONS, createServer } from "../src/mcp.ts";
import { CLI, NO_VENDORED_PRELOAD, fakeRipwire, newEntry, runCli, seedIndex, stdioTestEnv, tmp, useHome, writeSkill } from "./helpers.ts";

interface ToolText {
  isError: boolean;
  text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolText> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") };
}

test("MCP smoke: three tools, exact texts, no-sources, no-match, load, read, guard, live reindex", async (t) => {
  const home = await tmp("mg-home-");
  const fakeBin = await fakeRipwire();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env: stdioTestEnv({ PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home }),
  });
  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  // server instructions and tool descriptions are the exact plan texts
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  assert.equal(
    SERVER_INSTRUCTIONS,
    "This server gives access to installed skills that the agent does not load by default. Before a task in an unfamiliar domain, tool, or framework, call find_skills with the task in plain words. Call load_skill only for a recommended result. Call read_skill_file for a file that the skill names.",
  );
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((x) => x.name).sort(), ["find_skills", "load_skill", "read_skill_file"]);
  const desc = Object.fromEntries(tools.map((x) => [x.name, x.description]));
  assert.equal(
    desc["find_skills"],
    "Find recommended installed skills for a task in plain words. Use explain to see matching terms and weak matches. Use load_skill only for a recommended result. If the result contains a clarification question, repeat the search with more details. Set browse to true to skip the match count check.",
  );
  assert.equal(
    desc["load_skill"],
    "Load the instructions of one skill. Use an id from find_skills. Returns the skill text, its source, and its base directory.",
  );
  assert.equal(
    desc["read_skill_file"],
    "Read one file inside a skill directory. Use a path relative to the base directory that load_skill returns.",
  );
  assert.equal(FIND_DESCRIPTION, desc["find_skills"]);
  assert.equal(LOAD_DESCRIPTION, desc["load_skill"]);
  assert.equal(READ_DESCRIPTION, desc["read_skill_file"]);

  // no sources: find returns the hint text, not a tool error
  const noSources = await call(client, "find_skills", { task: "anything" });
  assert.equal(noSources.isError, false);
  assert.equal(noSources.text, "no skill sources installed; run: margrave install <owner/repo|path>");
  // load_skill and read_skill_file with no sources are tool errors with the same hint
  for (const [tool, args] of [
    ["load_skill", { id: "anything" }],
    ["read_skill_file", { id: "anything", path: "SKILL.md" }],
  ] as const) {
    const r = await call(client, tool, args);
    assert.deepEqual(r, { isError: true, text: noSources.text }, tool);
  }

  // install while the server runs: the server sees it without a restart
  const dir = await tmp("mg-localsrc-");
  const skillDir = await writeSkill(dir, "terraform-modules", "Design reusable Terraform modules");
  await writeSkill(dir, "ansible-roles", "Write Ansible roles and playbooks");
  await mkdir(path.join(skillDir, "references"));
  await writeFile(path.join(skillDir, "references", "x.md"), "reference text\n");
  await writeFile(path.join(dir, "secret.txt"), "outside\n");
  const inst = await runCli(["install", dir], { home, fakeBin });
  assert.equal(inst.code, 0, inst.stderr);
  const id = /^installed (\S+)/mu.exec(inst.stdout)?.[1] ?? "";

  const found = await call(client, "find_skills", { task: "terraform modules", limit: 3 });
  assert.equal(found.isError, false);
  assert.match(found.text, new RegExp(`^1\\. ${id}/terraform-modules `, "u"));
  assert.match(found.text, /\n   revision: sha256:[0-9a-f]{64}\n/u);
  assert.match(found.text, new RegExp(`load: margrave load ${id}/terraform-modules$`, "u"));

  // no match: empty result plus a hint, not a tool error
  const none = await call(client, "find_skills", { task: "quantum chromodynamics" });
  assert.equal(none.isError, false);
  assert.match(none.text, /^no match\n.*margrave list --skills/u);

  // load_skill: same text as `margrave load`
  const loaded = await call(client, "load_skill", { id: `${id}/terraform-modules` });
  assert.equal(loaded.isError, false);
  const cliLoad = await runCli(["load", `${id}/terraform-modules`], { home, fakeBin });
  assert.equal(loaded.text, cliLoad.stdout);
  assert.match(loaded.text, /^skill: .*terraform-modules\nsource: /u);
  assert.match(loaded.text, /body:\n# terraform-modules/u);

  // read_skill_file: inside works, outside is refused with a tool error
  const file = await call(client, "read_skill_file", { id: `${id}/terraform-modules`, path: "references/x.md" });
  assert.deepEqual(file, { isError: false, text: "reference text\n" });
  const escape = await call(client, "read_skill_file", { id: `${id}/terraform-modules`, path: "../secret.txt" });
  assert.equal(escape.isError, true);
  assert.equal(escape.text, "file is not in the selected skill revision");
  const abs = await call(client, "read_skill_file", { id: `${id}/terraform-modules`, path: path.join(dir, "secret.txt") });
  assert.equal(abs.isError, true);

  // unknown id is a tool error
  const unknown = await call(client, "load_skill", { id: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /no skill "nope"/u);

  // a corrupt index.db is a tool error that says how to repair it
  await writeFile(path.join(home, "index.db"), "garbage that is not a database");
  const corrupt = await call(client, "find_skills", { task: "terraform" });
  assert.equal(corrupt.isError, true);
  assert.match(corrupt.text, /is not a supported margrave catalog/u);
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  await assert.rejects(new SkillsClient(client).list(), /is not a supported margrave catalog/u);

  // the server is read-only: only the three tools exist
  assert.equal(tools.length, 3);
});

/** Run createServer() in this process through a stateless handler. */
async function connectInMemory(t: { after: (fn: () => Promise<void>) => void }, factory = () => createServer()): Promise<Client> {
  const handler = createMcpHandler(factory, { legacy: "reject" });
  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init)) }),
  );
  t.after(() => client.close());
  return client;
}

test("MCP server direct advertises metadata and validates revisions without a catalog", async (t) => {
  const home = await tmp("mg-direct-empty-");
  useHome(t, home);
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const client = await connectInMemory(t);
  assert.equal(client.getServerVersion()?.name, "margrave");
  const find = (await client.listTools()).tools.find((tool) => tool.name === "find_skills");
  const schema = find?.outputSchema as {
    properties: {
      results: { items: { properties: { scanVerdict: { enum: string[] }; matchedTerms: { properties: Record<string, unknown> } } } };
    };
  };
  assert.deepEqual(schema.properties.results.items.properties.scanVerdict.enum, ["unknown", "clean", "warn", "critical", "failed"]);
  assert.deepEqual(schema.properties.results.items.properties.matchedTerms.properties, {
    name: { type: "array", items: { type: "string" } },
    description: { type: "array", items: { type: "string" } },
    headings: { type: "array", items: { type: "string" } },
    body: { type: "array", items: { type: "string" } },
  });
  const hint = "no skill sources installed; run: margrave install <owner/repo|path>";
  for (const [tool, args] of [
    ["load_skill", { id: "missing" }],
    ["read_skill_file", { id: "missing", path: "SKILL.md" }],
  ] as const) {
    assert.deepEqual(await call(client, tool, { ...args, revision: "bad" }), {
      isError: true,
      text: "revision must be a SHA-256 digest",
    });
    assert.deepEqual(await call(client, tool, args), { isError: true, text: hint });
    assert.deepEqual(await call(client, tool, { ...args, revision: `sha256:${"0".repeat(64)}` }), {
      isError: true,
      text: "skill revision changed; search again",
    });
  }
});

test("MCP server direct distinguishes Git and local drift and closes the selected catalog", async (t) => {
  const home = await tmp("mg-direct-drift-");
  useHome(t, home);
  t.after(async () => {
    mock.restoreAll();
    await fsp.rm(home, { recursive: true, force: true });
  });
  const commit = "a".repeat(40);
  const snapshot = `${commit}-${"b".repeat(16)}`;
  const localDir = path.join(home, "local", "local-skill");
  const gitDir = path.join(home, "snapshots", "git-source", snapshot, "git-skill");
  const fixtures = [
    { source: "local-source", name: "local-skill", dir: localDir },
    { source: "git-source", name: "git-skill", dir: gitDir },
  ];
  const rows: ReturnType<typeof newEntry>[] = [];
  for (const fixture of fixtures) {
    await mkdir(fixture.dir, { recursive: true });
    const frontmatter = `name: ${fixture.name}\ndescription: valid`;
    const bytes = Buffer.from(`---\n${frontmatter}\n---\noriginal\n`);
    await writeFile(path.join(fixture.dir, "SKILL.md"), bytes);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    rows.push({
      ...newEntry(fixture.source, fixture.name),
      dir: fixture.source === "git-source" ? fixture.name : fixture.dir,
      revision: digest,
      frontmatter,
      manifest: JSON.stringify([{ path: "SKILL.md", digest, size: bytes.length }]),
    });
  }
  await seedIndex(rows, [
    {
      id: "local-source",
      kind: "local",
      spec: path.dirname(localDir),
      path: path.dirname(localDir),
      subpath: "",
      ref: null,
      commit: null,
      installedAt: "now",
    },
    {
      id: "git-source",
      kind: "git",
      spec: "https://example.invalid/repo.git",
      url: "https://example.invalid/repo.git",
      subpath: "",
      ref: "refs/heads/main",
      commit,
      snapshot,
      installedAt: "now",
    },
  ]);
  const client = await connectInMemory(t);
  const prepare = mock.method(DatabaseSync.prototype, "prepare");
  const close = mock.method(DatabaseSync.prototype, "close");
  try {
    for (const fixture of fixtures) {
      prepare.mock.resetCalls();
      close.mock.resetCalls();
      const id = `${fixture.source}/${fixture.name}`;
      assert.equal((await call(client, "load_skill", { id })).isError, false);
      assert.deepEqual(await call(client, "read_skill_file", { id, path: "SKILL.md" }), {
        isError: false,
        text: `---\nname: ${fixture.name}\ndescription: valid\n---\noriginal\n`,
      });
      const connections = new Set(
        prepare.mock.calls
          .filter(({ arguments: [sql] }) => sql === "SELECT id, record FROM sources ORDER BY position")
          .map((record) => record.this),
      );
      assert.equal(connections.size, 2);
      for (const connection of connections) {
        assert.ok(connection);
        assert.equal(close.mock.calls.filter((record) => record.this === connection).length, 1);
      }
    }
    prepare.mock.resetCalls();
    close.mock.resetCalls();
    assert.equal((await call(client, "load_skill", { id: "missing" })).isError, true);
    const failed = prepare.mock.calls.find(({ arguments: [sql] }) => sql === "SELECT id, record FROM sources ORDER BY position")?.this;
    assert.ok(failed);
    assert.equal(close.mock.calls.filter((record) => record.this === failed).length, 1);
  } finally {
    prepare.mock.restore();
    close.mock.restore();
  }
  const gitDrift = "skill files differ from the accepted revision. Ask the store operator to restore a verified copy";
  const localDrift = "skill files changed since indexing; ask the store operator to run margrave reindex, then search again";
  for (const [fixture, message] of [
    [fixtures[1]!, gitDrift],
    [fixtures[0]!, localDrift],
  ] as const) {
    await writeFile(path.join(fixture.dir, "SKILL.md"), `---\nname: ${fixture.name}\ndescription: valid\n---\nchanged!\n`);
    const id = `${fixture.source}/${fixture.name}`;
    for (const [tool, args] of [
      ["load_skill", { id }],
      ["read_skill_file", { id, path: "SKILL.md" }],
    ] as const)
      assert.deepEqual(await call(client, tool, args), { isError: true, text: message });
  }
  await fsp.rm(gitDir, { recursive: true });
  for (const [tool, args] of [
    ["load_skill", { id: "git-source/git-skill" }],
    ["read_skill_file", { id: "git-source/git-skill", path: "SKILL.md" }],
  ] as const)
    assert.deepEqual(await call(client, tool, args), { isError: true, text: gitDrift });
});

function boundSkillsPages(t: { after: (fn: () => void) => void }, limit: number): { cursors: string[] } {
  const prepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")?.value as DatabaseSync["prepare"];
  const cursors: string[] = [];
  const query =
    "SELECT id, name, description, source, dir, hash AS revision, manifest, frontmatter FROM skills WHERE id > ? AND (? IS NULL OR source IN (SELECT value FROM json_each(?))) ORDER BY id COLLATE BINARY LIMIT 51";
  const hooked = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql !== query) return statement;
    return {
      all: (...args: Parameters<typeof statement.all>) => {
        const cursor = args[0];
        assert.ok(typeof cursor === "string");
        cursors.push(cursor);
        assert.ok(cursors.length <= limit, "skills pagination exceeded the query limit");
        if (cursors.length > 1) assert.ok(cursors.at(-1)! > cursors.at(-2)!, "skills pagination did not advance");
        return statement.all(...args);
      },
    } as unknown as ReturnType<DatabaseSync["prepare"]>;
  });
  t.after(() => hooked.mock.restore());
  return { cursors };
}

test("MCP server version is 0.0.0 when package.json has no version or cannot be read", async (t) => {
  const realRead = fs.readFileSync;
  const asPackageJson = (file: unknown): boolean => String(file).endsWith("package.json");
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  const read = mock.method(fs, "readFileSync", (file: never, ...rest: never[]) =>
    asPackageJson(file) ? "{}" : (realRead as (...a: unknown[]) => unknown)(file, ...rest),
  );
  syncBuiltinESMExports();
  const noVersion = await connectInMemory(t);
  assert.equal(noVersion.getServerVersion()?.version, "0.0.0");

  read.mock.mockImplementation((file: never, ...rest: never[]) => {
    if (asPackageJson(file)) throw new Error("ENOENT: package.json is gone");
    return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
  });
  const unreadable = await connectInMemory(t);
  assert.equal(unreadable.getServerVersion()?.version, "0.0.0");
});

test("a tool whose work rejects with a non-Error value returns that value as text", async (t) => {
  const prev = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  const client = await connectInMemory(t);
  await seedIndex([newEntry("source", "skill")]);
  const { prepare } = DatabaseSync.prototype as unknown as {
    prepare: (this: DatabaseSync, sql: string) => ReturnType<DatabaseSync["prepare"]>;
  };
  mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    // This verifies that the MCP surface handles rejections that are not Error objects.
    // oxlint-disable-next-line typescript/only-throw-error
    if (sql === "SELECT id, record FROM sources ORDER BY position") throw "boom, not an Error";
    return prepare.call(this, sql);
  });
  const r = await call(client, "find_skills", { task: "anything" });
  assert.deepEqual(r, { isError: true, text: "boom, not an Error" });
});

test("Skills discovery reports a catalog close failure", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const prev = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  t.after(() => {
    mock.restoreAll();
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  await seedIndex([newEntry("source", "skill")]);
  const client = await connectInMemory(t);
  const { close } = DatabaseSync.prototype as unknown as { close: (this: DatabaseSync) => void };
  mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    close.call(this);
    throw new Error("catalog close failed");
  });
  await assert.rejects(new SkillsClient(client).list(), /catalog close failed/u);
});

test("MCP in-process: load_skill and read_skill_file work, and every tool turns a failure into a tool error", async (t) => {
  const prev = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  const client = await connectInMemory(t);
  const hint = "no skill sources installed; run: margrave install <owner/repo|path>";

  // No sources: load_skill and read_skill_file fail with the hint, find_skills answers with it.
  assert.deepEqual(await call(client, "find_skills", { task: "x" }), { isError: false, text: hint });
  assert.deepEqual(await call(client, "load_skill", { id: "x" }), { isError: true, text: hint });
  assert.deepEqual(await call(client, "read_skill_file", { id: "x", path: "SKILL.md" }), { isError: true, text: hint });

  const dir = await tmp("mg-localsrc-");
  const skillDir = await writeSkill(dir, "terraform-modules", "Design reusable Terraform modules");
  await mkdir(path.join(skillDir, "references"));
  await writeFile(path.join(skillDir, "references", "x.md"), "reference text\n");
  const inst = await runCli(["install", dir], { home, fakeBin: await fakeRipwire() });
  assert.equal(inst.code, 0, inst.stderr);
  const id = `${/^installed (\S+)/mu.exec(inst.stdout)?.[1] ?? ""}/terraform-modules`;

  const loaded = await call(client, "load_skill", { id });
  assert.equal(loaded.isError, false);
  assert.match(loaded.text, /^skill: .*terraform-modules\nsource: /u);
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "references/x.md" }), { isError: false, text: "reference text\n" });
  assert.match((await call(client, "load_skill", { id: "nope" })).text, /no skill "nope"/u);
  const escape = await call(client, "read_skill_file", { id, path: "../x" });
  assert.equal(escape.isError, true);
  assert.equal(escape.text, "file is not in the selected skill revision");

  // A corrupt index.db is a tool error for all three tools.
  await writeFile(path.join(home, "index.db"), "garbage that is not a database");
  for (const [tool, args] of [
    ["find_skills", { task: "terraform" }],
    ["load_skill", { id }],
    ["read_skill_file", { id, path: "SKILL.md" }],
  ] as const) {
    const r = await call(client, tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /is not a supported margrave catalog/u, tool);
  }
});

test("many failing tool calls leave no open index handle: reindex rebuilds the database afterwards", async (t) => {
  if ((await fsp.readdir("/dev/fd").catch(() => null)) === null)
    return t.skip("/dev/fd cannot be read here, so open descriptors cannot be counted");
  const home = await tmp("mg-home-");
  const prev = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = home;
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill");
  const fakeBin = await fakeRipwire();
  assert.equal((await runCli(["install", dir], { home, fakeBin })).code, 0);
  const handler = createMcpHandler(() => createServer(), { legacy: "reject" });
  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init)) }),
  );
  t.after(() => client.close());

  for (let i = 0; i < 300; i++) {
    assert.equal((await call(client, "load_skill", { id: `nope-${i}` })).isError, true);
    assert.equal((await call(client, "read_skill_file", { id: `nope-${i}`, path: "SKILL.md" })).isError, true);
  }
  assert.equal((await call(client, "find_skills", { task: "alpha" })).isError, false);
  assert.equal((await runCli(["reindex"], { home, fakeBin })).code, 0);
  assert.equal((await call(client, "find_skills", { task: "alpha" })).isError, false);
  // 600 failing calls would leave 600 open descriptors if a call did not close its handle; the usual limit is 256.
  const open = (await fsp.readdir("/dev/fd")).length;
  assert.ok(open < 200, `${open} open file descriptors`);
});

test("stdio source allowlists scope search and both reads", async (t) => {
  const home = await tmp("mg-home-");
  const fakeBin = await fakeRipwire();
  const ids: string[] = [];
  const dirs: string[] = [];
  for (const description of ["Shared terraform modules", "Shared terraform modules terraform modules"]) {
    const dir = await tmp("mg-scope-");
    const skill = await writeSkill(dir, "shared", description);
    dirs.push(skill);
    await writeFile(path.join(skill, "reference.txt"), description);
    const result = await runCli(["install", dir], { home, fakeBin });
    assert.equal(result.code, 0, result.stderr);
    ids.push(/^installed (\S+)/u.exec(result.stdout)?.[1] ?? "");
  }
  const [visible, hidden] = ids as [string, string];
  const cli = await runCli(["find", "terraform modules", "--limit", "10"], { home, fakeBin, extra: { MARGRAVE_ALLOWED_SOURCES: "" } });
  assert.equal(cli.code, 0, cli.stderr);
  assert.ok(cli.stdout.includes(visible) && cli.stdout.includes(hidden));
  for (const scope of [undefined, `${visible}, ${visible},missing`, "", "   "]) {
    const emptyScope = scope?.trim() === "";
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home };
    if (scope !== undefined) env["MARGRAVE_ALLOWED_SOURCES"] = scope;
    const client = new Client({ name: "scope-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: stdioTestEnv(env) }));
    t.after(() => client.close());
    const found = await call(client, "find_skills", { task: "terraform modules", limit: 1, explain: true });
    if (emptyScope) assert.match(found.text, /no match/u);
    else if (scope !== undefined) {
      assert.ok(found.text.includes(visible));
      assert.ok(!found.text.includes(hidden));
      assert.ok(!found.text.includes("terraform modules terraform modules"));
    } else assert.ok(found.text.includes(hidden));
    const bare = await call(client, "load_skill", { id: "shared" });
    if (scope === undefined) assert.match(bare.text, /ambiguous/u);
    else assert.equal(bare.isError, emptyScope);
    const revision = /revision: (sha256:[0-9a-f]{64})/u.exec(
      (await call(client, "find_skills", { task: "shared", explain: true })).text,
    )?.[1];
    for (const tool of ["load_skill", "read_skill_file"]) {
      for (const token of [undefined, revision ?? `sha256:${"a".repeat(64)}`]) {
        const args = (id: string) => ({
          id,
          ...(tool === "read_skill_file" ? { path: "reference.txt" } : {}),
          ...(token === undefined ? {} : { revision: token }),
        });
        const unknown = await call(client, tool, args("unknown/shared"));
        const hiddenResult = await call(client, tool, args(`${hidden}/shared`));
        if (scope !== undefined)
          assert.deepEqual(hiddenResult, { ...unknown, text: unknown.text.replace("unknown/shared", `${hidden}/shared`) });
        const visibleResult = await call(client, tool, args(`${visible}/shared`));
        if (emptyScope) assert.deepEqual(visibleResult, { ...unknown, text: unknown.text.replace("unknown/shared", `${visible}/shared`) });
        else if (token === undefined || scope !== undefined) assert.equal(visibleResult.isError, false);
      }
    }
    if (scope !== undefined && !emptyScope && revision !== undefined) {
      await writeFile(path.join(dirs[0]!, "reference.txt"), "updated reference");
      const update = await runCli(["update", visible], { home, fakeBin });
      assert.equal(update.code, 0, update.stderr);
      for (const tool of ["load_skill", "read_skill_file"]) {
        const args = { id: `${visible}/shared`, ...(tool === "read_skill_file" ? { path: "reference.txt" } : {}) };
        assert.match((await call(client, tool, { ...args, revision })).text, /skill revision changed/u);
        assert.equal((await call(client, tool, args)).isError, false);
      }
    }
  }
  for (const value of [",", `${visible},`, "bad/id", " .,ok"]) {
    const result = spawnSync(process.execPath, ["--import", NO_VENDORED_PRELOAD, CLI, "mcp"], {
      input: "",
      encoding: "utf8",
      timeout: 2000,
      env: stdioTestEnv({ PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home, MARGRAVE_ALLOWED_SOURCES: value }),
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /MARGRAVE_ALLOWED_SOURCES must contain comma-separated source IDs/u);
  }
});

test("stdio serves a client that opens with an older protocol revision", { timeout: 30_000 }, async () => {
  const home = await tmp("mg-home-");
  const dir = await tmp("mg-legacy-");
  const skill = await writeSkill(dir, "legacy-fixture", "Legacy fixture capability");
  await writeFile(path.join(skill, "reference.txt"), "legacy reference\n");
  const installed = await runCli(["install", dir], { home, fakeBin: await fakeRipwire() });
  assert.equal(installed.code, 0, installed.stderr);
  const id = `${/^installed (\S+)/u.exec(installed.stdout)?.[1] ?? ""}/legacy-fixture`;
  for (const protocolVersion of SUPPORTED_PROTOCOL_VERSIONS) {
    const child = spawn(process.execPath, [CLI, "mcp"], { env: stdioTestEnv({ PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home }) });
    const timeout = setTimeout(() => child.kill(), 10_000);
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let nextId = 0;
    const request = async (method: string, params: object) => {
      const requestId = ++nextId;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      const line = await lines.next();
      const response = JSON.parse(line.value ?? "") as {
        id: number;
        result?: {
          protocolVersion?: string;
          serverInfo?: { name: string };
          tools?: { name: string }[];
          isError?: boolean;
          content?: { type: string; text: string }[];
        };
        error?: unknown;
      };
      assert.equal(response.id, requestId);
      assert.equal(response.error, undefined);
      return response.result;
    };
    try {
      const result = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
      assert.equal(result?.protocolVersion, protocolVersion);
      assert.equal(result?.serverInfo?.name, "margrave");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const tools = await request("tools/list", {});
      assert.deepEqual(tools?.tools?.map((tool) => tool.name).sort(), ["find_skills", "load_skill", "read_skill_file"]);
      for (const [name, args, expected] of [
        ["find_skills", { task: "legacy fixture capability" }, id],
        ["load_skill", { id }, "Body of legacy-fixture"],
        ["read_skill_file", { id, path: "reference.txt" }, "legacy reference\n"],
      ] as const) {
        const tool = await request("tools/call", { name, arguments: args });
        assert.notEqual(tool?.isError, true);
        assert.ok(tool?.content?.some((item) => item.type === "text" && item.text.includes(expected)));
      }
    } finally {
      clearTimeout(timeout);
      child.stdin.end();
      child.kill();
    }
  }
});

test("Skills extension serves verified scoped pages over stdio", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const home = await tmp("mg-extension-home-");
  const fakeBin = await fakeRipwire();
  const dir = await tmp("mg-extension-source-");
  const skillDir = await writeSkill(dir, "toolkit", "A toolkit for focused checks");
  const toolkitPath = path.join(skillDir, "SKILL.md");
  await writeFile(toolkitPath, (await fsp.readFile(toolkitPath, "utf8")).replace("\n---\n", "\nlicense: MIT\nextra: preserved\n---\n"));
  await mkdir(path.join(skillDir, "references"));
  await mkdir(path.join(skillDir, "assets"));
  await writeFile(path.join(skillDir, "references", "checklist.md"), "checklist\n");
  await writeFile(path.join(skillDir, "references", "plain.txt"), "plain text\n");
  await writeFile(path.join(skillDir, "assets", "sample.bin"), Buffer.from([0, 255, 1]));
  await writeSkill(dir, "Bad_Name", "Legacy name");
  const nonjson = await writeSkill(dir, "nonjson", "Legacy nonfinite metadata");
  const nonjsonPath = path.join(nonjson, "SKILL.md");
  await writeFile(nonjsonPath, (await fsp.readFile(nonjsonPath, "utf8")).replace("\n---\n", "\nextra: .inf\n---\n"));
  const cyclic = await writeSkill(dir, "cyclic", "Legacy cyclic metadata");
  const cyclicPath = path.join(cyclic, "SKILL.md");
  await writeFile(cyclicPath, (await fsp.readFile(cyclicPath, "utf8")).replace("\n---\n", "\nextra: &loop [*loop]\n---\n"));
  for (const [name, extra] of [
    ["bad-compat", "compatibility: 42"],
    ["empty-compat", 'compatibility: ""'],
    ["long-compat", `compatibility: ${"x".repeat(501)}`],
    ["bad-metadata", "metadata: [value]"],
    ["bad-values", "metadata:\n  value: 42"],
  ] as const) {
    const folder = await writeSkill(dir, name, "Legacy metadata");
    const file = path.join(folder, "SKILL.md");
    await writeFile(file, (await fsp.readFile(file, "utf8")).replace("\n---\n", `\n${extra}\n---\n`));
  }
  await writeSkill(dir, "long-description", "x".repeat(1025));
  for (let i = 0; i < 51; i++) await writeSkill(dir, `page-${String(i).padStart(2, "0")}`, "Paging fixture");
  const installed = await runCli(["install", dir], { home, fakeBin });
  assert.equal(installed.code, 0, installed.stderr);
  const source = /^installed (\S+)/mu.exec(installed.stdout)![1]!;
  const client = new Client({ name: "skills-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      env: stdioTestEnv({ PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home, MARGRAVE_ALLOWED_SOURCES: source }),
    }),
  );
  t.after(() => client.close());
  const skills = new SkillsClient(client);
  assert.equal(skills.supported, true);
  assert.equal(skills.directoryRead, false);
  const all = await skills.list();
  assert.equal(all.skills.length, 52);
  assert.equal(all.ttlMs, 0);
  assert.equal(all.cacheScope, "private");
  const toolkit = all.skills.find((item) => item.frontmatter.name === "toolkit")!;
  assert.ok(toolkit);
  assert.equal(toolkit.frontmatter["extra"], "preserved");
  assert.equal((await call(client, "load_skill", { id: `${source}/nonjson` })).isError, false);
  assert.deepEqual((await skills.get(toolkit.uri)).skill, toolkit);
  assert.equal((await skills.read(toolkit, "references/checklist.md")).text, "checklist\n");
  assert.equal((await skills.read(toolkit, "references/plain.txt")).text, "plain text\n");
  assert.deepEqual([...(await skills.read(toolkit, "assets/sample.bin")).bytes], [0, 255, 1]);
  assert.equal((await skills.read(toolkit)).verified, true);
  await assert.rejects(
    skills.list({ cursor: "!" }),
    (err: unknown) => typeof err === "object" && err !== null && "code" in err && err.code === -32602,
  );
  await assert.rejects(skills.get(toolkit.uri.replace(/sha256%3A[0-9a-f]{64}/u, `sha256%3A${"0".repeat(64)}`)), /skill revision changed/u);
  await assert.rejects(client.readResource({ uri: toolkit.uri.replace("SKILL.md", "missing.md") }));
  await assert.rejects(client.readResource({ uri: toolkit.uri.replace("SKILL.md", "references/../SKILL.md") }));
  await assert.rejects(client.readResource({ uri: toolkit.uri.replace("SKILL.md", "%53KILL.md") }));
  const [, , , uriSource, uriRevision, uriSkill] = toolkit.uri.split("/");
  await assert.rejects(client.readResource({ uri: `skill://margrave/${uriSource}/${uriRevision}/${uriSkill}/%FF` }));
  await assert.rejects(client.readResource({ uri: "skill://other/unknown" }));
  await assert.rejects(client.readResource({ uri: "skill://margrave/short" }));
  await assert.rejects(client.readResource({ uri: toolkit.uri.replace(/sha256%3A[0-9a-f]{64}/u, "invalid") }));
  await assert.rejects(skills.get(toolkit.uri.replace("toolkit/SKILL.md", "missing/SKILL.md")));
  await assert.rejects(skills.get(toolkit.uri.replace("SKILL.md", "references/checklist.md")));
  const result = await client.callTool({ name: "find_skills", arguments: { task: "toolkit" } });
  const structured = result.structuredContent as {
    results: { source: string; scanVerdict: string; scanOverridden: boolean | null; license: string | null }[];
  };
  assert.equal(structured.results[0]?.source, source);
  assert.equal(structured.results[0]?.scanVerdict, "unknown");
  assert.equal(structured.results[0]?.scanOverridden, null);
  assert.equal(structured.results[0]?.license, "MIT");
  assert.equal(JSON.stringify(structured).includes(dir), false);

  const db = new DatabaseSync(path.join(home, "index.db"));
  try {
    db.prepare("UPDATE skills SET frontmatter = ? WHERE id = ?").run("[]", `${source}/toolkit`);
    assert.equal(
      (await skills.list()).skills.some((item) => item.frontmatter.name === "toolkit"),
      false,
    );
    db.prepare("UPDATE skills SET frontmatter = ?, manifest = ? WHERE id = ?").run(
      "name: toolkit\ndescription: Toolkit",
      JSON.stringify([
        { path: "SKILL.md", digest: `sha256:${"0".repeat(64)}`, size: 1 },
        { path: "../escape", digest: `sha256:${"0".repeat(64)}`, size: 1 },
      ]),
      `${source}/toolkit`,
    );
    assert.equal(
      (await skills.list()).skills.some((item) => item.frontmatter.name === "toolkit"),
      false,
    );
  } finally {
    db.close();
  }
});

test("MCP Skills direct validates catalog frontmatter boundaries", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const previous = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-direct-skills-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });
  const rows: ReturnType<typeof newEntry>[] = [];
  const add = async (name: string, frontmatter: string): Promise<void> => {
    const dir = path.join(home, "fixtures", String(rows.length));
    await mkdir(dir, { recursive: true });
    const content = Buffer.from(`---\n${frontmatter}\n---\nfixture\n`);
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await writeFile(path.join(dir, "SKILL.md"), content);
    const manifest = JSON.stringify([{ path: "SKILL.md", digest, size: content.length }]);
    rows.push({ ...newEntry("source", name), dir, revision: digest, manifest, frontmatter });
  };
  const fm = (name: string, extra = "", description = "valid"): string =>
    `name: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${extra}`;
  const longName = "a".repeat(64);
  await add("alpha", fm("alpha", "extra: preserved\nmetadata: {author: Ada}\ncompatibility: ascii\n"));
  await add("empty-map", fm("empty-map", "metadata: {}\n"));
  await add("a-0-z", fm("a-0-z"));
  await add("0", fm("0"));
  await add("unicode", fm("unicode", `compatibility: ${"😀".repeat(500)}\n`, "😀".repeat(1024)));
  await add(longName, fm(longName));
  for (const [name, value] of [
    ["primitive", "42"],
    ["null-value", "null"],
    ["array", "[one, two]"],
    ["missing-name", "description: valid"],
    ["number-name", "name: 42\ndescription: valid"],
    ["null-name", "name: null\ndescription: valid"],
    ["", 'name: ""\ndescription: valid'],
    ["mismatch", fm("other")],
    ["missing-description", "name: missing-description"],
    ["number-description", "name: number-description\ndescription: 42"],
    ["empty-description", fm("empty-description", "", "")],
    ["long-description", fm("long-description", "", "x".repeat(1025))],
    ["a".repeat(65), fm("a".repeat(65))],
    ["-leading", fm("-leading")],
    ["trailing-", fm("trailing-")],
    ["double--hyphen", fm("double--hyphen")],
    ["bad_name", fm("bad_name")],
    ["!leading", fm("!leading")],
    ["trailing!", fm("trailing!")],
    ["Uppercase", fm("Uppercase")],
    ["compat-empty", fm("compat-empty", 'compatibility: ""\n')],
    ["compat-long", fm("compat-long", `compatibility: ${"x".repeat(501)}\n`)],
    ["compat-number", fm("compat-number", "compatibility: 42\n")],
    ["metadata-null", fm("metadata-null", "metadata: null\n")],
    ["metadata-array", fm("metadata-array", "metadata: [value]\n")],
    ["metadata-number", fm("metadata-number", "metadata: 42\n")],
    ["metadata-value", fm("metadata-value", "metadata: {value: 42}\n")],
    ["nonfinite", fm("nonfinite", "extra: .inf\n")],
    ["cyclic", fm("cyclic", "extra: &loop [*loop]\n")],
  ] as const)
    await add(name, value);
  const template = rows.find((row) => row.name === "alpha")!;
  const manifestEntry = (JSON.parse(template.manifest) as { path: string; digest: string; size: number }[])[0]!;
  for (const [name, manifest] of [
    ["manifest-empty", JSON.stringify([manifestEntry, { ...manifestEntry, path: "nested//file" }])],
    ["manifest-missing", JSON.stringify([{ ...manifestEntry, path: "nested/file" }])],
  ] as const) {
    rows.push({ ...newEntry("source", name), dir: template.dir, revision: template.revision, manifest, frontmatter: fm(name) });
  }
  const fillers = Array.from({ length: 55 }, (_, i) => `z-filler-${String(i).padStart(2, "0")}`);
  for (const name of fillers) {
    rows.push({
      ...newEntry("source", name),
      dir: template.dir,
      revision: template.revision,
      manifest: template.manifest,
      frontmatter: fm(name),
    });
  }
  await seedIndex(rows);
  boundSkillsPages(t, 3);
  const client = await connectInMemory(t);
  const skills = new SkillsClient(client);
  const listing = await skills.list({ cursor: Buffer.from("source").toString("base64url") }, { timeout: 2000 });
  assert.deepEqual(
    listing.skills.map((item) => item.frontmatter.name),
    ["0", "a-0-z", longName, "alpha", "empty-map", "unicode", ...fillers.slice(0, 44)],
  );
  assert.equal(listing.nextCursor, Buffer.from("source/z-filler-43").toString("base64url"));
  const alpha = listing.skills.find((item) => item.frontmatter.name === "alpha")!;
  const alphaRow = rows.find((row) => row.name === "alpha")!;
  const digest = alphaRow.revision;
  const size = (JSON.parse(alphaRow.manifest) as { size: number }[])[0]!.size;
  const uri = `skill://margrave/source/${encodeURIComponent(digest)}/alpha/SKILL.md`;
  assert.deepEqual(alpha, {
    uri,
    frontmatter: { name: "alpha", description: "valid", extra: "preserved", metadata: { author: "Ada" }, compatibility: "ascii" },
    resources: [{ uri, digest, size }],
  });
  assert.deepEqual((await skills.get(uri)).skill, alpha);
  const response = await client.readResource({ uri });
  assert.deepEqual(response.contents, [
    { uri, mimeType: "text/markdown", text: await fsp.readFile(path.join(alphaRow.dir, "SKILL.md"), "utf8") },
  ]);
  assert.deepEqual(listing.skills.find((item) => item.frontmatter.name === "empty-map")?.frontmatter["metadata"], {});
  assert.equal(listing.skills.find((item) => item.frontmatter.name === "unicode")?.frontmatter["compatibility"], "😀".repeat(500));
  assert.equal(listing.skills.find((item) => item.frontmatter.name === "unicode")?.frontmatter.description, "😀".repeat(1024));
});

test("MCP Skills direct filters manifest paths, size and scope", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const previous = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-direct-manifest-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });
  const rows: ReturnType<typeof newEntry>[] = [];
  for (const [name, extraPath, extraSize] of [
    ["valid", "nested/reference.txt", 100],
    ["oversized", "nested/reference.txt", 101],
    ["missing", "nested/reference.txt", 1],
    ["empty", "nested//reference.txt", 1],
    ["dot", "nested/./reference.txt", 1],
    ["parent", "nested/../reference.txt", 1],
  ] as const) {
    const dir = path.join(home, name);
    const frontmatter = `name: ${name}\ndescription: valid`;
    const content = Buffer.from(`---\n${frontmatter}\n---\n`);
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await mkdir(path.join(dir, "nested"), { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), content);
    await writeFile(path.join(dir, "nested/reference.txt"), Buffer.alloc(extraSize));
    const manifest = [
      ...(name === "missing" ? [] : [{ path: "SKILL.md", digest, size: content.length }]),
      { path: extraPath, digest: `sha256:${createHash("sha256").update(Buffer.alloc(extraSize)).digest("hex")}`, size: extraSize },
    ];
    rows.push({ ...newEntry("source", name), dir, revision: digest, frontmatter, manifest: JSON.stringify(manifest) });
  }
  const base = rows.find((row) => row.name === "valid")!;
  const malformedSize = JSON.parse(base.manifest) as { path: string; digest: string; size: unknown }[];
  malformedSize[1]!.size = { toString: null };
  rows.push({
    ...newEntry("other", "malformed-size"),
    dir: base.dir,
    revision: base.revision,
    manifest: JSON.stringify(malformedSize),
    frontmatter: "name: malformed-size\ndescription: valid",
  });
  await seedIndex(rows);
  const pages = boundSkillsPages(t, 3);
  const factory =
    (scope: ReadonlySet<string> | undefined, limit?: number): (() => McpServer) =>
    () => {
      const server = new McpServer({ name: "direct-test", version: "1" });
      attachMargraveSkills(server, scope, limit);
      return server;
    };
  const unrestricted = new SkillsClient(await connectInMemory(t, factory(undefined)));
  assert.deepEqual(
    (await unrestricted.list()).skills.map((skill) => skill.frontmatter.name),
    ["oversized", "valid"],
  );
  pages.cursors.length = 0;
  const limited = new SkillsClient(await connectInMemory(t, factory(new Set(["source"]), 100)));
  const allowed = await limited.list();
  assert.deepEqual(
    allowed.skills.map((skill) => skill.frontmatter.name),
    ["valid"],
  );
  const resource = allowed.skills[0]?.resources[1];
  assert.ok(resource !== undefined && typeof resource !== "string");
  assert.equal(resource.size, 100);
  pages.cursors.length = 0;
  const empty = new SkillsClient(await connectInMemory(t, factory(new Set(), 100)));
  assert.deepEqual((await empty.list()).skills, []);
  for (const cursor of ["", "!", `${Buffer.from("source/valid").toString("base64url")}=`]) {
    await assert.rejects(
      limited.list({ cursor }),
      (err: unknown) =>
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === -32602 &&
        err instanceof Error &&
        err.message === "invalid cursor",
    );
  }
});

test("MCP Skills direct advances keyset pages past rejected rows", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const previous = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-direct-pages-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });
  const bytes = Buffer.from("page fixture\n");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const manifest = JSON.stringify([{ path: "SKILL.md", digest, size: bytes.length }]);
  const names = Array.from({ length: 56 }, (_, i) => `page-${String(i).padStart(2, "0")}`);
  const rows = names.map((name) => ({
    ...newEntry("source", name),
    revision: digest,
    manifest,
    frontmatter: `name: ${name}\ndescription: page`,
  }));
  for (let i = 0; i < 5; i++) {
    const name = `bad-${i}`;
    rows.push({ ...newEntry("source", name), revision: digest, manifest, frontmatter: "[]" });
  }
  await seedIndex(rows);
  const pages = boundSkillsPages(t, 3);
  for (const scope of [undefined, new Set(["source"])] as const) {
    const client = await connectInMemory(t, () => {
      const server = new McpServer({ name: "direct-test", version: "1" });
      attachMargraveSkills(server, scope);
      return server;
    });
    const skills = new SkillsClient(client);
    pages.cursors.length = 0;
    const first = await skills.list({ cursor: Buffer.from("source/").toString("base64url") });
    assert.deepEqual(
      first.skills.map((skill) => skill.frontmatter.name),
      names.slice(0, 50),
    );
    assert.deepEqual(
      first.skills.map((skill) => skill.uri),
      names.slice(0, 50).map((name) => `skill://margrave/source/${encodeURIComponent(digest)}/${name}/SKILL.md`),
    );
    assert.equal(first.nextCursor, Buffer.from("source/page-49").toString("base64url"));
    assert.deepEqual(pages.cursors, ["source/", "source/page-45"]);
    pages.cursors.length = 0;
    const second = await skills.list({ cursor: first.nextCursor });
    assert.deepEqual(
      second.skills.map((skill) => skill.frontmatter.name),
      names.slice(50),
    );
    assert.deepEqual(
      second.skills.map((skill) => skill.uri),
      names.slice(50).map((name) => `skill://margrave/source/${encodeURIComponent(digest)}/${name}/SKILL.md`),
    );
    assert.equal(second.nextCursor, undefined);
    assert.deepEqual(pages.cursors, ["source/page-49"]);
    pages.cursors.length = 0;
    const exact = await skills.list({ cursor: Buffer.from("source/page-05").toString("base64url") });
    assert.deepEqual(
      exact.skills.map((skill) => skill.frontmatter.name),
      names.slice(6),
    );
    assert.equal(exact.nextCursor, undefined);
    assert.deepEqual(pages.cursors, ["source/page-05"]);
    pages.cursors.length = 0;
    const all = await skills.list();
    assert.deepEqual(
      all.skills.map((skill) => skill.frontmatter.name),
      names,
    );
    assert.deepEqual(pages.cursors, ["", "source/page-45", "source/page-49"]);
  }
});

test("MCP Skills direct stops consuming rows once the next page is established", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const previous = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-direct-page-stop-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });
  const digest = `sha256:${createHash("sha256").update("page fixture\n").digest("hex")}`;
  const manifest = JSON.stringify([{ path: "SKILL.md", digest, size: 13 }]);
  const names = Array.from({ length: 110 }, (_, i) => (i < 100 ? `page-${String(i).padStart(2, "0")}` : `z-page-${i}`));
  const rows = names.map((name) => ({
    ...newEntry("source", name),
    revision: digest,
    manifest: name === "page-54" ? "{" : manifest,
    frontmatter: `name: ${name}\ndescription: page`,
  }));
  for (let i = 0; i < 5; i++) {
    const name = `bad-${i}`;
    rows.push({ ...newEntry("source", name), revision: digest, manifest, frontmatter: "[]" });
  }
  await seedIndex(rows);
  const pages = boundSkillsPages(t, 3);
  const skills = new SkillsClient(await connectInMemory(t));
  const page = await skills.list({ cursor: Buffer.from("source/").toString("base64url") });
  assert.deepEqual(
    page.skills.map((skill) => skill.frontmatter.name),
    names.slice(0, 50),
  );
  assert.equal(page.nextCursor, Buffer.from("source/page-49").toString("base64url"));
  assert.deepEqual(pages.cursors, ["source/", "source/page-45"]);
});

test("MCP Skills direct handles an absent catalog and closes catalog connections", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const previous = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-direct-empty-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });
  boundSkillsPages(t, 3);
  const client = await connectInMemory(t);
  const skills = new SkillsClient(client);
  const uri = `skill://margrave/source/${encodeURIComponent(`sha256:${"0".repeat(64)}`)}/missing/SKILL.md`;
  const noSkill = { code: -32602, message: `No skill is served at ${uri}` };
  const noResource = { code: -32602, message: `Resource not found: ${uri}` };
  assert.deepEqual((await skills.list()).skills, []);
  await assert.rejects(skills.get(uri), noSkill);
  await assert.rejects(client.readResource({ uri }), noResource);

  await seedIndex([newEntry("source", "skill")]);
  const close = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "close")?.value as DatabaseSync["close"];
  let closed = 0;
  const closeMock = mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closed++;
    close.call(this);
  });
  t.after(() => closeMock.mock.restore());
  assert.deepEqual((await skills.list()).skills, []);
  assert.equal(closed, 1);
  await assert.rejects(skills.get(uri), noSkill);
  assert.equal(closed, 2);
  await assert.rejects(client.readResource({ uri }), noResource);
  assert.equal(closed, 3);
  await assert.rejects(
    skills.list({ cursor: "!" }),
    (err: unknown) => err instanceof Error && "code" in err && err.code === -32602 && err.message === "invalid cursor",
  );
  assert.equal(closed, 4);
  const prepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")?.value as DatabaseSync["prepare"];
  const failure = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.includes("WHERE id > ? AND (? IS NULL OR source IN")) throw new Error("catalog query failed");
    return prepare.call(this, sql);
  });
  try {
    await assert.rejects(skills.list(), /catalog query failed/u);
    assert.equal(closed, 5);
  } finally {
    failure.mock.restore();
  }
});

test("MCP Skills direct reports catalog close failure", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const previous = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-direct-close-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });
  await seedIndex([newEntry("source", "skill")]);
  boundSkillsPages(t, 3);
  const client = await connectInMemory(t);
  const close = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "close")?.value as DatabaseSync["close"];
  const closeMock = mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    close.call(this);
    throw new Error("catalog close failed");
  });
  t.after(() => closeMock.mock.restore());
  await assert.rejects(new SkillsClient(client).list(), { code: -32603, message: "catalog close failed" });
});

test("MCP Skills direct reads exact resources and rejects noncanonical URIs", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const previous = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-direct-resource-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });
  const dir = path.join(home, "fixture");
  await mkdir(path.join(dir, "nested"), { recursive: true });
  const frontmatter = "name: example\ndescription: valid";
  const files = [
    ["SKILL.md", Buffer.from(`---\n${frontmatter}\n---\nbody\n`)],
    ["nested/résumé file.txt", Buffer.from("\uFEFFhello\n")],
    ["nested/reference.md", Buffer.from("markdown\n")],
    ["nested/data.bin", Buffer.from([0, 255, 1])],
  ] as const;
  const manifest = files.map(([file, bytes]) => ({
    path: file,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.length,
  }));
  for (const [file, bytes] of files) await writeFile(path.join(dir, file), bytes);
  const revision = manifest[0]!.digest;
  const badManifest = JSON.stringify([...manifest, { path: "../bad", digest: revision, size: 1 }]);
  await seedIndex([
    { ...newEntry("source", "example"), dir, revision, manifest: JSON.stringify(manifest), frontmatter },
    { ...newEntry("source", "invalid"), dir, revision, manifest: badManifest, frontmatter: "name: invalid\ndescription: valid" },
  ]);
  const prepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")?.value as DatabaseSync["prepare"];
  let selectedQueries = 0;
  const selectedSql =
    "SELECT id, name, description, source, dir, hash AS revision, manifest, frontmatter FROM skills WHERE id = ? AND source = ?";
  const sqlMock = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === selectedSql) selectedQueries++;
    return prepare.call(this, sql);
  });
  t.after(() => sqlMock.mock.restore());
  const client = await connectInMemory(t);
  const skills = new SkillsClient(client);
  const root = `skill://margrave/source/${encodeURIComponent(revision)}/example`;
  const uri = `${root}/SKILL.md`;
  const skill = (await skills.get(uri)).skill;
  assert.equal(skill.uri, uri);
  assert.deepEqual(
    skill.resources,
    manifest.map((item) => ({
      uri: `${root}/${item.path.split("/").map(encodeURIComponent).join("/")}`,
      digest: item.digest,
      size: item.size,
    })),
  );
  for (const [file, bytes] of files) {
    const fileUri = `${root}/${file.split("/").map(encodeURIComponent).join("/")}`;
    const content = (await client.readResource({ uri: fileUri })).contents;
    if (file.endsWith(".bin")) {
      assert.deepEqual(content, [{ uri: fileUri, mimeType: "application/octet-stream", blob: bytes.toString("base64") }]);
    } else {
      assert.deepEqual(content, [
        { uri: fileUri, text: bytes.toString("utf8"), ...(file.endsWith(".md") ? { mimeType: "text/markdown" } : {}) },
      ]);
    }
  }
  assert.equal((await skills.read(skill, "nested/résumé file.txt")).text, "\uFEFFhello\n");
  assert.deepEqual([...(await skills.read(skill, "nested/data.bin")).bytes], [0, 255, 1]);
  const missing = async (input: string): Promise<void> => {
    await assert.rejects(
      client.readResource({ uri: input }),
      (err: unknown) => err instanceof Error && "code" in err && err.code === -32602 && err.message === `Resource not found: ${input}`,
    );
  };
  const stale = `sha256:${"0".repeat(64)}`;
  for (const input of [
    `skill://other/source/${encodeURIComponent(revision)}/example/SKILL.md`,
    `skill://margrave//${encodeURIComponent(revision)}/example/SKILL.md`,
    `${root}//SKILL.md`,
    `${root}/./SKILL.md`,
    `${root}/../SKILL.md`,
    `${root}/%`,
    `${root}/%FF`,
    `${root}/%53KILL.md`,
    `skill://margrave/source/sha256%3a${revision.slice("sha256:".length)}/example/SKILL.md`,
    `skill://margrave/source/${encodeURIComponent(`x${revision}`)}/example/SKILL.md`,
    `skill://margrave/source/${encodeURIComponent(`${revision}x`)}/example/SKILL.md`,
    `skill://margrave/source/${encodeURIComponent(stale)}/example`,
  ]) {
    const before = selectedQueries;
    await missing(input);
    assert.equal(selectedQueries, before, input);
  }
  await missing(`${root}/nested%2Freference.md`);
  await missing(`${root}/unlisted.txt`);
  await missing(`skill://margrave/source/${encodeURIComponent(revision)}/absent/SKILL.md`);
  await missing(`skill://margrave/source/${encodeURIComponent(revision)}/invalid/SKILL.md`);
  const staleUri = `skill://margrave/source/${encodeURIComponent(stale)}/example/SKILL.md`;
  for (const request of [() => skills.get(staleUri), () => client.readResource({ uri: staleUri })]) {
    await assert.rejects(
      request(),
      (err: unknown) =>
        err instanceof Error && "code" in err && err.code === -32602 && err.message === "skill revision changed; search again",
    );
  }
});
