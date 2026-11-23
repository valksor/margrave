import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fakeRipwire, runCli, tmp, writeSkill, disposableHome, newEntry, seedIndex, connectHosted, CLI, stdioTestEnv } from "./helpers.ts";
import { FIND_GUIDANCE, searchSkills } from "../src/search.ts";
import { buildFieldTokens } from "../src/bm25.ts";
import type { Clarification } from "../src/search.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("frontend and migration searches use ordinary ranking", async (t) => {
  await disposableHome(t);
  await seedIndex([
    newEntry("one", "react-guide", "React frontend work forms validation migrate Vue"),
    newEntry("two", "vue-guide", "Vue frontend work forms validation migrate React"),
  ]);
  for (const task of ["frontend work", "migrate React to Vue for frontend forms", "frontend forms React to Vue with validation"]) {
    const result = await searchSkills(task, 5, true, false);
    assert.equal(result.clarification, undefined);
    assert.deepEqual(
      result.hits
        .filter((hit) => hit.recommended)
        .map((hit) => hit.name)
        .sort(),
      ["react-guide", "vue-guide"],
    );
  }
});

test("on hosted MCP a category requires evidence in the name or headings", async (t) => {
  await disposableHome(t);
  const joint = newEntry("joint", "frontend-interop", "Frontend work across frameworks");
  const categoryWords = Array.from({ length: 32 }, (_, i) => `topic${i}`);
  joint.tokens = buildFieldTokens({ ...joint, headings: ["React Native and Vue", ...categoryWords], body: "" });
  const tokenless = newEntry("three", "of", "Common PHP usage");
  tokenless.tokens = buildFieldTokens({ ...tokenless, headings: ["PHP"], body: "" });
  await seedIndex([
    newEntry("one", "react-guide", "React frontend work"),
    newEntry("two", "vue-guide", "Vue frontend work. Compare to React."),
    newEntry("two", "form-practices", "Frontend work on forms", "React"),
    newEntry("three", "php-guide", "PHP frontend work"),
    joint,
    tokenless,
  ]);
  const client = await connectHosted(t);
  for (const [category, names] of [
    ["general", ["form-practices", "frontend-interop", "php-guide", "react-guide", "vue-guide"]],
    ["react", ["frontend-interop", "react-guide"]],
    ["react".padEnd(1024), ["frontend-interop", "react-guide"]],
    [" React Native ", ["frontend-interop"]],
    ["vue", ["frontend-interop", "vue-guide"]],
    ["php", ["php-guide"]],
    ["rust", []],
    [[...categoryWords, categoryWords[0]].join(" "), ["frontend-interop"]],
  ] as const) {
    const result = await client.callTool({ name: "find_skills", arguments: { task: "frontend work", category } });
    assert.notEqual(result.isError, true);
    assert.deepEqual((result.structuredContent as { results: { name: string }[] }).results.map((hit) => hit.name).sort(), names);
  }
  const tooManyWords = [...categoryWords, "topic32"].join(" ");
  const overLimit = await client.callTool({ name: "find_skills", arguments: { task: "frontend work", category: tooManyWords } });
  assert.equal(overLimit.isError, true);
  assert.match((overLimit.content as { text: string }[])[0]!.text, /1 to 32 distinct searchable words/u);
  const overLength = await client.callTool({ name: "find_skills", arguments: { task: "frontend work", category: "react".padEnd(1025) } });
  assert.equal(overLength.isError, true);
  assert.match((overLength.content as { text: string }[])[0]!.text, /1024 characters/u);
  for (const [category, ids] of [
    ["php", ["three/of"]],
    ["react", []],
  ] as const) {
    const exact = await client.callTool({ name: "find_skills", arguments: { task: "of", category } });
    assert.deepEqual(
      (exact.structuredContent as { results: { id: string }[] }).results.map((hit) => hit.id),
      ids,
    );
  }
  const exactTask = "two/vue-guide";
  const exact = await client.callTool({ name: "find_skills", arguments: { task: exactTask, category: "general" } });
  assert.equal((exact.structuredContent as { results: { id: string }[] }).results[0]?.id, exactTask);
  const explained = await client.callTool({ name: "find_skills", arguments: { task: exactTask, category: "react", explain: true } });
  const weak = (explained.structuredContent as { results: { id: string; recommended: boolean }[] }).results;
  assert.deepEqual(
    weak.toSorted((a, b) => a.id.localeCompare(b.id)).map((hit) => [hit.id, hit.recommended]),
    [
      ["joint/frontend-interop", false],
      ["one/react-guide", false],
    ],
  );
  const limited = await connectHosted(t, ["two", "joint"]);
  const scoped = await limited.callTool({ name: "find_skills", arguments: { task: "frontend work", category: "react" } });
  assert.deepEqual(
    (scoped.structuredContent as { results: { name: string }[] }).results.map((hit) => hit.name),
    ["frontend-interop"],
  );
});

