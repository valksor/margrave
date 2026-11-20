#!/usr/bin/env node
// margrave CLI. Exit codes: 0 ok, 1 error, 2 usage.
import { parseArgs } from "node:util";
import { exportLock, readLock, restoreLock } from "./lock.ts";
import { runMcp, version } from "./mcp.ts";
import {
  NO_SOURCES_MESSAGE,
  clean,
  cleanBlock,
  formatFind,
  formatLoad,
  loadContext,
  loadSkill,
  readSelectedFile,
  resolveSkill,
  validateRevision,
} from "./skills.ts";
import { checkSources, installSource, listSources, migrateStore, reindexAll, removeSource, updateSources } from "./sources.ts";
import type { Ctx } from "./sources.ts";
import { MargraveError, RequestError, UsageError } from "./store.ts";
import { wrap } from "./wrap.ts";
import { formatSuggestions, searchSkills } from "./search.ts";

const USAGE = `usage: margrave <command>

  install <spec> [--ref R] [--allow-unsafe]   add a skill source (owner/repo[/sub/path], git URL, or local path)
  update [source] [--ref R] [--allow-unsafe]  refresh one source, or all
  check [source] [--json]                     check for updates and installed-file drift
  lock export [--source <id> ...]             export installed Git sources
  lock restore <file>                         restore locked Git sources
  remove <source>                             remove a source (never deletes a local directory)
  list [--skills] [--json]                    list sources, and with --skills every skill
  find "<task>" [--limit N] [--json] [--explain]  rank installed skills for a task
  load <id> [--json] [--revision <hash>]      print one skill
  load <id> --file <path> [--revision <hash>] print one file inside a skill directory
  reindex                                     rescan all sources
  migrate                                    upgrade a v0.2.1 store
  mcp                                         run the stdio MCP server
  wrap <claude|codex|bb|generic>              print setup text for an agent
  version                                     print the version
`;

type Parsed = ReturnType<typeof parseArgs>;

