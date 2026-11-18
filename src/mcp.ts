// stdio MCP server. Read-only: it opens index.db on every call.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NO_SOURCES_MESSAGE, findSkills, formatFind, formatLoad, loadContext, loadSkill, readSkillFile, resolveSkill } from "./skills.ts";
import type { Context, FindText } from "./skills.ts";
import { RequestError } from "./store.ts";
import type { IndexEntry } from "./store.ts";

export const SERVER_INSTRUCTIONS =
  "This server gives access to installed skills that the agent does not load by default. Before a task in an unfamiliar domain, tool, or framework, call find_skills with the task in plain words. Call load_skill with the best id. Call read_skill_file for a file that the skill names.";

export const FIND_DESCRIPTION =
  "Find installed skills for a task. Give the task in plain words. Returns ranked skill ids with descriptions. Use load_skill to read one.";
export const LOAD_DESCRIPTION =
  "Load the instructions of one skill. Use an id from find_skills. Returns the skill text, its source, and its base directory.";
export const READ_DESCRIPTION =
  "Read one file inside a skill directory. Use a path relative to the base directory that load_skill returns.";

export const HOSTED_LOAD_DESCRIPTION =
  "Load the instructions of one skill. Use an id from find_skills. Returns the skill text, its source, and its file list.";
export const HOSTED_READ_DESCRIPTION = "Read one file inside a skill directory. Use a path from the file list that load_skill returns.";
export const HOSTED_NO_SOURCES_MESSAGE = "no skills are installed on this server";
export const HOSTED_SERVER_ERROR = "the skill store on this server is not available; the server log has details";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

/** What differs between the stdio server and the hosted one. The tools themselves are registered once, in createServer. */
export interface Variant {
  loadDescription: string;
  readDescription: string;
  noSources: string;
  /** undefined = the formatFind default. */
  findText: FindText | undefined;
  showHostPaths: boolean;
  fail: (err: unknown) => ToolResult;
}

const LOCAL: Variant = {
  loadDescription: LOAD_DESCRIPTION,
  readDescription: READ_DESCRIPTION,
  noSources: NO_SOURCES_MESSAGE,
  findText: undefined,
  showHostPaths: true,
  fail,
};

/** A remote client sees only the text of a RequestError. Any other error goes to the server log. */
export const HOSTED: Variant = {
  loadDescription: HOSTED_LOAD_DESCRIPTION,
  readDescription: HOSTED_READ_DESCRIPTION,
  noSources: HOSTED_NO_SOURCES_MESSAGE,
  findText: { loadHint: (id) => `load: call load_skill with id ${id}`, noMatch: "no match\ntry other words" },
  showHostPaths: false,
  fail: (err) => {
    if (err instanceof RequestError) return fail(err);
    console.error(err);
    return { content: [{ type: "text", text: HOSTED_SERVER_ERROR }], isError: true };
  },
};

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Resolve an id, then close the handle: nothing else needs the database. */
function resolveEntry(ctx: Context, id: string): IndexEntry {
  try {
    return resolveSkill(ctx.db, id);
  } finally {
    ctx.db.close();
  }
}

export function createServer(variant: Variant = LOCAL): McpServer {
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
        if (ctx === null) return ok(variant.noSources);
        try {
          return ok(formatFind(findSkills(ctx.db, task, limit), variant.findText));
        } finally {
          ctx.db.close();
        }
      } catch (err) {
        return variant.fail(err);
      }
    },
  );

  server.registerTool("load_skill", { description: variant.loadDescription, inputSchema: { id: z.string() } }, async ({ id }) => {
    try {
      const ctx = await loadContext();
      if (ctx === null) return variant.fail(new RequestError(variant.noSources));
      const entry = resolveEntry(ctx, id);
      return ok(formatLoad(await loadSkill(entry, ctx.sources), { hostPaths: variant.showHostPaths }));
    } catch (err) {
      return variant.fail(err);
    }
  });

  server.registerTool(
    "read_skill_file",
    { description: variant.readDescription, inputSchema: { id: z.string(), path: z.string() } },
    async ({ id, path }) => {
      try {
        const ctx = await loadContext();
        if (ctx === null) return variant.fail(new RequestError(variant.noSources));
        const entry = resolveEntry(ctx, id);
        return ok(await readSkillFile(entry.dir, path));
      } catch (err) {
        return variant.fail(err);
      }
    },
  );

  return server;
}

export async function runMcp(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
