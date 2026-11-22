import {
  call,
  connectHosted,
  hostedUseHome as useHome,
  CLI,
  catalogRecords,
  fakeRipwire,
  git,
  leaveHotJournal,
  makeRepo,
  newEntry,
  runCli,
  seedIndex,
  skillMd,
  stdioTestEnv,
  tmp,
  writeSkill,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS, createMcpHandler } from "@modelcontextprotocol/server";
import type { ReadResourceRequest, ServerContext } from "@modelcontextprotocol/server";
import { handleHostedMcp } from "../src/hosted.ts";
import { attachMargraveSkills } from "../src/mcp-skills.ts";
import {
  FIND_DESCRIPTION,
  HOSTED_LOAD_DESCRIPTION,
  HOSTED_NO_SOURCES_MESSAGE,
  HOSTED_READ_DESCRIPTION,
  HOSTED_SERVER_ERROR,
  createServer,
} from "../src/mcp.ts";
import type { ServerOptions } from "../src/mcp.ts";

const examplePath = "../examples/hosted-mcp.mjs";

test("MCP Skills direct hosted scopes reads and distinguishes local and Git drift", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const home = await useHome(t);
  const commit = "a".repeat(40);
  const snapshot = `${commit}-${"b".repeat(16)}`;
  const localDir = path.join(home, "local", "local-skill");
  const gitDir = path.join(home, "snapshots", "git-source", snapshot, "git-skill");
  const otherDir = path.join(home, "other", "other-skill");
  const fixtures = [
    { source: "other-source", name: "other-skill", dir: otherDir },
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
      dir: fixture.source === "git-source" ? "git-skill" : fixture.dir,
      revision: digest,
      frontmatter,
      manifest: JSON.stringify([{ path: "SKILL.md", digest, size: bytes.length }]),
    });
  }
  await seedIndex(rows, [
    {
      id: "other-source",
      kind: "local",
      spec: path.dirname(otherDir),
      path: path.dirname(otherDir),
      subpath: "",
      ref: null,
      commit: null,
      installedAt: "now",
    },
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
  const uri = (index: number): string => {
    const row = rows[index]!;
    return `skill://margrave/${row.source}/${encodeURIComponent(row.revision)}/${row.name}/SKILL.md`;
  };
  const localUri = uri(1);
  const gitUri = uri(2);
  const scoped = await connectHosted(t, ["local-source"]);
  const both = await connectHosted(t, ["local-source", "git-source"]);
  const skills = new SkillsClient(scoped);
  const prepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")?.value as DatabaseSync["prepare"];
  const selectedSql =
    "SELECT id, name, description, source, dir, hash AS revision, manifest, frontmatter FROM skills WHERE id = ? AND source = ?";
  let selectedQueries = 0;
  const spy = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === selectedSql) selectedQueries++;
    return prepare.call(this, sql);
  });
  t.after(() => spy.mock.restore());
  assert.equal((await skills.get(localUri)).skill.uri, localUri);
  assert.deepEqual((await scoped.readResource({ uri: localUri })).contents, [
    { uri: localUri, mimeType: "text/markdown", text: "---\nname: local-skill\ndescription: valid\n---\noriginal\n" },
  ]);
  assert.deepEqual((await both.readResource({ uri: gitUri })).contents, [
    { uri: gitUri, mimeType: "text/markdown", text: "---\nname: git-skill\ndescription: valid\n---\noriginal\n" },
  ]);
  assert.ok(selectedQueries > 0);
  const before = selectedQueries;
  await assert.rejects(skills.get(gitUri), { code: -32602, message: `No skill is served at ${gitUri}` });
  await assert.rejects(scoped.readResource({ uri: gitUri }), { code: -32602, message: `Resource not found: ${gitUri}` });
  assert.equal(selectedQueries, before);
  for (const [dir, resource, message] of [
    [localDir, localUri, "skill files changed since indexing; ask the store operator to run margrave reindex, then search again"],
    [gitDir, gitUri, "skill files differ from the accepted revision. Ask the store operator to restore a verified copy"],
  ] as const) {
    const name = dir === localDir ? "local-skill" : "git-skill";
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: valid\n---\nchanged!\n`);
    await assert.rejects(both.readResource({ uri: resource }), { code: -32602, message });
  }
  await rm(gitDir, { recursive: true });
  await assert.rejects(both.readResource({ uri: gitUri }), {
    code: -32602,
    message: "skill files differ from the accepted revision. Ask the store operator to restore a verified copy",
  });
});

test("MCP Skills direct sanitizes catalog errors and preserves request errors", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const home = await useHome(t);
  const dir = path.join(home, "fixture");
  await mkdir(dir);
  const frontmatter = "name: example\ndescription: valid";
  const bytes = Buffer.from(`---\n${frontmatter}\n---\nbody\n`);
  await writeFile(path.join(dir, "SKILL.md"), bytes);
  const revision = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await seedIndex([
    {
      ...newEntry("source", "example"),
      dir,
      revision,
      frontmatter,
      manifest: JSON.stringify([{ path: "SKILL.md", digest: revision, size: bytes.length }]),
    },
  ]);
  const server = new McpServer({ name: "direct-test", version: "1" });
  type ReadHandler = (request: ReadResourceRequest, context: ServerContext) => Promise<unknown>;
  let readHandler: ReadHandler | undefined;
  const protocol = server.server as unknown as { setRequestHandler: (...args: unknown[]) => void };
  const register = protocol.setRequestHandler;
  const registration = mock.method(protocol, "setRequestHandler", function (this: typeof protocol, ...args: unknown[]) {
    if (args[0] === "resources/read") readHandler = args[1] as ReadHandler;
    return register.apply(this, args);
  });
  attachMargraveSkills(server, undefined, undefined, () => "safe catalog failure");
  registration.mock.restore();
  assert.ok(readHandler);
  const handler = createMcpHandler(
    () => {
      const instance = new McpServer({ name: "direct-test", version: "1" });
      attachMargraveSkills(instance, undefined, undefined, () => "safe catalog failure");
      return instance;
    },
    { legacy: "reject" },
  );
  const client = new Client({ name: "direct-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init)) }),
  );
  t.after(() => client.close());
  const uri = `skill://margrave/source/${encodeURIComponent(revision)}/example/SKILL.md`;
  const original = new Error("private catalog failure");
  const prepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")?.value as DatabaseSync["prepare"];
  const fault = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "SELECT id, record FROM sources ORDER BY position") throw original;
    return prepare.call(this, sql);
  });
  t.after(() => fault.mock.restore());
  await assert.rejects(
    readHandler({ method: "resources/read", params: { uri } }, {} as ServerContext),
    (err: unknown) => err instanceof Error && err.message === "safe catalog failure" && err.cause === original,
  );
  await assert.rejects(client.readResource({ uri }), /safe catalog failure/u);
  fault.mock.restore();
  const skills = new SkillsClient(client);
  await assert.rejects(skills.list({ cursor: "!" }), { code: -32602, message: "invalid cursor" });
  const stale = uri.replace(encodeURIComponent(revision), encodeURIComponent(`sha256:${"0".repeat(64)}`));
  for (const request of [() => skills.get(stale), () => client.readResource({ uri: stale })]) {
    await assert.rejects(request(), { code: -32602, message: "skill revision changed; search again" });
  }
});

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
      env: stdioTestEnv({ PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: moved }),
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

