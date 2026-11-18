import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handleHostedMcp } from "../src/hosted.ts";
import {
  FIND_DESCRIPTION,
  HOSTED_LOAD_DESCRIPTION,
  HOSTED_NO_SOURCES_MESSAGE,
  HOSTED_READ_DESCRIPTION,
  HOSTED_SERVER_ERROR,
  createServer,
} from "../src/mcp.ts";
import { fakeRipwire, git, runCli, skillMd, tmp, writeSkill } from "./helpers.ts";

interface ToolText {
  isError: boolean;
  text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolText> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") };
}

/** A client of handleHostedMcp. The fetch goes straight to the handler, so no network is used. */
async function connectHosted(t: { after: (fn: () => Promise<void>) => void }): Promise<Client> {
  const client = new Client({ name: "margrave-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp"), { fetch: (url, init) => handleHostedMcp(new Request(url, init)) }),
  );
  t.after(() => client.close());
  return client;
}

/** A client of the stdio server's createServer(), linked over memory. */
async function connectLocal(t: { after: (fn: () => Promise<void>) => void }): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "margrave-test", version: "0.0.0" });
  await client.connect(clientSide);
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
  const lines = found.text.split("\n");
  assert.match(lines[0] ?? "", new RegExp(`^1\\. ${id} `, "u"));
  assert.equal(lines.at(-1), `load: call load_skill with id ${id}`);
  assert.deepEqual(await call(client, "find_skills", { task: "quantum chromodynamics" }), {
    isError: false,
    text: "no match\ntry other words",
  });

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
    assert.match(logged.message, /is not a margrave index; move it aside, then run: margrave reindex/u, tool);
  }
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
