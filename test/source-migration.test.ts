import assert from "node:assert/strict";
import { cp, readFile, mkdir, readdir, rename, rm, writeFile, chmod, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateStore } from "../src/source-migration.ts";
import type { SourceRecord } from "../src/store.ts";
import {
  catalogRecords,
  changeAtLock,
  ROOT,
  tmp,
  useHome,
  fakeRipwire,
  link,
  makeRepo,
  runCli,
  writeCatalogRecords,
  writeSkill,
  cliSetup as setup,
  cliMg as mg,
  cliSnapshot as snapshot,
  sourceId,
  CLI,
  call,
  connectHosted,
  hostedUseHome,
} from "./helpers.ts";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("a concurrent migration is recognized after acquiring the writer lock", async (t) => {
  const home = path.join(await tmp("mg-home-"), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  useHome(t, home);
  const records = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as SourceRecord[];
  const hook = changeAtLock(t, 1, () => {
    const db = new DatabaseSync(path.join(home, "index.db"));
    db.exec(
      "CREATE TABLE sources(id TEXT PRIMARY KEY, record TEXT NOT NULL, position INTEGER NOT NULL); UPDATE skills SET dir = 'release-upgrade'; PRAGMA user_version = 4",
    );
    db.prepare("INSERT INTO sources(id, record, position) VALUES (?, ?, 0)").run(records[0]!.id, JSON.stringify(records[0]));
    db.close();
  });
  assert.equal(await migrateStore(), false);
  assert.equal(hook.fired(), true);
  assert.equal(catalogRecords(home)[0]?.id, records[0]?.id);
});

test("migration accepts a store reached through a directory symlink", async () => {
  const root = await tmp();
  const store = path.join(root, "store");
  const alias = path.join(root, "store-link");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), store, { recursive: true, verbatimSymlinks: true });
  await link(store, alias);
  const migrated = await runCli(["migrate"], { home: alias });
  assert.equal(migrated.code, 0, migrated.stderr);
  const loaded = await runCli(["load", "release-upgrade"], { home: alias });
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.match(loaded.stdout, /The installed upgrade skill survived/u);
});

