import { MAX_LIMIT, clampLimit } from "./bm25.ts";
import { findSkills, loadContext } from "./skills.ts";
import type { FindHit } from "./skills.ts";
import type { SourceRecord } from "./store.ts";

export interface Suggestion {
  id: string;
  source: string;
  url: string;
  installCommand: string;
}

const component = /^(?!-)(?!\.{1,2}$)[a-zA-Z0-9._-]+$/u;

function installedRepo(record: SourceRecord): string | undefined {
  if (record.kind !== "git" || record.subpath !== "") return undefined;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/iu.exec(
    record.url as string,
  );
  if (match === null) return undefined;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

async function catalog(task: string, limit: number, installed: Set<string>): Promise<Suggestion[]> {
  try {
    const query = new URLSearchParams({ q: task, limit: String(installed.size > 0 ? MAX_LIMIT : limit) });
    const response = await fetch(`https://skills.sh/api/search?${query}`, { signal: AbortSignal.timeout(2500), redirect: "error" });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("skills" in body) || !Array.isArray(body.skills)) return [];
    const result: Suggestion[] = [];
    const seen = new Set<string>();
    for (const row of body.skills as unknown[]) {
      if (typeof row !== "object" || row === null || !("source" in row) || !("skillId" in row)) continue;
      if (typeof row.source !== "string" || typeof row.skillId !== "string") continue;
      const parts = row.source.split("/");
      if (
        parts.length !== 2 ||
        !/^(?=.{1,39}$)[a-z0-9]+(?:-[a-z0-9]+)*$/iu.test(parts[0] as string) ||
        !component.test(parts[1] as string) ||
        /\.git$/iu.test(parts[1] as string)
      )
        continue;
      if (!component.test(row.skillId)) continue;
      const id = `${row.source}/${row.skillId}`;
      if (seen.has(id.toLowerCase()) || installed.has(row.source.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      result.push({ id, source: row.source, url: `https://skills.sh/${id}`, installCommand: `margrave install ${row.source}` });
      if (result.length === limit) break;
    }
    return result;
  } catch {
    return [];
  }
}

export async function searchSkills(
  task: string,
  limit: unknown,
  explain: boolean,
  skillsSh: boolean,
  allowedSources?: ReadonlySet<string>,
): Promise<{ hits: FindHit[]; noSources: boolean; suggestions: Suggestion[] }> {
  const ctx = await loadContext();
  let hits: FindHit[] = [];
  if (ctx !== null) {
    try {
      hits = findSkills(ctx.db, task, limit, explain, allowedSources);
    } finally {
      ctx.db.close();
    }
  }
  const noSources = ctx === null;
  if (!skillsSh || task.trim() === "" || hits.some((hit) => hit.recommended !== false)) return { hits, noSources, suggestions: [] };
  const installed = new Set<string>();
  for (const source of ctx?.sources ?? []) {
    if (allowedSources !== undefined && !allowedSources.has(source.id)) continue;
    const repo = installedRepo(source);
    if (repo !== undefined) installed.add(repo);
  }
  const suggestions = await catalog(task, clampLimit(limit), installed);
  return { hits, noSources, suggestions };
}

export function formatSuggestions(suggestions: readonly Suggestion[], hosted = false): string {
  if (suggestions.length === 0) return "";
  return `\n\nskills.sh suggestions\n${suggestions.map((s) => `  ${s.url}\n  Manual install: ${s.installCommand}`).join("\n")}${hosted ? "\nAsk the store operator to install a source on this server." : ""}`;
}
