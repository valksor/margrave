import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp, { mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { installSource, updateSources } from "../src/sources.ts";
import { deleteSourceSkills } from "../src/store.ts";
import {
  catalogRecords,
  changeAtLock,
  fakeRipwire,
  git,
  head,
  indexIds,
  indexRows,
  makeRepo,
  quiet,
  realClose,
  tmp,
  useHome,
  writeCatalogRecords,
  writeIndexRows,
  writeSkill,
} from "./helpers.ts";

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = await tmp("mg-update-direct-");
  const bin = await fakeRipwire();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const home = path.join(root, "home");
  useHome(t, home);
  const oldPath = process.env["PATH"];
  process.env["PATH"] = `${bin}:${oldPath ?? ""}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
  });
  return { root, home };
}

test("sources update direct validates arguments and preserves state", async (t) => {
  const { root, home } = await fixture(t);
  const nativeLstat = fsp.lstat;
  const nativePrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as typeof DatabaseSync.prototype.prepare;
  let indexStats = 0;
  let catalogReads = 0;
  const lstat = mock.method(fsp, "lstat", ((p: string, ...args: unknown[]) => {
    if (p === path.join(home, "index.db")) indexStats++;
    return (nativeLstat as (...args: unknown[]) => unknown)(p, ...args);
  }) as typeof fsp.lstat);
  const prepare = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "SELECT id, record FROM sources ORDER BY position") catalogReads++;
    return nativePrepare.call(this, sql);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(updateSources(null, quiet, "main"), { message: "update --ref requires one Git source" });
  } finally {
    lstat.mock.restore();
    prepare.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(indexStats, 0);
  assert.equal(catalogReads, 0);
  await assert.rejects(fsp.stat(home), { code: "ENOENT" });
  const whole = path.join(root, "whole"),
    selected = path.join(root, "selected");
  await mkdir(whole);
  await mkdir(selected);
  await writeSkill(whole, "whole", "whole");
  for (const name of ["alpha", "beta", "gamma"]) await writeSkill(selected, name, name);
  const a = await installSource(whole, null, quiet);
  const b = await installSource(selected, null, quiet, ["alpha"]);
  const records = catalogRecords(home),
    rows = indexRows(home);
  for (const arg of [null, selected, "unknown"]) {
    await assert.rejects(updateSources(arg, quiet, null, ["beta"]), { message: "skill selection requires an explicit source ID" });
  }
  await assert.rejects(updateSources("unknown", quiet), { message: 'no source "unknown"; run: margrave list' });
  const probes: DatabaseSync[] = [];
  const readers: DatabaseSync[] = [];
  const selectionPrepare = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (this.location("main") === path.join(home, "index.db")) {
      if (sql.includes("FROM sqlite_master") && sql.includes("pragma_user_version")) probes.push(this);
      if (sql === "SELECT id, record FROM sources ORDER BY position") readers.push(this);
    }
    return nativePrepare.call(this, sql);
  });
  try {
    await assert.rejects(updateSources(a.id, quiet, null, ["whole"]), { message: `source "${a.id}" already installs all skills` });
  } finally {
    selectionPrepare.mock.restore();
  }
  assert.equal(probes.length, 1);
  assert.deepEqual(readers, probes);
  await assert.rejects(updateSources(a.id, quiet, "main"), { message: "update --ref requires one Git source" });
  assert.deepEqual(catalogRecords(home), records);
  assert.deepEqual(indexRows(home), rows);
  const expanded = await updateSources(b.id, quiet, null, ["gamma", "beta", "gamma"]);
  assert.deepEqual(expanded, {
    results: [
      { id: b.id, kind: "local", oldCommit: null, newCommit: null, added: [`${b.id}/beta`, `${b.id}/gamma`], changed: [], removed: [] },
    ],
    errors: [],
  });
  assert.deepEqual(catalogRecords(home).find((r) => r.id === b.id)?.selection, ["alpha", "beta", "gamma"]);
  assert.deepEqual(
    catalogRecords(home).find((r) => r.id === a.id),
    records.find((r) => r.id === a.id),
  );
  const all = await updateSources(null, quiet);
  assert.deepEqual(all.errors, []);
  assert.equal(all.results.length, 2);
  assert.deepEqual((await updateSources(whole, quiet)).errors, []);
});

test("sources update direct replaces local rows and keeps unrelated records", async (t) => {
  const { root, home } = await fixture(t);
  const first = path.join(root, "first"),
    second = path.join(root, "second");
  await mkdir(first);
  await mkdir(second);
  for (const name of ["changed", "removed"]) await writeSkill(first, name, name);
  for (const name of ["alpha", "beta", "gamma"]) await writeSkill(second, name, name);
  const a = await installSource(first, null, quiet);
  const b = await installSource(second, null, quiet, ["alpha"]);
  const before = catalogRecords(home);
  const secondRows = indexRows(home).filter((r) => r.source === b.id);
  await rm(path.join(first, "removed"), { recursive: true });
  await writeSkill(first, "changed", "changed description");
  await writeSkill(first, "added", "added");
  assert.deepEqual(await updateSources(a.id, quiet), {
    results: [
      {
        id: a.id,
        kind: "local",
        oldCommit: null,
        newCommit: null,
        added: [`${a.id}/added`],
        changed: [`${a.id}/changed`],
        removed: [`${a.id}/removed`],
      },
    ],
    errors: [],
  });
  assert.deepEqual(
    indexRows(home).filter((r) => r.source === b.id),
    secondRows,
  );
  assert.deepEqual(catalogRecords(home), before);
  assert.deepEqual(indexIds(home), [`${a.id}/added`, `${a.id}/changed`, `${b.id}/alpha`].sort());
  assert.deepEqual(await updateSources(b.id, quiet, null, ["gamma", "beta", "beta"]), {
    results: [
      { id: b.id, kind: "local", oldCommit: null, newCommit: null, added: [`${b.id}/beta`, `${b.id}/gamma`], changed: [], removed: [] },
    ],
    errors: [],
  });
  assert.deepEqual(catalogRecords(home).find((r) => r.id === b.id)?.selection, ["alpha", "beta", "gamma"]);
  assert.deepEqual(
    catalogRecords(home).find((r) => r.id === a.id),
    before.find((r) => r.id === a.id),
  );
});

test("sources update direct refuses publication after selected local source removal", async (t) => {
  const { root, home } = await fixture(t);
  const first = path.join(root, "first"),
    second = path.join(root, "second");
  await mkdir(first);
  await mkdir(second);
  await writeSkill(first, "alpha", "alpha");
  await writeSkill(first, "beta", "beta");
  await writeSkill(second, "other", "other");
  const a = await installSource(first, null, quiet, ["alpha"]);
  const b = await installSource(second, null, quiet);
  const remaining = catalogRecords(home).filter((r) => r.id === b.id);
  const rows = indexRows(home).filter((r) => r.source === b.id);
  const race = changeAtLock(t, 1, () => {
    writeIndexRows(home, (db) => deleteSourceSkills(db, a.id));
    writeCatalogRecords(home, remaining);
  });
  await assert.rejects(updateSources(a.id, quiet, null, ["beta"]), { message: `no source "${a.id}"` });
  assert.equal(race.fired(), true);
  assert.deepEqual(catalogRecords(home), remaining);
  assert.deepEqual(indexRows(home), rows);
});

test("sources update direct checks a vanished catalog once for all sources", async (t) => {
  const { root, home } = await fixture(t);
  const source = path.join(root, "source");
  await mkdir(source);
  await writeSkill(source, "alpha", "alpha");
  await installSource(source, null, quiet);
  const records = catalogRecords(home),
    rows = indexRows(home);
  const nativePrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as typeof DatabaseSync.prototype.prepare;
  const readers = new WeakSet<DatabaseSync>();
  let removed = false;
  const prepare = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "SELECT id, record FROM sources ORDER BY position") {
      const dbs = nativePrepare.call(this, "PRAGMA database_list").all() as unknown as { name: string; file: string }[];
      if (dbs.some((db) => db.name === "main" && db.file === path.join(home, "index.db"))) readers.add(this);
    }
    return nativePrepare.call(this, sql);
  });
  const close = mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    realClose.call(this);
    if (readers.has(this) && !removed) {
      fs.renameSync(path.join(home, "index.db"), path.join(home, "saved.db"));
      removed = true;
    }
  });
  try {
    await assert.rejects(updateSources(null, quiet), { message: "index.db is missing. Restore the complete store backup" });
  } finally {
    close.mock.restore();
    prepare.mock.restore();
    if (removed) fs.renameSync(path.join(home, "saved.db"), path.join(home, "index.db"));
  }
  assert.equal(removed, true);
  assert.deepEqual(catalogRecords(home), records);
  assert.deepEqual(indexRows(home), rows);
});

test("sources update direct validates an explicit selection target before an additional index check", async (t) => {
  const { root, home } = await fixture(t);
  const source = path.join(root, "source");
  await mkdir(source);
  await writeSkill(source, "alpha", "alpha");
  await installSource(source, null, quiet, ["alpha"]);
  const records = catalogRecords(home),
    rows = indexRows(home);
  const nativePrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as typeof DatabaseSync.prototype.prepare;
  const probes: DatabaseSync[] = [];
  const readers: DatabaseSync[] = [];
  const spy = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (this.location("main") === path.join(home, "index.db")) {
      if (sql.includes("FROM sqlite_master") && sql.includes("pragma_user_version")) probes.push(this);
      if (sql === "SELECT id, record FROM sources ORDER BY position") readers.push(this);
    }
    return nativePrepare.call(this, sql);
  });
  try {
    await assert.rejects(updateSources(source, quiet, null, ["alpha"]), { message: "skill selection requires an explicit source ID" });
  } finally {
    spy.mock.restore();
  }
  assert.equal(probes.length, 1);
  assert.deepEqual(readers, probes);
  assert.deepEqual(catalogRecords(home), records);
  assert.deepEqual(indexRows(home), rows);
});

test("sources update direct publishes a new Git revision and retains its old snapshot", async (t) => {
  const { home } = await fixture(t);
  const repo = await makeRepo();
  t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const installed = await installSource(repo.url, "main", quiet);
  const old = catalogRecords(home)[0]!;
  const oldRows = indexRows(home);
  await rm(path.join(repo.dir, "skills", "docker-compose"), { recursive: true });
  await writeSkill(path.join(repo.dir, "skills"), "react-perf", "changed React skill");
  await writeSkill(path.join(repo.dir, "skills"), "new-skill", "new skill");
  await mkdir(path.join(repo.dir, "skills", "invalid"));
  await writeFile(path.join(repo.dir, "skills", "invalid", "SKILL.md"), "no frontmatter\n");
  await symlink("react-perf", path.join(repo.dir, "skills", "linked"));
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "replacement");
  const sha = await head(repo.dir);
  const nativeRm = fsp.rm;
  const nativeReaddir = fsp.readdir;
  let scans = 0;
  const scanSpy = mock.method(fsp, "readdir", ((p: string, options: unknown) => {
    if (
      p.startsWith(path.join(home, "staging") + path.sep) &&
      p.endsWith(`${path.sep}repo`) &&
      (options as { withFileTypes?: boolean })?.withFileTypes === true
    )
      scans++;
    return (nativeReaddir as (...args: unknown[]) => unknown)(p, options);
  }) as typeof fsp.readdir);
  const removals: { path: string; options: unknown }[] = [];
  const spy = mock.method(fsp, "rm", ((p: string, options: unknown) => {
    if (p.startsWith(path.join(home, "staging") + path.sep) && p.endsWith(`${path.sep}repo${path.sep}.git`))
      removals.push({ path: p, options });
    return (nativeRm as (...args: unknown[]) => unknown)(p, options);
  }) as typeof fsp.rm);
  syncBuiltinESMExports();
  const messages: string[] = [];
  try {
    assert.deepEqual(await updateSources(installed.id, { ...quiet, log: (s) => messages.push(s) }, "refs/heads/main"), {
      results: [
        {
          id: installed.id,
          kind: "git",
          oldCommit: old.commit,
          newCommit: sha,
          added: [`${installed.id}/new-skill`],
          changed: [`${installed.id}/react-perf`],
          removed: [`${installed.id}/docker-compose`],
        },
      ],
      errors: [],
    });
  } finally {
    spy.mock.restore();
    scanSpy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(scans, 2);
  assert.equal(removals.length, 1);
  assert.deepEqual(removals[0]!.options, { recursive: true, force: true });
  const clone = path.dirname(removals[0]!.path);
  const current = catalogRecords(home)[0]!;
  assert.equal(current.commit, sha);
  assert.equal(current.ref, "refs/heads/main");
  assert.notEqual(current.snapshot, old.snapshot);
  assert.equal(current.scan?.verdict, "clean");
  assert.equal(Object.hasOwn(current, "selection"), false);
  assert.deepEqual(indexIds(home), [`${installed.id}/new-skill`, `${installed.id}/postgres-tuning`, `${installed.id}/react-perf`].sort());
  assert.deepEqual(
    indexRows(home).find((r) => r.id.endsWith("/postgres-tuning"))?.hash,
    oldRows.find((r) => r.id.endsWith("/postgres-tuning"))?.hash,
  );
  assert.ok(
    (await readFile(path.join(home, "snapshots", installed.id, old.snapshot!, "skills", "docker-compose", "SKILL.md"), "utf8")).includes(
      "docker-compose",
    ),
  );
  assert.deepEqual(
    messages.filter((s) => s.startsWith("warning: skipped")),
    [
      `warning: skipped ${path.join(clone, "skills", "invalid", "SKILL.md")}: no frontmatter`,
      `warning: skipped symlink ${path.join(clone, "skills", "linked")} (git sources follow no symlinks)`,
    ],
  );
});

test("sources update direct keeps the installed Git revision when the new scan is empty or inaccessible", async (t) => {
  const { home } = await fixture(t);
  const repo = await makeRepo();
  t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const installed = await installSource(repo.url, null, quiet);
  const records = catalogRecords(home),
    rows = indexRows(home);
  await rm(path.join(repo.dir, "skills"), { recursive: true });
  await writeFile(path.join(repo.dir, "README"), "empty revision\n");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "empty revision");
  await assert.rejects(updateSources(installed.id, quiet), {
    message: `no valid skills found in the new revision of ${installed.id}; kept the old copy`,
  });
  assert.deepEqual(catalogRecords(home), records);
  assert.deepEqual(indexRows(home), rows);
  await writeSkill(path.join(repo.dir, "skills"), "alpha", "alpha");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "restore skill");
  const failure = Object.assign(new Error("staged read denied"), { code: "EACCES" });
  const nativeOpen = fsp.open;
  const spy = mock.method(fsp, "open", ((p: string, ...args: unknown[]) =>
    p.startsWith(path.join(home, "staging") + path.sep) && p.endsWith(`${path.sep}alpha${path.sep}SKILL.md`)
      ? Promise.reject(failure)
      : (nativeOpen as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.open);
  syncBuiltinESMExports();
  try {
    await assert.rejects(updateSources(installed.id, quiet), (error) => error === failure);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(catalogRecords(home), records);
  assert.deepEqual(indexRows(home), rows);
});

test("sources update direct persists selected Git inventory and preserves another source", async (t) => {
  const { root, home } = await fixture(t);
  const repo = await makeRepo();
  t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const other = path.join(root, "other");
  await mkdir(other);
  await writeSkill(other, "other", "other");
  const unrelated = await installSource(other, null, quiet);
  const installed = await installSource(repo.url, null, quiet, ["react-perf"]);
  const before = catalogRecords(home);
  const old = before.find((r) => r.id === installed.id)!;
  const otherRows = indexRows(home).filter((r) => r.source === unrelated.id);
  await writeSkill(path.join(repo.dir, "skills"), "react-perf", "updated React skill");
  await writeSkill(path.join(repo.dir, "skills"), "excluded", "excluded skill");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "selected revision");
  const sha = await head(repo.dir);
  assert.deepEqual(await updateSources(installed.id, quiet, null, ["postgres-tuning", "docker-compose", "postgres-tuning"]), {
    results: [
      {
        id: installed.id,
        kind: "git",
        oldCommit: old.commit,
        newCommit: sha,
        added: [`${installed.id}/docker-compose`, `${installed.id}/postgres-tuning`],
        changed: [`${installed.id}/react-perf`],
        removed: [],
      },
    ],
    errors: [],
  });
  const records = catalogRecords(home);
  const current = records.find((r) => r.id === installed.id)!;
  assert.deepEqual(current.selection, ["docker-compose", "postgres-tuning", "react-perf"]);
  assert.equal(current.ref, old.ref);
  assert.equal(current.commit, sha);
  assert.notEqual(current.snapshot, old.snapshot);
  assert.deepEqual(
    records.find((r) => r.id === unrelated.id),
    before.find((r) => r.id === unrelated.id),
  );
  assert.deepEqual(
    indexRows(home).filter((r) => r.source === unrelated.id),
    otherRows,
  );
  const snapshot = path.join(home, "snapshots", installed.id, current.snapshot!);
  const db = new DatabaseSync(path.join(home, "index.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, hash, manifest FROM skills WHERE source = ? ORDER BY id").all(installed.id) as unknown as {
      id: string;
      hash: string;
      manifest: string;
    }[];
    assert.deepEqual(
      rows.map((row) => row.id),
      ["docker-compose", "postgres-tuning", "react-perf"].map((name) => `${installed.id}/${name}`),
    );
    for (const row of rows) {
      const name = row.id.slice(installed.id.length + 1);
      const bytes = await readFile(path.join(snapshot, "skills", name, "SKILL.md"));
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const manifest = [{ path: "SKILL.md", digest, size: bytes.length }];
      assert.deepEqual(JSON.parse(row.manifest), manifest);
      assert.equal(
        row.hash,
        `sha256:${createHash("sha256")
          .update(JSON.stringify([["SKILL.md", digest, bytes.length]]))
          .digest("hex")}`,
      );
    }
  } finally {
    db.close();
  }
  const acceptedRows = indexRows(home);
  const alias = path.join(home, "sources", installed.id);
  const acceptedLink = await readlink(alias);
  await rm(path.join(repo.dir, "skills", "react-perf"), { recursive: true });
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "remove selected skill");
  await assert.rejects(updateSources(installed.id, quiet), {
    message: 'selected skill "react-perf" is missing from the new revision. The installed source is unchanged',
  });
  assert.deepEqual(catalogRecords(home), records);
  assert.deepEqual(indexRows(home), acceptedRows);
  assert.equal(await readlink(alias), acceptedLink);
});