test("migration rejects changed legacy skill bytes without publishing", async () => {
  const home = path.join(await tmp(), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const before = await readFile(path.join(home, "index.db"));
  const source = "example.invalid__fixtures__margrave-upgrade";
  await writeFile(path.join(home, "sources", source, "release-upgrade", "SKILL.md"), "changed bytes");
  const result = await runCli(["migrate"], { home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot upgrade source "example\.invalid__fixtures__margrave-upgrade"/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
});

test("schema 3 migration rebuilds search and preserves accepted Git records", async () => {
  const env = await setup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const before = await snapshot(env.home);
  const db = new DatabaseSync(path.join(env.home, "index.db"));
  db.exec(
    "DROP TABLE fts; CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='unicode61'); PRAGMA user_version = 3",
  );
  db.close();
  const source = sourceId(installed);
  const skill = path.join(env.home, "sources", source, "skills", "react-perf", "SKILL.md");
  const accepted = await readFile(skill);
  const oldCatalog = await readFile(path.join(env.home, "index.db"));
  await writeFile(skill, "changed bytes");
  const rejected = await mg(env, ["migrate"]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /cannot upgrade source/u);
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), oldCatalog);
  await writeFile(skill, accepted);
  const migrated = await mg(env, ["find", "react-perf"]);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.match(migrated.stderr, /margrave: store upgraded\. Backup:/u);
  assert.match(migrated.stdout, /react-perf/u);
  assert.deepEqual(await snapshot(env.home), before);
  assert.match((await mg(env, ["find", "react-perf"])).stdout, /react-perf/u);
});

test("schema 3 automatic migration retries after termination before publication", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  const repo = await makeRepo();
  const fakeBin = await fakeRipwire();
  const installed = await runCli(["install", repo.url], { home, fakeBin });
  assert.equal(installed.code, 0, installed.stderr);
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("PRAGMA user_version = 3");
  db.close();
  const original = await readFile(path.join(home, "index.db"));
  const preload = path.join(parent, "stop.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.rename;
fs.rename = function(from, to) { if (to === ${JSON.stringify(path.join(home, "index.db"))}) process.kill(process.pid, "SIGKILL"); return rename.call(this, from, to); };
syncBuiltinESMExports();\n`,
  );
  assert.notEqual((await runCli(["find", "react-perf"], { home, fakeBin, nodeArgs: ["--import", preload] })).code, 0);
  assert.deepEqual(await readFile(path.join(home, "index.db")), original);
  const found = await runCli(["find", "react-perf"], { home, fakeBin });
  assert.equal(found.code, 0, found.stderr);
  assert.match(found.stdout, /react-perf/u);
  const loaded = await runCli(["load", "react-perf"], { home, fakeBin });
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.match(loaded.stdout, /Body of react-perf/u);
  assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v3-")).length, 1);
});

test("schema 3 migration refuses changed local content without publication", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "Original description");
  assert.equal((await mg(env, ["install", dir])).code, 0);
  const db = new DatabaseSync(path.join(env.home, "index.db"));
  db.exec("PRAGMA user_version = 3");
  db.close();
  const before = await readFile(path.join(env.home, "index.db"));
  await writeSkill(dir, "alpha", "Changed description");
  const result = await mg(env, ["migrate"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot upgrade source/u);
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
});

test("schema 3 migration rejects selection metadata", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "Alpha skill");
  const installed = await mg(env, ["install", dir]);
  assert.equal(installed.code, 0, installed.stderr);
  const records = catalogRecords(env.home);
  records[0]!.selection = ["alpha"];
  writeCatalogRecords(env.home, records);
  const db = new DatabaseSync(path.join(env.home, "index.db"));
  db.exec("PRAGMA user_version = 3");
  db.close();
  const before = await readFile(path.join(env.home, "index.db"));
  const result = await mg(env, ["migrate"]);
  assert.match(result.stderr, /cannot upgrade source/u);
  assert.deepEqual(await readFile(path.join(env.home, "index.db")), before);
});

test("migration preserves a legacy local source with no indexed skills", async () => {
  const home = path.join(await tmp(), "store");
  const local = await tmp();
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const record = {
    id: "local__empty-123456",
    kind: "local",
    spec: local,
    path: local,
    subpath: "",
    ref: null,
    commit: null,
    installedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(path.join(home, "sources.json"), JSON.stringify([record]));
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("DELETE FROM fts; DELETE FROM skills");
  db.close();
  const conflicting = path.join(await tmp(), "store");
  await cp(home, conflicting, { recursive: true, verbatimSymlinks: true });
  const migrated = await runCli(["migrate"], { home });
  assert.equal(migrated.code, 0, migrated.stderr);
  const list = await runCli(["list", "--json"], { home });
  assert.equal(list.code, 0, list.stderr);
  const result = JSON.parse(list.stdout) as { sources: { id: string; skillCount: number }[] };
  assert.equal(result.sources[0]?.id, record.id);
  assert.equal(result.sources[0]?.skillCount, 0);
  await writeSkill(local, "new-skill", "unindexed skill");
  const rejected = await runCli(["migrate"], { home: conflicting });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /cannot upgrade source "local__empty-123456"/u);
});

test("migration preserves a Git skill at the snapshot root", async () => {
  const home = path.join(await tmp(), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const source = "example.invalid__fixtures__margrave-upgrade";
  const records = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { snapshot: string }[];
  const snapshotDir = path.join(home, "snapshots", source, records[0]!.snapshot);
  await rename(path.join(snapshotDir, "release-upgrade", "SKILL.md"), path.join(snapshotDir, "SKILL.md"));
  await rm(path.join(snapshotDir, "release-upgrade"), { recursive: true });
  const db = new DatabaseSync(path.join(home, "index.db"));
  db.exec("UPDATE skills SET dir = substr(dir, 1, length(dir) - length('/release-upgrade'))");
  db.close();
  const migrated = await runCli(["migrate"], { home });
  assert.equal(migrated.code, 0, migrated.stderr);
  const loaded = await runCli(["load", "release-upgrade"], { home });
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.match(loaded.stdout, /The installed upgrade skill survived/u);
});

test("migration refuses incomplete and conflicting legacy catalogs", async () => {
  const source = "example.invalid__fixtures__margrave-upgrade";
  const cases: { name: string; mutate: (home: string) => Promise<void> | void; expected: RegExp }[] = [
    { name: "missing source file", mutate: async (home) => rm(path.join(home, "sources.json")), expected: /sources\.json is missing/u },
    {
      name: "legacy scan provenance",
      mutate: async (home) => {
        const file = path.join(home, "sources.json");
        const records = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
        records[0]!["scan"] = { code: 0, files: [], keys: [], overridden: false, tree: null, verdict: "clean", version: null };
        await writeFile(file, JSON.stringify(records));
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "malformed source file",
      mutate: async (home) => writeFile(path.join(home, "sources.json"), "invalid json"),
      expected: /cannot upgrade the v0\.2\.1 catalog/u,
    },
    {
      name: "source identity mismatch",
      mutate: async (home) => {
        const file = path.join(home, "sources.json");
        const records = JSON.parse(await readFile(file, "utf8")) as { spec: string }[];
        records[0]!.spec = "other/repo";
        await writeFile(file, JSON.stringify(records));
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "duplicate source record",
      mutate: async (home) => {
        const file = path.join(home, "sources.json");
        const records = JSON.parse(await readFile(file, "utf8")) as unknown[];
        await writeFile(file, JSON.stringify([...records, records[0]]));
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "unknown indexed source",
      mutate: (home) => {
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.exec(
          "INSERT INTO skills(id, id_lc, name, name_lc, description, source, dir, hash, manifest, frontmatter) VALUES ('unknown/x', 'unknown/x', 'x', 'x', '', 'unknown', '/x', 'h', '[]', '')",
        );
        db.close();
      },
      expected: /index contains an unknown source/u,
    },
    {
      name: "indexed path escape",
      mutate: (home) => {
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.exec("UPDATE skills SET dir = dir || '/../../escape'");
        db.close();
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "indexed path with a different skill directory",
      mutate: (home) => {
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.exec("UPDATE skills SET dir = replace(dir, '/release-upgrade', '/different')");
        db.close();
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "indexed path with an invalid snapshot suffix",
      mutate: async (home) => {
        const records = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { snapshot: string }[];
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.prepare("UPDATE skills SET dir = replace(dir, ?, ?)").run(records[0]!.snapshot, `${records[0]!.snapshot}-other`);
        db.close();
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "snapshot symlink escape",
      mutate: async (home) => {
        const records = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { snapshot: string }[];
        const snapshotDir = path.join(home, "snapshots", source, records[0]!.snapshot);
        const outside = path.join(await tmp(), "outside");
        await rename(snapshotDir, outside);
        await link(outside, snapshotDir);
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    },
    {
      name: "interrupted legacy write",
      mutate: async (home) => writeFile(path.join(home, "index.db-journal"), "unfinished"),
      expected: /unfinished v0\.2\.1 write/u,
    },
  ];
  for (const [column, value] of [
    ["id", "different/id"],
    ["hash", `sha256:${"0".repeat(64)}`],
    ["manifest", "[]"],
    ["name", "different-name"],
    ["description", "different description"],
    ["frontmatter", "different frontmatter"],
    ["dir", "relative/path"],
    ["dir", "/tmp/outside"],
  ]) {
    cases.push({
      name: `changed ${column}`,
      mutate: (home) => {
        const db = new DatabaseSync(path.join(home, "index.db"));
        db.prepare(`UPDATE skills SET ${column} = ?`).run(value!);
        db.close();
      },
      expected: new RegExp(`cannot upgrade source "${source}"`, "u"),
    });
  }
  for (const item of cases) {
    const home = path.join(await tmp(), "store");
    await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
    await item.mutate(home);
    const before = await readFile(path.join(home, "index.db"));
    const result = await runCli(["migrate"], { home });
    assert.equal(result.code, 1, item.name);
    assert.match(result.stderr, item.expected, item.name);
    assert.deepEqual(await readFile(path.join(home, "index.db")), before, item.name);
  }
  const empty = await tmp();
  const current = await runCli(["migrate"], { home: empty });
  assert.equal(current.code, 0, current.stderr);
  assert.equal(current.stdout, "store is current\n");
  await writeFile(path.join(empty, "sources.json"), "[]");
  const missing = await runCli(["migrate"], { home: empty });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /index\.db is missing/u);
  await writeFile(path.join(empty, "index.db"), "");
  const unsupported = await runCli(["migrate"], { home: empty });
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.stderr, /not a supported margrave catalog/u);
});

test("migration rolls back a failed temporary catalog transaction", async () => {
  const home = path.join(await tmp(), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(await tmp(), "fail-migration-commit.mjs");
  await writeFile(
    preload,
    `import { DatabaseSync } from "node:sqlite";
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) { if (sql === "PRAGMA user_version = 4; COMMIT") throw new Error("migration commit failed"); return exec.call(this, sql); };\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /migration commit failed/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
  assert.ok(!(await readdir(home)).some((name) => name.startsWith(".catalog-")));
  assert.equal((await runCli(["migrate"], { home })).code, 0);
});

