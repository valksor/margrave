import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fsp, { chmod, cp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { parseLock, restoreLock } from "../src/lock.ts";
import { exportLock, indexedEntries, matchesLock, sameInventory, verifyInstalled } from "../src/lock-format.ts";
import { scanSource } from "../src/scan.ts";
import { toEntries } from "../src/source-files.ts";
import { parseSpec } from "../src/source-git.ts";
import { installSource } from "../src/sources.ts";
import {
  catalogRecords,
  changeAtLock,
  fakeRipwire,
  indexRows,
  makeRepo,
  newEntry,
  realExec,
  seedIndex,
  tmp,
  writeCatalogRecords,
  writeIndexRows,
} from "./helpers.ts";

test("lock inventory compares source identity and unordered skill revisions", () => {
  const spec = "example/project/skills";
  const parsed = parseSpec(spec);
  assert.equal(parsed.kind, "git");
  const rec = {
    ...parsed,
    spec,
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    installedAt: "2026-01-01T00:00:00.000Z",
    snapshot: `${"a".repeat(40)}-${"d".repeat(16)}`,
  };
  const revision = `sha256:${"b".repeat(64)}`;
  const locked = {
    spec,
    id: parsed.id,
    url: parsed.url,
    subpath: parsed.subpath,
    ref: rec.ref,
    commit: rec.commit,
    skills: [
      { id: `${parsed.id}/a`, revision },
      { id: `${parsed.id}/b`, revision },
    ],
  };
  assert.equal(matchesLock(rec, locked), true);
  assert.equal(matchesLock(rec, { ...locked, selection: null }), true);
  assert.equal(matchesLock({ ...rec, selection: ["a"] }, { ...locked, selection: ["a"] }), true);
  assert.equal(matchesLock({ ...rec, selection: ["a"] }, { ...locked, selection: ["b"] }), false);
  assert.equal(matchesLock({ ...rec, kind: "local" }, locked), false);
  for (const field of ["id", "spec", "url", "subpath", "ref", "commit"] as const)
    assert.equal(matchesLock({ ...rec, [field]: `${rec[field]}-other` }, locked), false, field);

  const entries = [
    { ...locked.skills[1]!, dir: "b", manifest: "b" },
    { ...locked.skills[0]!, dir: "a", manifest: "a" },
  ];
  assert.equal(sameInventory(entries, locked), true);
  assert.equal(sameInventory(entries.slice(1), locked), false);
  assert.equal(sameInventory([...entries, { ...entries[0]!, id: `${parsed.id}/c` }], locked), false);
  assert.equal(sameInventory([{ ...entries[0]!, id: `${parsed.id}/c` }, entries[1]!], locked), false);
  assert.equal(sameInventory([{ ...entries[0]!, revision: `sha256:${"c".repeat(64)}` }, entries[1]!], locked), false);
  const duplicate = { ...entries[1]!, revision: `sha256:${"d".repeat(64)}` };
  const duplicateLock = { ...locked, skills: [locked.skills[0]!, { id: duplicate.id, revision: duplicate.revision }, locked.skills[1]!] };
  assert.equal(sameInventory([entries[0]!, entries[1]!, duplicate], duplicateLock), true);
  assert.equal(sameInventory([entries[0]!, duplicate, entries[1]!], duplicateLock), false);
});

test("lock export API reads sorted source entries and closes the catalog", async (t) => {
  const previous = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(() => {
    mock.restoreAll();
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
  });
  assert.deepEqual(await exportLock([]), { version: 2, sources: [] });
  await assert.rejects(exportLock(["missing"]), { message: "--source must be an installed Git source ID" });
  await seedIndex([]);
  assert.deepEqual(await exportLock([]), { version: 2, sources: [] });

  const spec = "example/project";
  const parsed = parseSpec(spec);
  assert.equal(parsed.kind, "git");
  const rec = {
    ...parsed,
    spec,
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    installedAt: "2026-01-01T00:00:00.000Z",
    snapshot: `${"a".repeat(40)}-${"d".repeat(16)}`,
  };
  const local = {
    id: "local",
    kind: "local" as const,
    spec: "/local",
    path: "/local",
    subpath: "",
    ref: null,
    commit: null,
    installedAt: rec.installedAt,
  };
  const revision = `sha256:${"b".repeat(64)}`;
  const a = { ...newEntry(rec.id, "a"), revision, manifest: '["a"]', dir: "skills/a" };
  const b = { ...newEntry(rec.id, "b"), revision, manifest: '["b"]', dir: "skills/b" };
  await rm(path.join(home, "index.db"));
  await seedIndex([b, newEntry(local.id, "other"), a], [rec, local]);
  const db = new DatabaseSync(path.join(home, "index.db"), { readOnly: true });
  try {
    assert.deepEqual(
      indexedEntries(db, rec.id).map((row) => ({ ...row })),
      [
        { id: a.id, revision, manifest: a.manifest, dir: a.dir },
        { id: b.id, revision, manifest: b.manifest, dir: b.dir },
      ],
    );
    assert.deepEqual(indexedEntries(db, "missing"), []);
  } finally {
    db.close();
  }
  const closeDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "close");
  assert.ok(closeDescriptor?.value);
  let closes = 0;
  mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closes++;
    return (closeDescriptor.value as typeof DatabaseSync.prototype.close).call(this);
  });
  await assert.rejects(exportLock([]), { message: "select Git sources with --source when the store contains local directories" });
  assert.equal(closes, 1);
  for (const id of ["missing", local.id])
    await assert.rejects(exportLock([id]), { message: "--source must be an installed Git source ID" });
  const wholeLock = {
    version: 2,
    sources: [
      {
        spec,
        id: rec.id,
        url: rec.url,
        subpath: rec.subpath,
        ref: rec.ref,
        commit: rec.commit,
        skills: [
          { id: a.id, revision },
          { id: b.id, revision },
        ],
        selection: null,
      },
    ],
  };
  assert.deepEqual(await exportLock([rec.id]), wholeLock);
  assert.equal(closes, 4);
  mock.restoreAll();
  await rm(path.join(home, "index.db"));
  await seedIndex([b, a], [rec]);
  assert.deepEqual(await exportLock([]), wholeLock);
  assert.deepEqual(await exportLock([rec.id]), wholeLock);
  await rm(path.join(home, "index.db"));
  await seedIndex([a], [{ ...rec, selection: ["a"] }, local]);
  assert.deepEqual(await exportLock([rec.id]), {
    version: 2,
    sources: [
      {
        spec,
        id: rec.id,
        url: rec.url,
        subpath: rec.subpath,
        ref: rec.ref,
        commit: rec.commit,
        skills: [{ id: a.id, revision }],
        selection: ["a"],
      },
    ],
  });
  for (const change of [{ spec: "https://example.invalid/repo?query" }, { url: "https://@example.invalid/repo" }]) {
    await rm(path.join(home, "index.db"));
    await seedIndex([a, b], [rec, { ...rec, id: "other", ...change }]);
    const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
    assert.ok(prepareDescriptor?.value);
    const prepareMock = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql === "SELECT id, hash AS revision, manifest, dir FROM skills WHERE source = ? ORDER BY id")
        throw new Error("inventory query reached");
      return (prepareDescriptor.value as typeof DatabaseSync.prototype.prepare).call(this, sql);
    });
    const closed: DatabaseSync[] = [];
    const closeMock = mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
      closed.push(this);
      return (closeDescriptor.value as typeof DatabaseSync.prototype.close).call(this);
    });
    try {
      await assert.rejects(exportLock([rec.id, "other"]), {
        message: "lock source URL must not contain credentials, a query, or a fragment",
      });
      assert.equal(closed.length, 1);
      assert.equal(closed[0]?.isOpen, false);
    } finally {
      prepareMock.mock.restore();
      closeMock.mock.restore();
    }
  }
});

