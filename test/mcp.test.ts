import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp, { mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { FIND_DESCRIPTION, LOAD_DESCRIPTION, READ_DESCRIPTION, SERVER_INSTRUCTIONS, createServer } from "../src/mcp.ts";
import { CLI, fakeRipwire, runCli, tmp, writeSkill } from "./helpers.ts";

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
    env: { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home },
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
    "Find recommended installed skills for a task in plain words. Use explain to see matching terms and weak matches. Use load_skill only for a recommended result.",
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
  assert.match(escape.text, /outside/u);
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
  assert.match(corrupt.text, /is not a margrave index; move it aside, then run: margrave reindex/u);

  // the server is read-only: only the three tools exist
  assert.equal(tools.length, 3);
});

/** Run createServer() in this process through a stateless handler. */
async function connectInMemory(t: { after: (fn: () => Promise<void>) => void }): Promise<Client> {
  const handler = createMcpHandler(() => createServer(), { legacy: "reject" });
  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init)) }),
  );
  t.after(() => client.close());
  return client;
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

  mock.method(fsp, "readFile", () => Promise.reject("boom, not an Error"));
  syncBuiltinESMExports();
  const r = await call(client, "find_skills", { task: "anything" });
  assert.deepEqual(r, { isError: true, text: "boom, not an Error" });
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
  assert.match(escape.text, /outside/u);

  // A corrupt index.db is a tool error for all three tools.
  await writeFile(path.join(home, "index.db"), "garbage that is not a database");
  for (const [tool, args] of [
    ["find_skills", { task: "terraform" }],
    ["load_skill", { id }],
    ["read_skill_file", { id, path: "SKILL.md" }],
  ] as const) {
    const r = await call(client, tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /is not a margrave index; move it aside, then run: margrave reindex/u, tool);
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
  for (const description of ["Shared terraform modules", "Shared terraform modules terraform modules"]) {
    const dir = await tmp("mg-scope-");
    const skill = await writeSkill(dir, "shared", description);
    await writeFile(path.join(skill, "reference.txt"), description);
    const result = await runCli(["install", dir], { home, fakeBin });
    assert.equal(result.code, 0, result.stderr);
    ids.push(/^installed (\S+)/u.exec(result.stdout)?.[1] ?? "");
  }
  const [visible, hidden] = ids as [string, string];
  const cli = await runCli(["find", "terraform modules", "--limit", "10"], { home, fakeBin, extra: { MARGRAVE_ALLOWED_SOURCES: "" } });
  assert.equal(cli.code, 0, cli.stderr);
  assert.ok(cli.stdout.includes(visible) && cli.stdout.includes(hidden));
  for (const scope of [undefined, `${visible}, ${visible},missing`, ""]) {
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home };
    if (scope !== undefined) env["MARGRAVE_ALLOWED_SOURCES"] = scope;
    const client = new Client({ name: "scope-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env }));
    t.after(() => client.close());
    const found = await call(client, "find_skills", { task: "terraform modules", limit: 1, explain: true });
    if (scope === "") assert.match(found.text, /no match/u);
    else if (scope !== undefined) {
      assert.ok(found.text.includes(visible));
      assert.ok(!found.text.includes(hidden));
      assert.ok(!found.text.includes("terraform modules terraform modules"));
    } else assert.ok(found.text.includes(hidden));
    const bare = await call(client, "load_skill", { id: "shared" });
    if (scope === undefined) assert.match(bare.text, /ambiguous/u);
    else assert.equal(bare.isError, scope === "");
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
        if (scope === "")
          assert.deepEqual(visibleResult, { ...unknown, text: unknown.text.replace("unknown/shared", `${visible}/shared`) });
        else if (token === undefined || scope !== undefined) assert.equal(visibleResult.isError, false);
      }
    }
  }
  for (const value of [",", `${visible},`, "bad/id", " .,ok"]) {
    const result = await runCli(["mcp"], { home, extra: { MARGRAVE_ALLOWED_SOURCES: value } });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MARGRAVE_ALLOWED_SOURCES must contain comma-separated source IDs/u);
  }
});

test("stdio serves a client that opens with an older protocol revision", () => {
  for (const protocolVersion of ["2025-11-25", "2025-06-18"]) {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } },
    };
    const result = spawnSync(process.execPath, [CLI, "mcp"], { input: `${JSON.stringify(request)}\n`, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.split("\n")[0] ?? "") as {
      id: number;
      result?: { protocolVersion: string; serverInfo: { name: string } };
      error?: unknown;
    };
    assert.equal(response.id, 1);
    assert.equal(response.error, undefined);
    assert.equal(response.result?.protocolVersion, protocolVersion);
    assert.equal(response.result?.serverInfo.name, "margrave");
  }
});