test("migration reports source metadata access failures without changing the store", async () => {
  for (const legacyIndex of [false, true]) {
    const home = path.join(await tmp(), "store");
    await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
    const index = path.join(home, "index.db");
    if (!legacyIndex) await rm(index);
    const before = legacyIndex ? await readFile(index) : null;
    const source = path.join(home, "sources.json");
    const preload = path.join(await tmp(), "fail-source-stat.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstat;
fs.lstat = function(file, ...args) { if (file === ${JSON.stringify(source)}) return Promise.reject(Object.assign(new Error("source metadata denied"), { code: "EACCES" })); return lstat.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
    );
    const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /source metadata denied/u);
    if (before !== null) assert.deepEqual(await readFile(index), before);
    else await assert.rejects(readFile(index), { code: "ENOENT" });
  }
});

test("migration reports a non-Error metadata read failure", async () => {
  const home = path.join(await tmp(), "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const before = await readFile(path.join(home, "index.db"));
  const preload = path.join(await tmp(), "fail-source-read.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const readFile = fs.readFile;
fs.readFile = function(file, ...args) { if (file === ${JSON.stringify(path.join(home, "sources.json"))}) return Promise.reject("source read failed"); return readFile.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
  );
  const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /cannot upgrade the v0\.2\.1 catalog: source read failed/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), before);
});

