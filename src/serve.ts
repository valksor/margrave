import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { handleHostedMcp } from "./hosted.ts";
import { listSkillCatalog } from "./source-maintenance.ts";
import { UsageError } from "./store.ts";

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hostname(host: string): string {
  return isIP(host) === 6 ? new URL(`http://[${host}]/`).hostname : host;
}

function loopback(host: string): boolean {
  const normalized = hostname(host);
  return host.startsWith("127.") || normalized === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:/u.test(normalized);
}

function early(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string> = {}, body = ""): void {
  if (!req.complete) res.shouldKeepAlive = false;
  res.writeHead(status, headers).end(body);
}

async function respondMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return early(req, res, 405, { Allow: "POST" });
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const header = value as string | string[];
    headers.set(name, Array.isArray(header) ? header.join(", ") : header);
  }
  const body = Readable.toWeb(req, { strategy: { highWaterMark: 65536, size: (chunk: Buffer) => chunk.byteLength } });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body: body as unknown as ReadableStream,
    signal: req.signal,
    duplex: "half",
  };
  const request = new Request("http://localhost/mcp", init);
  const response = await handleHostedMcp(request);
  if (res.destroyed) {
    await response.body?.cancel();
    return;
  }
  if (!req.complete) res.shouldKeepAlive = false;
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null) res.end();
  else await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream), res);
}

async function respond(req: IncomingMessage, res: ServerResponse, hosts: Set<string>, origins: Set<string>): Promise<void> {
  try {
    // Node supplies the URL for server requests.
    const route = req.url!.split("?", 1)[0];
    if (route === "/api/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return early(req, res, 405, { Allow: "GET, HEAD" });
      return early(
        req,
        res,
        200,
        { "Content-Type": "application/json", "Content-Length": "15" },
        req.method === "HEAD" ? "" : '{"status":"ok"}',
      );
    }
    if (route !== "/mcp" && route !== "/skills.json") return early(req, res, 404);
    const host = req.headersDistinct.host ?? [];
    if (host.length !== 1 || !host[0] || !hosts.has(host[0].toLowerCase())) return early(req, res, 421);
    const origin = req.headersDistinct.origin ?? [];
    if (origin.length > 1 || (origin.length === 1 && !origins.has(origin[0]!))) return early(req, res, 403);
    if (route === "/skills.json") {
      if (req.method !== "GET" && req.method !== "HEAD") return early(req, res, 405, { Allow: "GET, HEAD" });
      const body = JSON.stringify(await listSkillCatalog());
      return early(
        req,
        res,
        200,
        { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), "Cache-Control": "no-store" },
        req.method === "HEAD" ? "" : body,
      );
    }
    await respondMcp(req, res);
  } catch {
    if (res.destroyed) return;
    console.error("margrave: HTTP server error");
    early(req, res, 500);
  }
}

export async function serveHttp(host: string, port: number): Promise<void> {
  const configured = list(process.env["MARGRAVE_ALLOWED_HOSTS"]);
  const origins = new Set(list(process.env["MARGRAVE_ALLOWED_ORIGINS"]));
  if (!loopback(host) && configured.length === 0) throw new UsageError("MARGRAVE_ALLOWED_HOSTS is required for a non-loopback bind");
  const hosts = new Set<string>();
  const server = createServer(
    { requireHostHeader: false, headersTimeout: 10000, requestTimeout: 15000, connectionsCheckingInterval: 1000 },
    (req, res) => {
      void respond(req, res, hosts, origins);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const defaults = ["127.0.0.1", "localhost", "[::1]", hostname(host)];
  const names =
    configured.length > 0
      ? configured
      : defaults.flatMap((name) => {
          const authority = `${name}:${address.port}`;
          return [authority, new URL(`http://${authority}`).host];
        });
  for (const name of names) hosts.add(name.toLowerCase());
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    setTimeout(() => server.closeAllConnections(), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.once("close", () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  });
  process.stdout.write(`margrave HTTP listening on http://${hostname(address.address)}:${address.port}\n`);
}
