import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fsp, { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { checkLockUrl, exportLock, parseLock, restoreLock } from "../src/lock.ts";
import { installSource, parseSpec } from "../src/sources.ts";
import { changeAtLock, fakeRipwire, indexRows, makeRepo, realExec, tmp, writeIndexRows } from "./helpers.ts";

test("an empty store exports and restores an empty lock", async (t) => {
  const previous = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  t.after(() => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
  });
  const lock = await exportLock([]);
  assert.deepEqual(lock, { version: 1, sources: [] });
  const output: string[] = [];
  await restoreLock(lock, { log: () => {}, allowUnsafe: false }, (line) => output.push(line));
  assert.deepEqual(output, []);
});

test("restore retains a malformed pending marker without publishing", async (t) => {
  const previousHome = process.env["MARGRAVE_HOME"];
  const previousPath = process.env["PATH"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  process.env["PATH"] = `${await fakeRipwire()}:${previousPath ?? ""}`;
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  });
  const repo = await makeRepo();
  const ctx = { log: (): void => {}, allowUnsafe: false };
  const { id } = await installSource(repo.url, null, ctx);
  const lock = await exportLock([]);
  const destination = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = destination;
  const pending = path.join(destination, "restore-pending", `${id}.json`);
  await mkdir(path.dirname(pending), { recursive: true });
  for (const contents of ["{", "{}\n", JSON.stringify({ source: lock.sources[0], record: null })]) {
    await writeFile(pending, contents);
    await assert.rejects(
      restoreLock(lock, ctx, () => {}),
      /pending restore record is malformed/u,
    );
    assert.equal(await readFile(pending, "utf8"), contents);
  }
  const actual = fsp.readFile;
  mock.method(fsp, "readFile", ((file: string, ...args: unknown[]) =>
    file === pending
      ? Promise.reject(Object.assign(new Error("pending read denied"), { code: "EACCES" }))
      : (actual as (...a: unknown[]) => Promise<unknown>)(file, ...args)) as typeof fsp.readFile);
  syncBuiltinESMExports();
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /pending read denied/u,
  );
  mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(await readFile(pending, "utf8"), JSON.stringify({ source: lock.sources[0], record: null }));
  await assert.rejects(readFile(path.join(destination, "sources.json")), { code: "ENOENT" });
});