test("lock verification compares the real snapshot, indexed inventory, manifest and directory", async (t) => {
  const previous = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(() => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
  });
  const spec = "example/project";
  const parsed = parseSpec(spec);
  assert.equal(parsed.kind, "git");
  const rec = {
    ...parsed,
    spec,
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    installedAt: "2026-01-01T00:00:00.000Z",
    snapshot: `${"a".repeat(40)}-${"d".repeat(16)}`,
  };
  const dir = path.join(home, "snapshots", rec.id, rec.snapshot);
  for (const name of ["skill", "second"]) {
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: A skill\n---\n\nContent\n`);
  }
  await symlink(path.join(dir, "skill"), path.join(dir, "link"));
  const scan = await scanSource(dir, { followSymlinks: false, boundary: dir, strict: true });
  assert.ok(scan.warnings.length > 0);
  const entries = toEntries(rec.id, scan.skills, (d) => path.relative(dir, d));
  assert.equal(entries.length, 2);
  const entry = entries[0]!;
  const locked = {
    spec,
    id: rec.id,
    url: rec.url,
    subpath: rec.subpath,
    ref: rec.ref,
    commit: rec.commit,
    skills: entries.map(({ id, revision }) => ({ id, revision })),
  };
  await seedIndex(entries, [rec]);
  const db = new DatabaseSync(path.join(home, "index.db"));
  t.after(() => db.close());
  await verifyInstalled(rec, locked, db);
  const stale = `sha256:${"c".repeat(64)}`;
  const failure = { message: `installed source differs from the lock: ${rec.id}` };
  db.prepare("UPDATE skills SET hash = ? WHERE id = ?").run(stale, entry.id);
  await assert.rejects(
    verifyInstalled(
      rec,
      { ...locked, skills: locked.skills.map((skill) => (skill.id === entry.id ? { ...skill, revision: stale } : skill)) },
      db,
    ),
    failure,
  );
  await assert.rejects(verifyInstalled(rec, locked, db), failure);
  db.prepare("UPDATE skills SET hash = ?, manifest = ? WHERE id = ?").run(entry.revision, "changed", entry.id);
  await assert.rejects(verifyInstalled(rec, locked, db), failure);
  db.prepare("UPDATE skills SET manifest = ?, dir = ? WHERE id = ?").run(entry.manifest, "changed", entry.id);
  await assert.rejects(verifyInstalled(rec, locked, db), failure);
});

test("an empty store exports and restores an empty lock", async (t) => {
  const previous = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  t.after(() => {
    if (previous === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = previous;
  });
  const lock = await exportLock([]);
  assert.deepEqual(lock, { version: 2, sources: [] });
  const output: string[] = [];
  await restoreLock(lock, { log: () => {}, allowUnsafe: false }, (line) => output.push(line));
  assert.deepEqual(output, []);
});

test("version 2 restores selected skills and version 1 restores the whole source", async (t) => {
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
  await installSource(repo.url, null, ctx, ["react-perf"]);
  const selected = await exportLock([]);
  assert.equal(selected.version, 2);
  assert.deepEqual(selected.sources[0]?.selection, ["react-perf"]);
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  await restoreLock(selected, ctx, () => {});
  assert.deepEqual((await exportLock([])).sources[0]?.selection, ["react-perf"]);
  assert.equal(indexRows(process.env["MARGRAVE_HOME"]).length, 1);
  await rename(repo.dir, `${repo.dir}-offline`);
  try {
    await restoreLock(selected, ctx, () => {});
  } finally {
    await rename(`${repo.dir}-offline`, repo.dir);
  }

  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  await installSource(repo.url, null, ctx);
  const whole = await exportLock([]);
  const legacy = parseLock({ version: 1, sources: whole.sources.map(({ selection: _selection, ...source }) => source) });
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  await restoreLock(legacy, ctx, () => {});
  assert.equal(indexRows(process.env["MARGRAVE_HOME"]).length, 3);
  assert.equal((await exportLock([])).sources[0]?.selection, null);
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
  const record = catalogRecords(process.env["MARGRAVE_HOME"])[0];
  const destination = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = destination;
  const pending = path.join(destination, "restore-pending", `${id}.json`);
  await mkdir(path.dirname(pending), { recursive: true });
  for (const contents of [
    "{",
    "{}\n",
    JSON.stringify({ source: lock.sources[0], record, original: "bad" }),
    JSON.stringify({ source: lock.sources[0], record: null }),
  ]) {
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

test("restore syncs an interrupted snapshot before retry publication", async (t) => {
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
  const record = catalogRecords(process.env["MARGRAVE_HOME"])[0];
  assert.ok(record?.snapshot);
  const relativeFile = path.join("skills", "react-perf", "SKILL.md");
  const bytes = await readFile(path.join(process.env["MARGRAVE_HOME"], "snapshots", id, record.snapshot, relativeFile));
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const marker = path.join(home, "restore-pending", `${id}.json`);
  const realOpen = fsp.open;
  let interrupted = false;
  let retrySynced = false;
  let syncedFile = "";
  mock.method(fsp, "open", (async (file: string, ...args: unknown[]) => {
    const handle = await (realOpen as (...a: unknown[]) => ReturnType<typeof fsp.open>)(file, ...args);
    if (typeof file === "string" && file.startsWith(path.join(home, "snapshots") + path.sep) && file.endsWith(relativeFile)) {
      const sync = handle.sync.bind(handle);
      mock.method(handle, "sync", async () => {
        if (!interrupted) {
          interrupted = true;
          syncedFile = file;
          throw new Error("snapshot sync interrupted");
        }
        assert.equal(file, syncedFile);
        assert.deepEqual((await exportLock([])).sources, []);
        await sync();
        retrySynced = true;
      });
    }
    return handle;
  }) as typeof fsp.open);
  syncBuiltinESMExports();
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /snapshot sync interrupted/u,
  );
  assert.ok(interrupted);
  assert.ok(existsSync(marker));
  assert.deepEqual(await readFile(syncedFile), bytes);
  assert.deepEqual((await exportLock([])).sources, []);
  await restoreLock(lock, ctx, () => {});
  assert.ok(retrySynced, "retry must sync the pending snapshot before publication");
  assert.deepEqual(await readFile(syncedFile), bytes);
  assert.deepEqual((await exportLock([])).sources, lock.sources);
  assert.equal(existsSync(marker), false);
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
  const records = catalogRecords(process.env["MARGRAVE_HOME"]);
  const record = records[0];
  assert.ok(record);
  const originalSnapshot = path.join(process.env["MARGRAVE_HOME"], "snapshots", id, record.snapshot!);
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
  const warnings: string[] = [];
  mock.method(console, "error", (message: unknown) => {
    warnings.push(String(message));
  });
  await restoreLock(lock, ctx, () => {});
  assert.ok(warnings.some((message) => message.includes("alias stat denied")));
  mock.restoreAll();
  syncBuiltinESMExports();
  await rm(invalid, { recursive: true });
  const existingMarker = path.join(process.env["MARGRAVE_HOME"], "restore-pending", `${id}.json`);
  await mkdir(path.dirname(existingMarker), { recursive: true });
  const mismatchedRecord = { ...record, snapshot: `${record.snapshot!.slice(0, -16)}0000000000000000` };
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
  const legacy = parseLock({ version: 1, sources: lock.sources.map(({ selection: _selection, ...source }) => source) });
  await writeFile(existingMarker, JSON.stringify({ source: legacy.sources[0], record }));
  await restoreLock(legacy, ctx, () => {});
  await assert.rejects(readFile(existingMarker), { code: "ENOENT" });
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  const marker = path.join(home, "restore-pending", `${id}.json`);
  const destination = path.join(home, "snapshots", id, record.snapshot!);
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, markerContents);
  await restoreLock(lock, ctx, () => {});
  const restored = catalogRecords(home);
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
  const otherDestination = path.join(other, "snapshots", id, record.snapshot!);
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
  assert.equal(catalogRecords(other)[0]?.snapshot, record.snapshot);

  const racing = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = racing;
  const racingMarker = path.join(racing, "restore-pending", `${id}.json`);
  const racingDestination = path.join(racing, "snapshots", id, record.snapshot!);
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
  await installSource(repo.url, null, ctx);
  const competingRecords = catalogRecords(competingHome);
  competingRecords[0]!.installedAt = "competing writer";
  const competingHook = changeAtLock(t, 3, () => writeCatalogRecords(competingHome, competingRecords));
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  assert.equal(competingHook.fired(), true);
  assert.deepEqual(catalogRecords(competingHome), competingRecords);
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
  const records = catalogRecords(home);
  assert.ok(records[0]);
  records[0].installedAt = "competing writer";
  const competing = JSON.stringify(records);
  const hook = changeAtLock(t, 3, () => writeCatalogRecords(home, records));
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  assert.equal(hook.fired(), true);
  assert.equal(JSON.stringify(catalogRecords(home)), competing);
});

test("recovery refuses a competing source update before publication", async (t) => {
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
  const { id } = await installSource(repo.url, null, ctx);
  const lock = await exportLock([]);
  await writeFile(path.join(home, "sources", id, "skills", "react-perf", "SKILL.md"), "drift\n");
  const competing = catalogRecords(home);
  competing[0]!.installedAt = "competing writer";
  const hook = changeAtLock(t, 3, () => writeCatalogRecords(home, competing));
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  assert.equal(hook.fired(), true);
  assert.deepEqual(catalogRecords(home), competing);
});

test("lock restore refuses staged edits on either side of the scan", async (t) => {
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
  for (const mode of ["before", "after"] as const) {
    process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
    let scans = 0;
    let fired = false;
    const real = fsp.readdir;
    mock.method(fsp, "readdir", (async (dir: string, ...args: unknown[]) => {
      if (dir.includes(`${path.sep}staging${path.sep}`) && dir.endsWith(`${path.sep}${id}`)) {
        if (args.length > 0) scans++;
        if (!fired && ((mode === "before" && args.length === 0) || (mode === "after" && scans === 2))) {
          fired = true;
          await writeFile(path.join(dir, "skills", "react-perf", "SKILL.md"), "changed\n");
        }
      }
      return (real as (...a: unknown[]) => Promise<unknown>)(dir, ...args);
    }) as typeof fsp.readdir);
    syncBuiltinESMExports();
    await assert.rejects(
      restoreLock(lock, ctx, () => {}),
      mode === "before" ? /staged skills differ from the lock/u : /installed source differs from the lock/u,
    );
    assert.equal(fired, true);
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("restore refuses a source installed after preflight", async (t) => {
  const previousHome = process.env["MARGRAVE_HOME"];
  const previousPath = process.env["PATH"];
  const from = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = from;
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
  const competing = catalogRecords(from);
  const destination = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = destination;
  await seedIndex([]);
  const hook = changeAtLock(t, 3, () => writeCatalogRecords(destination, competing));
  await assert.rejects(
    restoreLock(lock, ctx, () => {}),
    /installed source differs from the lock/u,
  );
  assert.equal(hook.fired(), true);
  assert.deepEqual(catalogRecords(destination), competing);
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
    if (sql === "ROLLBACK" || sql === "COMMIT") {
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
  assert.equal(catalogRecords(home)[0]?.id, id);
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
  assert.equal(catalogRecords(home)[0]?.id, id);
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
