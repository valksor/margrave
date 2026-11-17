import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FIND_DESCRIPTION, LOAD_DESCRIPTION, READ_DESCRIPTION, SERVER_INSTRUCTIONS } from "../src/mcp.ts";
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
  const client = new Client({ name: "margrave-test", version: "0.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });

  // server instructions and tool descriptions are the exact plan texts
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  assert.equal(
    SERVER_INSTRUCTIONS,
    "This server gives access to installed skills that the agent does not load by default. Before a task in an unfamiliar domain, tool, or framework, call find_skills with the task in plain words. Call load_skill with the best id. Call read_skill_file for a file that the skill names.",
  );
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((x) => x.name).sort(), ["find_skills", "load_skill", "read_skill_file"]);
  const desc = Object.fromEntries(tools.map((x) => [x.name, x.description]));
  assert.equal(desc["find_skills"], "Find installed skills for a task. Give the task in plain words. Returns ranked skill ids with descriptions. Use load_skill to read one.");
  assert.equal(desc["load_skill"], "Load the instructions of one skill. Use an id from find_skills. Returns the skill text, its source, and its base directory.");
  assert.equal(desc["read_skill_file"], "Read one file inside a skill directory. Use a path relative to the base directory that load_skill returns.");
  assert.equal(FIND_DESCRIPTION, desc["find_skills"]);
  assert.equal(LOAD_DESCRIPTION, desc["load_skill"]);
  assert.equal(READ_DESCRIPTION, desc["read_skill_file"]);

  // no sources: find returns the hint text, not a tool error
  const noSources = await call(client, "find_skills", { task: "anything" });
  assert.equal(noSources.isError, false);
  assert.equal(noSources.text, "no skill sources installed; run: margrave install <owner/repo|path>");

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

  // the server is read-only: only the three tools exist
  assert.equal(tools.length, 3);
});
