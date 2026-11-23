import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { connect } from "node:net";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  call,
  catalogSetup,
  cliSnapshot,
  copyLegacyStoreFixture,
  head,
  makeRepo,
  NO_VENDORED_PRELOAD,
  ROOT,
  runCli,
  sourceId,
  tmp,
  writeSkill,
} from "./helpers.ts";

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function raw(port: number, text: string): Promise<string> {
  const socket = connect(port, "127.0.0.1");
  socket.setTimeout(5000, () => socket.destroy());
  socket.write(text);
  let result = "";
  for await (const chunk of socket) result += chunk.toString();
  return result;
}

async function startServer(
  t: { after: (fn: () => Promise<void>) => void },
  env: Record<string, string>,
  mockHandler = false,
  onStderr: (text: string) => void = () => {},
  options: { extraArgs?: string[]; preload?: string } = {},
): Promise<{ base: string; stop: (signal?: NodeJS.Signals) => Promise<void> }> {
  const child = spawn(
    process.execPath,
    [
      ...(options.preload ? ["--import", options.preload] : []),
      ...(mockHandler ? ["--import", "./test/serve-mock-preload.ts"] : []),
      "--import",
      "./test/no-vendored-ripwire.ts",
      "src/cli.ts",
      "serve",
      "--http",
      "--port",
      "0",
      ...(options.extraArgs ?? []),
    ],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    onStderr(stderr);
  });
  const stop = async (signal: NodeJS.Signals = "SIGTERM"): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      assert.deepEqual(await exited, [0, null]);
    } finally {
      clearTimeout(timer);
    }
  };
  t.after(() => stop());
  const ready = new Promise<string>((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline !== -1) resolve(output.slice(0, newline));
    });
  });
  const line = await Promise.race([
    ready,
    exited.then(() => {
      throw new Error(`server exited before readiness: ${stderr}`);
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("server readiness timed out")), 10000);
      timer.unref();
    }),
  ]);
  assert.match(line, /^margrave HTTP listening on http:\/\//u);
  return { base: line.replace("margrave HTTP listening on ", ""), stop };
}

