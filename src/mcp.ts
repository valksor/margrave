// stdio MCP server. Read-only: it re-reads index.json on every call.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NO_SOURCES_MESSAGE, findSkills, formatFind, formatLoad, loadContext, loadSkill, readSkillFile, resolveSkill } from "./skills.ts";

export const SERVER_INSTRUCTIONS =
  "This server gives access to installed skills that the agent does not load by default. Before a task in an unfamiliar domain, tool, or framework, call find_skills with the task in plain words. Call load_skill with the best id. Call read_skill_file for a file that the skill names.";

export const FIND_DESCRIPTION =
  "Find installed skills for a task. Give the task in plain words. Returns ranked skill ids with descriptions. Use load_skill to read one.";
export const LOAD_DESCRIPTION =
  "Load the instructions of one skill. Use an id from find_skills. Returns the skill text, its source, and its base directory.";
export const READ_DESCRIPTION =
  "Read one file inside a skill directory. Use a path relative to the base directory that load_skill returns.";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "margrave", version: version() }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "find_skills",
    {
      description: FIND_DESCRIPTION,
      inputSchema: { task: z.string(), limit: z.number().int().optional() },
    },
    async ({ task, limit }) => {
      try {
        const ctx = await loadContext();
        if (ctx === null) return ok(NO_SOURCES_MESSAGE);
        return ok(formatFind(findSkills(ctx.index, task, limit)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool("load_skill", { description: LOAD_DESCRIPTION, inputSchema: { id: z.string() } }, async ({ id }) => {
    try {
      const ctx = await loadContext();
      if (ctx === null) return fail(new Error(NO_SOURCES_MESSAGE));
      const entry = resolveSkill(ctx.index, id);
      return ok(formatLoad(await loadSkill(entry, ctx.sources)));
    } catch (err) {
      return fail(err);
    }
  });

  server.registerTool(
    "read_skill_file",
    { description: READ_DESCRIPTION, inputSchema: { id: z.string(), path: z.string() } },
    async ({ id, path }) => {
      try {
        const ctx = await loadContext();
        if (ctx === null) return fail(new Error(NO_SOURCES_MESSAGE));
        const entry = resolveSkill(ctx.index, id);
        return ok(await readSkillFile(entry.dir, path));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

export async function runMcp(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
