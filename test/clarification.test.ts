import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fakeRipwire, runCli, tmp, writeSkill, disposableHome, newEntry, seedIndex, connectHosted, CLI, stdioTestEnv } from "./helpers.ts";
import { searchSkills } from "../src/search.ts";
import type { Clarification } from "../src/search.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("asks for a frontend framework", async (t) => {
  const dir = await tmp("mg-clarify-source-");
  const home = await tmp("mg-clarify-home-");
  const fakeBin = await fakeRipwire();
  t.after(async () => Promise.all([dir, home, fakeBin].map((p) => rm(p, { recursive: true, force: true }))));
  await writeSkill(dir, "react-frontend", "React frontend development");
  await writeSkill(dir, "vue-frontend", "Vue frontend development");
  const install = await runCli(["install", dir], { home, fakeBin });
  assert.equal(install.code, 0, install.stderr);
  const result = await runCli(["find", "frontend development", "--json"], { home, fakeBin });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).clarification, {
    kind: "framework",
    question: "Which frontend framework does the task use?",
    options: ["React", "Vue", "framework-agnostic"],
  });
});

test("counts all recommendations before the requested limit", async (t) => {
  const dir = await tmp("mg-count-source-");
  const home = await tmp("mg-count-home-");
  const fakeBin = await fakeRipwire();
  t.after(async () => Promise.all([dir, home, fakeBin].map((p) => rm(p, { recursive: true, force: true }))));
  for (let i = 0; i < 26; i++) await writeSkill(dir, `database-task-${i}`, "Database task guidance");
  const install = await runCli(["install", dir], { home, fakeBin });
  assert.equal(install.code, 0, install.stderr);
  const result = await runCli(["find", "database task", "--limit", "1", "--json"], { home, fakeBin });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).clarification, {
    kind: "refine",
    question: "What specific task should the skills cover?",
    matchCount: 26,
  });
  const browse = await runCli(["find", "database task", "--limit", "1", "--browse", "--json"], { home, fakeBin });
  assert.equal(browse.code, 0, browse.stderr);
  assert.equal(JSON.parse(browse.stdout).results.length, 1);
  assert.equal(JSON.parse(browse.stdout).clarification, undefined);
  const exact = await runCli(["find", "database-task-1", "--json"], { home, fakeBin });
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

