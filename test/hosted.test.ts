import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { handleHostedMcp } from "../src/hosted.ts";
import {
  FIND_DESCRIPTION,
  HOSTED_LOAD_DESCRIPTION,
  HOSTED_NO_SOURCES_MESSAGE,
  HOSTED_READ_DESCRIPTION,
  HOSTED_SERVER_ERROR,
  createServer,
} from "../src/mcp.ts";
import { CLI, ROOT, fakeRipwire, git, leaveHotJournal, makeRepo, runCli, skillMd, tmp, writeSkill } from "./helpers.ts";

interface ToolText {
  isError: boolean;
  text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolText> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") };
}

/** A client of handleHostedMcp. The fetch goes straight to the handler, so no network is used. */
async function connectHosted(t: { after: (fn: () => Promise<void>) => void }, allowedSources?: readonly string[]): Promise<Client> {
  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp?allowedSources=all"), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("allowedSources", "all");
        const response = await handleHostedMcp(
          new Request(url, { ...init, headers }),
          allowedSources === undefined ? {} : { allowedSources },
        );
        if (response.ok) assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/u);
        return response;
      },
    }),
  );
  t.after(() => client.close());
  return client;
}

/** A client of the stdio server's createServer(), using a stateless handler. */
async function connectLocal(t: { after: (fn: () => Promise<void>) => void }): Promise<Client> {
  const handler = createMcpHandler(() => createServer(), { legacy: "reject" });
  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init)) }),
  );
  t.after(() => client.close());
  return client;
}

/** Set MARGRAVE_HOME to a fresh temp dir until the test ends. */
async function useHome(t: { after: (fn: () => void) => void }): Promise<string> {
  const prev = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(() => {
    mock.restoreAll();
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  return home;
}

test("released v0.2.1 store remains usable after upgrade", async (t) => {
  const home = await useHome(t);
  t.after(() => rm(home, { recursive: true, force: true }));
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const source = "example.invalid__fixtures__margrave-upgrade";
  const id = `${source}/release-upgrade`;
  const body = "The installed upgrade skill survived.";
  const sources = await readFile(path.join(home, "sources.json"), "utf8");
  const beforeMigration = await runCli(["find", "release upgrade"], { home });
  assert.equal(beforeMigration.code, 1);
  assert.match(beforeMigration.stderr, /store upgrade required/u);
  const migration = await runCli(["migrate"], { home });
  assert.equal(migration.code, 0, migration.stderr);
  assert.equal(migration.stdout, "store upgraded\n");
  const filesBeforeRepeat = (await readdir(home)).sort();
  const repeated = await runCli(["migrate"], { home });
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(repeated.stdout, "store is current\n");
  assert.deepEqual((await readdir(home)).sort(), filesBeforeRepeat);
  await chmod(home, 0o555);
  try {
    const readOnlyRepeat = await runCli(["migrate"], { home });
    assert.equal(readOnlyRepeat.code, 0, readOnlyRepeat.stderr);
    assert.equal(readOnlyRepeat.stdout, "store is current\n");
  } finally {
    await chmod(home, 0o755);
  }
  const found = await runCli(["find", "release upgrade"], { home });
  assert.equal(found.code, 0, found.stderr);
  assert.ok(found.stdout.includes(id), found.stdout);
  const loaded = await runCli(["load", id], { home });
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.ok(loaded.stdout.includes(body), loaded.stdout);

  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      env: { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home },
    }),
  );
  const hosted = await connectHosted(t);
  for (const mcp of [client, hosted]) {
    const result = await call(mcp, "find_skills", { task: "release upgrade" });
    assert.equal(result.isError, false, result.text);
    assert.ok(result.text.includes(id), result.text);
    const skill = await call(mcp, "load_skill", { id });
    assert.equal(skill.isError, false, skill.text);
    assert.ok(skill.text.includes(body), skill.text);
  }
  const reindex = await runCli(["reindex"], { home });
  assert.equal(reindex.code, 0, reindex.stderr);
  assert.match(reindex.stdout, /1 skills? from 1 sources?/u);
  assert.equal(await readFile(path.join(home, "sources.json"), "utf8"), sources);
  const after = await runCli(["load", id], { home });
  assert.equal(after.code, 0, after.stderr);
  assert.ok(after.stdout.includes(body), after.stdout);
});