test("legacy source metadata failures after lock acquisition preserve the catalog", async () => {
  for (const operation of ["lstat", "readFile"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
    const index = path.join(home, "index.db");
    const source = path.join(home, "sources.json");
    const before = await readFile(index);
    const preload = path.join(parent, "fail-late.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const operation = ${JSON.stringify(operation)}; const original = fs[operation]; let visits = 0;
fs[operation] = function(file, ...args) { if (file === ${JSON.stringify(source)} && ++visits === 2) return Promise.reject(operation === "lstat" ? Object.assign(new Error("late metadata denied"), { code: "EACCES" }) : "late source read failed"); return original.call(this, file, ...args); };
syncBuiltinESMExports();\n`,
    );
    const failed = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    assert.equal(failed.code, 1, operation);
    assert.match(
      failed.stderr,
      operation === "lstat" ? /late metadata denied/u : /cannot upgrade the v0\.2\.1 catalog: late source read failed/u,
    );
    assert.deepEqual(await readFile(index), before);
    assert.equal((await runCli(["migrate"], { home })).code, 0);
  }
});

test("migration handles catalog changes between its probes", async () => {
  for (const change of ["missing", "current", "journal", "gone", "probe-error"]) {
    const parent = await tmp();
    const home = path.join(parent, "store");
    await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
    const index = path.join(home, "index.db");
    const before = await readFile(index);
    const preload = path.join(parent, "change-probe.mjs");
    const replacement = path.join(parent, "current.db");
    if (change === "current") {
      const other = path.join(parent, "other");
      await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), other, { recursive: true, verbatimSymlinks: true });
      assert.equal((await runCli(["migrate"], { home: other })).code, 0);
      await cp(path.join(other, "index.db"), replacement);
    }
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const readdir = fs.readdir; const lstat = fs.lstat; let changed = false; let journals = 0; let indexes = 0;
fs.readdir = async function(dir, ...args) {
  if (!changed && dir === ${JSON.stringify(home)} && !["journal", "gone", "probe-error"].includes(${JSON.stringify(change)})) {
    changed = true;
    if (${JSON.stringify(change)} === "missing") await fs.rename(${JSON.stringify(index)}, ${JSON.stringify(`${index}.saved`)});
    else await fs.copyFile(${JSON.stringify(replacement)}, ${JSON.stringify(index)});
  }
  return readdir.call(this, dir, ...args);
};
fs.lstat = async function(file, ...args) {
  if (${JSON.stringify(change)} === "gone" && file === ${JSON.stringify(index)} && ++indexes >= 2) throw Object.assign(new Error("gone"), { code: "ENOENT" });
  if (${JSON.stringify(change)} === "gone" && file === ${JSON.stringify(path.join(home, "sources.json"))} && indexes >= 2) throw Object.assign(new Error("gone"), { code: "ENOENT" });
  if (file === ${JSON.stringify(`${index}-journal`)} && ${JSON.stringify(change)} === "probe-error" && ++journals === 3) throw Object.assign(new Error("probe failure"), { code: "EACCES" });
  if (file === ${JSON.stringify(`${index}-journal`)} && ${JSON.stringify(change)} === "journal" && ++journals === 3) await fs.writeFile(file, Buffer.alloc(512));
  return lstat.call(this, file, ...args);
}; syncBuiltinESMExports();\n`,
    );
    const result = await runCli(["migrate"], { home, nodeArgs: ["--import", preload] });
    if (change === "current" || change === "gone") {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "store is current\n");
      if (change === "gone") {
        assert.deepEqual(await readFile(index), before);
        assert.equal((await runCli(["migrate"], { home })).code, 0);
      }
    } else {
      assert.equal(result.code, 1, change);
      assert.match(
        result.stderr,
        change === "missing" ? /index\.db is missing/u : change === "probe-error" ? /probe failure/u : /unfinished v0\.2\.1 write/u,
      );
      if (change === "missing") await rename(`${index}.saved`, index);
      else if (change === "journal") await rm(`${index}-journal`);
      assert.deepEqual(await readFile(index), before);
      assert.equal((await runCli(["migrate"], { home })).code, 0);
    }
  }
});