test("hosted tools share stdio schemas and advertise hosted behavior", async (t) => {
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
  const localDesc = Object.fromEntries(localTools.map((x) => [x.name, x.description]));
  assert.equal(localDesc["find_skills"], FIND_DESCRIPTION);
  assert.ok(desc["find_skills"]?.startsWith(FIND_DESCRIPTION));
  assert.match(
    desc["find_skills"] ?? "",
    /Supply catalogQuery with a short capability description to request public suggestions after a local miss\./u,
  );
  assert.equal(desc["load_skill"], HOSTED_LOAD_DESCRIPTION);
  assert.equal(desc["read_skill_file"], HOSTED_READ_DESCRIPTION);
  assert.equal(
    HOSTED_LOAD_DESCRIPTION,
    "Load the instructions of one skill. Use an id from find_skills. Returns the skill text, its source, and its file list.",
  );
  assert.equal(HOSTED_READ_DESCRIPTION, "Read one file inside a skill directory. Use a path from the file list that load_skill returns.");
});

test("hosted: with no sources, find_skills answers and the other two tools fail, all with the hosted text", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  await useHome(t);
  const client = await connectHosted(t);
  const skills = new SkillsClient(client);
  assert.deepEqual((await skills.list()).skills, []);
  const missing = `skill://margrave/source/sha256%3A${"0".repeat(64)}/skill/SKILL.md`;
  await assert.rejects(skills.get(missing));
  await assert.rejects(client.readResource({ uri: missing }));
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
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "references/x.md" }), {
    isError: true,
    text: "skill files changed since indexing; ask the store operator to run margrave reindex, then search again",
  });
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
    assert.equal(r.text, "file is not in the selected skill revision", bad);
  }
  const unknown = await call(client, "load_skill", { id: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /no skill "nope"/u);
  noPaths(unknown.text);
  await writeFile(path.join(skillDir, "references", "x.md"), "updated reference\n");
  const update = await runCli(["update", sourceId], { home, fakeBin });
  assert.equal(update.code, 0, update.stderr);
  for (const tool of ["load_skill", "read_skill_file"]) {
    const args = { id, ...(tool === "read_skill_file" ? { path: "references/x.md" } : {}) };
    assert.match((await call(client, tool, { ...args, revision })).text, /skill revision changed/u);
    assert.equal((await call(client, tool, args)).isError, false);
  }
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
  assert.equal(r.text, "file is not in the selected skill revision");
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
    assert.equal(r.text, "file is not in the selected skill revision");
  }
  const source = id.split("/")[0]!;
  const snapshotSkill = path.join(home, "sources", source, "SKILL.md");
  await writeFile(snapshotSkill, skillMd("root-skill", "Changed"));
  const drift = "skill files differ from the accepted revision. Ask the store operator to restore a verified copy";
  assert.deepEqual(await call(client, "load_skill", { id }), { isError: true, text: drift });
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "SKILL.md" }), { isError: true, text: drift });
  await rm(path.join(home, "sources", source), { force: true });
  const record = catalogRecords(home).find((s) => s.id === source)!;
  await rm(path.join(home, "snapshots", source, record.snapshot!), { recursive: true });
  assert.deepEqual(await call(client, "load_skill", { id }), { isError: true, text: drift });
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "SKILL.md" }), { isError: true, text: drift });
});

