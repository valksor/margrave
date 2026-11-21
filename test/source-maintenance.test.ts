import assert from "node:assert/strict";
import fsp, { mkdir, writeFile, rm, readFile, readdir, realpath } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock } from "node:test";
import { checkSources, reindexAll, removeSource } from "../src/source-maintenance.ts";
import { installSource, localId } from "../src/sources.ts";
import {
  catalogRecords,
  fakeRipwire,
  indexIds,
  indexRows,
  makeRepo,
  runCli,
  tmp,
  writeCatalogRecords,
  writeSkill,
  quiet,
  inStore,
  failRename,
  passRename,
  read,
  mockSourcesRead,
  changeAtLock,
  newEntry,
  writeIndexRows,
  useHome,
  catalogSetup,
  localSource,
  readSourceRecords,
  removedByAnother,
  git,
  head,
  skillMd,
  cliSetup,
  cliMg as mg,
  cliSnapshot as snapshot,
  sourceId,
  installLocalDir,
} from "./helpers.ts";
import { insertSkills } from "../src/store.ts";

export async function storeFiles(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(await storeFiles(file))) files[path.join(entry.name, name)] = bytes;
    } else if (entry.isFile()) files[entry.name] = (await readFile(file)).toString("base64");
  }
  return files;
}

test("reindex: when sources.json cannot be written, the rows roll back, and a legacy index.json is kept", async (t) => {
  await inStore(t, async (home) => {
    const dir = await tmp("mg-localsrc-");
    await writeSkill(dir, "alpha", "alpha skill");
    await installSource(dir, null, quiet);
    const ids = indexIds(home);
    const sources = await read(home, "sources.json");
    await writeFile(path.join(home, "index.json"), "legacy");
    await writeSkill(dir, "beta", "beta skill");

    failRename((_from, to) => to.endsWith("index.db"));
    await assert.rejects(reindexAll(quiet), /mock: cannot rename to .*index\.db/u);
    assert.deepEqual(indexIds(home), ids, "the old index stays");
    assert.equal(await read(home, "sources.json"), sources);
    assert.equal(await read(home, "index.json"), "legacy", "the legacy file stays after a failed reindex");

    passRename();
    assert.deepEqual(await reindexAll(quiet), { skills: 2, sources: 1 });
    assert.equal(indexIds(home).length, 2);
    assert.equal(await read(home, "index.json"), "legacy");
  });
});

test("reindex: a rejection that is not an Error is logged as text and the source is skipped", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const dir = await fsp.realpath(path.join(home, "sources", id));

    mock.restoreAll();
    const real = fsp.realpath;
    mock.method(fsp, "realpath", (p: string, ...rest: never[]) =>
      p === dir ? Promise.reject("boom, not an Error") : (real as (...a: unknown[]) => Promise<string>)(p, ...rest),
    );
    syncBuiltinESMExports();
    const logs: string[] = [];
    const r = await reindexAll({ log: (m) => logs.push(m), allowUnsafe: false });
    assert.deepEqual(r, { skills: 0, sources: 1 });
    assert.deepEqual(logs, [`warning: ${id}: boom, not an Error; skipped`]);
  });
});

test("check reports a source record changed during its scan", async (t) => {
  await inStore(t, async (home) => {
    const root = await tmp("mg-source-");
    await writeSkill(root, "alpha", "alpha skill");
    const { id } = await installSource(root, null, quiet);
    const real = fsp.readdir;
    let changed = false;
    mock.method(fsp, "readdir", (async (p: string, ...args: unknown[]) => {
      if (p === root && !changed) {
        changed = true;
        const records = catalogRecords(home);
        assert.ok(records[0]);
        records[0].installedAt = "changed";
        writeCatalogRecords(home, records);
      }
      return (real as (...x: unknown[]) => Promise<unknown>)(p, ...args);
    }) as typeof fsp.readdir);
    syncBuiltinESMExports();
    const results = await checkSources(id);
    assert.equal(changed, true);
    assert.equal(results[0]?.error, "source changed during check; run margrave check again");
  });
});