test("restore resumes a pending snapshot and rejects missing or non-directory destinations", async (t) => {
  const previousHome = process.env["MARGRAVE_HOME"];
  const previousPath = process.env["PATH"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  process.env["PATH"] = `${await fakeRipwire()}:${previousPath ?? ""}`;
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  });
  const repo = await makeRepo();
  const ctx = { log: (): void => {}, allowUnsafe: false };
  const { id } = await installSource(repo.url, null, ctx);
  const lock = await exportLock([]);
  const records = JSON.parse(await readFile(path.join(process.env["MARGRAVE_HOME"], "sources.json"), "utf8")) as { snapshot: string }[];
  const record = records[0];
  assert.ok(record);
  const originalSnapshot = path.join(process.env["MARGRAVE_HOME"], "snapshots", id, record.snapshot);
  const markerContents = JSON.stringify({ source: lock.sources[0], record });
  const invalid = path.join(originalSnapshot, "skills", "invalid");
  await mkdir(invalid);
  await writeFile(path.join(invalid, "SKILL.md"), "no frontmatter\n");
  const wrongLock = structuredClone(lock);
  assert.ok(wrongLock.sources[0]);
  wrongLock.sources[0].ref = "refs/heads/other";
  await assert.rejects(
    restoreLock(wrongLock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  const alias = path.join(process.env["MARGRAVE_HOME"], "sources", id);
  const realLstat = fsp.lstat;
  mock.method(fsp, "lstat", ((file: string, ...args: unknown[]) =>
    file === alias
      ? Promise.reject(Object.assign(new Error("alias stat denied"), { code: "EACCES" }))
      : (realLstat as (...a: unknown[]) => Promise<unknown>)(file, ...args)) as typeof fsp.lstat);
  syncBuiltinESMExports();
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /alias stat denied/u,
  );
  mock.restoreAll();
  syncBuiltinESMExports();
  const existingMarker = path.join(process.env["MARGRAVE_HOME"], "restore-pending", `${id}.json`);
  await mkdir(path.dirname(existingMarker), { recursive: true });
  const mismatchedRecord = { ...record, snapshot: `${record.snapshot.slice(0, -16)}0000000000000000` };
  await writeFile(existingMarker, JSON.stringify({ source: lock.sources[0], record: mismatchedRecord }));
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  await writeFile(existingMarker, markerContents);
  const report: string[] = [];
  await restoreLock(lock, ctx, (line) => report.push(line));
  assert.deepEqual(report, [`already restored ${id}`]);
  await assert.rejects(readFile(existingMarker), { code: "ENOENT" });
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const marker = path.join(home, "restore-pending", `${id}.json`);
  const destination = path.join(home, "snapshots", id, record.snapshot);
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, markerContents);
  await restoreLock(lock, ctx, () => {});
  const restored = JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { snapshot: string }[];
  assert.equal(restored[0]?.snapshot, record.snapshot);
  await rm(destination, { recursive: true });
  await writeFile(marker, markerContents);
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  assert.equal(await readFile(marker, "utf8"), markerContents);

  const other = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = other;
  const otherMarker = path.join(other, "restore-pending", `${id}.json`);
  const otherDestination = path.join(other, "snapshots", id, record.snapshot);
  await mkdir(path.dirname(otherMarker), { recursive: true });
  await mkdir(path.dirname(otherDestination), { recursive: true });
  await writeFile(otherMarker, markerContents);
  await writeFile(otherDestination, "not a directory");
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /pending restore record is malformed/u,
  );
  assert.equal(await readFile(otherMarker, "utf8"), markerContents);
  assert.equal(await readFile(otherDestination, "utf8"), "not a directory");
  const actual = fsp.lstat;
  mock.method(fsp, "lstat", ((file: string, ...args: unknown[]) =>
    file === otherDestination
      ? Promise.reject(Object.assign(new Error("snapshot stat denied"), { code: "EACCES" }))
      : (actual as (...a: unknown[]) => Promise<unknown>)(file, ...args)) as typeof fsp.lstat);
  syncBuiltinESMExports();
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /snapshot stat denied/u,
  );
  mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(await readFile(otherMarker, "utf8"), markerContents);
  assert.equal(await readFile(otherDestination, "utf8"), "not a directory");
  await rm(otherDestination);
  await mkdir(otherDestination);
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /staged skills differ from the lock/u,
  );
  assert.equal(await readFile(otherMarker, "utf8"), markerContents);
  await rm(otherDestination, { recursive: true });
  await cp(originalSnapshot, otherDestination, { recursive: true });
  await restoreLock(lock, ctx, () => {});
  assert.equal(
    (JSON.parse(await readFile(path.join(other, "sources.json"), "utf8")) as { snapshot: string }[])[0]?.snapshot,
    record.snapshot,
  );

  const racing = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = racing;
  const racingMarker = path.join(racing, "restore-pending", `${id}.json`);
  const racingDestination = path.join(racing, "snapshots", id, record.snapshot);
  await mkdir(path.dirname(racingMarker), { recursive: true });
  await writeFile(racingMarker, markerContents);
  const hook = changeAtLock(t, 3, () => {
    mkdirSync(racingDestination, { recursive: true });
    writeFileSync(path.join(racingDestination, "other-writer"), "retained");
  });
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /pending restore record is malformed/u,
  );
  assert.equal(hook.fired(), true);
  assert.equal(await readFile(racingMarker, "utf8"), markerContents);
  assert.equal(await readFile(path.join(racingDestination, "other-writer"), "utf8"), "retained");
  mock.restoreAll();
  await rm(racingDestination, { recursive: true });
  const originalLstat = fsp.lstat;
  let destinationReads = 0;
  mock.method(fsp, "lstat", ((file: string, ...args: unknown[]) =>
    file === racingDestination && ++destinationReads === 2
      ? Promise.reject(Object.assign(new Error("publication stat denied"), { code: "EACCES" }))
      : (originalLstat as (...a: unknown[]) => Promise<unknown>)(file, ...args)) as typeof fsp.lstat);
  syncBuiltinESMExports();
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /publication stat denied/u,
  );
  mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal(await readFile(racingMarker, "utf8"), markerContents);

  const competingHome = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = competingHome;
  const competingSources = path.join(competingHome, "sources.json");
  const competingContents = JSON.stringify([record]);
  const competingHook = changeAtLock(t, 2, () => writeFileSync(competingSources, competingContents));
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  assert.equal(competingHook.fired(), true);
  assert.equal(await readFile(competingSources, "utf8"), competingContents);
});