test("hosted: a store failure returns a generic error and logs the cause", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
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
  await assert.rejects(new SkillsClient(client).list(), /the skill store on this server is not available/u);

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
  let optionsRead = false;
  const options: ServerOptions = {
    get allowedSources() {
      optionsRead = true;
      return [];
    },
  };
  for (const method of ["GET", "DELETE"]) {
    const res = await handleHostedMcp(new Request("http://test/mcp", { method }), options);
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("Allow"), "POST", method);
    assert.equal(res.headers.get("Content-Type"), "application/json", method);
    assert.deepEqual(await res.json(), { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, method);
    assert.equal(optionsRead, false, method);
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

test("hosted serves a client that opens with an older protocol revision", async (t) => {
  const home = await useHome(t);
  const dir = await tmp("mg-legacy-");
  const skill = await writeSkill(dir, "legacy-fixture", "Legacy fixture capability");
  await writeFile(path.join(skill, "reference.txt"), "legacy reference\n");
  const installed = await runCli(["install", dir], { home, fakeBin: await fakeRipwire() });
  assert.equal(installed.code, 0, installed.stderr);
  const id = `${/^installed (\S+)/u.exec(installed.stdout)?.[1] ?? ""}/legacy-fixture`;
  for (const protocolVersion of SUPPORTED_PROTOCOL_VERSIONS) {
    let nextId = 0;
    const request = async (method: string, params: object) => {
      const requestId = ++nextId;
      const response = await handleHostedMcp(
        new Request("http://test/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": protocolVersion,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
        }),
      );
      assert.equal(response.status, 200);
      const text = await response.text();
      // A stateless 2025 answer may come as one server-sent event: take its data line.
      const json = text.trimStart().startsWith("{") ? text : (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6);
      const body = JSON.parse(json) as {
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
      assert.equal(body.id, requestId);
      assert.equal(body.error, undefined);
      return body.result;
    };
    const body = await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(body?.protocolVersion, protocolVersion);
    assert.equal(body?.serverInfo?.name, "margrave");
    const tools = await request("tools/list", {});
    assert.deepEqual(tools?.tools?.map((tool) => tool.name).sort(), ["find_skills", "load_skill", "read_skill_file"]);
    for (const [name, args, expected] of [
      ["find_skills", { task: "legacy fixture capability" }, id],
      ["load_skill", { id }, "Body of legacy-fixture"],
      ["read_skill_file", { id, path: "reference.txt" }, "legacy reference\n"],
    ] as const) {
      const result = await request("tools/call", { name, arguments: args });
      assert.notEqual(result?.isError, true);
      assert.ok(result?.content?.some((item) => item.type === "text" && item.text.includes(expected)));
    }
  }
});

test("production integration admits authenticated requests and enforces limits", async () => {
  const { createHostedMcpApp } = await import(examplePath);
  let calls = 0;
  let clock = 0;
  const releases: (() => void)[] = [];
  let hold = false;
  const app = createHostedMcpApp({
    principals: [
      { token: "dummy-one", allowedSources: ["one"] },
      { token: "dummy-two", allowedSources: ["two"] },
    ],
    allowedHosts: ["example.test"],
    allowedOrigins: ["https://browser.test"],
    now: () => clock,
    handle: async (_request: Request, options: { allowedSources: string[] }) => {
      calls++;
      if (hold)
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      return Response.json(options);
    },
  });
  const request = (headers: Record<string, string> = {}, body = "{}") =>
    new Request("http://private/mcp", {
      method: "POST",
      headers: { host: "example.test", authorization: "Bearer dummy-one", ...headers },
      body,
    });
  assert.deepEqual(await (await app(request())).json(), { allowedSources: ["one"] });
  assert.deepEqual(await (await app(request({ authorization: "Bearer dummy-two", origin: "https://browser.test" }))).json(), {
    allowedSources: ["two"],
  });
  for (const [headers, status, message] of [
    [{ authorization: "Bearer wrong" }, 401, "Authentication required"],
    [{ host: "bad.test" }, 403, "Request origin is not allowed"],
    [{ origin: "https://bad.test" }, 403, "Request origin is not allowed"],
    [{ "content-length": "262145" }, 413, "Request body is too large"],
  ] as const) {
    const response = await app(request(headers));
    assert.equal(response.status, status);
    assert.equal(await response.text(), message);
  }
  assert.equal((await app(request({}, "x".repeat(262145)))).status, 413);
  assert.equal(calls, 2);
  const exact = await app(request({}, "x".repeat(262144)));
  assert.equal(exact.status, 200);
  await exact.arrayBuffer();
  hold = true;
  const pending = Array.from({ length: 8 }, () => app(request()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app(request())).status, 503);
  hold = false;
  for (const release of releases) release();
  for (const response of await Promise.all(pending)) await response.arrayBuffer();
  const after = await app(request());
  assert.equal(after.status, 200);
  await after.arrayBuffer();
  clock = 60_001;
  for (let i = 0; i < 60; i++) {
    const response = await app(request());
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const throttled = await app(request());
  assert.equal(throttled.status, 429);
  assert.equal(await throttled.text(), "Request limit reached");
  const other = await app(request({ authorization: "Bearer dummy-two" }));
  assert.equal(other.status, 200);
  await other.arrayBuffer();
  clock += 60_001;
  const renewed = await app(request());
  assert.equal(renewed.status, 200);
  await renewed.arrayBuffer();
});

test("production integration passes authenticated source scope to hosted MCP", async (t) => {
  const { createHostedMcpApp } = await import(examplePath);
  const home = await useHome(t);
  const fakeBin = await fakeRipwire();
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const dir = await tmp("mg-example-scope-");
    await writeSkill(dir, "shared", "Shared terraform modules");
    const installed = await runCli(["install", dir], { home, fakeBin });
    assert.equal(installed.code, 0, installed.stderr);
    ids.push(/^installed (\S+)/u.exec(installed.stdout)?.[1] ?? "");
  }
  const app = createHostedMcpApp({
    principals: [{ token: "dummy", allowedSources: [ids[0]] }],
    allowedHosts: ["test"],
    allowedOrigins: [],
    handle: handleHostedMcp,
  });
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp"), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", "test");
        headers.set("authorization", "Bearer dummy");
        return app(new Request(url, { ...init, headers }));
      },
    }),
  );
  t.after(() => client.close());
  assert.equal((await call(client, "load_skill", { id: `${ids[0]}/shared`, allowedSources: ids })).isError, false);
  assert.equal((await call(client, "load_skill", { id: `${ids[1]}/shared`, allowedSources: ids })).isError, true);
});

