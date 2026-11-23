import { FIND_GUIDANCE } from "../src/search.ts";
import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { installSource } from "../src/sources.ts";
import { catalogRecords, cliSnapshot, disposableHome, fakeRipwire, quiet, runCli, tmp, withPath, writeSkill } from "./helpers.ts";

test("CLI output direct local sources and presentation contracts", async (t) => {
  const home = await disposableHome(t);
  const root = await tmp("mg-cli-output-");
  const fakeBin = await fakeRipwire();
  t.after(async () => {
    await Promise.all([root, fakeBin].map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await mkdir(first);
  await mkdir(second);
  await writeSkill(first, "alpha", "Profile React rendering performance", "# React rendering\nProfile React rendering.\n");
  await writeFile(path.join(first, "alpha", "notes.txt"), "original notes");
  await writeSkill(first, "beta", "Plan database migrations", "# Database\nPlan migrations.\n");
  await writeSkill(second, "gamma", "Profile Vue rendering performance", "# Vue rendering\nProfile Vue rendering.\n");
  const [a, b] = await withPath(
    `${fakeBin}:${process.env["PATH"] ?? ""}`,
    async () => [await installSource(first, null, quiet), await installSource(second, null, quiet)] as const,
  );
  const cli = (args: string[]) => runCli(args, { home, fakeBin, extra: { MARGRAVE_SKILLS_SH: "0" } });
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const records = catalogRecords(home);
  assert.equal(records.length, 2);
  const sources = [
    {
      id: a.id,
      kind: "local",
      spec: first,
      path: first,
      subpath: "",
      ref: null,
      commit: null,
      installedAt: records[0]!.installedAt,
      skillCount: 2,
    },
    {
      id: b.id,
      kind: "local",
      spec: second,
      path: second,
      subpath: "",
      ref: null,
      commit: null,
      installedAt: records[1]!.installedAt,
      skillCount: 1,
    },
  ];
  const headings = `${a.id}  local  ref=-  commit=-  skills=2\n${b.id}  local  ref=-  commit=-  skills=1\n`;
  const descriptors = [
    { id: `${a.id}/alpha`, name: "alpha", description: "Profile React rendering performance", source: a.id },
    { id: `${a.id}/beta`, name: "beta", description: "Plan database migrations", source: a.id },
    { id: `${b.id}/gamma`, name: "gamma", description: "Profile Vue rendering performance", source: b.id },
  ].sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(await cli(["list"]), ok(headings));
  assert.deepEqual(
    await cli(["list", "--skills"]),
    ok(
      `${a.id}  local  ref=-  commit=-  skills=2\n  ${a.id}/alpha: Profile React rendering performance\n  ${a.id}/beta: Plan database migrations\n${b.id}  local  ref=-  commit=-  skills=1\n  ${b.id}/gamma: Profile Vue rendering performance\n`,
    ),
  );
  assert.deepEqual(await cli(["list", "--json"]), ok(json({ sources })));
  assert.deepEqual(
    await cli(["list", "--skills", "--json"]),
    ok(
      json({
        sources: [
          { id: a.id, kind: "local", ref: null, commit: null, skillCount: 2 },
          { id: b.id, kind: "local", ref: null, commit: null, skillCount: 1 },
        ],
        skills: descriptors,
      }),
    ),
  );
  assert.deepEqual(await cli(["check", a.id]), ok(`${a.id}: current\n`));

  const found = await cli(["find", "--category", "general", "React", "rendering", "--limit", "1", "--explain", "--json"]);
  assert.equal(found.code, 0);
  assert.equal(found.stderr, "");
  const parsed = JSON.parse(found.stdout) as {
    task: string;
    results: {
      id: string;
      name: string;
      description: string;
      revision: string;
      source: string;
      commit: null;
      license: null;
      scanVerdict: string;
      scanOverridden: null;
      exact: boolean;
      recommended: boolean;
      matchedTerms: { name: string[]; description: string[]; headings: string[]; body: string[] };
    }[];
    message?: string;
    suggestions?: unknown;
  };
  assert.equal(parsed.task, "React rendering");
  assert.equal(parsed.results.length, 1);
  const hit = parsed.results[0]!;
  assert.deepEqual(
    {
      id: hit.id,
      name: hit.name,
      description: hit.description,
      source: hit.source,
      commit: hit.commit,
      license: hit.license,
      scanVerdict: hit.scanVerdict,
      scanOverridden: hit.scanOverridden,
      recommended: hit.recommended,
    },
    {
      id: `${a.id}/alpha`,
      name: "alpha",
      description: "Profile React rendering performance",
      source: a.id,
      commit: null,
      license: null,
      scanVerdict: "unknown",
      scanOverridden: null,
      recommended: true,
    },
  );
  assert.match(hit.revision, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(hit.matchedTerms.description, ["react", "render"]);
  assert.equal(Object.hasOwn(parsed, "message"), false);
  assert.equal(Object.hasOwn(parsed, "suggestions"), false);
  const unexplained = await cli(["find", "--category", "general", "React", "rendering", "--limit", "1", "--json"]);
  const { exact: _exact, recommended: _recommended, matchedTerms: _matchedTerms, ...unexplainedHit } = hit;
  assert.deepEqual(unexplained, ok(json({ task: "React rendering", results: [unexplainedHit], guidance: FIND_GUIDANCE })));
  const preload = path.join(root, "load-reader.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const prepare = DatabaseSync.prototype.prepare;
let reader;
DatabaseSync.prototype.prepare = function (sql) {
  if (sql.startsWith("SELECT ") && sql.endsWith(" FROM skills WHERE id = ?")) reader = this;
  return prepare.call(this, sql);
};
process.on("exit", () => {
  if (reader === undefined) process.exitCode = 70;
  else if (reader.isOpen) process.exitCode = 71;
});
`,
  );
  const loadWithReaderCheck = (args: string[]) => runCli(args, { home, fakeBin, nodeArgs: ["--import", preload] });
  assert.deepEqual(
    await loadWithReaderCheck(["load", hit.id, "--json", "--revision", hit.revision]),
    ok(
      json({
        id: hit.id,
        source: a.id,
        spec: first,
        commit: null,
        base: path.join(first, "alpha"),
        frontmatter: "name: alpha\ndescription: Profile React rendering performance",
        files: ["SKILL.md", "notes.txt"],
        body: "# React rendering\nProfile React rendering.\n",
      }),
    ),
  );
  assert.deepEqual(await loadWithReaderCheck(["load", "missing-skill"]), {
    code: 1,
    stdout: "",
    stderr: 'margrave: no skill "missing-skill"; run: margrave find "<task>" --category general or margrave list --skills\n',
  });
  assert.deepEqual(
    await cli(["load", hit.id, "--revision", hit.revision]),
    ok(
      `skill: ${hit.id}\nsource: ${a.id} (${first})\ncommit: none (local directory)\nbase: ${path.join(first, "alpha")}\nfrontmatter:\n---\nname: alpha\ndescription: Profile React rendering performance\n---\nfiles:\n- SKILL.md\n- notes.txt\nbody:\n# React rendering\nProfile React rendering.\n`,
    ),
  );
  assert.deepEqual(
    await cli(["load", hit.id, "--file", "notes.txt", "--revision", hit.revision, "--json"]),
    ok(json({ id: hit.id, path: "notes.txt", content: "original notes" })),
  );
  assert.deepEqual(await cli(["load", hit.id, "--file", "notes.txt"]), ok("original notes"));

  await rm(path.join(first, "beta"), { recursive: true });
  await writeFile(path.join(first, "alpha", "notes.txt"), "changed notes");
  assert.deepEqual(await cli(["load", hit.id, "--file", "notes.txt", "--revision", hit.revision]), {
    code: 1,
    stdout: "",
    stderr: "margrave: skill files changed since indexing; ask the store operator to run margrave reindex, then search again\n",
  });
  await writeSkill(first, "delta", "Deploy local services");
  const before = await cliSnapshot(home);
  const drift = {
    id: a.id,
    updateAvailable: false,
    added: [`${a.id}/delta`],
    changed: [`${a.id}/alpha`],
    removed: [`${a.id}/beta`],
    error: null,
  };
  assert.deepEqual(await cli(["check", a.id]), {
    code: 1,
    stdout: `${a.id}: installed files changed\n  added: ${a.id}/delta\n  changed: ${a.id}/alpha\n  removed: ${a.id}/beta\n`,
    stderr: "",
  });
  assert.deepEqual(await cli(["check", a.id, "--json"]), { code: 1, stdout: json([drift]), stderr: "" });
  assert.deepEqual(await cliSnapshot(home), before);
  assert.deepEqual(
    await cli(["update", a.id]),
    ok(`${a.id}: reindexed\n  added: ${a.id}/delta\n  changed: ${a.id}/alpha\n  removed: ${a.id}/beta\n`),
  );
  assert.deepEqual(await cli(["check", a.id]), ok(`${a.id}: current\n`));
  assert.deepEqual(await cli(["reindex"]), ok("reindexed 3 skills from 2 sources\n"));
  await rename(second, `${second}-away`);
  assert.deepEqual(await cli(["check", b.id]), {
    code: 1,
    stdout: "",
    stderr: `${b.id}: ${second} is not readable; remove the source or restore the directory\n`,
  });
  await rename(`${second}-away`, second);
  assert.deepEqual(await cli(["remove", b.id]), ok(`unregistered ${b.id} (the directory was not touched)\n`));
  assert.equal(await readFile(path.join(second, "gamma", "SKILL.md"), "utf8").then((s) => s.includes("Profile Vue")), true);

  const selected = path.join(root, "selected");
  await mkdir(selected);
  for (const name of ["one", "two", "three"]) await writeSkill(selected, name, `${name} selection skill`);
  const installed = await cli(["install", selected, "--skill", "two", "--skill", "one"]);
  const record = catalogRecords(home).find((source) => source.path === selected)!;
  assert.deepEqual(record.selection, ["one", "two"]);
  assert.deepEqual(installed, ok(`installed ${record.id} (2 skills)\n  ${record.id}/one\n  ${record.id}/two\n`));
  await writeSkill(selected, "four", "four selection skill");
  assert.deepEqual(
    await cli(["update", record.id, "--skill", "three", "--skill", "four"]),
    ok(`${record.id}: reindexed\n  added: ${record.id}/four\n  added: ${record.id}/three\n`),
  );
  assert.deepEqual(catalogRecords(home).find((source) => source.id === record.id)!.selection, ["four", "one", "three", "two"]);
});

test("CLI output direct independent drift and update error", async (t) => {
  const home = await disposableHome(t);
  const root = await tmp("mg-cli-status-");
  const fakeBin = await fakeRipwire();
  t.after(async () => {
    await Promise.all([root, fakeBin].map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const source = path.join(root, "source");
  await mkdir(source);
  await writeSkill(source, "alpha", "Alpha skill");
  await writeSkill(source, "beta", "Beta skill");
  const notes = path.join(source, "alpha", "notes.txt");
  await writeFile(notes, "original");
  const { id } = await withPath(`${fakeBin}:${process.env["PATH"] ?? ""}`, () => installSource(source, null, quiet));
  const cli = (args: string[]) => runCli(args, { home, fakeBin });

  await writeSkill(source, "gamma", "Gamma skill");
  assert.deepEqual(await cli(["check", id]), {
    code: 1,
    stdout: `${id}: installed files changed\n  added: ${id}/gamma\n`,
    stderr: "",
  });
  await rm(path.join(source, "gamma"), { recursive: true });

  await writeFile(notes, "changed");
  assert.deepEqual(await cli(["check", id]), {
    code: 1,
    stdout: `${id}: installed files changed\n  changed: ${id}/alpha\n`,
    stderr: "",
  });
  await writeFile(notes, "original");

  await rename(path.join(source, "beta"), path.join(root, "beta"));
  assert.deepEqual(await cli(["check", id]), {
    code: 1,
    stdout: `${id}: installed files changed\n  removed: ${id}/beta\n`,
    stderr: "",
  });
  await rename(path.join(root, "beta"), path.join(source, "beta"));

  await rename(source, path.join(root, "source-away"));
  assert.deepEqual(await cli(["update"]), {
    code: 1,
    stdout: "",
    stderr: `margrave: update ${id} failed: ${source} is not readable; remove the source or restore the directory\n`,
  });
  await rename(path.join(root, "source-away"), source);
});

test("CLI output direct empty store", async (t) => {
  const home = await disposableHome(t);
  const message = "no skill sources installed; run: margrave install <owner/repo|path>";
  assert.deepEqual(await runCli(["check"], { home }), { code: 0, stdout: `${message}\n`, stderr: "" });
  assert.deepEqual(
    await runCli(["find", "--category", "general", "React", "rendering", "--json"], { home, extra: { MARGRAVE_SKILLS_SH: "0" } }),
    {
      code: 0,
      stdout: `${JSON.stringify({ task: "React rendering", results: [], guidance: FIND_GUIDANCE, message }, null, 2)}\n`,
      stderr: "",
    },
  );
});
