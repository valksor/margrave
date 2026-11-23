// The stdio MCP server reads index.db for each tool call after startup.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  NO_SOURCES_MESSAGE,
  formatFind,
  formatLoad,
  loadContext,
  loadSkill,
  readSelectedFile,
  resolveSkill,
  validateRevision,
} from "./skills.ts";
import type { Context, FindText } from "./skills.ts";
import { RequestError } from "./store.ts";
import type { IndexEntry } from "./store.ts";
import { checkId, migrateStore } from "./sources.ts";
import {
  FIND_GUIDANCE,
  HOSTED_SUGGESTION_GUIDANCE,
  formatClarification,
  formatSuggestions,
  parseFindCategory,
  searchSkills,
} from "./search.ts";
import { attachMargraveSkills } from "./mcp-skills.ts";

export const SERVER_INSTRUCTIONS =
  "This server gives access to installed skills that the agent does not load by default. Before an unfamiliar task, call find_skills with the task in plain words and a category. Use a technology such as react or use general for a broad search. Call load_skill only for a recommended result. Call read_skill_file for a file that the skill names.";

export const FIND_DESCRIPTION =
  "Find recommended installed skills for a task in plain words. Use explain to see matching terms and weak matches. Use load_skill only for a recommended result. If the result contains a clarification question, repeat the search with more details. Set browse to true to skip the match count check.";
export const LOAD_DESCRIPTION =
  "Load the instructions of one skill. Use an id from find_skills. Returns the skill text, its source, and its base directory.";
export const READ_DESCRIPTION =
  "Read one file inside a skill directory. Use a path relative to the base directory that load_skill returns.";

export const HOSTED_LOAD_DESCRIPTION =
  "Load the instructions of one skill. Use an id from find_skills. Returns the skill text, its source, and its file list.";
export const HOSTED_READ_DESCRIPTION = "Read one file inside a skill directory. Use a path from the file list that load_skill returns.";
export const HOSTED_NO_SOURCES_MESSAGE = "no skills are installed on this server";
export const HOSTED_SERVER_ERROR = "the skill store on this server is not available; the server log has details";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

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
  readLimit?: number;
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
  readLimit: 1024 * 1024,
  fail: (err) => {
    if (err instanceof RequestError) return fail(err);
    console.error(err);
    return { content: [{ type: "text", text: HOSTED_SERVER_ERROR }], isError: true };
  },
};

export function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Resolve an id, then close the handle: nothing else needs the database. */
function resolveEntry(
  ctx: Context,
  id: string,
  revision: string | undefined,
  allowedSources: ReadonlySet<string> | undefined,
): { entry: IndexEntry; revision: string; gitDrift: "mcp" | undefined } {
  try {
    const entry = resolveSkill(ctx.db, id, revision, allowedSources, true);
    return {
      entry,
      revision: revision ?? entry.revision,
      gitDrift: ctx.sources.some((s) => s.id === entry.source && s.kind === "git") ? "mcp" : undefined,
    };
  } finally {
    ctx.db.close();
  }
}

async function loadForMcp(
  ctx: Context,
  selected: ReturnType<typeof resolveEntry>,
  showHostPaths: boolean,
  limit?: number,
): Promise<string> {
  const result = await loadSkill(selected.entry, ctx.sources, selected.revision, selected.gitDrift, limit);
  return formatLoad(result, { hostPaths: showHostPaths });
}

function readForMcp(selected: ReturnType<typeof resolveEntry>, file: string, limit?: number): Promise<string> {
  return readSelectedFile(selected.entry, file, selected.revision, selected.gitDrift, limit);
}

export interface ServerOptions {
  allowedSources?: readonly string[];
  skillsSh?: boolean;
}

function validateAllowedSources(value: unknown, invalidMessage: string): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  try {
    if (!Array.isArray(value)) throw new Error();
    for (const id of value) {
      if (typeof id !== "string") throw new Error();
      checkId(id);
    }
    return new Set(value);
  } catch {
    throw new Error(invalidMessage);
  }
}

export function createServer(variant: Variant = LOCAL, options: ServerOptions = {}): McpServer {
  return buildServer(
    variant,
    validateAllowedSources(options.allowedSources, "allowedSources must contain valid source IDs"),
    options.skillsSh === true,
  );
}

const FIND_OUTPUT_SCHEMA = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      revision: z.string(),
      score: z.number(),
      source: z.string(),
      commit: z.string().nullable(),
      license: z.string().nullable(),
      scanVerdict: z.enum(["unknown", "clean", "warn", "critical", "failed"]),
      scanOverridden: z.boolean().nullable(),
      recommended: z.boolean().optional(),
      exact: z.boolean().optional(),
      matchedTerms: z
        .object({
          name: z.array(z.string()),
          description: z.array(z.string()),
          headings: z.array(z.string()),
          body: z.array(z.string()),
        })
        .optional(),
    }),
  ),
  suggestions: z.array(z.object({ id: z.string(), source: z.string() })),
  guidance: z.string(),
  clarification: z.object({ kind: z.literal("refine"), question: z.string(), matchCount: z.number() }).optional(),
});

