import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BODY_TOKEN_LIMIT, FIELD_WEIGHTS, NAME_BONUS, queryTerms } from "../src/bm25.ts";
import { findSkills } from "../src/skills.ts";
import { CLI, fakeRipwire, runCli, tmp, writeSkill } from "./helpers.ts";

test("search relevance and CLI/MCP parity on an installed corpus", async (t) => {
  const dir = await tmp("mg-find-source-");
  const home = await tmp("mg-find-home-");
  const fakeBin = await fakeRipwire();
  let db: DatabaseSync | undefined;
  t.after(async () => {
    db?.close();
    await Promise.all([dir, home, fakeBin].map((p) => rm(p, { recursive: true, force: true })));
  });
  const skills = [
    [
      "react-perf",
      "Profile React rendering performance and optimize components",
      "# React rendering\nUse the profiler to inspect slow renders.",
    ],
    ["vue-perf", "Profile Vue rendering performance and optimize components", "# Vue rendering\nInspect slow components."],
    ["react-tests", "Test React forms and validation", "# Form testing\nTest interactive React form validation."],
    ["go-tests", "Write test cases in Go", "# Go testing\nRun Go unit tests."],
    ["rust-tests", "Write test cases in Rust", "# Rust testing\nRun Rust unit tests."],
    ["postgres-indexes", "Tune PostgreSQL database indexes and query performance", "# Index maintenance\nAnalyze database queries."],
    ["postgres-migrations", "Plan PostgreSQL database schema migrations", "# Schema migration\nDeploy database changes."],
    ["mysql-indexes", "Tune MySQL database indexes and query performance", "# Index maintenance\nAnalyze MySQL queries."],
    ["github-ci", "Repair GitHub Actions CI cache", "# Workflow cache\nRefresh stale caches."],
    ["gitlab-ci", "Repair GitLab CI cache", "# Pipeline cache\nRefresh stale caches."],
    ["python-packaging", "Package Python libraries for distribution", "# Publishing wheels\nBuild Python packages."],
    ["docker-compose", "Run local services with Docker Compose", "# Containers\nStart dependent services."],
    ["heading-evidence", "A guide to application operations", `${"filler ".repeat(BODY_TOKEN_LIMIT)}\n# Kubernetes pod eviction`],
    [
      "body-evidence",
      "A guide to application diagnostics",
      "# Troubleshooting\nInvestigate elusive semaphore contention. Docker Docker Docker.",
    ],
    ["markdown-samples", "Show nested Markdown code examples", "````markdown\n```sh\n# YAML anchors\n```\n````"],
    [
      "config-reuse",
      "Share settings across a group of services",
      "# YAML anchors\nReuse configuration across jobs. Define a block once and refer to it in other sections. Share the defaults while overriding deployment, environment, and runtime settings.",
    ],
  ] as const;
  for (const [name, description, body] of skills) await writeSkill(dir, name, description, body);
  const install = await runCli(["install", dir], { home, fakeBin });
  assert.equal(install.code, 0, install.stderr);
  const source = /^installed (\S+)/mu.exec(install.stdout)?.[1];
  assert.ok(source);
  const index = new DatabaseSync(path.join(home, "index.db"), { readOnly: true });
  db = index;
  const heldOut = [
    ["How can I profile React performance?", "react-perf"],
    ["Control deployment with YAML anchors", "config-reuse"],
    ["Investigate elusive semaphore contention", "body-evidence"],
    ["Run Go unit tests", "go-tests"],
    ["How do I buy a concert ticket with Docker?", null],
    ["How do I renew a license on GitHub?", null],
    ["What is the rainfall tolerance for containers?", null],
    ["Explain profilers on Mars", null],
  ] as const;
  await t.test("held-out recommendation rule", () => {
    let recall = 0;
    let falseRecommendations = 0;
    let baselineRecall = 0;
    let baselineFalseRecommendations = 0;
    const baseline = index.prepare(`WITH hits AS MATERIALIZED (
      SELECT rowid, -bm25(fts, ${FIELD_WEIGHTS.name}, ${FIELD_WEIGHTS.description}, ${FIELD_WEIGHTS.headings}, ${FIELD_WEIGHTS.body}) AS s
      FROM fts WHERE fts MATCH ?
    ), cand AS (
      SELECT rowid, s FROM hits
      UNION ALL SELECT rowid, 0 FROM skills WHERE (name_lc = ? OR id_lc = ?) AND rowid NOT IN (SELECT rowid FROM hits)
    ) SELECT k.id, (k.name_lc = ? OR k.id_lc = ?) AS exact,
      c.s + CASE WHEN k.name_lc = ? OR k.id_lc = ? THEN ${NAME_BONUS} ELSE 0 END AS score
      FROM cand c JOIN skills k ON k.rowid = c.rowid ORDER BY exact DESC, score DESC, k.id LIMIT 3`);
    for (const [query, expected] of heldOut) {
      const hits = findSkills(index, query, 3);
      const q = query.trim().toLowerCase();
      const oldHits = baseline.all(
        queryTerms(query)
          .map((term) => `"${term}"`)
          .join(" OR "),
        q,
        q,
        q,
        q,
        q,
        q,
      ) as unknown as { id: string }[];
      if (expected === null) {
        falseRecommendations += Number(hits.length > 0);
        baselineFalseRecommendations += Number(oldHits.length > 0);
      } else {
        recall += Number(hits.some((hit) => hit.id === `${source}/${expected}`));
        baselineRecall += Number(oldHits.some((hit) => hit.id === `${source}/${expected}`));
      }
    }
    assert.equal(recall, 4);
    assert.equal(falseRecommendations, 0);
    assert.equal(baselineRecall, 4);
    assert.equal(baselineFalseRecommendations, 4);
    console.log(`held-out baseline: recall ${baselineRecall}/4, false recommendations ${baselineFalseRecommendations}/4`);
    console.log(`held-out new: recall ${recall}/4, false recommendations ${falseRecommendations}/4`);
  });
  await t.test("incidental body overlap is weak and has distinct evidence", async () => {
    const query = "How do I repair a toaster with Docker?";
    const baseline = index
      .prepare("SELECT skills.id FROM fts JOIN skills ON skills.rowid = fts.rowid WHERE fts MATCH ? ORDER BY bm25(fts)")
      .all('"repair" OR "toaster" OR "docker"') as unknown as { id: string }[];
    assert.ok(baseline.some((hit) => hit.id === `${source}/body-evidence`));
    assert.deepEqual(findSkills(index, query, undefined), []);
    const hits = findSkills(index, query, 25, true);
    const weak = hits.find((hit) => hit.id === `${source}/body-evidence`);
    assert.equal(weak?.recommended, false);
    assert.deepEqual(weak?.matchedTerms?.body, ["docker"]);
    const cli = await runCli(["find", query, "--explain"], { home, fakeBin });
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /weak match/u);
    assert.match(cli.stdout, /matches in body \(docker\)/u);
    assert.doesNotMatch(cli.stdout, /load:/u);
    const json = await runCli(["find", query, "--explain", "--json"], { home, fakeBin });
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual((JSON.parse(json.stdout) as { results: typeof hits }).results, hits);
  });
  await t.test("recommendations precede weak matches before the limit", () => {
    const hits = findSkills(index, "Investigate elusive semaphore contention Docker", 1, true);
    assert.equal(hits[0]?.id, `${source}/body-evidence`);
    assert.equal(hits[0]?.recommended, true);
    assert.deepEqual(hits[0]?.matchedTerms?.body, ["content", "docker", "elus", "investig", "semaphor"]);
  });
  const cases: [string, string, string | null, "first" | "top-three" | "ci" | "empty"][] = [
    ["React render profiling", "How do I profile rendering performance in React?", "react-perf", "first"],
    ["React form validation", "How do I test a React form with validation?", "react-tests", "first"],
    ["Go test cases", "How should I write test cases in Go?", "go-tests", "first"],
    ["PostgreSQL index tuning", "Tune PostgreSQL indexes after a database schema migration", "postgres-indexes", "top-three"],
    ["GitHub stale cache", "My GitHub Actions CI cache is stale", "github-ci", "first"],
    ["Vue performance", "Profile Vue rendering performance", "vue-perf", "first"],
    ["Rust testing", "Write test cases in Rust", "rust-tests", "first"],
    ["MySQL indexes", "Tune MySQL indexes", "mysql-indexes", "first"],
    ["PostgreSQL migrations", "PostgreSQL schema migrations", "postgres-migrations", "first"],
    ["GitLab pipeline", "GitLab CI cache", "gitlab-ci", "first"],
    ["case and punctuation", "REACT: rendering PERFORMANCE!", "react-perf", "first"],
    ["inflected forms", "testing validated React forms", "react-tests", "first"],
    ["short Go term", "Go", "go-tests", "first"],
    ["short CI term", "CI", null, "ci"],
    ["qualified ID", `${source}/vue-perf`, "vue-perf", "first"],
    ["heading evidence", "Kubernetes pod eviction", "heading-evidence", "first"],
    ["body evidence", "semaphore contention", "body-evidence", "first"],
    ["Python packaging", "Publish Python wheels", "python-packaging", "first"],
    ["Docker services", "Docker Compose local services", "docker-compose", "first"],
    ["unrelated text", "quasar xylophone nebula", null, "empty"],
    ["unmatched TLS request", "How do I renew a TLS certificate?", null, "empty"],
  ];
  for (const [name, query, expected, kind] of cases) {
    await t.test(name, () => {
      const ids = findSkills(index, query, undefined).map((hit) => hit.id);
      if (kind === "empty") assert.deepEqual(ids, []);
      else if (kind === "first") assert.equal(ids[0], `${source}/${expected}`);
      else if (kind === "top-three") assert.ok(ids.slice(0, 3).includes(`${source}/${expected}`), ids.join(", "));
      else for (const skill of ["github-ci", "gitlab-ci"]) assert.ok(ids.includes(`${source}/${skill}`), ids.join(", "));
    });
  }
  await t.test("YAML anchors rank the real heading while retaining the example", () => {
    const ids = findSkills(index, "YAML anchors", 50).map((hit) => hit.id);
    assert.ok(ids.includes(`${source}/markdown-samples`));
    assert.equal(ids[0], `${source}/config-reuse`);
  });
  await t.test("CLI and stdio MCP agree on limited ordered results and hint", async () => {
    const query = "profile rendering performance";
    const cli = await runCli(["find", query, "--limit", "2", "--json"], { home, fakeBin });
    assert.equal(cli.code, 0, cli.stderr);
    for (const hit of (JSON.parse(cli.stdout) as { results: { revision: string }[] }).results) {
      assert.match(hit.revision, /^sha256:[0-9a-f]{64}$/u);
    }
    const ids = (JSON.parse(cli.stdout) as { results: { id: string }[] }).results.map((hit) => hit.id);
    assert.equal(ids.length, 2);
    const client = new Client({ name: "find-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      env: { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home },
    });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "find_skills", arguments: { task: query, limit: 2 } });
      assert.notEqual(result.isError, true);
      const text = (result.content as { text: string }[]).map((item) => item.text).join("\n");
      assert.deepEqual(
        [...text.matchAll(/^\d+\. (\S+)/gmu)].map((match) => match[1]),
        ids,
      );
      assert.ok(text.includes(`load: margrave load ${ids[0]}`));
      const plain = await runCli(["find", query, "--limit", "2"], { home, fakeBin });
      assert.equal(plain.code, 0, plain.stderr);
      assert.ok(plain.stdout.includes(`load: margrave load ${ids[0]}`));
      const weakQuery = "How do I repair a toaster with Docker?";
      const weak = await client.callTool({ name: "find_skills", arguments: { task: weakQuery, explain: true } });
      const weakText = (weak.content as { text: string }[]).map((item) => item.text).join("\n");
      const cliWeak = await runCli(["find", weakQuery, "--explain"], { home, fakeBin });
      assert.equal(weakText, cliWeak.stdout.trimEnd());
      assert.match(weakText, /weak match/u);
      assert.doesNotMatch(weakText, /load:/u);
    } finally {
      await client.close();
    }
  });
});