test("restore keeps a competing source record changed before publication", async (t) => {
  const previousHome = process.env["MARGRAVE_HOME"];
  const previousPath = process.env["PATH"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  process.env["PATH"] = `${await fakeRipwire()}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  });
  const repo = await makeRepo();
  const ctx = { log: (): void => {}, allowUnsafe: false };
  await installSource(repo.url, null, ctx);
  const lock = await exportLock([]);
  const file = path.join(home, "sources.json");
  const records = JSON.parse(readFileSync(file, "utf8")) as { installedAt: string }[];
  assert.ok(records[0]);
  records[0].installedAt = "competing writer";
  const competing = JSON.stringify(records);
  const hook = changeAtLock(t, 1, () => writeFileSync(file, competing));
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  assert.equal(hook.fired(), true);
  assert.equal(readFileSync(file, "utf8"), competing);
});

test("restore retains competing index changes before publication", async (t) => {
  const previousHome = process.env["MARGRAVE_HOME"];
  const previousPath = process.env["PATH"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  process.env["PATH"] = `${await fakeRipwire()}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  });
  const repo = await makeRepo();
  const ctx = { log: (): void => {}, allowUnsafe: false };
  await installSource(repo.url, null, ctx);
  const lock = await exportLock([]);
  const id = lock.sources[0]?.skills[0]?.id;
  assert.ok(id);
  const hash = `sha256:${"c".repeat(64)}`;
  const hook = changeAtLock(t, 1, () =>
    writeIndexRows(home, (db) => {
      db.prepare("UPDATE skills SET hash = ? WHERE id = ?").run(hash, id);
    }),
  );
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  assert.equal(hook.fired(), true);
  const after = await exportLock([]);
  assert.equal(after.sources[0]?.skills.find((skill) => skill.id === id)?.revision, hash);
  mock.restoreAll();
  const revision = lock.sources[0]?.skills.find((skill) => skill.id === id)?.revision;
  assert.ok(revision);
  writeIndexRows(home, (db) => {
    db.prepare("UPDATE skills SET hash = ?, dir = ? WHERE id = ?").run(revision, "/different/indexed/directory", id);
  });
  const before = indexRows(home);
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  assert.deepEqual(indexRows(home), before);
});

test("restore recreates the pending marker when cleanup commit fails", async (t) => {
  const previousHome = process.env["MARGRAVE_HOME"];
  const previousPath = process.env["PATH"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  process.env["PATH"] = `${await fakeRipwire()}:${previousPath ?? ""}`;
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  });
  const repo = await makeRepo();
  const ctx = { log: (): void => {}, allowUnsafe: false };
  const { id } = await installSource(repo.url, null, ctx);
  const lock = await exportLock([]);
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const marker = path.join(home, "restore-pending", `${id}.json`);
  let published = false;
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") {
      if (published && !existsSync(marker)) throw new Error("cleanup commit failed");
      if (existsSync(marker)) published = true;
    }
    return realExec.call(this, sql);
  });
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /restore partially completed: cleanup commit failed/u,
  );
  assert.equal(published, true);
  assert.equal((JSON.parse(await readFile(marker, "utf8")) as { source: { id: string } }).source.id, id);
  assert.equal((JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { id: string }[])[0]?.id, id);
  mock.restoreAll();
  const realRm = fsp.rm;
  mock.method(fsp, "rm", ((file: string, ...args: unknown[]) =>
    file === marker
      ? Promise.reject("cleanup denied")
      : (realRm as (...a: unknown[]) => Promise<unknown>)(file, ...args)) as typeof fsp.rm);
  syncBuiltinESMExports();
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /restore partially completed: cleanup denied/u,
  );
  mock.restoreAll();
  syncBuiltinESMExports();
  assert.equal((JSON.parse(await readFile(marker, "utf8")) as { source: { id: string } }).source.id, id);
});

