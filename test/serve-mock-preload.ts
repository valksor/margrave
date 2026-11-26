import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./hosted.ts" && context.parentURL?.endsWith("/src/serve.ts")) {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export async function handleHostedMcp(request: Request): Promise<Response> {
  const mode = request.headers.get("x-test-mode");
  if (mode === "cookies") {
    const seen = {
      "set-cookie": request.headers.get("set-cookie"),
      accept: request.headers.get("accept"),
      cookie: request.headers.get("cookie"),
    };
    process.stderr.write(`headers:${JSON.stringify(seen)}\n`);
    return new Response(null, { status: 202 });
  }
  if (mode === "read" || mode === "read-error") {
    await request.arrayBuffer();
    if (mode === "read-error") throw new Error("test read error");
    return new Response(null, { status: 202 });
  }
  if (mode === "error") throw new Error("test handler error");
  if (mode === "abort" || mode === "abort-error" || mode === "abort-cancel" || mode === "abort-null") {
    process.stderr.write(`ready:${mode}\n`);
    await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
    if (mode === "abort-error") throw new Error("test abort error");
    if (mode === "abort-null") {
      process.stderr.write("returned:abort-null\n");
      return new Response(null, { status: 202 });
    }
    if (mode === "abort-cancel") {
      const marker = request.headers.get("x-test-marker");
      return new Response(
        new ReadableStream({
          cancel() {
            if (marker !== null) writeFileSync(marker, "canceled");
          },
        }),
      );
    }
    return new Response("cancel this body");
  }
  if (mode === "stream") {
    return new Response(new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array([65])) }));
  }
  return new Response(null, { status: 202 });
}
