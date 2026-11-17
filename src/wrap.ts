// Per-agent setup text. Print only: this module writes nothing.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./store.ts";
import { shellQuote } from "./skills.ts";

export const AGENTS = ["claude", "codex", "bb", "generic"] as const;
export type Agent = (typeof AGENTS)[number];

export const SNIPPET =
  'Installed skills are available on demand through margrave. Before a task in an unfamiliar domain, tool, or framework, run `margrave find "<task in plain words>"` (or the find_skills MCP tool). Then run `margrave load <id>` (or load_skill) for the best match and follow it.';

export interface WrapInput {
  nodePath: string;
  cliPath: string;
  /** Value of MARGRAVE_HOME, when set. */
  home: string | undefined;
}

function toml(s: string): string {
  return JSON.stringify(s);
}

function commandLine(i: WrapInput): string {
  const env = i.home === undefined ? "" : ` -e ${shellQuote(`MARGRAVE_HOME=${i.home}`)}`;
  return `claude mcp add margrave${env} -- ${shellQuote(i.nodePath)} ${shellQuote(i.cliPath)} mcp`;
}

export function renderWrap(agent: Agent, i: WrapInput): string {
  const snippet = `Add this to the agent's instructions:\n\n${SNIPPET}`;
  switch (agent) {
    case "claude":
      return `Run this command to add the margrave MCP server to Claude Code:\n\n${commandLine(i)}\n\n${snippet}\n`;
    case "codex": {
      const lines = ["[mcp_servers.margrave]", `command = ${toml(i.nodePath)}`, `args = [${toml(i.cliPath)}, "mcp"]`];
      if (i.home !== undefined) lines.push(`env = { MARGRAVE_HOME = ${toml(i.home)} }`);
      return `Add this block to ~/.codex/config.toml:\n\n${lines.join("\n")}\n\n${snippet}\n`;
    }
    case "bb":
      return `bb runs the MCP config of its provider. For a Claude Code thread, run this command:\n\n${commandLine(i)}\n\nFor a Codex thread, use \`margrave wrap codex\`.\n\n${snippet}\n`;
    case "generic": {
      const env = i.home === undefined ? "" : `MARGRAVE_HOME=${shellQuote(i.home)} `;
      return `Start the stdio MCP server with this command:\n\n${env}${shellQuote(i.nodePath)} ${shellQuote(i.cliPath)} mcp\n\n${snippet}\n`;
    }
  }
}

/** Absolute paths: the agent's own PATH and nvm state do not matter. */
export function defaultWrapInput(): WrapInput {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const home = process.env["MARGRAVE_HOME"];
  return {
    nodePath: process.execPath,
    // src/ and dist/ are both one level below the repo root.
    cliPath: path.resolve(here, "..", "dist", "cli.js"),
    home: home !== undefined && home !== "" ? path.resolve(home) : undefined,
  };
}

export function wrap(agentArg: string): { text: string; note: string | null } {
  if (!(AGENTS as readonly string[]).includes(agentArg)) {
    throw new UsageError(`unknown agent "${agentArg}"; use one of: ${AGENTS.join(", ")}`);
  }
  const input = defaultWrapInput();
  const note = existsSync(input.cliPath) ? null : `note: ${input.cliPath} does not exist yet; run: pnpm run build`;
  return { text: renderWrap(agentArg as Agent, input), note };
}
