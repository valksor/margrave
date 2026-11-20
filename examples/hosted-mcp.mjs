import { createHash, timingSafeEqual } from "node:crypto";

const BODY_LIMIT = 256 * 1024;
const REQUEST_LIMIT = 60;
const WINDOW_MS = 60_000;
const CONCURRENCY_LIMIT = 8;

// Mount this handler on a private listener behind a TLS-terminating proxy.
export function createHostedMcpApp({ principals, allowedHosts, allowedOrigins, handle, now = Date.now }) {
  const accounts = principals.map(({ token, allowedSources }) => ({
    digest: createHash("sha256").update(token).digest(),
    allowedSources: [...allowedSources],
    requests: [],
  }));
  const hosts = new Set(allowedHosts);
  const origins = new Set(allowedOrigins);
  let admitted = 0;

  return async (request) => {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer (\S+)$/u.exec(authorization);
    const digest = createHash("sha256")
      .update(match?.[1] ?? "")
      .digest();
    let principal;
    let matches = 0;
    for (const account of accounts) {
      if (timingSafeEqual(digest, account.digest) && match !== null) {
        principal = account;
        matches++;
      }
    }
    if (principal === undefined || matches !== 1) return new Response("Authentication required", { status: 401 });
    const origin = request.headers.get("origin");
    if (!hosts.has(request.headers.get("host")) || (origin !== null && !origins.has(origin))) {
      return new Response("Request origin is not allowed", { status: 403 });
    }
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > BODY_LIMIT)) {
      return new Response("Request body is too large", { status: 413 });
    }
    const time = now();
    principal.requests = principal.requests.filter((started) => time - started < WINDOW_MS);
    if (principal.requests.length >= REQUEST_LIMIT) return new Response("Request limit reached", { status: 429 });
    if (admitted >= CONCURRENCY_LIMIT) return new Response("Hosted MCP is busy", { status: 503 });
    principal.requests.push(time);
    admitted++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      admitted--;
    };
    try {
      const chunks = [];
      let size = 0;
      if (request.body !== null) {
        const reader = request.body.getReader();
        const abortBody = () => {
          void reader.cancel(request.signal.reason).catch(() => {});
        };
        request.signal.addEventListener("abort", abortBody, { once: true });
        try {
          if (request.signal.aborted) throw request.signal.reason;
          while (true) {
            const { done, value } = await reader.read();
            if (request.signal.aborted) throw request.signal.reason;
            if (done) break;
            size += value.byteLength;
            if (size > BODY_LIMIT) {
              void reader.cancel().catch(() => {});
              release();
              return new Response("Request body is too large", { status: 413 });
            }
            chunks.push(value);
          }
        } finally {
          request.signal.removeEventListener("abort", abortBody);
          reader.releaseLock();
        }
      }
      if (request.signal.aborted) throw request.signal.reason;
      const body = request.body === null ? undefined : Buffer.concat(chunks, size);
      const buffered = new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal });
      const response = await handle(buffered, { allowedSources: [...principal.allowedSources] });
      if (response.body === null) {
        release();
        return response;
      }
      const reader = response.body.getReader();
      const abort = () => {
        void reader.cancel().catch(() => {});
        finish();
      };
      const finish = () => {
        request.signal.removeEventListener("abort", abort);
        release();
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              finish();
              controller.close();
            } else controller.enqueue(value);
          } catch (error) {
            finish();
            controller.error(error);
          }
        },
        async cancel(reason) {
          finish();
          await reader.cancel(reason);
        },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      release();
      throw error;
    }
  };
}