test("counts all recommendations before the requested limit", async (t) => {
  const dir = await tmp("mg-count-source-");
  const home = await tmp("mg-count-home-");
  const fakeBin = await fakeRipwire();
  t.after(async () => Promise.all([dir, home, fakeBin].map((p) => rm(p, { recursive: true, force: true }))));
  for (let i = 0; i < 25; i++) await writeSkill(dir, `database-task-${i}`, "Database task guidance");
  await writeSkill(dir, "postgres-maintenance", "Database task guidance");
  const install = await runCli(["install", dir], { home, fakeBin });
  assert.equal(install.code, 0, install.stderr);
  const result = await runCli(["find", "--category", "general", "database task", "--limit", "1", "--json"], { home, fakeBin });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).clarification, {
    kind: "refine",
    question: "What specific task should the skills cover?",
    matchCount: 26,
  });
  const scoped = await runCli(["find", "database task", "--category", "database", "--limit", "1", "--json"], { home, fakeBin });
  assert.equal(scoped.code, 0, scoped.stderr);
  assert.equal(JSON.parse(scoped.stdout).clarification.matchCount, 25);
  const narrow = await runCli(["find", "database task", "--category", "postgres", "--limit", "1", "--json"], { home, fakeBin });
  assert.equal(narrow.code, 0, narrow.stderr);
  assert.equal(JSON.parse(narrow.stdout).clarification, undefined);
  assert.equal(JSON.parse(narrow.stdout).results[0]?.name, "postgres-maintenance");
  const browse = await runCli(["find", "--category", "general", "database task", "--limit", "1", "--browse", "--json"], { home, fakeBin });
  assert.equal(browse.code, 0, browse.stderr);
  assert.equal(JSON.parse(browse.stdout).results.length, 1);
  assert.equal(JSON.parse(browse.stdout).clarification, undefined);
  const exact = await runCli(["find", "--category", "general", "database-task-1", "--json"], { home, fakeBin });
  assert.equal(exact.code, 0, exact.stderr);
  assert.equal(JSON.parse(exact.stdout).clarification, undefined);
  assert.ok(JSON.parse(exact.stdout).results.some((hit: { name: string }) => hit.name === "database-task-1"));
});

