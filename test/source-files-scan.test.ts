import assert from "node:assert/strict";
import fsp, { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { mock, test } from "node:test";
import { scanSource } from "../src/scan.ts";
import { diffEntries, logWarnings, resolveScanRoot, scanInstalledSource, scanLocal, selectSkills } from "../src/source-files.ts";
import type { SourceRecord } from "../src/store-files.ts";
import { link, newEntry, tmp, useHome, writeSkill } from "./helpers.ts";

test("source files scan direct logs warnings in order with control bytes escaped", () => {
  const messages: string[] = [];
  const ctx = { log: (message: string) => messages.push(message) };
  logWarnings(ctx, []);
  assert.deepEqual(messages, []);
  logWarnings(ctx, ["plain warning", "line\nnext\t\u001b\u007f\u009f", "last\u0000warning"]);
  assert.deepEqual(messages, ["warning: plain warning", "warning: line\\x0anext\\x09\\x1b\\x7f\\x9f", "warning: last\\x00warning"]);
});

test("source files scan direct diffs unsorted entries into disjoint sorted categories", () => {
  const before = new Map([
    ["src/removed-z", "old"],
    ["src/changed-z", "old-z"],
    ["src/same", "same"],
    ["src/removed-a", "old"],
    ["src/changed-a", "old-a"],
  ]);
  const next = [
    { ...newEntry("src", "changed-z"), revision: "new-z" },
    { ...newEntry("src", "added-z"), revision: "new" },
    { ...newEntry("src", "same"), revision: "same" },
    { ...newEntry("src", "changed-a"), revision: "new-a" },
    { ...newEntry("src", "added-a"), revision: "new" },
  ];
  const result = diffEntries(before, next);
  assert.deepEqual(result, {
    added: ["src/added-a", "src/added-z"],
    removed: ["src/removed-a", "src/removed-z"],
    changed: ["src/changed-a", "src/changed-z"],
  });
  const all = [...result.added, ...result.removed, ...result.changed];
  assert.equal(new Set(all).size, all.length);
});

test("source files scan direct selects real skills in scan order and reports ambiguity and missing names", async (t) => {
  const root = await realpath(await tmp("mg-source-select-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSkill(root, "alpha", "alpha description");
  await writeSkill(root, "bravo", "bravo description");
  await writeSkill(root, "charlie", "charlie description");
  const duplicate = path.join(root, "duplicate");
  await mkdir(duplicate);
  await writeFile(path.join(duplicate, "SKILL.md"), "---\nname: bravo\ndescription: duplicate\n---\n");
  const scan = await scanSource(root, { followSymlinks: false });
  assert.deepEqual(
    scan.skills.map((skill) => skill.name),
    ["alpha", "bravo", "charlie"],
  );
  assert.deepEqual(scan.duplicates, ["bravo"]);
  assert.deepEqual(
    selectSkills("source", scan).map((skill) => skill.name),
    ["alpha", "bravo", "charlie"],
  );
  assert.deepEqual(selectSkills("source", scan, []), []);
  assert.deepEqual(
    selectSkills("source", scan, ["charlie", "alpha"]).map((skill) => skill.name),
    ["alpha", "charlie"],
  );
  assert.throws(() => selectSkills("source", scan, ["bravo"]), { message: 'skill "bravo" is ambiguous in source "source"' });
  assert.throws(() => selectSkills("source", scan, ["missing"]), { message: 'skill "missing" does not exist in source "source"' });
  assert.throws(() => selectSkills("source", scan, ["missing"], true), {
    message: 'selected skill "missing" is missing from the new revision. The installed source is unchanged',
  });
});

test("source files scan direct local scans follow symlinks, log warnings, and propagate strict failures", async (t) => {
  const fixture = await realpath(await tmp("mg-source-local-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "root");
  const target = path.join(fixture, "target");
  await mkdir(root);
  await mkdir(target);
  await writeSkill(target, "chosen", "chosen description");
  const linked = path.join(root, "linked");
  await link(path.join(target, "chosen"), linked);
  const invalid = path.join(root, "invalid");
  await mkdir(invalid);
  await writeFile(path.join(invalid, "SKILL.md"), "no frontmatter\n");
  const rec: SourceRecord = {
    id: "local",
    kind: "local",
    spec: root,
    path: root,
    subpath: "",
    ref: null,
    commit: null,
    installedAt: "2026-01-01",
    selection: ["chosen"],
  };
  const messages: string[] = [];
  const ctx = { log: (message: string) => messages.push(message) };
  for (const scan of [scanLocal, scanInstalledSource]) {
    messages.length = 0;
    const entries = await scan(rec, ctx);
    assert.deepEqual(
      entries.map(({ id, name, dir }) => ({ id, name, dir })),
      [{ id: "local/chosen", name: "chosen", dir: linked }],
    );
    assert.deepEqual(messages, [`warning: skipped ${path.join(invalid, "SKILL.md")}: no frontmatter`]);
  }
  const missing = path.join(fixture, "missing");
  await assert.rejects(scanLocal({ ...rec, path: missing }, ctx), {
    message: `${missing} is not readable; remove the source or restore the directory`,
  });
  await assert.rejects(scanLocal({ ...rec, selection: ["absent"] }, ctx), {
    message: 'selected skill "absent" is missing from the new revision. The installed source is unchanged',
  });
  const failure = Object.assign(new Error("local access denied"), { code: "EACCES" });
  const file = path.join(linked, "SKILL.md");
  const realOpen = fsp.open;
  const spy = mock.method(fsp, "open", ((p: string, ...args: unknown[]) =>
    p === file ? Promise.reject(failure) : (realOpen as (...args: unknown[]) => unknown)(p, ...args)) as typeof fsp.open);
  syncBuiltinESMExports();
  messages.length = 0;
  try {
    await assert.rejects(scanLocal(rec, ctx), (error) => error === failure);
    assert.deepEqual(messages, []);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("source files scan direct git snapshot respects subpath, selection, symlinks, and strict failures", async (t) => {
  const fixture = await realpath(await tmp("mg-source-git-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = path.join(fixture, "home");
  useHome(t, home);
  const snapshot = `${"a".repeat(40)}-${"b".repeat(16)}`;
  const dir = path.join(home, "snapshots", "owner__repo", snapshot);
  const root = path.join(dir, "skills");
  await mkdir(root, { recursive: true });
  await writeSkill(root, "chosen", "chosen description");
  await writeSkill(root, "unselected", "unselected description");
  const hidden = await writeSkill(dir, "hidden", "hidden description");
  const symlink = path.join(root, "linked");
  await link(hidden, symlink);
  const invalid = path.join(root, "invalid");
  await mkdir(invalid);
  await writeFile(path.join(invalid, "SKILL.md"), "no frontmatter\n");
  const rec: SourceRecord = {
    id: "owner__repo",
    kind: "git",
    spec: "owner/repo",
    url: "https://example.invalid/owner/repo.git",
    subpath: "skills",
    ref: "main",
    commit: "a".repeat(40),
    installedAt: "2026-01-01",
    snapshot,
    selection: ["chosen"],
  };
  const messages: string[] = [];
  const ctx = { log: (message: string) => messages.push(message) };
  const entries = await scanInstalledSource(rec, ctx);
  assert.deepEqual(
    entries.map(({ id, name, dir: entryDir }) => ({ id, name, dir: entryDir })),
    [{ id: "owner__repo/chosen", name: "chosen", dir: path.join("skills", "chosen") }],
  );
  assert.deepEqual(messages, [
    `warning: skipped ${path.join(invalid, "SKILL.md")}: no frontmatter`,
    `warning: skipped symlink ${symlink} (git sources follow no symlinks)`,
  ]);
  messages.length = 0;
  const { selection: _selection, ...allRecord } = rec;
  const allEntries = await scanInstalledSource(allRecord, ctx);
  assert.deepEqual(
    allEntries.map((entry) => entry.name),
    ["chosen", "unselected"],
  );
  await assert.rejects(scanInstalledSource({ ...rec, selection: ["absent"] }, ctx), {
    message: 'selected skill "absent" is missing from the new revision. The installed source is unchanged',
  });
  const failure = Object.assign(new Error("git access denied"), { code: "EACCES" });
  const file = path.join(root, "chosen", "SKILL.md");
  const realOpen = fsp.open;
  const spy = mock.method(fsp, "open", ((p: string, ...args: unknown[]) =>
    p === file ? Promise.reject(failure) : (realOpen as (...args: unknown[]) => unknown)(p, ...args)) as typeof fsp.open);
  syncBuiltinESMExports();
  messages.length = 0;
  try {
    await assert.rejects(scanInstalledSource(rec, ctx), (error) => error === failure);
    assert.deepEqual(messages, []);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("source files scan direct propagates realpath access errors", async (t) => {
  const root = await tmp("mg-source-realpath-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const localPath = path.join(root, "local");
  const clone = path.join(root, "clone");
  const nested = path.join(clone, "nested");
  await mkdir(localPath);
  await mkdir(nested, { recursive: true });
  const rec: SourceRecord = {
    id: "local",
    kind: "local",
    spec: localPath,
    path: localPath,
    subpath: "",
    ref: null,
    commit: null,
    installedAt: "2026-01-01",
  };
  const failure = Object.assign(new Error("realpath denied"), { code: "EACCES" });
  const realRealpath = fsp.realpath;
  const calls: string[] = [];
  const spy = mock.method(fsp, "realpath", ((file: string, ...args: unknown[]) => {
    if (file === localPath || file === nested) {
      calls.push(file);
      return Promise.reject(failure);
    }
    return (realRealpath as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fsp.realpath);
  syncBuiltinESMExports();
  try {
    await assert.rejects(scanLocal(rec, { log: () => {} }), (error) => error === failure);
    await assert.rejects(resolveScanRoot(clone, "nested"), (error) => error === failure);
    assert.deepEqual(calls, [localPath, nested]);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});