test("restore keeps a competing marker written before cleanup", async (t) => {
  const previousHome = process.env["MARGRAVE_HOME"];
  const previousPath = process.env["PATH"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  process.env["PATH"] = `${await fakeRipwire()}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  });
  const repo = await makeRepo();
  const ctx = { log: (): void => {}, allowUnsafe: false };
  const { id } = await installSource(repo.url, null, ctx);
  const lock = await exportLock([]);
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const marker = path.join(home, "restore-pending", `${id}.json`);
  let competing = "";
  await assert.rejects(
    restoreLock(lock, ctx, () => {
      const value = JSON.parse(readFileSync(marker, "utf8")) as { record: { installedAt: string } };
      value.record.installedAt = "competing writer";
      competing = JSON.stringify(value);
      writeFileSync(marker, competing);
    }),
    /restore partially completed: restore is pending for a different lock source/u,
  );
  assert.notEqual(competing, "");
  assert.equal(await readFile(marker, "utf8"), competing);
  assert.equal((JSON.parse(await readFile(path.join(home, "sources.json"), "utf8")) as { id: string }[])[0]?.id, id);
  const other = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = other;
  const otherMarker = path.join(other, "restore-pending", `${id}.json`);
  await assert.rejects(
    restoreLock(lock, ctx, () => {
      const value = JSON.parse(readFileSync(otherMarker, "utf8")) as { source: { ref: string }; record: { ref: string } };
      value.source.ref = "refs/heads/other";
      value.record.ref = value.source.ref;
      competing = JSON.stringify(value);
      writeFileSync(otherMarker, competing);
    }),
    /restore partially completed: restore is pending for a different lock source/u,
  );
  assert.equal(await readFile(otherMarker, "utf8"), competing);
});

test("restore rejects a staged commit that does not match the lock", async (t) => {
  const previousHome = process.env["MARGRAVE_HOME"];
  const previousPath = process.env["PATH"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  process.env["PATH"] = `${await fakeRipwire()}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previousHome;
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
  });
  const repo = await makeRepo();
  const ctx = { log: (): void => {}, allowUnsafe: false };
  await installSource(repo.url, null, ctx);
  const lock = await exportLock([]);
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const bin = await tmp("mg-git-wrapper-");
  const wrapper = path.join(bin, "git");
  await writeFile(
    wrapper,
    '#!/bin/sh\nif [ "$3" = rev-parse ] && [ "$4" = HEAD ]; then printf "%040d\\n" 0; exit 0; fi\nPATH=${PATH#*:}; export PATH\nexec git "$@"\n',
  );
  await chmod(wrapper, 0o755);
  process.env["PATH"] = `${bin}:${process.env["PATH"]}`;
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /locked commit is unavailable/u,
  );
  await assert.rejects(readFile(path.join(home, "sources.json")), { code: "ENOENT" });
});

test("lock validation rejects malformed source and skill fields", () => {
  assert.doesNotThrow(() => checkLockUrl("https://["));
  const parsed = parseSpec("owner/repo");
  assert.equal(parsed.kind, "git");
  if (parsed.kind !== "git") throw new Error("expected Git source");
  const skill = { id: `${parsed.id}/skill`, revision: `sha256:${"b".repeat(64)}` };
  const source = {
    spec: "owner/repo",
    id: parsed.id,
    url: parsed.url,
    subpath: parsed.subpath,
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    skills: [skill],
  };
  for (const value of [null, {}, { version: 2, sources: [] }, { version: 1, sources: "bad" }, { version: 1, sources: [], extra: 1 }]) {
    assert.throws(() => parseLock(value), /lock file is malformed/u);
  }
  for (const change of [
    { spec: 1 },
    { id: 1 },
    { url: 1 },
    { subpath: 1 },
    { ref: 1 },
    { commit: 1 },
    { skills: null },
    { extra: 1 },
    { commit: "bad" },
    { skills: [null] },
    { skills: [{ ...skill, id: "wrong" }] },
    { skills: [{ ...skill, id: `${parsed.id}/` }] },
    { skills: [{ ...skill, id: `${parsed.id}/nested/skill` }] },
    { skills: [{ ...skill, id: 1 }] },
    { skills: [{ ...skill, revision: 1 }] },
    { skills: [{ ...skill, revision: "bad" }] },
    { skills: [{ ...skill, extra: 1 }] },
    { skills: [skill, skill] },
  ]) {
    assert.throws(() => parseLock({ version: 1, sources: [{ ...source, ...change }] }), /lock file is malformed/u);
  }
  assert.throws(
    () => parseLock({ version: 1, sources: [{ ...source, spec: "not-a-spec" }] }),
    /lock source does not match its install spec/u,
  );
});

test("lock parsing orders sources and skills lexically", () => {
  const makeSource = (spec: string) => {
    const parsed = parseSpec(spec);
    assert.equal(parsed.kind, "git");
    if (parsed.kind !== "git") throw new Error("expected Git source");
    return {
      spec,
      id: parsed.id,
      url: parsed.url,
      subpath: parsed.subpath,
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      skills: ["z", "a", "m"].map((name) => ({ id: `${parsed.id}/${name}`, revision: `sha256:${"b".repeat(64)}` })),
    };
  };
  const sources = [makeSource("z/repo"), makeSource("a/repo"), makeSource("m/repo")];
  const result = parseLock({ version: 1, sources });
  assert.deepEqual(
    result.sources.map((source) => source.id),
    ["a__repo", "m__repo", "z__repo"],
  );
  for (const source of result.sources) {
    assert.deepEqual(
      source.skills.map((skill) => skill.id),
      ["a", "m", "z"].map((name) => `${source.id}/${name}`),
    );
  }
});