test("hosted file reads enforce the limit and detect growth after stat", async (t) => {
  const { open, appendFile } = await import("node:fs/promises");
  const { readSkillFileBytes } = await import("../src/skill-files.ts");
  const home = await useHome(t);
  const dir = await tmp("mg-hosted-limit-");
  const skill = await writeSkill(dir, "large", "Large skill fixture");
  const limit = 1024 * 1024;
  await writeFile(path.join(skill, "exact.txt"), Buffer.alloc(limit, 120));
  await writeFile(path.join(skill, "large.txt"), Buffer.alloc(limit + 1, 120));
  const installed = await runCli(["install", dir], { home, fakeBin: await fakeRipwire() });
  assert.equal(installed.code, 0, installed.stderr);
  const id = `${/^installed (\S+)/u.exec(installed.stdout)?.[1] ?? ""}/large`;
  const client = await connectHosted(t);
  assert.equal((await call(client, "read_skill_file", { id, path: "exact.txt" })).text.length, limit);
  assert.deepEqual(await call(client, "read_skill_file", { id, path: "large.txt" }), {
    isError: true,
    text: "skill file exceeds the hosted size limit",
  });
  await writeFile(path.join(skill, "SKILL.md"), Buffer.alloc(limit + 1, 120));
  assert.deepEqual(await call(client, "load_skill", { id }), { isError: true, text: "skill file exceeds the hosted size limit" });
  const probe = await open(path.join(skill, "exact.txt"));
  const prototype = Object.getPrototypeOf(probe) as typeof probe;
  await probe.close();
  const original = Object.getOwnPropertyDescriptor(prototype, "stat")!.value as typeof probe.stat;
  const stat = mock.method(prototype, "stat", async function (this: typeof probe, ...args: Parameters<typeof original>) {
    const result = await original.apply(this, args);
    await appendFile(path.join(skill, "exact.txt"), "x");
    return result;
  });
  await assert.rejects(readSkillFileBytes(skill, "exact.txt", false, false, limit), {
    message: "skill file exceeds the hosted size limit",
  });
  stat.mock.restore();
});