test("check reports a metadata read failure without changing the store", async (t) => {
  await inStore(t, async (home) => {
    const root = await tmp("mg-source-");
    await writeSkill(root, "alpha", "alpha skill");
    const { id } = await installSource(root, null, quiet);
    const before = await read(home, "sources.json");
    const rows = indexRows(home);
    mockSourcesRead((nth) => (nth === 2 ? { error: new Error("metadata denied") } : undefined));
    const checked = await checkSources(id);
    assert.equal(checked[0]?.error, "metadata denied");
    mockSourcesRead((nth) => (nth === 2 ? { error: "metadata unavailable" } : undefined));
    assert.equal((await checkSources(id))[0]?.error, "metadata unavailable");
    mock.restoreAll();
    syncBuiltinESMExports();
    const actual = fsp.readdir;
    mock.method(fsp, "readdir", ((file: string, ...args: unknown[]) =>
      file === root
        ? Promise.reject("scan unavailable")
        : (actual as (...a: unknown[]) => Promise<unknown>)(file, ...args)) as typeof fsp.readdir);
    syncBuiltinESMExports();
    assert.equal((await checkSources(id))[0]?.error, "scan unavailable");
    mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(await read(home, "sources.json"), before);
    assert.deepEqual(indexRows(home), rows);
  });
});

test("check scans valid skills alongside a skipped invalid skill", async (t) => {
  await inStore(t, async (home) => {
    const root = await tmp("mg-source-");
    await writeSkill(root, "alpha", "alpha skill");
    const { id } = await installSource(root, null, quiet);
    const before = await read(home, "sources.json");
    const rows = indexRows(home);
    await mkdir(path.join(root, "invalid"));
    await writeFile(path.join(root, "invalid", "SKILL.md"), "no frontmatter\n");
    const checked = await checkSources(id);
    assert.equal(checked[0]?.error, null);
    assert.deepEqual(checked[0]?.added, []);
    assert.deepEqual(checked[0]?.changed, []);
    assert.deepEqual(checked[0]?.removed, []);
    assert.equal(await read(home, "sources.json"), before);
    assert.deepEqual(indexRows(home), rows);
  });
});

test("check reports an unavailable local Git remote without changing the store", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const before = await read(home, "sources.json");
    const rows = indexRows(home);
    await fsp.rm(repo.dir, { recursive: true, force: true });
    const checked = await checkSources(id);
    assert.match(checked[0]?.error ?? "", /cannot read remote tracking ref/u);
    assert.equal(await read(home, "sources.json"), before);
    assert.deepEqual(indexRows(home), rows);
  });
});

test("reindex: control characters in a failure message are logged as text", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const dir = await fsp.realpath(path.join(home, "sources", id));

    mock.restoreAll();
    const real = fsp.realpath;
    mock.method(fsp, "realpath", (p: string, ...rest: never[]) =>
      p === dir ? Promise.reject(new Error("bad \u001b[2J name")) : (real as (...a: unknown[]) => Promise<string>)(p, ...rest),
    );
    syncBuiltinESMExports();
    const logs: string[] = [];
    await reindexAll({ log: (m) => logs.push(m), allowUnsafe: false });
    assert.deepEqual(logs, [`warning: ${id}: bad \\x1b[2J name; skipped`]);
    assert.ok(!logs.join("").includes("\u001b"));
  });
});

