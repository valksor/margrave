import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { searchSkills } from "../src/search.ts";
import { handleHostedMcp } from "../src/hosted.ts";
import { CLI, newEntry, runCli, seedIndex, tmp, writeCatalogRecords } from "./helpers.ts";

test("catalog fallback uses visible sources and validates responses", async (t) => {
  const home = await tmp("mg-catalog-");
  const oldHome = process.env["MARGRAVE_HOME"];
  const originalFetch = globalThis.fetch;
  process.env["MARGRAVE_HOME"] = home;
  t.after(async () => {
    if (oldHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = oldHome;
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  });
  let calls = 0;
  const limits: (string | null)[] = [];
  globalThis.fetch = (input, init) => {
    calls++;
    assert.ok(typeof input === "string");
    const url = new URL(input);
    assert.equal(url.origin, "https://skills.sh");
    assert.equal(url.pathname, "/api/search");
    assert.equal(url.searchParams.get("q"), "unmatched & task");
    limits.push(url.searchParams.get("limit"));
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return Promise.resolve(
      Response.json({
        skills: [
          null,
          "invalid",
          { source: "owner/repo" },
          { skillId: "one" },
          { source: 1, skillId: "one" },
          { source: "owner/repo", skillId: 1 },
          { source: "owner", skillId: "one" },
          { source: "owner/-repo", skillId: "one" },
          { source: "Owner/Repo", skillId: "one" },
          { source: "owner/repo", skillId: "ONE" },
          { source: "-bad/repo", skillId: "x" },
          { source: "other/project.git", skillId: "x" },
          { source: "other/project", skillId: "../x" },
          { source: "other/project", skillId: "two", description: "ignored" },
          { source: "third/project", skillId: "three" },
        ],
      }),
    );
  };
  assert.deepEqual((await searchSkills("unmatched & task", 2, false, false)).suggestions, []);
  assert.deepEqual((await searchSkills(" ", 2, false, true)).suggestions, []);
  assert.equal(calls, 0);
  const missing = await searchSkills("unmatched & task", 2, false, true);
  assert.equal(missing.noSources, true);
  assert.deepEqual(missing.suggestions, [
    { id: "Owner/Repo/one", source: "Owner/Repo", url: "https://skills.sh/Owner/Repo/one", installCommand: "margrave install Owner/Repo" },
    {
      id: "other/project/two",
      source: "other/project",
      url: "https://skills.sh/other/project/two",
      installCommand: "margrave install other/project",
    },
  ]);
  assert.deepEqual(await readdir(home), []);
  const sources = [
    {
      id: "visible",
      kind: "git",
      spec: "owner/repo",
      url: "https://github.com/OWNER/REPO.git",
      subpath: "",
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      snapshot: `${"a".repeat(40)}-${"b".repeat(16)}`,
      installedAt: "now",
    },
  ] as const;
  await seedIndex([newEntry("visible", "local", "unrelated subject", "docker")], [...sources]);
  const before = await readdir(home);
  const indexBytes = await readFile(path.join(home, "index.db"));
  const scoped = await searchSkills("unmatched & task", 2, false, true, new Set());
  assert.equal(scoped.suggestions[0]?.id, "Owner/Repo/one");
  const visible = await searchSkills("unmatched & task", 2, false, true);
  assert.equal(visible.suggestions[0]?.id, "other/project/two");
  assert.deepEqual(limits, ["2", "2", "25"]);
  assert.deepEqual(await readdir(home), before);
  assert.deepEqual(await readFile(path.join(home, "index.db")), indexBytes);
  const requestedLimits: number[] = [];
  globalThis.fetch = (input) => {
    assert.ok(typeof input === "string");
    const requested = Number(new URL(input).searchParams.get("limit"));
    requestedLimits.push(requested);
    return Promise.resolve(
      Response.json({
        skills: [
          { source: "owner/repo", skillId: "first" },
          { source: "owner/repo", skillId: "second" },
          { source: "other/project", skillId: "third" },
        ].slice(0, requested),
      }),
    );
  };
  const filtered = await searchSkills("nothing", 1, false, true);
  assert.deepEqual(
    filtered.suggestions.map((item) => item.id),
    ["other/project/third"],
  );
  const hidden = await searchSkills("nothing", 1, false, true, new Set());
  assert.deepEqual(
    hidden.suggestions.map((item) => item.id),
    ["owner/repo/first"],
  );
  assert.deepEqual(requestedLimits, [25, 1]);
  globalThis.fetch = () => Promise.resolve(Response.json({ skills: [{ source: "other/project", skillId: "two" }] }));
  const weak = await searchSkills("repair toaster with docker", 2, true, true);
  assert.equal(weak.hits[0]?.recommended, false);
  assert.equal(weak.suggestions.length, 1);
  let unexpectedCalls = 0;
  globalThis.fetch = () => {
    unexpectedCalls++;
    return Promise.reject(new Error("must not fetch"));
  };
  const recommended = await searchSkills("local", 2, false, true);
  assert.equal(recommended.hits[0]?.id, "visible/local");
  assert.deepEqual(recommended.suggestions, []);
  assert.equal(unexpectedCalls, 0);
  globalThis.fetch = () => Promise.resolve(Response.json({ skills: "invalid" }));
  assert.deepEqual((await searchSkills("nothing", 2, false, true)).suggestions, []);
  globalThis.fetch = () => Promise.resolve(Response.json(null));
  assert.deepEqual((await searchSkills("nothing", 2, false, true)).suggestions, []);
  globalThis.fetch = () => Promise.resolve(new Response("not json"));
  assert.deepEqual((await searchSkills("nothing", 2, false, true)).suggestions, []);
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 500 }));
  assert.deepEqual((await searchSkills("nothing", 2, false, true)).suggestions, []);
  globalThis.fetch = () => Promise.reject(new Error("offline"));
  assert.deepEqual((await searchSkills("nothing", 2, false, true)).suggestions, []);
  globalThis.fetch = () => Promise.resolve(Response.json({ skills: [{ source: "Owner/Repo", skillId: "one" }] }));
  for (const [spec, url, subpath, suppressed] of [
    ["git@github.com:OWNER/REPO.git", "git@github.com:OWNER/REPO.git", "", true],
    ["owner/repo", "https://github.com/owner/repo.git", "", true],
    ["owner/repo", "https://example.com/owner/repo.git", "", false],
    ["https://github.com/owner/repo.git", "https://github.com/owner/repo.git", "skills/one", false],
    ["https://example.com/owner/repo.git", "https://example.com/owner/repo.git", "", false],
  ] as const) {
    writeCatalogRecords(home, [
      {
        id: "visible",
        kind: "git",
        spec,
        url,
        subpath,
        ref: "refs/heads/main",
        commit: "a".repeat(40),
        snapshot: `${"a".repeat(40)}-${"b".repeat(16)}`,
        installedAt: "now",
      },
    ]);
    assert.equal((await searchSkills("nothing", 2, false, true)).suggestions.length, suppressed ? 0 : 1);
  }
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.prepare("UPDATE sources SET record = ?").run("invalid json");
  db.close();
  globalThis.fetch = () => {
    unexpectedCalls++;
    return Promise.reject(new Error("must not fetch"));
  };
  await assert.rejects(searchSkills("nothing", 2, false, true));
  assert.equal(unexpectedCalls, 0);
});

