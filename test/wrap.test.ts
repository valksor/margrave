import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock } from "node:test";
import { UsageError } from "../src/store.ts";
import { AGENTS, SNIPPET, defaultWrapInput, renderWrap, wrap } from "../src/wrap.ts";
import { ROOT, runCli, tmp } from "./helpers.ts";

const input = { command: "/opt/node/bin/node", args: ["/opt/margrave/dist/cli.js"], home: undefined };
const binary = { command: "/opt/homebrew/opt/margrave/libexec/bin/margrave", args: [], home: undefined };
const binaryWithHome = { ...binary, home: "/data/margrave home" };
const withHome = { ...input, home: "/data/margrave home" };

test("the snippet is the exact plan text", () => {
  assert.equal(
    SNIPPET,
    'Installed skills are available on demand through margrave. Before a task in an unfamiliar domain, tool, or framework, run `margrave find "<task in plain words>"` (or the find_skills MCP tool). Run `margrave load <id>` (or load_skill) only for a recommended result.',
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
  assert.ok(
    text.includes("claude mcp add margrave -e 'MARGRAVE_HOME=/data/margrave home' -- /opt/node/bin/node /opt/margrave/dist/cli.js mcp\n"),
  );
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

test("generic: no MARGRAVE_HOME prefix when it is not set", () => {
  const text = renderWrap("generic", input);
  assert.ok(text.includes("\n\n/opt/node/bin/node /opt/margrave/dist/cli.js mcp\n"));
  assert.ok(!text.includes("MARGRAVE_HOME"));
});

test("generic: the command line and the snippet", () => {
  const text = renderWrap("generic", withHome);
  assert.ok(text.includes("MARGRAVE_HOME='/data/margrave home' /opt/node/bin/node /opt/margrave/dist/cli.js mcp\n"));
  assert.ok(text.includes(SNIPPET));
  assert.equal(AGENTS.length, 4);
});

test("binary form: claude, codex and generic print the command and `mcp` with no script argument", () => {
  const claude = renderWrap("claude", binary);
  assert.ok(claude.includes("claude mcp add margrave -- /opt/homebrew/opt/margrave/libexec/bin/margrave mcp\n"));
  assert.ok(
    renderWrap("claude", binaryWithHome).includes(
      "claude mcp add margrave -e 'MARGRAVE_HOME=/data/margrave home' -- /opt/homebrew/opt/margrave/libexec/bin/margrave mcp\n",
    ),
  );
  const codex = renderWrap("codex", binaryWithHome);
  assert.ok(
    codex.includes(
      '[mcp_servers.margrave]\ncommand = "/opt/homebrew/opt/margrave/libexec/bin/margrave"\nargs = ["mcp"]\nenv = { MARGRAVE_HOME = "/data/margrave home" }\n',
    ),
  );
  assert.ok(renderWrap("generic", binary).includes("\n\n/opt/homebrew/opt/margrave/libexec/bin/margrave mcp\n"));
  assert.ok(
    renderWrap("generic", binaryWithHome).includes(
      "MARGRAVE_HOME='/data/margrave home' /opt/homebrew/opt/margrave/libexec/bin/margrave mcp\n",
    ),
  );
});

test("defaultWrapInput uses the absolute node and dist/cli.js, and passes MARGRAVE_HOME when set", async () => {
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const d = defaultWrapInput();
  assert.equal(d.command, process.execPath);
  assert.deepEqual(d.args, [path.join(ROOT, "dist", "cli.js")]);
  assert.equal(d.home, home);
  assert.deepEqual(defaultWrapInput(false), d);
});

test("defaultWrapInput in a SEA uses the invoked path, and process.execPath when it has no slash", () => {
  const stable = "/opt/homebrew/opt/margrave/libexec/bin/margrave";
  assert.deepEqual(defaultWrapInput(true, stable), { command: stable, args: [], home: defaultWrapInput().home });
  assert.equal(defaultWrapInput(true, "margrave").command, process.execPath);
  assert.deepEqual(defaultWrapInput(true, "margrave").args, []);
  // An explicit `undefined` takes the default, process.argv[1], which is the invoked path.
  assert.equal(defaultWrapInput(true, undefined).command, path.resolve(process.argv[1] as string));
  assert.equal(defaultWrapInput(true, "./bin/margrave").command, path.resolve("./bin/margrave"));
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

test("defaultWrapInput has no home when MARGRAVE_HOME is unset or empty", (t) => {
  const prev = process.env["MARGRAVE_HOME"];
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  delete process.env["MARGRAVE_HOME"];
  assert.equal(defaultWrapInput().home, undefined);
  process.env["MARGRAVE_HOME"] = "";
  assert.equal(defaultWrapInput().home, undefined);
});

test("wrap rejects an unknown agent, and adds a build note only when dist/cli.js is missing", (t) => {
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.throws(
    () => wrap("emacs"),
    (e: unknown) => e instanceof UsageError && /unknown agent "emacs"/u.test(e.message),
  );

  const exists = mock.method(fs, "existsSync", () => false);
  syncBuiltinESMExports();
  const missing = wrap("claude");
  assert.equal(missing.note, `note: ${path.join(ROOT, "dist", "cli.js")} does not exist yet; run: pnpm run build`);
  assert.ok(missing.text.includes(SNIPPET));

  exists.mock.mockImplementation(() => true);
  assert.equal(wrap("claude").note, null);
});

test("wrap adds no build note for the binary form, even when no file exists", (t) => {
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  mock.method(fs, "existsSync", () => false);
  syncBuiltinESMExports();
  const r = wrap("claude", binary);
  assert.equal(r.note, null);
  assert.ok(r.text.includes("/opt/homebrew/opt/margrave/libexec/bin/margrave mcp\n"));
});