test("a moved Git store loads from its new path through CLI and MCP", async (t) => {
  const original = await useHome(t);
  const repo = await makeRepo();
  const installed = await runCli(["install", repo.url], { home: original, fakeBin: await fakeRipwire() });
  assert.equal(installed.code, 0, installed.stderr);
  const id = /^installed (\S+)/mu.exec(installed.stdout)?.[1];
  assert.ok(id);
  const moved = path.join(await tmp(), "moved");
  await rename(original, moved);
  await cp(moved, original, { recursive: true, verbatimSymlinks: true });
  await writeFile(
    path.join(original, "sources", id, "skills", "react-perf", "SKILL.md"),
    skillMd("react-perf", "old copy", "old copy bytes"),
  );
  process.env["MARGRAVE_HOME"] = moved;
  const found = await runCli(["find", "react-perf"], { home: moved });
  assert.equal(found.code, 0, found.stderr);
  assert.match(found.stdout, /react-perf/u);
  const loaded = await runCli(["load", "react-perf"], { home: moved });
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.match(loaded.stdout, /Body of react-perf/u);
  assert.doesNotMatch(loaded.stdout, /old copy bytes/u);
  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      env: { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: moved },
    }),
  );
  const hosted = await connectHosted(t);
  for (const mcp of [client, hosted]) {
    const foundSkill = await call(mcp, "find_skills", { task: "react-perf" });
    assert.equal(foundSkill.isError, false, foundSkill.text);
    assert.match(foundSkill.text, /react-perf/u);
    const result = await call(mcp, "load_skill", { id: `${id}/react-perf` });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Body of react-perf/u);
    assert.doesNotMatch(result.text, /old copy bytes/u);
  }
});