test("production integration retains admission through streamed responses", async () => {
  const { createHostedMcpApp } = await import(examplePath);
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const app = createHostedMcpApp({
    principals: [{ token: "dummy", allowedSources: [] }],
    allowedHosts: ["test"],
    allowedOrigins: [],
    handle: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controllers.push(controller);
            },
          }),
          { status: 201, headers: { "x-test": "value" } },
        ),
      ),
  });
  const request = (signal?: AbortSignal) =>
    new Request("http://test/mcp", { method: "POST", headers: { host: "test", authorization: "Bearer dummy" }, signal });
  const responses = await Promise.all(Array.from({ length: 8 }, () => app(request())));
  assert.equal(responses[0].status, 201);
  assert.equal(responses[0].headers.get("x-test"), "value");
  assert.equal((await app(request())).status, 503);
  await responses[0].body!.cancel();
  const replacement = await app(request());
  assert.equal(replacement.status, 201);
  controllers[1]!.close();
  await responses[1].arrayBuffer();
  const aborter = new AbortController();
  const aborted = await app(request(aborter.signal));
  assert.equal(aborted.status, 201);
  aborter.abort();
  const last = await app(request());
  assert.equal(last.status, 201);
  await Promise.all([...responses.slice(2), replacement, aborted, last].map((r) => r.body!.cancel()));
  const ambiguous = createHostedMcpApp({
    principals: [
      { token: "dummy", allowedSources: [] },
      { token: "dummy", allowedSources: [] },
    ],
    allowedHosts: ["test"],
    allowedOrigins: [],
    handle: handleHostedMcp,
  });
  const denied = await ambiguous(request());
  assert.equal(denied.status, 401);
  assert.equal(await denied.text(), "Authentication required");
});

