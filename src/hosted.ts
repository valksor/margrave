// Hosted MCP: the stdio server's tools over stateless Streamable HTTP. No listener here; a host app mounts handleHostedMcp.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { HOSTED, createServer } from "./mcp.ts";
import type { ServerOptions } from "./mcp.ts";

export function createHostedServer(options: ServerOptions = {}): McpServer {
  return createServer(HOSTED, options);
}

/** One POST in, one JSON response out. Each request gets its own server and transport. */
export async function handleHostedMcp(req: Request, options: ServerOptions = {}): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
    });
  }
  const server = createHostedServer(options);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
