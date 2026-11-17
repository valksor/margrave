import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AGENTS, SNIPPET, defaultWrapInput, renderWrap } from "../src/wrap.ts";
import { ROOT, runCli, tmp } from "./helpers.ts";

const input = { nodePath: "/opt/node/bin/node", cliPath: "/opt/margrave/dist/cli.js", home: undefined };
const withHome = { ...input, home: "/data/margrave home" };

test("the snippet is the exact plan text", () => {
  assert.equal(
    SNIPPET,
    'Installed skills are available on demand through margrave. Before a task in an unfamiliar domain, tool, or framework, run `margrave find "<task in plain words>"` (or the find_skills MCP tool). Then run `margrave load <id>` (or load_skill) for the best match and follow it.',
  );
});

test("claude: mcp add command with absolute paths, then the snippet", () => {
  const text = renderWrap("claude", input);
  assert.ok(text.includes("claude mcp add margrave -- /opt/node/bin/node /opt/margrave/dist/cli.js mcp\n"));
  assert.ok(text.includes(SNIPPET));
  assert.ok(!text.includes("MARGRAVE_HOME"));
  assert.ok(text.indexOf("claude mcp add") < text.indexOf(SNIPPET));
});

test("claude: -e MARGRAVE_HOME is added, and quoted, when set", () => {
  const text = renderWrap("claude", withHome);
  assert.ok(text.includes("claude mcp add margrave -e 'MARGRAVE_HOME=/data/margrave home' -- /opt/node/bin/node /opt/margrave/dist/cli.js mcp\n"));
});

test("codex: a [mcp_servers.margrave] TOML block, env only when MARGRAVE_HOME is set", () => {
  const plain = renderWrap("codex", input);
  assert.ok(plain.includes('[mcp_servers.margrave]\ncommand = "/opt/node/bin/node"\nargs = ["/opt/margrave/dist/cli.js", "mcp"]\n'));
  assert.ok(!plain.includes("env ="));
  assert.ok(plain.includes(SNIPPET));
  const withEnv = renderWrap("codex", withHome);
  assert.ok(withEnv.includes('env = { MARGRAVE_HOME = "/data/margrave home" }'));
});

test("bb: the claude command line plus a note that bb runs the provider's MCP config", () => {
  const text = renderWrap("bb", input);
  assert.ok(text.includes("claude mcp add margrave -- /opt/node/bin/node /opt/margrave/dist/cli.js mcp\n"));
  assert.match(text, /bb runs the MCP config of its provider/u);
  assert.ok(text.includes(SNIPPET));
});

test("generic: the command line and the snippet", () => {
  const text = renderWrap("generic", withHome);
  assert.ok(text.includes("MARGRAVE_HOME='/data/margrave home' /opt/node/bin/node /opt/margrave/dist/cli.js mcp\n"));
  assert.ok(text.includes(SNIPPET));
  assert.equal(AGENTS.length, 4);
});

test("defaultWrapInput uses the absolute node and dist/cli.js, and passes MARGRAVE_HOME when set", async () => {
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const d = defaultWrapInput();
  assert.equal(d.nodePath, process.execPath);
  assert.equal(d.cliPath, path.join(ROOT, "dist", "cli.js"));
  assert.equal(d.home, home);
});

test("`margrave wrap` prints, exits 0, and writes nothing into MARGRAVE_HOME", async () => {
  const home = await tmp("mg-home-");
  for (const agent of AGENTS) {
    const r = await runCli(["wrap", agent], { home });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(SNIPPET));
    assert.ok(r.stdout.includes(`MARGRAVE_HOME`), `${agent} passes MARGRAVE_HOME`);
    assert.ok(r.stdout.includes(path.join(ROOT, "dist", "cli.js")));
  }
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(home), []);
});