function registerFind(server: McpServer, variant: Variant, allowedSources: ReadonlySet<string> | undefined, skillsSh: boolean): void {
  server.registerTool(
    "find_skills",
    {
      description:
        FIND_DESCRIPTION +
        (skillsSh
          ? " Supply catalogQuery with a short capability description to request public suggestions after a local miss. Do not include task details. " +
            (variant.showHostPaths
              ? "Offer catalog suggestions to the user. Wait for an explicit request before installation."
              : HOSTED_SUGGESTION_GUIDANCE)
          : ""),
      inputSchema: z.object({
        task: z.string(),
        category: z.string().describe("Technology for installed skills. Use general for a broad search."),
        limit: z.number().int().optional(),
        explain: z.boolean().optional(),
        browse: z.boolean().optional(),
        catalogQuery: z.string().optional(),
      }),
      outputSchema: FIND_OUTPUT_SCHEMA,
    },
    async ({ task, category, limit, explain, catalogQuery, browse }) => {
      try {
        const categoryQuery = parseFindCategory(category);
        if (categoryQuery === undefined) throw new RequestError("Use general or specify a technology with searchable words.");
        const { hits, noSources, suggestions, clarification } = await searchSkills(
          task,
          limit,
          explain === true,
          skillsSh,
          allowedSources,
          catalogQuery,
          browse,
          categoryQuery,
        );
        return {
          ...ok(
            (clarification
              ? formatClarification(clarification, "mcp")
              : noSources
                ? variant.noSources
                : formatFind(hits, variant.findText)) +
              formatSuggestions(suggestions, !variant.showHostPaths) +
              `\n\n${FIND_GUIDANCE}`,
          ),
          structuredContent: {
            results: hits,
            guidance: FIND_GUIDANCE,
            suggestions: suggestions.map(({ id, source }) => ({ id, source })),
            ...(clarification ? { clarification } : {}),
          },
        };
      } catch (err) {
        return variant.fail(err);
      }
    },
  );
}

function buildServer(variant: Variant, allowedSources: ReadonlySet<string> | undefined, skillsSh: boolean): McpServer {
  const server = new McpServer({ name: "margrave", version: version() }, { instructions: SERVER_INSTRUCTIONS });
  attachMargraveSkills(
    server,
    allowedSources,
    variant.readLimit,
    variant.showHostPaths ? undefined : (err) => variant.fail(err).content[0]!.text,
  );

  registerFind(server, variant, allowedSources, skillsSh);

  server.registerTool(
    "load_skill",
    { description: variant.loadDescription, inputSchema: z.object({ id: z.string(), revision: z.string().optional() }) },
    async ({ id, revision }) => {
      try {
        validateRevision(revision);
        const ctx = await loadContext();
        if (ctx === null)
          return variant.fail(new RequestError(revision === undefined ? variant.noSources : "skill revision changed; search again"));
        const selected = resolveEntry(ctx, id, revision, allowedSources);
        return ok(await loadForMcp(ctx, selected, variant.showHostPaths, variant.readLimit));
      } catch (err) {
        return variant.fail(err);
      }
    },
  );

  server.registerTool(
    "read_skill_file",
    { description: variant.readDescription, inputSchema: z.object({ id: z.string(), path: z.string(), revision: z.string().optional() }) },
    async ({ id, path, revision }) => {
      try {
        validateRevision(revision);
        const ctx = await loadContext();
        if (ctx === null)
          return variant.fail(new RequestError(revision === undefined ? variant.noSources : "skill revision changed; search again"));
        const selected = resolveEntry(ctx, id, revision, allowedSources);
        return ok(await readForMcp(selected, path, variant.readLimit));
      } catch (err) {
        return variant.fail(err);
      }
    },
  );

  return server;
}

export async function runMcp(): Promise<void> {
  const value = process.env["MARGRAVE_ALLOWED_SOURCES"];
  const ids = value === undefined ? undefined : value.trim() === "" ? [] : value.split(",").map((id) => id.trim());
  const allowedSources = validateAllowedSources(ids, "MARGRAVE_ALLOWED_SOURCES must contain comma-separated source IDs");
  await migrateStore();
  // Keep the SDK default for older MCP clients.
  serveStdio(() => buildServer(LOCAL, allowedSources, process.env["MARGRAVE_SKILLS_SH"] === "1"));
}
