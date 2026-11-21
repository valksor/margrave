import assert from "node:assert/strict";
import fsp, { writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { mock } from "node:test";
import { checkSources, installSource, reindexAll, updateSources } from "../src/sources.ts";
import { MargraveError, openIndexRead, readSources } from "../src/store.ts";
import { resolveSkill } from "../src/skills.ts";
import {
  useHome,
  quiet,
  inStore,
  mockSourcesRead,
  changeAtLock,
  catalogRecords,
  indexIds,
  indexRows,
  makeRepo,
  newEntry,
  seedIndex,
  tmp,
  writeCatalogRecords,
  writeSkill,
} from "./helpers.ts";

test("qualified ids stay stable after a second source adds the same name; the bare alias works only while unique", async (t) => {
  useHome(t, await tmp("mg-home-"));
  await seedIndex([newEntry("src-a", "react"), newEntry("src-a", "docker")]);
  const first = await openIndexRead();
  try {
    assert.equal(resolveSkill(first, "react").id, "src-a/react");
    assert.equal(resolveSkill(first, "src-a/react").id, "src-a/react");
  } finally {
    first.close();
  }

  // A second source with the same name. Rows are replaced here only to build the fixture.
  useHome(t, await tmp("mg-home-"));
  await seedIndex([newEntry("src-a", "react"), newEntry("src-a", "docker"), newEntry("src-b", "react")]);
  const second = await openIndexRead();
  try {
    assert.equal(resolveSkill(second, "src-a/react").id, "src-a/react");
    assert.equal(resolveSkill(second, "src-b/react").id, "src-b/react");
    assert.equal(resolveSkill(second, "docker").id, "src-a/docker");
    assert.throws(
      () => resolveSkill(second, "react"),
      (e: unknown) =>
        e instanceof MargraveError &&
        /ambiguous/u.test(e.message) &&
        e.message.includes("src-a/react") &&
        e.message.includes("src-b/react"),
    );
    assert.throws(() => resolveSkill(second, "nope"), /no skill "nope"/u);
  } finally {
    second.close();
  }
});

// ---- a write that fails half way ----

test("Git install and update refuse staged changes before the scanner reads", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const real = fsp.readdir;
    const inject = (): void => {
      let fired = false;
      mock.method(fsp, "readdir", (async (dir: string, ...args: unknown[]) => {
        if (!fired && dir.includes(`${path.sep}staging${path.sep}`) && dir.endsWith(`${path.sep}repo`) && args.length === 0) {
          fired = true;
          await writeFile(path.join(dir, "skills", "react-perf", "SKILL.md"), "changed\n");
        }
        return (real as (...a: unknown[]) => Promise<unknown>)(dir, ...args);
      }) as typeof fsp.readdir);
      syncBuiltinESMExports();
    };
    inject();
    await assert.rejects(installSource(repo.url, null, quiet), /staged skills changed during scan/u);
    mock.restoreAll();
    syncBuiltinESMExports();
    const { id } = await installSource(repo.url, null, quiet);
    const before = catalogRecords(home);
    inject();
    await assert.rejects(updateSources(id, quiet), /staged skills changed during scan/u);
    assert.deepEqual(catalogRecords(home), before);
  });
});

test("Git update preserves a source record changed by another writer", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const records = catalogRecords(home);
    assert.ok(records[0]);
    records[0].installedAt = "competing writer";
    const competing = JSON.stringify(records);
    const alias = await fsp.readlink(path.join(home, "sources", id));
    const rows = indexRows(home);
    const hook = changeAtLock(t, 3, () => writeCatalogRecords(home, records));
    await assert.rejects(updateSources(id, quiet), /source changed during update/u);
    assert.equal(hook.fired(), true);
    assert.equal(JSON.stringify(catalogRecords(home)), competing);
    assert.equal(await fsp.readlink(path.join(home, "sources", id)), alias);
    assert.deepEqual(indexRows(home), rows);
  });
});