function parse(args: string[], options: NonNullable<Parameters<typeof parseArgs>[0]>["options"]): Parsed {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

/** With `min` of 1 or more, the first element exists: callers cast it. */
function positionals(p: Parsed, min: number, max: number, what: string): string[] {
  if (p.positionals.length < min || p.positionals.length > max) throw new UsageError(`expected ${what}`);
  return p.positionals;
}

const out = (s: string): void => {
  process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
};
const err = (s: string): void => {
  const t = cleanBlock(s);
  process.stderr.write(t.endsWith("\n") ? t : `${t}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

const short = (sha: string | null): string => (sha === null ? "-" : sha.slice(0, 7));

async function updateCommand(rest: string[]): Promise<void> {
  const ctx = (allowUnsafe: boolean): Ctx => ({ log: err, allowUnsafe });
  const p = parse(rest, { ref: { type: "string" }, "allow-unsafe": { type: "boolean" } });
  if (p.values["ref"] !== undefined && p.positionals.length !== 1) throw new UsageError("update --ref requires one Git source");
  const [source] = positionals(p, 0, 1, "update [source]");
  const { results, errors } = await updateSources(
    source ?? null,
    ctx(p.values["allow-unsafe"] === true),
    typeof p.values["ref"] === "string" ? p.values["ref"] : null,
  );
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

async function checkCommand(rest: string[]): Promise<void> {
  const p = parse(rest, { json: { type: "boolean" } });
  const [source] = positionals(p, 0, 1, "check [source] [--json]");
  const results = await checkSources(source ?? null);
  if (results.length === 0) out(NO_SOURCES_MESSAGE);
  else if (p.values["json"] === true) {
    json(
      results.map(({ id, updateAvailable, added, changed, removed, error }) => ({
        id: clean(id),
        updateAvailable,
        added: added.map(clean),
        changed: changed.map(clean),
        removed: removed.map(clean),
        error: error === null ? null : cleanBlock(error),
      })),
    );
  } else {
    for (const r of results) {
      const drift = r.added.length + r.changed.length + r.removed.length > 0;
      if (r.updateAvailable) out(`${clean(r.id)}: update available (${short(r.oldCommit)} → ${short(r.newCommit)})`);
      if (drift) {
        out(`${clean(r.id)}: installed files changed`);
        for (const id of r.added) out(`  added: ${clean(id)}`);
        for (const id of r.changed) out(`  changed: ${clean(id)}`);
        for (const id of r.removed) out(`  removed: ${clean(id)}`);
      }
      if (r.error !== null) err(`${clean(r.id)}: ${r.error}`);
      if (!r.updateAvailable && !drift && r.error === null) out(`${clean(r.id)}: current`);
    }
  }
  if (results.some((r) => r.updateAvailable || r.added.length + r.changed.length + r.removed.length > 0 || r.error !== null))
    process.exitCode = 1;
  return;
}

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError("missing command");
  if (command === "--help" || command === "-h" || command === "help") {
    out(USAGE);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    out(`margrave ${version()}`);
    return;
  }
  const ctx = (allowUnsafe: boolean): Ctx => ({ log: err, allowUnsafe });

  switch (command) {
    case "lock": {
      const [action, ...args] = rest;
      if (action === "export") {
        const p = parse(args, { source: { type: "string", multiple: true } });
        positionals(p, 0, 0, "lock export [--source <id> ...]");
        json(await exportLock((p.values["source"] as string[] | undefined) ?? []));
        return;
      }
      if (action === "restore") {
        const [file] = positionals(parse(args, {}), 1, 1, "lock restore <file>");
        await restoreLock(await readLock(file as string), ctx(false), out);
        return;
      }
      throw new UsageError("expected lock export or lock restore");
    }
    case "install": {
      const p = parse(rest, { ref: { type: "string" }, "allow-unsafe": { type: "boolean" } });
      const [spec] = positionals(p, 1, 1, "install <spec>");
      const r = await installSource(
        spec as string,
        typeof p.values["ref"] === "string" ? p.values["ref"] : null,
        ctx(p.values["allow-unsafe"] === true),
      );
      out(`installed ${clean(r.id)} (${r.skills.length} skills)`);
      for (const s of r.skills) out(`  ${clean(s)}`);
      return;
    }
    case "update":
      return updateCommand(rest);
    case "check":
      return checkCommand(rest);
    case "remove": {
      const p = parse(rest, {});
      const [source] = positionals(p, 1, 1, "remove <source>");
      const rec = await removeSource(source as string);
      out(rec.kind === "local" ? `unregistered ${clean(rec.id)} (the directory was not touched)` : `removed ${clean(rec.id)}`);
      return;
    }
    case "list": {
      const p = parse(rest, { skills: { type: "boolean" }, json: { type: "boolean" } });
      positionals(p, 0, 0, "list [--skills] [--json]");
      const withSkills = p.values["skills"] === true;
      const { sources, skills } = await listSources(withSkills);
      if (p.values["json"] === true) {
        json({
          sources,
          ...(withSkills ? { skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description })) } : {}),
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
          for (const e of skills) {
            if (e.source === s.id) out(`  ${clean(e.id)}: ${clean(e.description)}`);
          }
        }
      }
      return;
    }
    case "find": {
      const p = parse(rest, { limit: { type: "string" }, json: { type: "boolean" }, explain: { type: "boolean" } });
      const words = positionals(p, 1, Number.POSITIVE_INFINITY, 'find "<task>"');
      const task = words.join(" ");
      const { hits, noSources, suggestions } = await searchSkills(
        task,
        p.values["limit"],
        p.values["explain"] === true,
        process.env["MARGRAVE_SKILLS_SH"] === "1",
      );
      if (p.values["json"] === true)
        json({
          task,
          results: hits,
          ...(noSources ? { message: NO_SOURCES_MESSAGE } : {}),
          ...(suggestions.length > 0 ? { suggestions } : {}),
        });
      else out((noSources ? NO_SOURCES_MESSAGE : formatFind(hits)) + formatSuggestions(suggestions));
      return;
    }
    case "load": {
      const p = parse(rest, { json: { type: "boolean" }, file: { type: "string" }, revision: { type: "string" } });
      const revision = typeof p.values["revision"] === "string" ? p.values["revision"] : undefined;
      validateRevision(revision);
      const [id] = positionals(p, 1, 1, "load <id>");
      const c = await loadContext();
      if (c === null)
        throw revision === undefined ? new MargraveError(NO_SOURCES_MESSAGE) : new RequestError("skill revision changed; search again");
      let entry;
      try {
        entry = resolveSkill(c.db, id as string, revision);
      } finally {
        c.db.close();
      }
      if (typeof p.values["file"] === "string") {
        const content = await readSelectedFile(entry, p.values["file"], revision);
        if (p.values["json"] === true) json({ id: entry.id, path: p.values["file"], content });
        else process.stdout.write(content);
        return;
      }
      const r = await loadSkill(entry, c.sources, revision);
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
    case "migrate": {
      positionals(parse(rest, {}), 0, 0, "migrate");
      out((await migrateStore()) ? "store upgraded" : "store is current");
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
      const w = wrap(agent as string);
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
  // Any other stdout error must stay loud. A test could emit an error event with another code through a
  // preload, but that test would cost more than it checks, so this line is left out of the coverage count.
  /* node:coverage ignore next */
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