test("hosted tools have the same names, input schemas, and instructions as the stdio server; only the two descriptions differ", async (t) => {
  await useHome(t);
  const local = await connectLocal(t);
  const hosted = await connectHosted(t);

  assert.equal(hosted.getInstructions(), local.getInstructions());
  const localTools = (await local.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
  const hostedTools = (await hosted.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    hostedTools.map((x) => x.name),
    localTools.map((x) => x.name),
  );
  assert.equal(hostedTools.length, 3);
  assert.deepEqual(
    hostedTools.map((x) => x.inputSchema),
    localTools.map((x) => x.inputSchema),
  );

  const desc = Object.fromEntries(hostedTools.map((x) => [x.name, x.description]));
  assert.equal(desc["find_skills"], FIND_DESCRIPTION);
  assert.equal(desc["load_skill"], HOSTED_LOAD_DESCRIPTION);
  assert.equal(desc["read_skill_file"], HOSTED_READ_DESCRIPTION);
  assert.equal(
    HOSTED_LOAD_DESCRIPTION,
    "Load the instructions of one skill. Use an id from find_skills. Returns the skill text, its source, and its file list.",
  );
  assert.equal(HOSTED_READ_DESCRIPTION, "Read one file inside a skill directory. Use a path from the file list that load_skill returns.");
});

test("hosted: with no sources, find_skills answers and the other two tools fail, all with the hosted text", async (t) => {
  await useHome(t);
  const client = await connectHosted(t);
  assert.equal(HOSTED_NO_SOURCES_MESSAGE, "no skills are installed on this server");
  assert.deepEqual(await call(client, "find_skills", { task: "x" }), { isError: false, text: HOSTED_NO_SOURCES_MESSAGE });
  assert.deepEqual(await call(client, "load_skill", { id: "x" }), { isError: true, text: HOSTED_NO_SOURCES_MESSAGE });
  assert.deepEqual(await call(client, "read_skill_file", { id: "x", path: "SKILL.md" }), {
    isError: true,
    text: HOSTED_NO_SOURCES_MESSAGE,
  });
  const revision = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(await call(client, "load_skill", { id: "x", revision }), {
    isError: true,
    text: "skill revision changed; search again",
  });
  assert.deepEqual(await call(client, "read_skill_file", { id: "x", path: "SKILL.md", revision }), {
    isError: true,
    text: "skill revision changed; search again",
  });
});

test("hosted: find, load, read, and request errors, with no server path in any text", async (t) => {
  const home = await useHome(t);
  const fakeBin = await fakeRipwire();
  const dir = await tmp("mg-localsrc-");
  const skillDir = await writeSkill(dir, "terraform-modules", "Design reusable Terraform modules");
  await writeSkill(dir, "ansible-roles", "Write Ansible roles and playbooks");
  await mkdir(path.join(skillDir, "references"));
  await writeFile(path.join(skillDir, "references", "x.md"), "reference text\n");
  await writeFile(path.join(dir, "secret.txt"), "outside\n");
  const inst = await runCli(["install", dir], { home, fakeBin });
  assert.equal(inst.code, 0, inst.stderr);
  const id = `${/^installed (\S+)/mu.exec(inst.stdout)?.[1] ?? ""}/terraform-modules`;
  const client = await connectHosted(t);
  const noPaths = (text: string): void => {
    assert.ok(!text.includes(home), text);
    assert.ok(!text.includes(dir), text);
  };

  const found = await call(client, "find_skills", { task: "terraform modules", limit: 3 });
  assert.equal(found.isError, false);
  const revision = /revision: (sha256:[0-9a-f]{64})/u.exec(found.text)?.[1];
  assert.ok(revision);
  assert.deepEqual(await call(client, "load_skill", { id: "removed", revision }), {
    isError: true,
    text: "skill revision changed; search again",
  });
  assert.equal((await call(client, "load_skill", { id, revision })).isError, false);
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "references/x.md", revision }), {
    isError: false,
    text: "reference text\n",
  });
  for (const [args, message] of [
    [{ id, revision: "bad" }, "revision must be a SHA-256 digest"],
    [{ id, revision: `sha256:${"0".repeat(64)}` }, "skill revision changed; search again"],
  ] as const)
    assert.deepEqual(await call(client, "load_skill", args), { isError: true, text: message });
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "../secret.txt", revision }), {
    isError: true,
    text: "file is not in the selected skill revision",
  });
  await writeFile(path.join(skillDir, "references", "x.md"), "x".repeat("reference text\n".length));
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "references/x.md", revision }), {
    isError: true,
    text: "skill files changed since indexing; ask the store operator to run margrave reindex, then search again",
  });
  await rm(path.join(skillDir, "references", "x.md"));
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "references/x.md", revision }), {
    isError: true,
    text: "skill files changed since indexing; ask the store operator to run margrave reindex, then search again",
  });
  await writeFile(path.join(skillDir, "references", "x.md"), "changed\n");
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "references/x.md", revision }), {
    isError: true,
    text: "skill files changed since indexing; ask the store operator to run margrave reindex, then search again",
  });
  await writeFile(path.join(skillDir, "references", "x.md"), "reference text\n");
  const lines = found.text.split("\n");
  assert.match(lines[0] ?? "", new RegExp(`^1\\. ${id} `, "u"));
  assert.equal(lines.at(-1), `load: call load_skill with id ${id}`);
  assert.deepEqual(await call(client, "find_skills", { task: "quantum chromodynamics" }), {
    isError: false,
    text: "no match\ntry other words",
  });
  const weakQuery = "repair a toaster with Terraform";
  assert.deepEqual(await call(client, "find_skills", { task: weakQuery }), { isError: false, text: "no match\ntry other words" });
  const weak = await call(client, "find_skills", { task: weakQuery, explain: true });
  assert.equal(weak.isError, false);
  assert.match(weak.text, /weak match/u);
  assert.match(weak.text, /matches in name \(terraform\)/u);
  assert.doesNotMatch(weak.text, /load:/u);
  noPaths(weak.text);
  const explained = await call(client, "find_skills", { task: "terraform modules", explain: true });
  assert.match(explained.text, /matches in name \(modul, terraform\)/u);
  assert.match(explained.text, /load: call load_skill/u);
  noPaths(explained.text);

  const loaded = await call(client, "load_skill", { id });
  assert.equal(loaded.isError, false);
  const cliLoad = await runCli(["load", id], { home, fakeBin });
  const sourceId = id.split("/")[0] ?? "";
  assert.equal(loaded.text, cliLoad.stdout.replace(/^base: .*\n/mu, "").replace(/^source: .*$/mu, `source: ${sourceId}`));
  assert.ok(loaded.text.split("\n").includes(`source: ${sourceId}`));
  assert.doesNotMatch(loaded.text, /^base: /mu);
  noPaths(loaded.text);

  assert.deepEqual(await call(client, "read_skill_file", { id, path: "references/x.md" }), { isError: false, text: "reference text\n" });
  for (const bad of ["../secret.txt", path.join(dir, "secret.txt")]) {
    const r = await call(client, "read_skill_file", { id, path: bad });
    assert.equal(r.isError, true, bad);
    assert.match(r.text, bad.startsWith("..") ? /outside/u : /relative/u, bad);
  }
  const unknown = await call(client, "load_skill", { id: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /no skill "nope"/u);
  noPaths(unknown.text);
});