test("migration rejects a non-file legacy source list", async () => {
  const parent = await tmp();
  const home = path.join(parent, "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const sourceFile = path.join(home, "sources.json");
  const original = await readFile(sourceFile);
  const index = await readFile(path.join(home, "index.db"));
  await rm(sourceFile);
  await mkdir(sourceFile);
  const refused = await runCli(["migrate"], { home });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /cannot verify the interrupted Margrave upgrade/u);
  assert.deepEqual(await readFile(path.join(home, "index.db")), index);
  await rm(sourceFile, { recursive: true });
  await writeFile(sourceFile, original);
  const retried = await runCli(["migrate"], { home });
  assert.equal(retried.code, 0, retried.stderr);
});

test("released v0.2.1 store remains usable after upgrade", async (t) => {
  const home = await hostedUseHome(t);
  t.after(() => rm(home, { recursive: true, force: true }));
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const source = "example.invalid__fixtures__margrave-upgrade";
  const id = `${source}/release-upgrade`;
  const body = "The installed upgrade skill survived.";
  const sources = await readFile(path.join(home, "sources.json"), "utf8");
  const beforeMigration = await runCli(["find", "release upgrade"], { home });
  assert.equal(beforeMigration.code, 0, beforeMigration.stderr);
  assert.ok(beforeMigration.stdout.includes(id));
  const marker = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { kind: string; backup: string };
  assert.equal(marker.kind, "margrave-store-migration");
  const backup = path.join(path.dirname(await realpath(home)), marker.backup);
  t.after(() => rm(backup, { recursive: true, force: true }));
  assert.match(beforeMigration.stderr, /margrave: store upgraded\. Backup:/u);
  assert.equal(execFileSync("/usr/bin/tar", ["-xOf", path.join(backup, "store.tar"), "./sources.json"], { encoding: "utf8" }), sources);
  assert.equal(catalogRecords(home)[0]?.scan, undefined);
  const migration = await runCli(["migrate"], { home });
  assert.equal(migration.code, 0, migration.stderr);
  assert.equal(migration.stdout, "store is current\n");
  const filesBeforeRepeat = (await readdir(home)).sort();
  const repeated = await runCli(["migrate"], { home });
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(repeated.stdout, "store is current\n");
  assert.deepEqual((await readdir(home)).sort(), filesBeforeRepeat);
  await chmod(home, 0o555);
  try {
    const readOnlyRepeat = await runCli(["migrate"], { home });
    assert.equal(readOnlyRepeat.code, 0, readOnlyRepeat.stderr);
    assert.equal(readOnlyRepeat.stdout, "store is current\n");
  } finally {
    await chmod(home, 0o755);
  }
  const found = await runCli(["find", "release upgrade"], { home });
  assert.equal(found.code, 0, found.stderr);
  assert.ok(found.stdout.includes(id), found.stdout);
  const loaded = await runCli(["load", id], { home });
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.ok(loaded.stdout.includes(body), loaded.stdout);

  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      env: { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home },
    }),
  );
  const hosted = await connectHosted(t);
  const homeMode = (await lstat(home)).mode & 0o777;
  const index = path.join(home, "index.db");
  const indexMode = (await lstat(index)).mode & 0o777;
  await chmod(index, 0o444);
  await chmod(home, 0o555);
  try {
    for (const mcp of [client, hosted]) {
      const result = await call(mcp, "find_skills", { task: "release upgrade" });
      assert.equal(result.isError, false, result.text);
      assert.ok(result.text.includes(id), result.text);
      const skill = await call(mcp, "load_skill", { id });
      assert.equal(skill.isError, false, skill.text);
      assert.ok(skill.text.includes(body), skill.text);
    }
  } finally {
    await chmod(index, indexMode);
    await chmod(home, homeMode);
  }
  const reindex = await runCli(["reindex"], { home });
  assert.equal(reindex.code, 0, reindex.stderr);
  assert.match(reindex.stdout, /1 skills? from 1 sources?/u);
  assert.equal(JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")).kind, "margrave-store-migration");
  const after = await runCli(["load", id], { home });
  assert.equal(after.code, 0, after.stderr);
  assert.ok(after.stdout.includes(body), after.stdout);
});