test("CLI, stdio and hosted opt in through trusted configuration", async (t) => {
  const home = await tmp("mg-catalog-entry-");
  const previous = process.env["MARGRAVE_HOME"];
  const originalFetch = globalThis.fetch;
  process.env["MARGRAVE_HOME"] = home;
  const preload = path.join(home, "fetch.mjs");
  await writeFile(preload, 'globalThis.fetch = async () => Response.json({ skills: [{ source: "owner/repo", skillId: "skill" }] });\n');
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
    await rm(home, { recursive: true, force: true });
  });
  const extra = { MARGRAVE_SKILLS_SH: "1" };
  const nodeArgs = ["--import", preload];
  const enabled = await runCli(["find", "task", "--json"], { home, extra, nodeArgs });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.equal((JSON.parse(enabled.stdout) as { suggestions: { id: string }[] }).suggestions[0]?.id, "owner/repo/skill");
  const disabled = await runCli(["find", "task", "--json"], { home, extra: { MARGRAVE_SKILLS_SH: "0" }, nodeArgs });
  assert.equal("suggestions" in (JSON.parse(disabled.stdout) as object), false);
  const text = await runCli(["find", "task"], { home, extra, nodeArgs });
  assert.match(
    text.stdout,
    /skills\.sh suggestions\n  https:\/\/skills\.sh\/owner\/repo\/skill\n  Manual install: margrave install owner\/repo/u,
  );
  const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", preload, CLI, "mcp"],
      env: { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home, ...extra },
    }),
  );
  try {
    const tools = await client.listTools();
    assert.match(tools.tools.find((tool) => tool.name === "find_skills")?.description ?? "", /Wait for an explicit request/u);
    const result = await client.callTool({ name: "find_skills", arguments: { task: "task" } });
    assert.match(JSON.stringify(result.content), /skills\.sh suggestions/u);
  } finally {
    await client.close();
  }
  let calls = 0;
  globalThis.fetch = () => {
    calls++;
    return Promise.resolve(Response.json({ skills: [{ source: "owner/repo", skillId: "skill" }] }));
  };
  for (const enabledHosted of [false, true]) {
    const hosted = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await hosted.connect(
      new StreamableHTTPClientTransport(new URL("http://test/mcp?skillsSh=true"), {
        fetch: (url, init) =>
          handleHostedMcp(
            new Request(url, { ...init, headers: new Headers({ ...Object.fromEntries(new Headers(init?.headers)), skillsSh: "true" }) }),
            { skillsSh: enabledHosted },
          ),
      }),
    );
    try {
      const result = await hosted.callTool({ name: "find_skills", arguments: { task: "task", skillsSh: true } });
      const output = JSON.stringify(result.content);
      assert.equal(output.includes("skills.sh suggestions"), enabledHosted);
      if (enabledHosted) assert.match(output, /Ask the store operator to install a source on this server\./u);
      assert.equal(calls, Number(enabledHosted));
    } finally {
      await hosted.close();
    }
  }
});