test("hosted: read_skill_file refuses .git and the text holds no store path", async (t) => {
  const home = await useHome(t);
  const fakeBin = await fakeRipwire();
  const dir = await tmp("mg-localsrc-");
  const skillDir = await writeSkill(dir, "terraform-modules", "Design reusable Terraform modules");
  await mkdir(path.join(skillDir, ".git"));
  await writeFile(path.join(skillDir, ".git", "config"), "[remote]\nurl = https://user:token@example.com/r.git\n");
  const inst = await runCli(["install", dir], { home, fakeBin });
  assert.equal(inst.code, 0, inst.stderr);
  const id = `${/^installed (\S+)/mu.exec(inst.stdout)?.[1] ?? ""}/terraform-modules`;
  const client = await connectHosted(t);

  const r = await call(client, "read_skill_file", { id, path: ".git/config" });
  assert.equal(r.isError, true);
  assert.match(r.text, /inside \.git/u);
  assert.ok(!r.text.includes(home), r.text);
  assert.ok(!r.text.includes(dir), r.text);
  assert.ok(!r.text.includes("token"), r.text);
});

test("hosted: a git source with SKILL.md at the repository root serves no .git file", async (t) => {
  const home = await useHome(t);
  const fakeBin = await fakeRipwire();
  const repo = await tmp("mg-rootrepo-");
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "SKILL.md"), skillMd("root-skill", "A skill at the repository root"));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "initial");
  const inst = await runCli(["install", `file://${repo}`], { home, fakeBin });
  assert.equal(inst.code, 0, inst.stderr);
  const id = `${/^installed (\S+)/mu.exec(inst.stdout)?.[1] ?? ""}/root-skill`;
  const client = await connectHosted(t);

  assert.equal((await call(client, "load_skill", { id })).isError, false);
  for (const p of [".git/config", ".git/logs/HEAD"]) {
    const r = await call(client, "read_skill_file", { id, path: p });
    assert.equal(r.isError, true, p);
    assert.match(r.text, /inside \.git/u);
  }
});

test("hosted: a store failure returns a generic error and logs the cause", async (t) => {
  const home = await useHome(t);
  const fakeBin = await fakeRipwire();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "terraform-modules", "Design reusable Terraform modules");
  const inst = await runCli(["install", dir], { home, fakeBin });
  assert.equal(inst.code, 0, inst.stderr);
  const id = `${/^installed (\S+)/mu.exec(inst.stdout)?.[1] ?? ""}/terraform-modules`;
  const client = await connectHosted(t);
  await writeFile(path.join(home, "index.db"), "garbage that is not a database");
  const log = mock.method(console, "error", () => {});

  assert.equal(HOSTED_SERVER_ERROR, "the skill store on this server is not available; the server log has details");
  for (const [tool, args] of [
    ["find_skills", { task: "terraform" }],
    ["load_skill", { id }],
    ["read_skill_file", { id, path: "SKILL.md" }],
  ] as const) {
    log.mock.resetCalls();
    const r = await call(client, tool, args);
    assert.deepEqual(r, { isError: true, text: HOSTED_SERVER_ERROR }, tool);
    assert.ok(!r.text.includes(home) && !r.text.includes(dir), tool);
    assert.equal(log.mock.callCount(), 1, tool);
    const logged: unknown = log.mock.calls[0]?.arguments[0];
    assert.ok(logged instanceof Error, tool);
    assert.match(logged.message, /is not a supported margrave catalog/u, tool);
  }
});

