#!/usr/bin/env node
// margrave CLI. Exit codes: 0 ok, 1 error, 2 usage.
import { parseArgs } from "node:util";
import { runMcp } from "./mcp.ts";
import {
  NO_SOURCES_MESSAGE,
  clean,
  findSkills,
  formatFind,
  formatLoad,
  loadContext,
  loadSkill,
  readSkillFile,
  resolveSkill,
} from "./skills.ts";
import { installSource, listSources, reindexAll, removeSource, updateSources } from "./sources.ts";
import type { Ctx } from "./sources.ts";
import { MargraveError, UsageError } from "./store.ts";
import { wrap } from "./wrap.ts";

const USAGE = `usage: margrave <command>

  install <spec> [--ref R] [--allow-unsafe]   add a skill source (owner/repo[/sub/path], git URL, or local path)
  update [source] [--allow-unsafe]            refresh one source, or all
  remove <source>                             remove a source (never deletes a local directory)
  list [--skills] [--json]                    list sources, and with --skills every skill
  find "<task>" [--limit N] [--json]          rank installed skills for a task
  load <id> [--json]                          print one skill
  load <id> --file <path>                     print one file inside a skill directory
  reindex                                     rescan all sources
  mcp                                         run the stdio MCP server
  wrap <claude|codex|bb|generic>              print setup text for an agent
`;

type Parsed = ReturnType<typeof parseArgs>;

function parse(args: string[], options: NonNullable<Parameters<typeof parseArgs>[0]>["options"]): Parsed {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function positionals(p: Parsed, min: number, max: number, what: string): string[] {
  if (p.positionals.length < min || p.positionals.length > max) throw new UsageError(`expected ${what}`);
  return p.positionals;
}

const out = (s: string): void => {
  process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
};
const err = (s: string): void => {
  process.stderr.write(s.endsWith("\n") ? s : `${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

const short = (sha: string | null): string => (sha === null ? "-" : sha.slice(0, 7));

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError("missing command");
  if (command === "--help" || command === "-h" || command === "help") {
    out(USAGE);
    return;
  }
  const ctx = (allowUnsafe: boolean): Ctx => ({ log: err, allowUnsafe });

  switch (command) {
    case "install": {
      const p = parse(rest, { ref: { type: "string" }, "allow-unsafe": { type: "boolean" } });
      const [spec] = positionals(p, 1, 1, "install <spec>");
      const r = await installSource(
        spec ?? "",
        typeof p.values["ref"] === "string" ? p.values["ref"] : null,
        ctx(p.values["allow-unsafe"] === true),
      );
      out(`installed ${clean(r.id)} (${r.skills.length} skills)`);
      for (const s of r.skills) out(`  ${clean(s)}`);
      return;
    }
    case "update": {
      const p = parse(rest, { "allow-unsafe": { type: "boolean" } });
      const [source] = positionals(p, 0, 1, "update [source]");
      const { results, errors } = await updateSources(source ?? null, ctx(p.values["allow-unsafe"] === true));
      for (const r of results) {
        out(r.kind === "git" ? `${clean(r.id)}: ${short(r.oldCommit)} → ${short(r.newCommit)}` : `${clean(r.id)}: reindexed`);
        for (const id of r.added) out(`  added: ${clean(id)}`);
        for (const id of r.changed) out(`  changed: ${clean(id)}`);
        for (const id of r.removed) out(`  removed: ${clean(id)}`);
      }
      if (results.length === 0 && errors.length === 0) out(NO_SOURCES_MESSAGE);
      for (const e of errors) err(`margrave: update ${clean(e.id)} failed: ${e.message}`);
      if (errors.length > 0) process.exitCode = 1;
      return;
    }
    case "remove": {
      const p = parse(rest, {});
      const [source] = positionals(p, 1, 1, "remove <source>");
      const rec = await removeSource(source ?? "");
      out(rec.kind === "local" ? `unregistered ${clean(rec.id)} (the directory was not touched)` : `removed ${clean(rec.id)}`);
      return;
    }
    case "list": {
      const p = parse(rest, { skills: { type: "boolean" }, json: { type: "boolean" } });
      positionals(p, 0, 0, "list [--skills] [--json]");
      const { sources, index } = await listSources();
      const withSkills = p.values["skills"] === true;
      if (p.values["json"] === true) {
        json({
          sources,
          ...(withSkills ? { skills: (index?.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description })) } : {}),
        });
        return;
      }
      if (sources.length === 0) {
        out(NO_SOURCES_MESSAGE);
        return;
      }
      for (const s of sources) {
        out(`${clean(s.id)}  ${s.kind}  ref=${s.ref === null ? "-" : clean(s.ref)}  commit=${short(s.commit)}  skills=${s.skillCount}`);
        if (withSkills) {
          for (const e of index?.skills ?? []) {
            if (e.source === s.id) out(`  ${clean(e.id)}: ${clean(e.description)}`);
          }
        }
      }
      return;
    }
    case "find": {
      const p = parse(rest, { limit: { type: "string" }, json: { type: "boolean" } });
      const words = positionals(p, 1, Number.POSITIVE_INFINITY, 'find "<task>"');
      const task = words.join(" ");
      const c = await loadContext();
      if (c === null) {
        if (p.values["json"] === true) json({ task, results: [], message: NO_SOURCES_MESSAGE });
        else out(NO_SOURCES_MESSAGE);
        return;
      }
      const hits = findSkills(c.index, task, p.values["limit"]);
      if (p.values["json"] === true) json({ task, results: hits });
      else out(formatFind(hits));
      return;
    }
    case "load": {
      const p = parse(rest, { json: { type: "boolean" }, file: { type: "string" } });
      const [id] = positionals(p, 1, 1, "load <id>");
      const c = await loadContext();
      if (c === null) throw new MargraveError(NO_SOURCES_MESSAGE);
      const entry = resolveSkill(c.index, id ?? "");
      if (typeof p.values["file"] === "string") {
        const content = await readSkillFile(entry.dir, p.values["file"]);
        if (p.values["json"] === true) json({ id: entry.id, path: p.values["file"], content });
        else process.stdout.write(content);
        return;
      }
      const r = await loadSkill(entry, c.sources);
      // Written as is: the body is the payload, so no newline is added.
      if (p.values["json"] === true) json(r);
      else process.stdout.write(formatLoad(r));
      return;
    }
    case "reindex": {
      positionals(parse(rest, {}), 0, 0, "reindex");
      const r = await reindexAll(ctx(false));
      out(`reindexed ${r.skills} skills from ${r.sources} sources`);
      return;
    }
    case "mcp": {
      positionals(parse(rest, {}), 0, 0, "mcp");
      await runMcp();
      return;
    }
    case "wrap": {
      const p = parse(rest, {});
      const [agent] = positionals(p, 1, 1, "wrap <claude|codex|bb|generic>");
      const w = wrap(agent ?? "");
      if (w.note !== null) err(w.note);
      out(w.text);
      return;
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

// A closed pipe (`margrave load x | head`) is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
});

run(process.argv.slice(2)).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof UsageError) {
    err(`margrave: ${msg}\nrun: margrave --help`);
    process.exitCode = 2;
  } else {
    err(`margrave: ${msg}`);
    process.exitCode = 1;
  }
});