test("reindex preserves unreadable source rows", async (t) => {
  const prev = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const root = await tmp("mg-source-");
  const skill = await writeSkill(root, "alpha", "test skill");
  const refs = path.join(skill, "references");
  await mkdir(refs);
  await writeFile(path.join(refs, "x.md"), "text");
  const result = await runCli(["install", root], { home, fakeBin: await fakeRipwire() });
  assert.equal(result.code, 0, result.stderr);
  const other = await tmp("mg-source-");
  const otherSkill = await writeSkill(other, "beta", "other skill");
  const second = await runCli(["install", other], { home, fakeBin: await fakeRipwire() });
  assert.equal(second.code, 0, second.stderr);
  const rows = indexRows(home);
  await writeFile(path.join(otherSkill, "reference.md"), "new content");
  const actual = fsp.readdir;
  mock.method(fsp, "readdir", ((p: string, ...args: unknown[]) =>
    p === refs
      ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
      : (actual as (...x: unknown[]) => unknown)(p, ...args)) as typeof fsp.readdir);
  syncBuiltinESMExports();
  const checked = await checkSources(null);
  assert.equal(checked.length, 2);
  assert.match(checked.find((item) => item.id === localId(root))?.error ?? "", /denied/u);
  assert.deepEqual(checked.find((item) => item.id === localId(other))?.changed, [`${localId(other)}/beta`]);
  const logs: string[] = [];
  await reindexAll({ log: (line) => logs.push(line), allowUnsafe: false });
  const after = indexRows(home);
  assert.deepEqual(
    after.find((row) => row.name === "alpha"),
    rows.find((row) => row.name === "alpha"),
  );
  assert.notEqual(after.find((row) => row.name === "beta")?.hash, rows.find((row) => row.name === "beta")?.hash);
  assert.match(logs.join("\n"), /denied/u);
  mock.restoreAll();
  syncBuiltinESMExports();
  await reindexAll({ log: () => {}, allowUnsafe: false });
});