test("hosted: a hot journal returns the generic error and logs the unfinished-write message", { timeout: 60_000 }, async (t) => {
  const home = await useHome(t);
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "terraform-modules", "Design reusable Terraform modules");
  const inst = await runCli(["install", dir], { home, fakeBin: await fakeRipwire() });
  assert.equal(inst.code, 0, inst.stderr);
  const client = await connectHosted(t);
  await leaveHotJournal(path.join(home, "index.db"));
  const log = mock.method(console, "error", () => {});

  const r = await call(client, "find_skills", { task: "terraform" });
  assert.deepEqual(r, { isError: true, text: HOSTED_SERVER_ERROR });
  assert.equal(log.mock.callCount(), 1);
  const logged: unknown = log.mock.calls[0]?.arguments[0];
  assert.ok(logged instanceof Error);
  assert.match(logged.message, /index\.db has an unfinished v0.2.1 write. Restore a complete backup before migrating/u);
});

test("hosted: only POST is served", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await handleHostedMcp(new Request("http://test/mcp", { method }));
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("Allow"), "POST", method);
    assert.deepEqual(await res.json(), { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, method);
  }
});

test("hosted: a read-only MARGRAVE_HOME (mode 555) still serves find_skills, load_skill, and read_skill_file", async (t) => {
  const home = await useHome(t);
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "terraform-modules", "Design reusable Terraform modules");
  const inst = await runCli(["install", dir], { home, fakeBin: await fakeRipwire() });
  assert.equal(inst.code, 0, inst.stderr);
  const id = `${/^installed (\S+)/mu.exec(inst.stdout)?.[1] ?? ""}/terraform-modules`;
  const client = await connectHosted(t);
  t.after(() => chmod(home, 0o755));
  await chmod(home, 0o555);

  const found = await call(client, "find_skills", { task: "terraform" });
  assert.equal(found.isError, false, found.text);
  assert.match(found.text, /terraform-modules/u);
  const loaded = await call(client, "load_skill", { id });
  assert.equal(loaded.isError, false, loaded.text);
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "SKILL.md" }), {
    isError: false,
    text: "---\nname: terraform-modules\ndescription: Design reusable Terraform modules\n---\n# terraform-modules\n\nBody of terraform-modules.\n",
  });
});

test("hosted source options isolate requests on the same store", async (t) => {
  const home = await useHome(t);
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
  const [first, second] = ids as [string, string];
  for (const scope of [undefined, [first, first, "missing"], [second], []]) {
    const client = await connectHosted(t, scope);
    const found = await call(client, "find_skills", {
      task: "terraform modules",
      limit: 1,
      explain: true,
      allowedSources: [first, second],
    });
    if (scope?.length === 0) assert.match(found.text, /no match/u);
    else if (scope !== undefined) {
      assert.ok(found.text.includes(scope[0] ?? ""));
      assert.ok(!found.text.includes(scope[0] === first ? second : first));
    } else assert.ok(found.text.includes(second));
    const bare = await call(client, "load_skill", { id: "shared" });
    if (scope === undefined) assert.match(bare.text, /ambiguous/u);
    else assert.equal(bare.isError, scope.length === 0);
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
        for (const id of ids) {
          const result = await call(client, tool, args(`${id}/shared`));
          if (scope !== undefined && !scope.includes(id))
            assert.deepEqual(result, { ...unknown, text: unknown.text.replace("unknown/shared", `${id}/shared`) });
          else if (token === undefined || scope?.[0] === id) assert.equal(result.isError, false);
        }
      }
    }
  }
  for (const allowedSources of ["bad", [123], ["bad/id"], [""]]) {
    await assert.rejects(handleHostedMcp(new Request("http://test/mcp", { method: "POST" }), { allowedSources } as never), {
      message: "allowedSources must contain valid source IDs",
    });
  }
});

test("hosted serves a client that opens with an older protocol revision", async () => {
  for (const protocolVersion of ["2025-11-25", "2025-06-18"]) {
    const response = await handleHostedMcp(
      new Request("http://test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } },
        }),
      }),
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    // A stateless 2025 answer may come as one server-sent event: take its data line.
    const json = text.trimStart().startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6);
    const body = JSON.parse(json) as {
      id: number;
      result?: { protocolVersion: string; serverInfo: { name: string } };
      error?: unknown;
    };
    assert.equal(body.id, 1);
    assert.equal(body.error, undefined);
    assert.equal(body.result?.protocolVersion, protocolVersion);
    assert.equal(body.result?.serverInfo.name, "margrave");
  }
});