test("frontend evidence, scopes, retries and public fallback", async (t) => {
  await disposableHome(t);
  await seedIndex([
    ...Array.from({ length: 25 }, (_, i) => newEntry("react", `nextjs-frontend-forms-${i}`, "Next.js frontend forms")),
    newEntry("vue", "nuxt-frontend-forms", "Nuxt frontend forms"),
    newEntry("angular", "angular-frontend-forms", "Angular frontend forms"),
    newEntry("svelte", "sveltekit-frontend-forms", "SvelteKit frontend forms"),
    newEntry("generic", "frontend-forms", "Frontend forms guidance"),
    newEntry("generic", "frontend-validation", "Frontend validation guidance", "Validate forms."),
    newEntry("body", "vue-forms", "Vue forms guidance", "frontend forms"),
    newEntry("unrelated", "angular-forms", "Angular forms guidance", "frontend forms"),
  ]);
  const framework = await searchSkills("frontend forms", 1, false, false, new Set(["react", "vue", "generic", "body"]), undefined, true);
  assert.deepEqual(framework.clarification, {
    kind: "framework",
    question: "Which frontend framework does the task use?",
    options: ["React", "Vue", "framework-agnostic"],
  });
  const all = await searchSkills("frontend forms", 1, false, false);
  assert.deepEqual(all.clarification?.kind === "framework" && all.clarification.options, [
    "Angular",
    "React",
    "Svelte",
    "Vue",
    "framework-agnostic",
  ]);
  const negative = await searchSkills("frontend forms", 5, false, false, new Set(["react", "unrelated"]));
  assert.equal(negative.clarification?.kind, "refine");
  const agnostic = await searchSkills("frontend forms framework-agnostic", 5, false, false);
  assert.equal(agnostic.clarification, undefined);
  assert.deepEqual(agnostic.hits.map((hit) => hit.name).sort(), ["frontend-forms", "frontend-validation"]);
  const explicit = await searchSkills("frontend forms Vue", 25, false, false);
  assert.equal(explicit.clarification, undefined);
  assert.ok(explicit.hits.some((hit) => hit.name === "nuxt-frontend-forms"));
  assert.ok(explicit.hits.every((hit) => !hit.name.startsWith("nextjs")));
  for (const alias of [
    "React",
    "Next.js",
    "NextJS",
    "Next-js",
    "Svelte",
    "SvelteKit",
    "Vue",
    "Vue.js",
    "VueJS",
    "Nuxt",
    "Nuxt.js",
    "NuxtJS",
    "Angular",
  ]) {
    const result = await searchSkills(`frontend forms ${alias}`, 25, false, false, undefined, undefined, true);
    assert.equal(result.clarification, undefined, alias);
    if (/^(?:react|next)/iu.test(alias))
      assert.ok(
        result.hits.every((hit) => !hit.name.startsWith("nuxt")),
        alias,
      );
    if (/^(?:vue|nuxt)/iu.test(alias))
      assert.ok(
        result.hits.every((hit) => !hit.name.startsWith("nextjs")),
        alias,
      );
  }
  const bodyOnly = await searchSkills("frontend forms", 1, false, false, new Set(["react", "body"]), undefined, true);
  assert.equal(bodyOnly.clarification, undefined);
  const multiple = await searchSkills("frontend forms React Vue", 2, false, false, undefined, undefined, true);
  assert.equal(multiple.clarification, undefined);
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    fetches++;
    return Promise.resolve(Response.json({ skills: [] }));
  };
  try {
    await searchSkills("frontend forms", 1, false, true, undefined, "frontend forms");
    await searchSkills("frontend forms React", 1, false, true, undefined, "frontend forms");
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
  const cli = await runCli(["find", "frontend development"], { home });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /Which frontend framework does the task use\?/u);
  assert.doesNotMatch(cli.stdout, /no match/u);
  const countCli = await runCli(["find", "database task guidance"], { home });
  assert.match(countCli.stdout, /25 installed skills match/u);
  assert.match(countCli.stdout, /Use --browse/u);
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
    const framework = await client.callTool({ name: "find_skills", arguments: { task: "frontend development" } });
    assert.notEqual(framework.isError, true);
    const frameworkData = framework.structuredContent as
      { results: unknown[]; suggestions: unknown[]; clarification?: Clarification } | undefined;
    assert.deepEqual(frameworkData?.results, []);
    assert.deepEqual(frameworkData?.suggestions, []);
    assert.equal(frameworkData?.clarification?.kind, "framework");
    assert.match((framework.content as { text: string }[])[0]!.text, /Which frontend framework/u);
    const count = await client.callTool({ name: "find_skills", arguments: { task: "database task guidance", limit: 1 } });
    assert.notEqual(count.isError, true);
    const countData = count.structuredContent as { results: unknown[]; suggestions: unknown[]; clarification?: Clarification } | undefined;
    assert.ok(countData?.clarification);
    assert.equal(countData.clarification.kind, "refine");
    assert.equal(countData.clarification.matchCount, 25);
    assert.match((count.content as { text: string }[])[0]!.text, /Set browse to true/u);
  }
});

test("split frontend evidence and exact agnostic names", async (t) => {
  await disposableHome(t);
  await seedIndex([
    newEntry("split", "react-front-end-forms", "React front end forms"),
    newEntry("split", "vue-front-end-forms", "Vue front end forms"),
    newEntry("split", "angular-end-forms", "Angular end forms"),
    newEntry("exact", "frontend framework-agnostic", "Frontend framework agnostic guidance"),
  ]);
  const result = await searchSkills("front end forms", 5, false, false, new Set(["split"]));
  assert.deepEqual(result.clarification?.kind === "framework" && result.clarification.options, ["React", "Vue", "framework-agnostic"]);
  const exact = await searchSkills("frontend framework-agnostic", 5, true, false, new Set(["exact"]));
  assert.equal(exact.clarification, undefined);
  assert.equal(exact.hits[0]?.exact, true);
  assert.ok(exact.hits[0]?.matchedTerms?.name.includes("framework"));
});
