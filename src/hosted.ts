// Hosted MCP: the stdio server's tools over stateless Streamable HTTP. No listener here; a host app mounts handleHostedMcp.
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { HOSTED, createServer } from "./mcp.ts";
import type { ServerOptions } from "./mcp.ts";

export function createHostedServer(options: ServerOptions = {}): McpServer {
  return createServer(HOSTED, options);
}

/** One POST in, one JSON response out. */
export async function handleHostedMcp(req: Request, options: ServerOptions = {}): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
    });
  }
  const server = createHostedServer(options);
  // Clients that still open with an older protocol revision are served statelessly, one request at a time.
  return createMcpHandler(() => server, { legacy: "stateless" }).fetch(req);
}
