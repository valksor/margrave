import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp, { mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { mock, test } from "node:test";
import { scanSource } from "../src/scan.ts";
import { PINNED_RIPWIRE } from "../src/safety.ts";
import { resolveSkill } from "../src/skills.ts";
import { openIndexRead } from "../src/store.ts";
import { installSource, localId, parseSpec } from "../src/sources.ts";
import {
  catalogRecords,
  fakeRipwire,
  git,
  head,
  indexIds,
  indexRows,
  makeRepo,
  quiet,
  tmp,
  useHome,
  withPath,
  writeSkill,
} from "./helpers.ts";

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const root = await tmp("mg-install-direct-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  useHome(t, home);
  const bin = await fakeRipwire();
  t.after(() => rm(bin, { recursive: true, force: true }));
  return { root, home, bin };
}

function gitId(url: string): string {
  const parsed = parseSpec(url);
  assert.equal(parsed.kind, "git");
  return parsed.id;
}

function duplicate(id: string): string {
  return `source ${id} is already installed; run: margrave update ${id} (or margrave remove ${id})`;
}

test("sources install direct validates local roots and qualified refs before publication", async (t) => {
  const { root, home } = await fixture(t);
  const file = path.join(root, "file");
  await writeFile(file, "file");
  await assert.rejects(installSource(root, "main", quiet), { message: "--ref is not allowed with a local source" });
  for (const p of [file, path.join(root, "absent")]) {
    await assert.rejects(installSource(p, null, quiet), { message: `${p} is not a directory that exists` });
  }
  await assert.rejects(installSource(`file://${path.join(root, "repo")}`, "refs/heads/bad..name", quiet), {
    message: "command failed: git check-ref-format refs/heads/bad..name\nCommand failed: git check-ref-format refs/heads/bad..name\n",
  });
  await assert.rejects(fsp.stat(home), { code: "ENOENT" });
});

test("sources install direct preserves unrelated local records and selection through canonical paths", async (t) => {
  const { root, home, bin } = await fixture(t);
  await withPath(`${bin}:${process.env["PATH"] ?? ""}`, async () => {
    const other = path.join(root, "other");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await mkdir(other);
    await mkdir(source);
    await mkdir(target);
    await writeSkill(other, "other", "other skill");
    await writeSkill(target, "chosen", "chosen skill");
    await symlink(path.join(target, "chosen"), path.join(source, "linked"));
    await writeSkill(source, "extra", "extra skill");
    await mkdir(path.join(source, "invalid"));
    await writeFile(path.join(source, "invalid", "SKILL.md"), "no frontmatter\n");
    const first = await installSource(other, null, quiet);
    const original = catalogRecords(home)[0];
    const originalRows = indexRows(home);
    const alias = path.join(root, "alias");
    await symlink(source, alias);
    const messages: string[] = [];
    const canonicalSource = await realpath(source);
    const id = localId(canonicalSource);
    const result = await installSource(alias, null, { ...quiet, log: (s) => messages.push(s) }, ["chosen"]);
    assert.deepEqual(result, { id, skills: [`${id}/chosen`] });
    assert.deepEqual(messages, [`warning: skipped ${path.join(source, "invalid", "SKILL.md")}: no frontmatter`]);
    const records = catalogRecords(home);
    assert.deepEqual(records[0], original);
    const record = records.find((r) => r.id === id)!;
    assert.deepEqual(
      { ...record, installedAt: "time" },
      { id, kind: "local", spec: alias, path: source, subpath: "", ref: null, commit: null, installedAt: "time", selection: ["chosen"] },
    );
    assert.equal(new Date(record.installedAt).toISOString(), record.installedAt);
    assert.equal(Object.hasOwn(original!, "selection"), false);
    assert.deepEqual(indexIds(home), [`${first.id}/other`, `${id}/chosen`].sort());
    const rows = indexRows(home);
    assert.deepEqual(
      rows.filter((row) => row.source === first.id),
      originalRows,
    );
    const scanned = (await scanSource(source, { followSymlinks: true, strict: true })).skills.find((skill) => skill.name === "chosen")!;
    const db = await openIndexRead();
    try {
      const entry = resolveSkill(db, `${id}/chosen`);
      assert.deepEqual(
        {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          source: entry.source,
          dir: entry.dir,
          revision: entry.revision,
          manifest: entry.manifest,
        },
        {
          id: `${id}/chosen`,
          name: "chosen",
          description: "chosen skill",
          source: id,
          dir: path.join(source, "linked"),
          revision: scanned.revision,
          manifest: JSON.stringify(scanned.manifest),
        },
      );
      assert.throws(() => resolveSkill(db, `${id}/extra`), {
        message: `no skill "${id}/extra"; run: margrave find "<task>" or margrave list --skills`,
      });
    } finally {
      db.close();
    }
    const bytes = await readFile(path.join(target, "chosen", "SKILL.md"), "utf8");
    const readdir = fsp.readdir.bind(fsp);
    let scannedRoot = false;
    const spy = mock.method(fsp, "readdir", ((p: string, ...args: unknown[]) => {
      if (p === canonicalSource) scannedRoot = true;
      return (readdir as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof fsp.readdir);
    syncBuiltinESMExports();
    try {
      await assert.rejects(installSource(source, null, quiet), { message: duplicate(id) });
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(scannedRoot, false);
    assert.deepEqual(catalogRecords(home), records);
    assert.deepEqual(indexRows(home), rows);
    assert.equal(await readFile(path.join(target, "chosen", "SKILL.md"), "utf8"), bytes);
  });
});

test("sources install direct propagates strict local errors and rejects empty and critical scans", async (t) => {
  const { root, home, bin } = await fixture(t);
  await withPath(`${bin}:${process.env["PATH"] ?? ""}`, async () => {
    const empty = path.join(root, "empty");
    await mkdir(empty);
    await assert.rejects(installSource(empty, null, quiet), {
      message: `no valid skills (SKILL.md with name and description) found in ${await realpath(empty)}`,
    });
    const source = path.join(root, "skill");
    await mkdir(source);
    const skill = await writeSkill(source, "alpha", "alpha skill");
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const open = fsp.open.bind(fsp);
    const spy = mock.method(fsp, "open", ((p: string, ...args: unknown[]) =>
      p === path.join(skill, "SKILL.md") ? Promise.reject(error) : (open as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.open);
    syncBuiltinESMExports();
    try {
      await assert.rejects(installSource(source, null, quiet), (e) => e === error);
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
    await writeFile(path.join(skill, "danger.txt"), "FAKE-CRIT dangerous\n");
    await assert.rejects(installSource(source, null, quiet), /ripwire found CRITICAL findings/);
    await assert.rejects(fsp.stat(path.join(home, "index.db")), { code: "ENOENT" });
  });
});

test("sources install direct rejects malformed Git aliases without publication", async (t) => {
  const { home, bin } = await fixture(t);
  const repo = await makeRepo();
  t.after(() => rm(repo.dir, { recursive: true, force: true }));
  await withPath(`${bin}:${process.env["PATH"] ?? ""}`, async () => {
    const id = gitId(repo.url);
    const alias = path.join(home, "sources", id);
    await mkdir(path.dirname(alias), { recursive: true });
    const failure = Object.assign(new Error("alias denied"), { code: "EACCES" });
    const lstat = fsp.lstat.bind(fsp);
    const spy = mock.method(fsp, "lstat", ((p: string, ...args: unknown[]) =>
      p === alias ? Promise.reject(failure) : (lstat as (...a: unknown[]) => unknown)(p, ...args)) as typeof fsp.lstat);
    syncBuiltinESMExports();
    try {
      await assert.rejects(installSource(repo.url, null, quiet), (e) => e === failure);
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
    await writeFile(alias, "occupied");
    await assert.rejects(installSource(repo.url, null, quiet), { message: duplicate(id) });
    await rm(alias);
    const digest = "a".repeat(40),
      long = "a".repeat(64),
      suffix = "b".repeat(16);
    for (const name of [
      `x${digest}-${suffix}`,
      `${digest}-${suffix}x`,
      `a-${suffix}`,
      `${"g".repeat(40)}-${suffix}`,
      `${"g".repeat(64)}-${suffix}`,
      `${long}-b`,
      `${long}-${"g".repeat(16)}`,
      "outside",
    ]) {
      await symlink(path.join("..", "snapshots", id, name), alias);
      await assert.rejects(installSource(repo.url, null, quiet), { message: duplicate(id) });
      assert.equal(await readlink(alias), path.join("..", "snapshots", id, name));
      await rm(alias);
    }
    const foreign = path.join(home, "foreign");
    await mkdir(foreign);
    await writeFile(path.join(foreign, "keep"), "intact");
    await symlink(path.join("..", "foreign"), alias);
    await assert.rejects(installSource(repo.url, null, quiet), { message: duplicate(id) });
    assert.equal(await readlink(alias), path.join("..", "foreign"));
    assert.equal(await readFile(path.join(foreign, "keep"), "utf8"), "intact");
    await assert.rejects(fsp.stat(path.join(home, "index.db")), { code: "ENOENT" });
  });
});

test("sources install direct publishes selected Git snapshots and accepts managed stale aliases", async (t) => {
  const { home, bin } = await fixture(t);
  const repo = await makeRepo();
  t.after(() => rm(repo.dir, { recursive: true, force: true }));
  const second = await makeRepo();
  t.after(() => rm(second.dir, { recursive: true, force: true }));
  await writeFile(path.join(repo.dir, "skills", "react-perf", "warning.txt"), "FAKE-WARN advisory\n");
  await symlink("react-perf", path.join(repo.dir, "skills", "linked"));
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "warning and symlink");
  const sha = await head(repo.dir);
  await withPath(`${bin}:${process.env["PATH"] ?? ""}`, async () => {
    const id = gitId(repo.url);
    const alias = path.join(home, "sources", id);
    await mkdir(path.dirname(alias), { recursive: true });
    await symlink(path.join("..", "snapshots", id, `${"a".repeat(64)}-${"b".repeat(16)}`), alias);
    const messages: string[] = [];
    const nativeRm = fsp.rm.bind(fsp);
    const nativeReaddir = fsp.readdir.bind(fsp);
    let scans = 0;
    let stagedRoot = "";
    const scanSpy = mock.method(fsp, "readdir", ((p: string, options: unknown) => {
      if (
        p.startsWith(path.join(home, "staging") + path.sep) &&
        p.endsWith(`${path.sep}repo`) &&
        (options as { withFileTypes?: boolean })?.withFileTypes === true
      ) {
        scans++;
        stagedRoot = p;
      }
      assert.ok(!p.endsWith(`${path.sep}skills${path.sep}linked`));
      return (nativeReaddir as (...a: unknown[]) => unknown)(p, options);
    }) as typeof fsp.readdir);
    const removals: { p: string; options: unknown }[] = [];
    const spy = mock.method(fsp, "rm", ((p: string, options: unknown) => {
      if (p.endsWith(`${path.sep}repo${path.sep}.git`)) removals.push({ p: p, options });
      return (nativeRm as (...a: unknown[]) => unknown)(p, options);
    }) as typeof fsp.rm);
    syncBuiltinESMExports();
    let result;
    try {
      result = await installSource(repo.url, "main", { ...quiet, log: (s) => messages.push(s) }, ["react-perf"]);
    } finally {
      spy.mock.restore();
      scanSpy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(scans, 4);
    assert.deepEqual(result, { id, skills: [`${id}/react-perf`] });
    assert.equal(removals.length, 1);
    assert.deepEqual(removals[0]!.options, { recursive: true, force: true });
    assert.ok(removals[0]!.p.startsWith(path.join(home, "staging") + path.sep));
    const rec = catalogRecords(home).find((r) => r.id === id)!;
    assert.deepEqual(
      { kind: rec.kind, spec: rec.spec, url: rec.url, subpath: rec.subpath, ref: rec.ref, commit: rec.commit, selection: rec.selection },
      { kind: "git", spec: repo.url, url: repo.url, subpath: "", ref: "refs/heads/main", commit: sha, selection: ["react-perf"] },
    );
    assert.match(rec.snapshot!, new RegExp(`^${sha}-[0-9a-f]{16}$`));
    assert.equal(await readlink(alias), path.join("..", "snapshots", id, rec.snapshot!));
    const snapshot = path.join(home, "snapshots", id, rec.snapshot!);
    await assert.rejects(fsp.stat(path.join(snapshot, ".git")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(snapshot, "skills", "react-perf", "warning.txt"), "utf8"), "FAKE-WARN advisory\n");
    const rel = "skills/react-perf/warning.txt";
    const lineHash = createHash("sha256").update("FAKE-WARN advisory").digest("hex");
    const fileHash = createHash("sha256").update("FAKE-WARN advisory\n").digest("hex");
    assert.match(rec.scan!.tree!, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      { ...rec.scan, tree: "tree" },
      {
        code: 1,
        overridden: false,
        version: PINNED_RIPWIRE,
        verdict: "warn",
        keys: [[JSON.stringify([rel, "advisory", "warn", lineHash]), 1]],
        files: [[rel, fileHash]],
        tree: "tree",
      },
    );
    const report = path.join(home, "reports", `${id}.xml`);
    assert.deepEqual(messages, [
      `warning: skipped symlink ${path.join(stagedRoot, "skills", "linked")} (git sources follow no symlinks)`,
      `scan: WARN — 1 finding(s) (1 warn) in 1 skill(s)\n  by rule:   advisory 1\n  top skills: react-perf 1\n  full report: ${report}`,
    ]);
    assert.equal(
      await readFile(report, "utf8"),
      `<skillscan files="1" findings="1" skipped="0" verdict="warn"><f p="${path.join(stagedRoot, rel)}:1" rule="advisory" sev="warn"/></skillscan>\n`,
    );
    const scanned = (await scanSource(repo.dir, { followSymlinks: false, strict: true })).skills.find(
      (skill) => skill.name === "react-perf",
    )!;
    const db = await openIndexRead();
    try {
      const entry = resolveSkill(db, `${id}/react-perf`);
      assert.deepEqual(
        {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          source: entry.source,
          dir: entry.dir,
          revision: entry.revision,
          manifest: entry.manifest,
        },
        {
          id: `${id}/react-perf`,
          name: "react-perf",
          description: "Optimize React rendering performance and bundle size",
          source: id,
          dir: path.join(snapshot, "skills", "react-perf"),
          revision: scanned.revision,
          manifest: JSON.stringify(scanned.manifest),
        },
      );
      assert.throws(() => resolveSkill(db, `${id}/docker-compose`), {
        message: `no skill "${id}/docker-compose"; run: margrave find "<task>" or margrave list --skills`,
      });
    } finally {
      db.close();
    }
    assert.deepEqual(indexIds(home), [`${id}/react-perf`]);
    const before = catalogRecords(home),
      rows = indexRows(home);
    const lstat = fsp.lstat.bind(fsp);
    let probedAlias = false;
    const duplicateSpy = mock.method(fsp, "lstat", ((p: string, ...args: unknown[]) => {
      if (p === alias) probedAlias = true;
      return (lstat as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof fsp.lstat);
    syncBuiltinESMExports();
    try {
      await assert.rejects(installSource(repo.url, null, quiet), { message: duplicate(id) });
    } finally {
      duplicateSpy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(probedAlias, false);
    assert.deepEqual(catalogRecords(home), before);
    assert.deepEqual(indexRows(home), rows);
    const otherId = gitId(second.url);
    const otherAlias = path.join(home, "sources", otherId);
    await symlink(path.join("..", "snapshots", otherId, `${"a".repeat(40)}-${"b".repeat(16)}`), otherAlias);
    const other = await installSource(second.url, "refs/heads/main", quiet);
    assert.deepEqual(other, { id: otherId, skills: ["docker-compose", "postgres-tuning", "react-perf"].map((n) => `${otherId}/${n}`) });
    const otherRecord = catalogRecords(home).find((r) => r.id === otherId)!;
    assert.equal(otherRecord.ref, "refs/heads/main");
    assert.equal(otherRecord.commit, await head(second.dir));
    assert.equal(Object.hasOwn(otherRecord, "selection"), false);
    const otherScan = await scanSource(second.dir, { followSymlinks: false, strict: true });
    const otherDb = await openIndexRead();
    try {
      for (const skill of otherScan.skills) {
        const entry = resolveSkill(otherDb, `${otherId}/${skill.name}`);
        assert.deepEqual(
          {
            id: entry.id,
            name: entry.name,
            description: entry.description,
            source: entry.source,
            dir: entry.dir,
            revision: entry.revision,
            manifest: entry.manifest,
          },
          {
            id: `${otherId}/${skill.name}`,
            name: skill.name,
            description: skill.description,
            source: otherId,
            dir: path.join(home, "snapshots", otherId, otherRecord.snapshot!, path.relative(second.dir, skill.dir)),
            revision: skill.revision,
            manifest: JSON.stringify(skill.manifest),
          },
        );
      }
    } finally {
      otherDb.close();
    }
    assert.deepEqual(
      indexRows(home).filter((row) => row.source === id),
      rows,
    );
    assert.deepEqual(
      catalogRecords(home).find((r) => r.id === id),
      rec,
    );
  });
});

test("sources install direct rejects an empty Git checkout", async (t) => {
  const { root, bin } = await fixture(t);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "README"), "empty\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "empty");
  const url = `file://${repo}`;
  await withPath(`${bin}:${process.env["PATH"] ?? ""}`, async () => {
    await assert.rejects(installSource(url, null, quiet), {
      message: `no valid skills (SKILL.md with name and description) found in ${url}`,
    });
  });
});

test("sources install direct preserves the first staged scan filesystem error", async (t) => {
  const { home, bin } = await fixture(t);
  const repo = await makeRepo();
  t.after(() => rm(repo.dir, { recursive: true, force: true }));
  await withPath(`${bin}:${process.env["PATH"] ?? ""}`, async () => {
    const id = gitId(repo.url);
    const failure = Object.assign(new Error("staged read denied"), { code: "EACCES" });
    const readdir = fsp.readdir.bind(fsp);
    const open = fsp.open.bind(fsp);
    let stagedRoot = "";
    let attempts = 0;
    const scanSpy = mock.method(fsp, "readdir", ((p: string, options: unknown) => {
      if (
        p.startsWith(path.join(home, "staging") + path.sep) &&
        p.endsWith(`${path.sep}repo`) &&
        (options as { withFileTypes?: boolean })?.withFileTypes === true
      )
        stagedRoot = p;
      return (readdir as (...a: unknown[]) => unknown)(p, options);
    }) as typeof fsp.readdir);
    const openSpy = mock.method(fsp, "open", ((p: string, ...args: unknown[]) => {
      if (stagedRoot && p === path.join(stagedRoot, "skills", "react-perf", "SKILL.md")) {
        attempts++;
        if (attempts === 1) return Promise.reject(failure);
      }
      return (open as (...a: unknown[]) => unknown)(p, ...args);
    }) as typeof fsp.open);
    syncBuiltinESMExports();
    try {
      await assert.rejects(installSource(repo.url, null, quiet), (e) => e === failure);
    } finally {
      openSpy.mock.restore();
      scanSpy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(attempts, 1);
    await assert.rejects(fsp.stat(path.join(home, "index.db")), { code: "ENOENT" });
    await assert.rejects(fsp.lstat(path.join(home, "sources", id)), { code: "ENOENT" });
    await assert.rejects(fsp.stat(path.dirname(stagedRoot)), { code: "ENOENT" });
  });
});

test("sources install direct rejects duplicate-only staged scan changes and preserves accepted state", async (t) => {
  const { home, bin } = await fixture(t);
  const first = await makeRepo();
  t.after(() => rm(first.dir, { recursive: true, force: true }));
  const second = await makeRepo();
  t.after(() => rm(second.dir, { recursive: true, force: true }));
  await withPath(`${bin}:${process.env["PATH"] ?? ""}`, async () => {
    const accepted = await installSource(first.url, null, quiet);
    const records = catalogRecords(home),
      rows = indexRows(home);
    assert.equal(records.find((r) => r.id === accepted.id)?.ref, "refs/heads/main");
    const alias = path.join(home, "sources", accepted.id),
      link = await readlink(alias);
    const readdir = fsp.readdir.bind(fsp);
    let seen = 0;
    const spy = mock.method(fsp, "readdir", (async (p: string, options: unknown) => {
      if (
        p.startsWith(path.join(home, "staging") + path.sep) &&
        p.endsWith(`${path.sep}repo`) &&
        (options as { withFileTypes?: boolean })?.withFileTypes === true &&
        ++seen === 4
      ) {
        const dir = path.join(p, "zz-duplicate");
        await mkdir(dir);
        await writeFile(path.join(dir, "SKILL.md"), "---\nname: react-perf\ndescription: duplicate\n---\n");
      }
      return (readdir as (...a: unknown[]) => Promise<unknown>)(p, options);
    }) as typeof fsp.readdir);
    syncBuiltinESMExports();
    try {
      await assert.rejects(installSource(second.url, null, quiet), { message: "staged skills changed during scan" });
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(seen, 4);
    assert.deepEqual(catalogRecords(home), records);
    assert.deepEqual(indexRows(home), rows);
    assert.equal(await readlink(alias), link);
  });
});

test("sources install direct preserves the second staged scan filesystem error", async (t) => {
  const { home, bin } = await fixture(t);
  const first = await makeRepo();
  t.after(() => rm(first.dir, { recursive: true, force: true }));
  const second = await makeRepo();
  t.after(() => rm(second.dir, { recursive: true, force: true }));
  await withPath(`${bin}:${process.env["PATH"] ?? ""}`, async () => {
    const accepted = await installSource(first.url, null, quiet);
    const records = catalogRecords(home),
      rows = indexRows(home);
    const alias = path.join(home, "sources", accepted.id),
      link = await readlink(alias);
    const failure = Object.assign(new Error("staged read denied"), { code: "EACCES" });
    const readdir = fsp.readdir.bind(fsp);
    let seen = 0;
    const spy = mock.method(fsp, "readdir", ((p: string, options: unknown) => {
      if (
        p.startsWith(path.join(home, "staging") + path.sep) &&
        p.endsWith(`${path.sep}repo`) &&
        (options as { withFileTypes?: boolean })?.withFileTypes === true &&
        ++seen === 2
      )
        return Promise.reject(failure);
      return (readdir as (...a: unknown[]) => unknown)(p, options);
    }) as typeof fsp.readdir);
    syncBuiltinESMExports();
    try {
      await assert.rejects(installSource(second.url, null, quiet), (e) => e === failure);
    } finally {
      spy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(seen, 2);
    assert.deepEqual(catalogRecords(home), records);
    assert.deepEqual(indexRows(home), rows);
    assert.equal(await readlink(alias), link);
  });
});