test("reindex creates MARGRAVE_HOME when it does not exist", async () => {
  const home = path.join(await tmp("mg-parent-"), "not", "there", "yet");
  const r = await runCli(["reindex"], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(indexIds(home), []);
});

test("a source whose skills are gone lists with skills=0 after a reindex", async () => {
  const s = await catalogSetup();
  await rm(path.join(s.dir, "alpha"), { recursive: true });
  assert.equal((await s.mg(["reindex"])).code, 0);
  const list = await s.mg(["list"]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /skills=0\n$/u);
});

test("a reindex whose sources change after its scan reports it under the lock, and loses nothing", async (t) => {
  const s = await catalogSetup();
  useHome(t, s.home);
  const extra = await localSource("beta");
  const record = extra.record("local__extra-abc123");
  const existing = readSourceRecords(s.home);
  // BEGIN IMMEDIATE number 1 is the schema check when the connection opens; number 2 is the reindex's own lock.
  const lock = changeAtLock(t, 1, () => {
    // The change acts as an install that won the lock: a new source record and new rows.
    writeIndexRows(s.home, (db) => insertSkills(db, [newEntry(record.id, "beta")]));
    writeCatalogRecords(s.home, [...existing, record]);
  });
  await assert.rejects(reindexAll(quiet), /sources changed during reindex; run: margrave reindex/u);
  assert.equal(lock.fired(), true, "the error came after the reindex's lock was taken");
  assert.equal(lock.begins(), 2);
  assert.deepEqual(
    readSourceRecords(s.home)
      .map((x) => x.id)
      .sort(),
    [s.id, "local__extra-abc123"].sort(),
  );
  assert.deepEqual(indexIds(s.home), ["local__extra-abc123/beta", `${s.id}/alpha`].sort());
  // The next reindex sees the new set and works.
  mock.restoreAll();
  assert.deepEqual(await reindexAll(quiet), { skills: 2, sources: 2 });
});

test("a remove whose source another write removed fails under the lock and changes nothing", async (t) => {
  const s = await catalogSetup();
  useHome(t, s.home);
  const lock = removedByAnother(t, s.home, s.id);
  await assert.rejects(removeSource(s.id), new RegExp(`no source "${s.id}"; run: margrave list`, "u"));
  assert.equal(lock.fired(), true, "the error came after the remove's lock was taken");
  assert.equal(lock.begins(), 2);
  assert.deepEqual(readSourceRecords(s.home), []);
  assert.deepEqual(indexIds(s.home), []);
});

test("Git reindex preserves the accepted inventory when installed files drift", async () => {
  const env = await cliSetup();
  const repo = await makeRepo();
  const installed = await mg(env, ["install", repo.url]);
  assert.equal(installed.code, 0, installed.stderr);
  const id = sourceId(installed);
  const before = await snapshot(env.home);
  const normal = await mg(env, ["reindex"]);
  assert.equal(normal.code, 0, normal.stderr);
  assert.deepEqual(await snapshot(env.home), before);
  await writeFile(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"), skillMd("react-perf", "Changed"));
  const drift = await mg(env, ["reindex"]);
  assert.match(
    drift.stdout + drift.stderr,
    /installed Git files differ from the accepted revision\. Restore a verified lock or a known-good backup/u,
  );
  assert.deepEqual(await snapshot(env.home), before);
});

test("check and explicit Git tracking refs", async () => {
  const env = await cliSetup();
  const repo = await makeRepo();
  await git(repo.dir, "branch", "refs/topic");
  await git(repo.dir, "tag", "-a", "shared", "-m", "tag");
  await git(repo.dir, "branch", "shared");
  const sharedEnv = await cliSetup();
  const shared = await mg(sharedEnv, ["install", repo.url, "--ref", "shared"]);
  assert.equal(shared.code, 0, shared.stderr);
  const sharedRecords = catalogRecords(sharedEnv.home);
  assert.equal(sharedRecords[0]?.ref, "refs/heads/shared");
  const inst = await mg(env, ["install", repo.url, "--ref", "refs/topic"]);
  assert.equal(inst.code, 0, inst.stderr);
  const id = sourceId(inst);
  const indexFile = path.join(env.home, "index.db");
  const record = (): ReturnType<typeof catalogRecords> => catalogRecords(env.home);
  assert.equal(record()[0]?.ref, "refs/heads/refs/topic");
  const taggedCommit = record()[0]?.commit;
  const before = await storeFiles(env.home);
  const current = await mg(env, ["check", id, "--json"]);
  assert.equal(current.code, 0, current.stderr);
  assert.equal((JSON.parse(current.stdout) as { updateAvailable: boolean }[])[0]?.updateAvailable, false);
  assert.deepEqual(await storeFiles(env.home), before);
  const originalSources = catalogRecords(env.home);
  const invalidRecords = structuredClone(originalSources);
  assert.ok(invalidRecords[0]);
  invalidRecords[0].ref = "refs/heads/bad..ref";
  writeCatalogRecords(env.home, invalidRecords);
  assert.equal((await mg(env, ["check", id])).code, 1);
  writeCatalogRecords(env.home, originalSources);
  await writeSkill(path.join(repo.dir, "skills"), "branch-only", "A branch skill");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-qm", "branch commit");
  await git(repo.dir, "branch", "-f", "shared", "HEAD");
  const tag = await mg(env, ["update", id, "--ref", "refs/tags/shared"]);
  assert.equal(tag.code, 0, tag.stderr);
  assert.equal(record()[0]?.ref, "refs/tags/shared");
  assert.equal(record()[0]?.commit, taggedCommit);
  assert.equal((await mg(env, ["check", id])).code, 0);
  await git(repo.dir, "tag", "-d", "shared");
  const missingBefore = await storeFiles(env.home);
  assert.equal((await mg(env, ["check", id])).code, 1);
  const missingJson = await mg(env, ["check", id, "--json"]);
  assert.equal(missingJson.code, 1);
  assert.ok((JSON.parse(missingJson.stdout) as { error: string | null }[])[0]?.error);
  assert.deepEqual(await storeFiles(env.home), missingBefore);
  const failed = await mg(env, ["update", id, "--ref", "refs/heads/missing"]);
  assert.equal(failed.code, 1);
  assert.equal(record()[0]?.ref, "refs/tags/shared");
  const branch = await mg(env, ["update", id, "--ref", "refs/heads/shared"]);
  assert.equal(branch.code, 0, branch.stderr);
  assert.equal(record()[0]?.commit, await head(repo.dir));
  await writeSkill(path.join(repo.dir, "skills"), "later", "A later skill");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-qm", "later commit");
  await git(repo.dir, "branch", "-f", "shared", "HEAD");
  const available = await mg(env, ["check", id]);
  assert.equal(available.code, 1);
  assert.match(available.stdout, /update available/u);
  assert.equal((await mg(env, ["update", "--ref", "refs/heads/main"])).code, 2);
  assert.equal((await mg(env, ["update", id, "--ref", "main"])).code, 2);
  assert.equal((await mg(env, ["update", id, "--ref", "refs/heads/bad..ref"])).code, 2);
  await writeFile(path.join(env.home, "sources", id, "skills", "react-perf", "SKILL.md"), skillMd("react-perf", "changed"));
  const driftBefore = [JSON.stringify(catalogRecords(env.home)), await readFile(indexFile)];
  const drift = await mg(env, ["check", id, "--json"]);
  assert.equal(drift.code, 1, drift.stderr);
  assert.deepEqual((JSON.parse(drift.stdout) as { changed: string[] }[])[0]?.changed, [`${id}/react-perf`]);
  assert.equal((JSON.parse(drift.stdout) as { updateAvailable: boolean }[])[0]?.updateAvailable, true);
  assert.deepEqual([JSON.stringify(catalogRecords(env.home)), await readFile(indexFile)], driftBefore);
});

test("check reports local additions, removals, and supporting file changes", async () => {
  const env = await cliSetup();
  const empty = await mg(env, ["check"]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /no skill sources installed/u);
  const invalidLock = await mg(env, ["lock", "invalid"]);
  assert.equal(invalidLock.code, 2);
  assert.match(invalidLock.stderr, /expected lock export or lock restore/u);
  const root = await tmp("mg-local-");
  await writeSkill(root, "old", "Old skill");
  await writeSkill(root, "kept", "Kept skill");
  const inst = await mg(env, ["install", root]);
  assert.equal(inst.code, 0, inst.stderr);
  const id = sourceId(inst);
  await writeFile(path.join(root, "kept", "support.txt"), "new bytes");
  await rm(path.join(root, "old"), { recursive: true });
  await writeSkill(root, "new", "New skill");
  const before = [JSON.stringify(catalogRecords(env.home)), await readFile(path.join(env.home, "index.db"))];
  const checked = await mg(env, ["check", root, "--json"]);
  assert.equal(checked.code, 1, checked.stderr);
  const rows = JSON.parse(checked.stdout) as { added: string[]; changed: string[]; removed: string[] }[];
  assert.deepEqual(rows[0]?.added, [`${id}/new`]);
  assert.deepEqual(rows[0]?.changed, [`${id}/kept`]);
  assert.deepEqual(rows[0]?.removed, [`${id}/old`]);
  const text = await mg(env, ["check", id]);
  assert.equal(text.code, 1, text.stderr);
  assert.match(text.stdout, new RegExp(`added: ${id}/new`, "u"));
  assert.match(text.stdout, new RegExp(`changed: ${id}/kept`, "u"));
  assert.match(text.stdout, new RegExp(`removed: ${id}/old`, "u"));
  assert.deepEqual([JSON.stringify(catalogRecords(env.home)), await readFile(path.join(env.home, "index.db"))], before);
  assert.equal((await mg(env, ["update", id, "--ref", "refs/heads/main"])).code, 2);
});

test("list errors when index.db is gone, instead of printing skills=0", async () => {
  const env = await cliSetup();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  await rm(path.join(env.home, "index.db"));
  for (const args of [["list"], ["list", "--skills"], ["list", "--json", "--skills"]]) {
    const r = await mg(env, args);
    assert.equal(r.code, 1, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    assert.match(r.stderr, /index\.db is missing\. Restore the complete store backup/u, args.join(" "));
  }
});

test("git source: reindex rescans the stored copy, and skips it when the copy is gone", async () => {
  const env = await cliSetup();
  const repo = await makeRepo();
  const id = sourceId(await mg(env, ["install", repo.url]));
  const re = await mg(env, ["reindex"]);
  assert.equal(re.code, 0, re.stderr);
  assert.equal(re.stdout.trim(), "reindexed 3 skills from 1 sources");

  await rm(await realpath(path.join(env.home, "sources", id)), { recursive: true });
  const gone = await mg(env, ["reindex"]);
  assert.equal(gone.code, 0, gone.stderr);
  assert.equal(gone.stdout.trim(), "reindexed 0 skills from 1 sources");
  assert.match(gone.stderr, new RegExp(`warning: ${id}: .*; skipped`, "u"));
});