test("stdio upgrades an untouched released store before serving", async (t) => {
  const parent = await tmp("mg-stdio-upgrade-");
  const home = path.join(parent, "store");
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const child = spawn(process.execPath, [CLI, "mcp"], {
    env: { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home },
  });
  const exited = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await exited;
    lines.close();
    await rm(parent, { recursive: true, force: true });
  });
  async function request(id: number, method: string, params: Record<string, unknown>): Promise<string> {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const line = await Promise.race([
      once(lines, "line").then(([value]) => value as string),
      exited.then(() => {
        throw new Error(`stdio exited: ${stderr}`);
      }),
    ]);
    const response = JSON.parse(line) as { error?: unknown; result?: unknown };
    assert.equal(response.error, undefined);
    return JSON.stringify(response.result);
  }
  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const found = await request(2, "tools/call", { name: "find_skills", arguments: { task: "release upgrade" } });
  assert.match(found, /release-upgrade/u);
  const loaded = await request(3, "tools/call", {
    name: "load_skill",
    arguments: { id: "example.invalid__fixtures__margrave-upgrade/release-upgrade" },
  });
  assert.match(loaded, /The installed upgrade skill survived/u);
  assert.match(stderr, /margrave: store upgraded\. Backup:/u);
});

test("stdio resumes interrupted legacy migrations", async (t) => {
  for (const checkpoint of ["before-record", "record", "nonhot", "changes", "committed"]) {
    const parent = await tmp("mg-stdio-retry-");
    const home = path.join(parent, "store");
    await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
    const original = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { id: string; ref: string; commit: string }[];
    const preload = path.join(parent, "stop.mjs");
    await writeFile(
      preload,
      `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
const checkpoint = ${JSON.stringify(checkpoint)};
const rename = fs.rename;
fs.rename = async function(from, to) { if (checkpoint === "before-record" && to === ${JSON.stringify(path.join(home, "sources.json"))}) process.kill(process.pid, "SIGKILL"); return rename.call(this, from, to); };
syncBuiltinESMExports();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (checkpoint === "record" && sql.startsWith("CREATE TABLE sources")) process.kill(process.pid, "SIGKILL");
  const result = exec.call(this, sql);
  if (checkpoint === "nonhot" && sql.startsWith("CREATE TABLE sources")) process.kill(process.pid, "SIGKILL");
  if (checkpoint === "changes" && sql.startsWith("DROP TABLE fts")) { exec.call(this, "PRAGMA cache_size = 1; UPDATE skills SET description = hex(randomblob(300000))"); process.kill(process.pid, "SIGKILL"); }
  if (checkpoint === "committed" && sql === "PRAGMA user_version = 4; COMMIT") process.kill(process.pid, "SIGKILL");
  return result;
};\n`,
    );
    assert.notEqual((await runCli(["migrate"], { home, nodeArgs: ["--import", preload] })).code, 0);
    const child = spawn(process.execPath, [CLI, "mcp"], { env: { PATH: process.env["PATH"] ?? "", MARGRAVE_HOME: home } });
    const exited = once(child, "close");
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const lines = createInterface({ input: child.stdout });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      lines.close();
      await rm(parent, { recursive: true, force: true });
    });
    async function request(id: number, method: string, params: Record<string, unknown>): Promise<string> {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const line = await Promise.race([
        once(lines, "line").then(([value]) => value as string),
        exited.then(() => {
          throw new Error(`stdio exited: ${stderr}`);
        }),
      ]);
      const response = JSON.parse(line) as { error?: unknown; result?: unknown };
      assert.equal(response.error, undefined, checkpoint);
      return JSON.stringify(response.result);
    }
    await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    assert.match(await request(2, "tools/call", { name: "find_skills", arguments: { task: "release upgrade" } }), /release-upgrade/u);
    assert.match(
      await request(3, "tools/call", { name: "load_skill", arguments: { id: `${original[0]!.id}/release-upgrade` } }),
      /The installed upgrade skill survived/u,
    );
    child.stdin.end();
    assert.equal((await exited)[0], 0, stderr);
    assert.equal(stderr.includes("store upgraded. Backup:"), checkpoint !== "committed", checkpoint);
    assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-")).length, 1);
    const current = catalogRecords(home)[0]!;
    assert.deepEqual([current.id, current.ref, current.commit], [original[0]!.id, original[0]!.ref, original[0]!.commit]);
  }
});