test("scoped recommendation counts exclude weak matches", async (t) => {
  await disposableHome(t);
  const entries = [
    ...Array.from({ length: 24 }, (_, i) => newEntry("base", i === 0 ? "database task" : `database-task-${i}`, "Database task guidance")),
    newEntry("extra", "database-task-extra", "Database task guidance"),
    newEntry("last", "database-task-last", "Database task guidance"),
    ...Array.from({ length: 30 }, (_, i) => newEntry("weak", `database-only-${i}`, "Database guide")),
  ];
  await seedIndex(entries);
  const base = await searchSkills("database task guidance", 1, true, false, new Set(["base"]));
  assert.equal(base.clarification, undefined);
  assert.equal(base.hits.length, 1);
  const atCutoff = await searchSkills("database task guidance", 1, true, false, new Set(["base", "extra", "weak"]));
  assert.deepEqual(atCutoff.clarification, { kind: "refine", question: "What specific task should the skills cover?", matchCount: 25 });
  const above = await searchSkills("database task guidance", 1, true, false, new Set(["base", "extra", "last", "weak"]));
  assert.deepEqual(above.clarification, { kind: "refine", question: "What specific task should the skills cover?", matchCount: 26 });
  const exact = await searchSkills("database task", 1, true, false, new Set(["base", "extra", "last"]));
  assert.equal(exact.clarification, undefined);
  assert.equal(exact.hits[0]?.name, "database task");
  const narrow = await searchSkills("extra", 1, false, false, new Set(["base", "extra", "last"]));
  assert.equal(narrow.clarification, undefined);
  assert.equal(narrow.hits[0]?.name, "database-task-extra");
});

test("count clarification skips public lookup", async (t) => {
  await disposableHome(t);
  await seedIndex(Array.from({ length: 25 }, (_, i) => newEntry("count", `database-task-${i}`, "Database task guidance")));
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    fetches++;
    return Promise.resolve(Response.json({ skills: [] }));
  };
  try {
    const result = await searchSkills("database task guidance", 1, false, true, undefined, "database");
    assert.equal(result.clarification?.kind, "refine");
    assert.equal(fetches, 0);
    await searchSkills("xylophone nebula", 1, false, true, undefined, "xylophone");
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("stdio and hosted MCP return clarification text and structured content", async (t) => {
  const home = await disposableHome(t);
  await seedIndex([
    newEntry("one", "react-frontend", "React frontend development"),
    newEntry("two", "vue-frontend", "Vue frontend development"),
    ...Array.from({ length: 25 }, (_, i) => newEntry("count", `database-task-${i}`, "Database task guidance")),
  ]);
  const cli = await runCli(["find", "--category", "general", "frontend development"], { home });
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(cli.stdout.split(FIND_GUIDANCE).length - 1, 1);
  const json = await runCli(["find", "--category", "general", "frontend development", "--json"], { home });
  assert.equal(JSON.parse(json.stdout).guidance, FIND_GUIDANCE);
  const countCli = await runCli(["find", "--category", "general", "database task guidance"], { home });
  assert.match(countCli.stdout, /25 installed skills match/u);
  assert.match(countCli.stdout, /Use --browse/u);
  assert.equal(countCli.stdout.split(FIND_GUIDANCE).length - 1, 1);
  const local = new Client({ name: "clarification", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await local.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      env: stdioTestEnv({ PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home }),
    }),
  );
  t.after(() => local.close());
  const hosted = await connectHosted(t);
  for (const client of [local, hosted]) {
    const result = await client.callTool({ name: "find_skills", arguments: { category: "general", task: "frontend development" } });
    assert.notEqual(result.isError, true);
    assert.equal((result.structuredContent as { guidance: string }).guidance, FIND_GUIDANCE);
    assert.equal((result.content as { text: string }[])[0]!.text.split(FIND_GUIDANCE).length - 1, 1);
    const count = await client.callTool({
      name: "find_skills",
      arguments: { category: "general", task: "database task guidance", limit: 1 },
    });
    assert.notEqual(count.isError, true);
    const countData = count.structuredContent as { results: unknown[]; suggestions: unknown[]; clarification?: Clarification } | undefined;
    assert.ok(countData?.clarification);
    assert.equal(countData.clarification.kind, "refine");
    assert.equal(countData.clarification.matchCount, 25);
    assert.match((count.content as { text: string }[])[0]!.text, /Set browse to true/u);
    assert.equal((count.structuredContent as { guidance: string }).guidance, FIND_GUIDANCE);
    assert.equal((count.content as { text: string }[])[0]!.text.split(FIND_GUIDANCE).length - 1, 1);
  }
});
