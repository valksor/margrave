import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from "@modelcontextprotocol/server";
import { SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import type { Skill, SkillSource } from "@modelcontextprotocol/server/ext/skills";
import { parseFrontmatter } from "./scan.ts";
import { loadContext, readSelectedFileBytes, resolveSkill } from "./skills.ts";
import type { Context } from "./skills.ts";
import { RequestError } from "./store.ts";
import { isRecord } from "./store-files.ts";
import type { IndexEntry } from "./store.ts";
import type { ManifestEntry } from "./scan.ts";

const columns = "id, name, description, source, dir, hash AS revision, manifest, frontmatter";
const prefix = "skill://margrave/";

function uri(entry: IndexEntry, file: string): string {
  const root = `${prefix}${encodeURIComponent(entry.source)}/${encodeURIComponent(entry.revision)}/${encodeURIComponent(entry.name)}`;
  return `${root}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

function entrySkill(entry: IndexEntry, limit?: number): Skill | undefined {
  let fm: unknown;
  const frontmatter = entry.frontmatter;
  try {
    fm = parseFrontmatter(frontmatter);
    JSON.stringify(fm, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError();
      return value;
    });
  } catch {
    return undefined;
  }
  if (!isRecord(fm)) return undefined;
  const fields = fm;
  const name = fields["name"];
  const description = fields["description"];
  if (name !== entry.name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return undefined;
  if (typeof description !== "string" || description.length === 0 || Array.from(description).length > 1024) return undefined;
  if (
    fields["compatibility"] !== undefined &&
    (typeof fields["compatibility"] !== "string" || fields["compatibility"] === "" || Array.from(fields["compatibility"]).length > 500)
  )
    return undefined;
  if (
    fields["metadata"] !== undefined &&
    (!isRecord(fields["metadata"]) || Object.values(fields["metadata"]).some((v) => typeof v !== "string"))
  )
    return undefined;
  const manifest = JSON.parse(entry.manifest) as ManifestEntry[];
  if (!manifest.some((item) => item.path === "SKILL.md") || manifest.some((item) => limit !== undefined && item.size > limit))
    return undefined;
  if (manifest.some((item) => item.path.split("/").some((part) => part === "" || part === "." || part === ".."))) return undefined;
  return {
    uri: uri(entry, "SKILL.md"),
    frontmatter: { ...fields, name, description },
    resources: manifest.map((item) => ({ uri: uri(entry, item.path), digest: item.digest, size: item.size })),
  };
}

function decodeUri(input: string): { source: string; revision: string; name: string; file: string } | undefined {
  if (!input.startsWith(prefix)) return undefined;
  const raw = input.slice(prefix.length).split("/");
  if (raw.length < 4) return undefined;
  let parts: string[];
  let encodedParts: string[];
  try {
    parts = raw.map(decodeURIComponent);
    encodedParts = parts.map(encodeURIComponent);
  } catch {
    return undefined;
  }
  if (parts.some((part, i) => part === "" || part === "." || part === ".." || encodedParts[i] !== raw[i])) return undefined;
  const [source, revision, name, ...file] = parts as [string, string, string, ...string[]];
  if (!/^sha256:[0-9a-f]{64}$/u.test(revision)) return undefined;
  return { source, revision, name, file: file.join("/") };
}

function selected(
  ctx: Context,
  input: string,
  scope: ReadonlySet<string> | undefined,
  limit?: number,
): { entry: IndexEntry; file: string } | undefined {
  const parts = decodeUri(input);
  if (parts === undefined || (scope !== undefined && !scope.has(parts.source))) return undefined;
  const id = `${parts.source}/${parts.name}`;
  const row = ctx.db.prepare(`SELECT ${columns} FROM skills WHERE id = ? AND source = ?`).get(id, parts.source) as IndexEntry | undefined;
  if (row === undefined || entrySkill(row, limit) === undefined) return undefined;
  if (row.revision !== parts.revision) throw new RequestError("skill revision changed; search again");
  if (uri(row, parts.file) !== input || !(JSON.parse(row.manifest) as ManifestEntry[]).some((item) => item.path === parts.file))
    return undefined;
  return { entry: resolveSkill(ctx.db, id, parts.revision, scope, true), file: parts.file };
}

export function attachMargraveSkills(
  server: McpServer,
  scope: ReadonlySet<string> | undefined,
  limit?: number,
  sanitize?: (err: unknown) => string,
): void {
  async function withContext<T>(fn: (ctx: Context | null) => T | Promise<T>): Promise<T> {
    try {
      const ctx = await loadContext();
      return await Promise.resolve()
        .then(() => fn(ctx))
        .finally(() => ctx?.db.close());
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      if (err instanceof RequestError) throw new ProtocolError(ProtocolErrorCode.InvalidParams, err.message);
      if (sanitize !== undefined) throw new Error(sanitize(err), { cause: err });
      throw err;
    }
  }
  const source: SkillSource = {
    list: async ({ cursor }) =>
      withContext((ctx) => {
        let after = "";
        if (cursor !== undefined) {
          after = Buffer.from(cursor, "base64url").toString("utf8");
          if (after === "" || Buffer.from(after).toString("base64url") !== cursor)
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, "invalid cursor");
        }
        const found: { id: string; skill: Skill }[] = [];
        if (ctx !== null) {
          const scopeJson = scope === undefined ? null : JSON.stringify([...scope]);
          let rows: IndexEntry[];
          do {
            rows = ctx.db
              .prepare(
                `SELECT ${columns} FROM skills WHERE id > ? AND (? IS NULL OR source IN (SELECT value FROM json_each(?))) ORDER BY id COLLATE BINARY LIMIT 51`,
              )
              .all(after, scopeJson, scopeJson) as IndexEntry[];
            for (const row of rows) {
              after = row.id;
              const skill = entrySkill(row, limit);
              if (skill !== undefined) found.push({ id: row.id, skill });
              if (found.length === 51) break;
            }
          } while (rows.length === 51 && found.length !== 51);
        }
        const page = found.slice(0, 50);
        return {
          skills: page.map((item) => item.skill),
          ...(found.length > 50 ? { nextCursor: Buffer.from(page[49]!.id).toString("base64url") } : {}),
        };
      }),
    get: async (input) =>
      withContext((ctx) => {
        if (ctx === null) return undefined;
        const item = selected(ctx, input, scope, limit);
        return item?.file === "SKILL.md" ? entrySkill(item.entry, limit) : undefined;
      }),
    read: async (input) =>
      withContext(async (ctx) => {
        if (ctx === null) return undefined;
        const item = selected(ctx, input, scope, limit);
        if (item === undefined) return undefined;
        const git = ctx.sources.some((s) => s.id === item.entry.source && s.kind === "git");
        const bytes = await readSelectedFileBytes(item.entry, item.file, item.entry.revision, git ? "mcp" : undefined, limit);
        try {
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          return { text, ...(item.file.endsWith(".md") ? { mimeType: "text/markdown" } : {}) };
        } catch {
          return { bytes, mimeType: "application/octet-stream" };
        }
      }),
  };
  new SkillsExtension({ source, baseUri: "skill://margrave" }).attach(server);
  // The SDK resource template normalizes URLs before invoking the source. Inspect
  // the original URI so alternate spellings cannot bypass the canonical check.
  server.server.setRequestHandler("resources/read", async (request, ctx) => {
    const resource = await source.read(request.params.uri, ctx);
    if (resource === undefined) throw new ResourceNotFoundError(request.params.uri);
    const content = "text" in resource ? { text: resource.text } : { blob: Buffer.from(resource.bytes).toString("base64") };
    return {
      contents: [{ uri: request.params.uri, ...content, mimeType: resource.mimeType }],
    };
  });
}