test("concurrent first use publishes one backup", async (t) => {
  const parent = await tmp("mg-concurrent-upgrade-");
  const home = path.join(parent, "store");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const results = await Promise.all([
    runCli(["find", "release upgrade", "--json"], { home }),
    runCli(["find", "release upgrade", "--json"], { home }),
  ]);
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).results.length > 0);
  }
  assert.equal(results.filter((result) => result.stderr.includes("store upgraded. Backup:")).length, 1);
  assert.equal((await readdir(parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-")).length, 1);
});

test("usage and setup commands do not upgrade a legacy store", async (t) => {
  const parent = await tmp("mg-usage-upgrade-");
  const home = path.join(parent, "store");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(path.join(ROOT, "test/fixtures/store-v0.2.1/store"), home, { recursive: true, verbatimSymlinks: true });
  const index = await readFile(path.join(home, "index.db"));
  const sources = await readFile(path.join(home, "sources.json"));
  for (const args of [["--help"], ["version"], ["wrap", "generic"], ["find"], ["update", "source", "--ref", "bad"]]) {
    const result = await runCli(args, { home });
    assert.equal(result.code, args[0] === "find" || args[0] === "update" ? 2 : 0, result.stderr);
    assert.deepEqual(await readFile(path.join(home, "index.db")), index);
    assert.deepEqual(await readFile(path.join(home, "sources.json")), sources);
  }
  assert.deepEqual(await readdir(parent), ["store"]);
});