test("HTTP skill catalog matches CLI output and checks access", async (t) => {
  const { home, fakeBin, dir, id, mg } = await catalogSetup();
  const repo = await makeRepo();
  t.after(async () => {
    await Promise.all([home, fakeBin, dir, repo.dir].map((item) => rm(item, { recursive: true, force: true })));
  });
  await writeSkill(dir, "alpha", "Café catalog skill");
  assert.equal((await mg(["update", id])).code, 0);
  const installed = await mg(["install", repo.url, "--ref", "main"]);
  assert.equal(installed.code, 0, installed.stderr);
  const gitId = sourceId(installed);
  const commit = await head(repo.dir);
  const expected = {
    sources: [
      { id, kind: "local", ref: null, commit: null, skillCount: 1 },
      { id: gitId, kind: "git", ref: "refs/heads/main", commit, skillCount: 3 },
    ],
    skills: [
      { id: `${id}/alpha`, name: "alpha", description: "Café catalog skill", source: id },
      {
        id: `${gitId}/docker-compose`,
        name: "docker-compose",
        description: "Write Docker Compose files for local services",
        source: gitId,
      },
      {
        id: `${gitId}/postgres-tuning`,
        name: "postgres-tuning",
        description: "Tune PostgreSQL queries, indexes, and vacuum settings",
        source: gitId,
      },
      { id: `${gitId}/react-perf`, name: "react-perf", description: "Optimize React rendering performance and bundle size", source: gitId },
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  const cli = await mg(["list", "--skills", "--json"]);
  assert.equal(cli.code, 0, cli.stderr);
  const before = await cliSnapshot(home);
  const inventory = await readdir(home);
  const bytes = await readFile(path.join(home, "index.db"));
  const { base } = await startServer(t, {
    MARGRAVE_HOME: home,
    PATH: `${fakeBin}:${process.env["PATH"]}`,
    MARGRAVE_ALLOWED_HOSTS: "",
    MARGRAVE_ALLOWED_ORIGINS: "https://example.test",
  });
  const response = await fetch(`${base}/skills.json`, { headers: { origin: "https://example.test" } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), expected);
  assert.deepEqual(JSON.parse(body), JSON.parse(cli.stdout));
  assert.equal(body.includes(dir), false);
  assert.equal(body.includes(repo.url), false);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body)));
  assert.equal(response.headers.get("cache-control"), "no-store");
  const headResponse = await fetch(`${base}/skills.json`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  for (const name of ["content-type", "content-length", "cache-control"])
    assert.equal(headResponse.headers.get(name), response.headers.get(name));
  const port = Number(new URL(base).port);
  const rawHead = await raw(port, `HEAD /skills.json HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
  assert.match(rawHead, /^HTTP\/1.1 200 /u);
  assert.ok(rawHead.includes("\r\n\r\n"));
  assert.equal(rawHead.slice(rawHead.indexOf("\r\n\r\n") + 4), "");
  assert.deepEqual(await cliSnapshot(home), before);
  assert.deepEqual(await readdir(home), inventory);
  assert.deepEqual(await readFile(path.join(home, "index.db")), bytes);
  const method = await fetch(`${base}/skills.json`, { method: "POST" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, HEAD");
});

test("HTTP skill catalog distinguishes empty, invalid, and legacy stores", async (t) => {
  const root = await tmp("mg-http-stores-");
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const store of ["empty", "invalid", "legacy"] as const) {
    const home = path.join(root, store);
    await mkdir(home);
    if (store === "invalid") await writeFile(path.join(home, "index.db"), "not a database");
    if (store === "legacy") await copyLegacyStoreFixture(home);
    const inventory = await readdir(home);
    const bytes = store === "empty" ? null : await readFile(path.join(home, "index.db"));
    const sources = store === "legacy" ? await readFile(path.join(home, "sources.json")) : null;
    const { base } = await startServer(t, { MARGRAVE_HOME: home, MARGRAVE_ALLOWED_HOSTS: "", MARGRAVE_ALLOWED_ORIGINS: "" });
    if (store === "invalid") {
      const port = Number(new URL(base).port);
      for (const method of ["GET", "HEAD"]) {
        for (const [requestHeaders, status] of [
          ["Host: bad", 421],
          [`Host: localhost:${port}\r\nOrigin: https://bad.test`, 403],
        ] as const) {
          const result = await raw(port, `${method} /skills.json HTTP/1.1\r\n${requestHeaders}\r\nConnection: close\r\n\r\n`);
          assert.match(result, new RegExp(`^HTTP/1\\.1 ${status} `));
        }
      }
    }
    const response = await fetch(`${base}/skills.json`);
    assert.equal(response.status, store === "empty" ? 200 : 500);
    if (store !== "empty") assert.equal(await response.text(), "");
    else assert.deepEqual(await response.json(), { sources: [], skills: [] });
    assert.deepEqual(await readdir(home), inventory);
    if (store !== "empty") assert.deepEqual(await readFile(path.join(home, "index.db")), bytes);
    if (store === "legacy") assert.deepEqual(await readFile(path.join(home, "sources.json")), sources);
  }
});

