// Per-agent setup text. Print only: this module writes nothing.
import { existsSync } from "node:fs";
import path from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { UsageError } from "./store.ts";
import { shellQuote } from "./skills.ts";

export const AGENTS = ["claude", "codex", "bb", "generic"] as const;
export type Agent = (typeof AGENTS)[number];

export const SNIPPET =
  'Installed skills are available on demand through margrave. Before an unfamiliar task, search for a skill. Run `margrave find "<task in plain words>" --category general` or call the find_skills MCP tool. Use a technology such as react as the category for a focused search. Use general for a broad search. Run `margrave load <id>` or call load_skill only for a recommended result.';

export interface WrapInput {
  /** Executable to run: the margrave binary, or node. */
  command: string;
  /** Arguments before `mcp`: empty for the binary, the dist/cli.js path for node. */
  args: string[];
  /** Value of MARGRAVE_HOME, when set. */
  home: string | undefined;
}

function toml(s: string): string {
  return JSON.stringify(s);
}

function shellWords(i: WrapInput): string {
  return [i.command, ...i.args, "mcp"].map(shellQuote).join(" ");
}

function commandLine(i: WrapInput): string {
  const env = i.home === undefined ? "" : ` -e ${shellQuote(`MARGRAVE_HOME=${i.home}`)}`;
  return `claude mcp add margrave${env} -- ${shellWords(i)}`;
}

export function renderWrap(agent: Agent, i: WrapInput): string {
  const snippet = `Add this to the agent's instructions:\n\n${SNIPPET}`;
  switch (agent) {
    case "claude":
      return `Run this command to add the margrave MCP server to Claude Code:\n\n${commandLine(i)}\n\n${snippet}\n`;
    case "codex": {
      const args = [...i.args, "mcp"].map(toml).join(", ");
      const lines = ["[mcp_servers.margrave]", `command = ${toml(i.command)}`, `args = [${args}]`];
      if (i.home !== undefined) lines.push(`env = { MARGRAVE_HOME = ${toml(i.home)} }`);
      return `Add this block to ~/.codex/config.toml:\n\n${lines.join("\n")}\n\n${snippet}\n`;
    }
    case "bb":
      return `bb runs the MCP config of its provider. For a Claude Code thread, run this command:\n\n${commandLine(i)}\n\nFor a Codex thread, use \`margrave wrap codex\`.\n\n${snippet}\n`;
    case "generic": {
      const env = i.home === undefined ? "" : `MARGRAVE_HOME=${shellQuote(i.home)} `;
      return `Start the stdio MCP server with this command:\n\n${env}${shellWords(i)}\n\n${snippet}\n`;
    }
  }
}

/**
 * Absolute paths: the agent's own PATH and nvm state do not matter.
 * In a SEA the command is the binary. libuv realpaths `process.execPath`, so under Homebrew it is a
 * versioned Cellar path that `brew upgrade` deletes; the invoked path keeps the stable `opt` path.
 */
export function defaultWrapInput(sea: boolean = isSea(), invoked: string | undefined = process.argv[1]): WrapInput {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const home = process.env["MARGRAVE_HOME"];
  const resolvedHome = home !== undefined && home !== "" ? path.resolve(home) : undefined;
  if (sea) {
    const command = invoked !== undefined && invoked.includes("/") ? path.resolve(invoked) : process.execPath;
    return { command, args: [], home: resolvedHome };
  }
  // src/ and dist/ are both one level below the repo root.
  return { command: process.execPath, args: [path.resolve(here, "..", "dist", "cli.js")], home: resolvedHome };
}

export function wrap(agentArg: string, input: WrapInput = defaultWrapInput()): { text: string; note: string | null } {
  if (!(AGENTS as readonly string[]).includes(agentArg)) {
    throw new UsageError(`unknown agent "${agentArg}"; use one of: ${AGENTS.join(", ")}`);
  }
  const first = input.args[0];
  const note = first !== undefined && !existsSync(first) ? `note: ${first} does not exist yet; run: pnpm run build` : null;
  return { text: renderWrap(agentArg as Agent, input), note };
}