test("production integration times out an unfinished incoming body", async (t) => {
  const { createHostedMcpApp } = await import(examplePath);
  let deadline = new AbortController();
  const timeout = t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  let calls = 0;
  const app = createHostedMcpApp({
    principals: [{ token: "dummy", allowedSources: [] }],
    allowedHosts: ["test"],
    allowedOrigins: [],
    handle: () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  for (let i = 0; i < 8; i++) {
    deadline = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = app(
      new Request("http://test/mcp", {
        method: "POST",
        headers: { host: "test", authorization: "Bearer dummy" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    assert.equal(timeout.mock.callCount(), i + 1);
    assert.deepEqual(timeout.mock.calls[i]?.arguments, [10_000]);
    deadline.abort(new DOMException("deadline", "TimeoutError"));
    const response = await pending;
    assert.equal(response.status, 408);
    assert.equal(await response.text(), "Request body timed out");
    assert.equal(cancelled, true);
    assert.equal(calls, 0);
  }
  timeout.mock.restore();
  const next = await app(
    new Request("http://test/mcp", { method: "POST", headers: { host: "test", authorization: "Bearer dummy" }, body: "{}" }),
  );
  assert.equal(next.status, 204);
  assert.equal(calls, 1);
});

test("production integration releases admission when an incoming body aborts", async () => {
  const { createHostedMcpApp } = await import(examplePath);
  let calls = 0;
  let cancelled = false;
  const app = createHostedMcpApp({
    principals: [{ token: "dummy", allowedSources: [] }],
    allowedHosts: ["test"],
    allowedOrigins: [],
    handle: () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  const aborter = new AbortController();
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://test/mcp", {
    method: "POST",
    headers: { host: "test", authorization: "Bearer dummy" },
    body,
    signal: aborter.signal,
    duplex: "half",
  } as RequestInit);
  const pending = app(request);
  const reason = new Error("dummy abort");
  aborter.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(cancelled, true);
  assert.equal(calls, 0);
  const next = await app(new Request("http://test/mcp", { method: "POST", headers: { host: "test", authorization: "Bearer dummy" } }));
  assert.equal(next.status, 204);
  assert.equal(calls, 1);
});

test("production integration preserves client abort when the body deadline also fires", async (t) => {
  const { createHostedMcpApp } = await import(examplePath);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const client = new AbortController();
  let cancelled = false;
  let calls = 0;
  const app = createHostedMcpApp({
    principals: [{ token: "dummy", allowedSources: [] }],
    allowedHosts: ["test"],
    allowedOrigins: [],
    handle: () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  const pending = app(
    new Request("http://test/mcp", {
      method: "POST",
      headers: { host: "test", authorization: "Bearer dummy" },
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      signal: client.signal,
      duplex: "half",
    } as RequestInit),
  );
  deadline.abort(new DOMException("deadline", "TimeoutError"));
  const reason = new Error("dummy abort");
  client.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(cancelled, true);
  assert.equal(calls, 0);
});

test("production integration releases admission after handler failure", async () => {
  const { createHostedMcpApp } = await import(examplePath);
  let fails = true;
  const app = createHostedMcpApp({
    principals: [{ token: "dummy", allowedSources: [] }],
    allowedHosts: ["test"],
    allowedOrigins: [],
    handle: () => {
      if (fails) return Promise.reject(new Error("dummy failure"));
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  const request = () => new Request("http://test/mcp", { method: "POST", headers: { host: "test", authorization: "Bearer dummy" } });
  for (let i = 0; i < 8; i++) await assert.rejects(app(request()), /dummy failure/u);
  fails = false;
  assert.equal((await app(request())).status, 204);
});

test("hosted Skills extension scopes manifests and enforces the read bound", async (t) => {
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const home = await useHome(t);
  const fakeBin = await fakeRipwire();
  const dir = await tmp("mg-hosted-skills-");
  const toolkit = await writeSkill(dir, "toolkit", "A hosted toolkit");
  await mkdir(path.join(toolkit, "assets"));
  await writeFile(path.join(toolkit, "assets", "sample.bin"), Buffer.from([0, 255, 1]));
  const oversized = await writeSkill(dir, "oversized", "A large hosted fixture");
  await writeFile(path.join(oversized, "large.bin"), Buffer.alloc(1024 * 1024 + 1));
  const installed = await runCli(["install", dir], { home, fakeBin });
  assert.equal(installed.code, 0, installed.stderr);
  const source = /^installed (\S+)/mu.exec(installed.stdout)![1]!;
  const client = await connectHosted(t, [source]);
  const skills = new SkillsClient(client);
  await assert.rejects(
    skills.list({ cursor: "!" }),
    (err: unknown) => typeof err === "object" && err !== null && "code" in err && err.code === -32602,
  );
  const listing = await skills.list();
  assert.deepEqual(
    listing.skills.map((s) => s.frontmatter.name),
    ["toolkit"],
  );
  const entry = listing.skills[0]!;
  assert.deepEqual([...(await skills.read(entry, "assets/sample.bin")).bytes], [0, 255, 1]);
  const denied = new SkillsClient(await connectHosted(t, []));
  assert.deepEqual((await denied.list()).skills, []);
  await assert.rejects(denied.get(entry.uri));
  await assert.rejects(denied.read(entry, "assets/sample.bin"));
  await writeFile(path.join(toolkit, "assets", "sample.bin"), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(skills.read(entry, "assets/sample.bin"), /hosted size limit/u);
});

test("recommendation provenance reflects verified and overridden Git scans", async (t) => {
  const home = await useHome(t);
  const fakeBin = await fakeRipwire();
  const cleanRepo = await makeRepo();
  const unsafeRepo = await makeRepo();
  await writeFile(
    path.join(unsafeRepo.dir, "skills", "react-perf", "SKILL.md"),
    skillMd("react-perf", "Optimize React", "FAKE-CRIT EXFILTRATE:net-exfil\n"),
  );
  await git(unsafeRepo.dir, "add", "-A");
  await git(unsafeRepo.dir, "commit", "-q", "-m", "critical fixture");
  const clean = await runCli(["install", cleanRepo.url], { home, fakeBin });
  assert.equal(clean.code, 0, clean.stderr);
  const unsafe = await runCli(["install", unsafeRepo.url, "--allow-unsafe"], { home, fakeBin });
  assert.equal(unsafe.code, 0, unsafe.stderr);
  const cleanId = /^installed (\S+)/mu.exec(clean.stdout)![1]!;
  const unsafeId = /^installed (\S+)/mu.exec(unsafe.stdout)![1]!;
  const client = await connectHosted(t);
  const { SkillsClient } = await import("@modelcontextprotocol/client/ext/skills");
  const skills = new SkillsClient(client);
  const gitEntry = (await skills.list()).skills.find((entry) => entry.uri.includes(cleanId))!;
  assert.equal((await skills.read(gitEntry)).verified, true);
  const response = await client.callTool({ name: "find_skills", arguments: { task: "react-perf" } });
  const results = (
    response.structuredContent as { results: { source: string; commit: string; scanVerdict: string; scanOverridden: boolean }[] }
  ).results;
  assert.deepEqual(
    results
      .map(({ source, scanVerdict, scanOverridden }) => ({ source, scanVerdict, scanOverridden }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    [
      { source: cleanId, scanVerdict: "clean", scanOverridden: false },
      { source: unsafeId, scanVerdict: "critical", scanOverridden: true },
    ].sort((a, b) => a.source.localeCompare(b.source)),
  );
  assert.ok(results.every((hit) => /^[0-9a-f]{40}$/u.test(hit.commit)));
  assert.equal(JSON.stringify(response.structuredContent).includes(cleanRepo.dir), false);
  const cli = await runCli(["find", "react-perf", "--json"], { home, fakeBin });
  assert.deepEqual((JSON.parse(cli.stdout) as { results: unknown }).results, results);
});