test("HTTP skill catalog keeps one generation during publication", async (t) => {
  const { home, fakeBin, dir, id } = await catalogSetup();
  t.after(async () => {
    await Promise.all([home, fakeBin, dir].map((item) => rm(item, { recursive: true, force: true })));
  });
  await writeSkill(dir, "beta", "beta skill");
  const preload = path.join(dir, "publication-preload.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const prepare = DatabaseSync.prototype.prepare;
let called = false;
DatabaseSync.prototype.prepare = function (sql) {
  if (!called && sql === "SELECT source, count(*) AS n FROM skills GROUP BY source") {
    called = true;
    DatabaseSync.prototype.prepare = prepare;
    const result = spawnSync(process.execPath, ["--import", ${JSON.stringify(NO_VENDORED_PRELOAD)}, ${JSON.stringify(path.join(ROOT, "src/cli.ts"))}, "update", ${JSON.stringify(id)}], { cwd: ${JSON.stringify(ROOT)}, env: process.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return prepare.call(this, sql);
};
`,
  );
  const { base } = await startServer(
    t,
    { MARGRAVE_HOME: home, PATH: `${fakeBin}:${process.env["PATH"]}`, MARGRAVE_ALLOWED_HOSTS: "", MARGRAVE_ALLOWED_ORIGINS: "" },
    false,
    undefined,
    { preload },
  );
  const source = { id, kind: "local", ref: null, commit: null, skillCount: 1 };
  const alpha = { id: `${id}/alpha`, name: "alpha", description: "alpha skill for the guard tests", source: id };
  const beta = { id: `${id}/beta`, name: "beta", description: "beta skill", source: id };
  const first = await fetch(`${base}/skills.json`);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { sources: [source], skills: [alpha] });
  const second = await fetch(`${base}/skills.json`);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { sources: [{ ...source, skillCount: 2 }], skills: [alpha, beta] });
});

test("HTTP CLI serves the catalog and enforces its boundary", async (t) => {
  const { home, fakeBin, dir, id } = await catalogSetup();
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });
  const before = await cliSnapshot(home);
  const { base } = await startServer(t, {
    MARGRAVE_HOME: home,
    PATH: `${fakeBin}:${process.env["PATH"]}`,
    MARGRAVE_ALLOWED_HOSTS: "",
    MARGRAVE_ALLOWED_ORIGINS: "https://example.test",
  });
  const port = Number(new URL(base).port);
  const health = await fetch(`${base}/api/health`, { headers: { host: "bad" } });
  assert.equal(await health.text(), '{"status":"ok"}');
  assert.equal((await fetch(`${base}/api/health`, { method: "HEAD" })).headers.get("content-length"), "15");
  assert.equal((await fetch(`${base}/api/health`, { method: "POST" })).headers.get("allow"), "GET, HEAD");
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/mcp`)).headers.get("allow"), "POST");
  assert.equal((await fetch(`${base}/mcp`, { headers: { origin: "https://bad.test" } })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { headers: { origin: "https://example.test" } })).status, 405);
  for (const [extra, status] of [
    ["Host: bad", 421],
    [`Host: localhost:${port}\r\nHost: localhost:${port}`, 421],
    [`Host: localhost:${port}\r\nOrigin: https://example.test\r\nOrigin: https://example.test`, 403],
    ["", 421],
  ]) {
    assert.match(await raw(port, `GET /mcp HTTP/1.1\r\n${extra}\r\nConnection: close\r\n\r\n`), new RegExp(`^HTTP/1.1 ${status}`));
  }
  assert.match(
    await raw(port, "POST /mcp HTTP/1.1\r\nHost: bad\r\nContent-Length: 100\r\n\r\n{"),
    /^HTTP\/1.1 421[\s\S]*connection: close/iu,
  );
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  t.after(() => client.close());
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "find_skills"));
  assert.match((await call(client, "find_skills", { category: "general", task: "alpha" })).text, /alpha/u);
  assert.match((await call(client, "load_skill", { id: `${id}/alpha` })).text, /alpha/u);
  const notification = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-protocol-version": "2026-07-28", "mcp-method": "notifications/initialized" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
  assert.deepEqual(await cliSnapshot(home), before);
  const conflict = await runCli(["serve", "--http", "--port", String(port)], { home });
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /EADDRINUSE/u);
  const large = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: "POST", headers: { ...headers, "content-length": String(5 * 1024 * 1024) } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.flushHeaders();
  });
  assert.equal(large, 413);
  const chunked = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.write(Buffer.alloc(5 * 1024 * 1024));
  });
  assert.equal(chunked, 413);
  const disconnected = connect(port, "127.0.0.1");
  disconnected.write(`POST /mcp HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  disconnected.destroy();
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  await new Promise<void>((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: "POST", headers }, (res) => {
      res.destroy();
      resolve();
    });
    req.setTimeout(5000, () => req.destroy(new Error("response timed out")));
    req.on("error", reject);
    req.end('{"jsonrpc":"2.0","id":1,"method":"invalid"}');
  });
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("configured hosts replace loopback defaults", async (t) => {
  const { base } = await startServer(
    t,
    { MARGRAVE_ALLOWED_HOSTS: " , EXAMPLE.test:443, ", MARGRAVE_ALLOWED_ORIGINS: "" },
    false,
    undefined,
    { extraArgs: ["--host", "0.0.0.0"] },
  );
  const port = Number(new URL(base).port);
  async function status(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/mcp", headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
  }
  assert.equal(await status(`127.0.0.1:${port}`), 421);
  assert.equal(await status("example.TEST:443"), 405);
});

test("IPv6 loopback admits its default authority", async (t) => {
  const { base } = await startServer(t, { MARGRAVE_ALLOWED_HOSTS: "", MARGRAVE_ALLOWED_ORIGINS: "" }, false, undefined, {
    extraArgs: ["--host", "::1"],
  });
  assert.match(base, /^http:\/\/\[::1\]:\d+$/u);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("incomplete headers and bodies time out", async (t) => {
  const { base } = await startServer(t, { MARGRAVE_ALLOWED_HOSTS: "", MARGRAVE_ALLOWED_ORIGINS: "" });
  const port = Number(new URL(base).port);
  const sockets = [connect(port, "127.0.0.1"), connect(port, "127.0.0.1")];
  t.after(() => {
    for (const socket of sockets) socket.destroy();
  });
  const responses = sockets.map(
    (socket) =>
      new Promise<string>((resolve, reject) => {
        let response = "";
        socket.setTimeout(20000, () => socket.destroy(new Error("request deadline timed out")));
        socket.on("data", (chunk: Buffer) => {
          response += chunk.toString();
        });
        socket.on("error", reject);
        socket.on("close", () => resolve(response));
      }),
  );
  sockets[0]!.write(`GET /mcp HTTP/1.1\r\nHost: localhost:${port}\r\n`);
  sockets[1]!.write(`POST /mcp HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  for (const response of await Promise.all(responses)) assert.match(response, /^HTTP\/1.1 408/u);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("handler failures and bodyless responses stay contained", async (t) => {
  const abortReady = Promise.withResolvers<void>();
  const errorReady = Promise.withResolvers<void>();
  const { base } = await startServer(t, { MARGRAVE_ALLOWED_HOSTS: "", MARGRAVE_ALLOWED_ORIGINS: "" }, true, (text) => {
    if (text.includes("ready:abort\n")) abortReady.resolve();
    if (text.includes("ready:abort-error\n")) errorReady.resolve();
  });
  const empty = await fetch(`${base}/mcp`, { method: "POST", headers, body: "{}" });
  assert.equal(empty.status, 202);
  assert.equal(await empty.text(), "");
  const failed = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "x-test-mode": "error" }, body: "{}" });
  assert.equal(failed.status, 500);
  const port = Number(new URL(base).port);
  for (const [mode, ready] of [
    ["abort", abortReady.promise],
    ["abort-error", errorReady.promise],
  ] as const) {
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(`POST /mcp HTTP/1.1\r\nHost: localhost:${port}\r\nX-Test-Mode: ${mode}\r\nContent-Length: 100\r\n\r\n{`);
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("handler timed out")), 5000))]);
    socket.destroy();
    await once(socket, "close");
  }
  await new Promise<void>((resolve, reject) => {
    const req = request(
      `${base}/mcp`,
      { method: "POST", headers: { ...headers, "x-test-mode": "stream", "set-cookie": ["one=1", "two=2"] } },
      (res) => {
        res.once("data", () => {
          res.destroy();
          resolve();
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("stream timed out")));
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("shutdown force closes an open response", async (t) => {
  const { base, stop } = await startServer(t, { MARGRAVE_ALLOWED_HOSTS: "", MARGRAVE_ALLOWED_ORIGINS: "" }, true);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: "POST", headers: { ...headers, "x-test-mode": "stream" } }, resolve);
    req.on("error", reject);
    req.end("{}");
  });
  await once(response, "data");
  const closed = new Promise<void>((resolve) => {
    response.on("error", () => {});
    response.once("close", resolve);
  });
  await Promise.race([
    Promise.all([stop(), stop("SIGINT"), closed]),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("shutdown timed out")), 10000);
      timer.unref();
    }),
  ]);
  assert.equal(response.complete, false);
});