test("local selections expand and reject competing source changes", async (t) => {
  await inStore(t, async (home) => {
    const dir = await tmp();
    await writeSkill(dir, "alpha", "Alpha skill");
    await writeSkill(dir, "beta", "Beta skill");
    const { id } = await installSource(dir, null, quiet, ["alpha"]);
    await updateSources(id, quiet, null, ["beta"]);
    assert.deepEqual(indexIds(home), [`${id}/alpha`, `${id}/beta`]);
    assert.deepEqual(catalogRecords(home)[0]?.selection, ["alpha", "beta"]);
    await reindexAll(quiet);
    assert.equal((await checkSources(id))[0]?.error, null);
    const records = catalogRecords(home);
    records[0]!.installedAt = "competing writer";
    const hook = changeAtLock(t, 1, () => writeCatalogRecords(home, records));
    await assert.rejects(updateSources(id, quiet), /source changed during update/u);
    assert.equal(hook.fired(), true);
  });
});

test("whole sources reject expansion and malformed stored selections", async (t) => {
  await inStore(t, async (home) => {
    const dir = await tmp();
    await writeSkill(dir, "alpha", "Alpha skill");
    const { id } = await installSource(dir, null, quiet);
    await assert.rejects(updateSources(id, quiet, null, ["alpha"]), /already installs all skills/u);
    const records = catalogRecords(home);
    records[0]!.selection = [];
    writeCatalogRecords(home, records);
    await assert.rejects(readSources(), /malformed source records/u);
  });
});

test("selection expansion rejects a source replaced between reads", async (t) => {
  await inStore(t, async (home) => {
    const dir = await tmp();
    await writeSkill(dir, "alpha", "Alpha skill");
    const { id } = await installSource(dir, null, quiet, ["alpha"]);
    const records = catalogRecords(home);
    delete records[0]!.selection;
    const realLstat = fsp.lstat;
    let reads = 0;
    mock.method(fsp, "lstat", (async (file: string, ...args: unknown[]) => {
      if (file === path.join(home, "index.db") && ++reads === 3) writeCatalogRecords(home, records);
      return (realLstat as (...a: unknown[]) => Promise<unknown>)(file, ...args);
    }) as typeof fsp.lstat);
    syncBuiltinESMExports();
    await assert.rejects(updateSources(id, quiet, null, ["alpha"]), /already installs all skills/u);
    assert.ok(reads >= 3);
  });
});

test("Git update preserves another writer's removal", async (t) => {
  await inStore(t, async (home) => {
    const repo = await makeRepo();
    const { id } = await installSource(repo.url, null, quiet);
    const hook = changeAtLock(t, 3, () => writeCatalogRecords(home, []));
    await assert.rejects(updateSources(id, quiet), /no source/u);
    assert.equal(hook.fired(), true);
    assert.deepEqual(catalogRecords(home), []);
  });
});

// ---- an error that is not an Error, and a source that vanishes between two reads ----

test("update of all sources: a rejection that is not an Error, or a source that vanished, is reported for that source", async (t) => {
  await inStore(t, async () => {
    await assert.rejects(updateSources(null, quiet, "refs/heads/main"), /update --ref requires one Git source/u);
    const dir = await tmp("mg-localsrc-");
    await writeSkill(dir, "alpha", "alpha skill");
    const { id } = await installSource(dir, null, quiet);

    // The first read (updateSources) works; the second (updateOne) rejects with a string.
    mockSourcesRead((nth) => (nth === 2 ? { error: "boom, not an Error" } : undefined));
    assert.deepEqual(await updateSources(null, quiet), { results: [], errors: [{ id, message: "boom, not an Error" }] });

    // The second read finds no sources: someone removed this one in between.
    mockSourcesRead((nth) => (nth === 2 ? { empty: true } : undefined));
    assert.deepEqual(await updateSources(null, quiet), { results: [], errors: [{ id, message: `no source "${id}"` }] });
  });
});
