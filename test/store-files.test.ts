import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { home as storeHome, readLegacySources, atomicWrite } from "../src/store-files.ts";
import { readSources } from "../src/store.ts";
import { fakeRipwire, runCli, tmp, writeSkill, useHome, cliSetup as setup, cliMg as mg, installLocalDir } from "./helpers.ts";
import { DatabaseSync } from "node:sqlite";

test("a malformed sources.json is an error and nothing is written", async () => {
  const home = await tmp("mg-home-");
  const bin = await fakeRipwire();
  const file = path.join(home, "sources.json");
  await writeFile(file, "{ not json");

  process.env["MARGRAVE_HOME"] = home;
  await assert.rejects(readLegacySources(), /not valid JSON/u);
  await writeFile(file, JSON.stringify([{ id: 1 }]));
  await assert.rejects(readLegacySources(), /malformed/u);

  const src = await tmp("mg-src-");
  await writeSkill(src, "a-skill", "a skill");
  for (const content of ["{ not json", JSON.stringify([{ id: 1 }])]) {
    await writeFile(file, content);
    const r = await runCli(["install", src], { home, fakeBin: bin });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /index\.db is missing/u);
    assert.equal(await readFile(file, "utf8"), content, "sources.json unchanged");
    assert.equal((await readdir(home)).includes("index.db"), false, "no index.db written");
    assert.deepEqual(
      (await readdir(home)).filter((n) => n.endsWith(".tmp")),
      [],
    );
  }
});

test("a missing sources.json is an empty list", async () => {
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  assert.deepEqual(await readSources(), []);
  assert.deepEqual(await readLegacySources(), []);
});

test("home() is MARGRAVE_HOME when set, and ~/.margrave when it is unset or empty", (t) => {
  const prev = process.env["MARGRAVE_HOME"];
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  process.env["MARGRAVE_HOME"] = "/some/where";
  assert.equal(storeHome(), "/some/where");
  delete process.env["MARGRAVE_HOME"];
  assert.equal(storeHome(), path.join(homedir(), ".margrave"));
  process.env["MARGRAVE_HOME"] = "";
  assert.equal(storeHome(), path.join(homedir(), ".margrave"));
});

test("a sources.json that cannot be read for a reason other than ENOENT is an error, not an empty list", async (t) => {
  const h = await tmp("mg-home-");
  useHome(t, h);
  await mkdir(path.join(h, "sources.json"));
  await assert.rejects(readLegacySources(), /EISDIR/u);
});

test("every field of a source record is checked", async (t) => {
  const h = await tmp("mg-home-");
  useHome(t, h);
  const good = {
    id: "o__r",
    kind: "git",
    spec: "o/r",
    url: "u",
    subpath: "",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    snapshot: `${"a".repeat(40)}-${"b".repeat(16)}`,
    installedAt: "now",
  };
  const local = { id: "l", kind: "local", spec: "/p", path: "/p", subpath: "", ref: null, commit: null, installedAt: "now" };
  await writeFile(path.join(h, "sources.json"), JSON.stringify([good, local]));
  assert.equal((await readLegacySources()).length, 2);

  const { url: _url, ...noUrl } = good;
  const bad: Record<string, unknown> = {
    "not an object": 1,
    "a list instead of an object": [],
    "null instead of an object": null,
    "id is not a string": { ...good, id: 1 },
    "id traverses directories": { ...good, id: "../outside" },
    "id is dot": { ...good, id: "." },
    "id is dot-dot": { ...good, id: ".." },
    "spec is not a string": { ...good, spec: 1 },
    "kind is unknown": { ...good, kind: "svn" },
    "subpath is not a string": { ...good, subpath: 1 },
    "ref is neither null nor a string": { ...good, ref: 1 },
    "commit is neither null nor a string": { ...good, commit: 1 },
    "installedAt is not a string": { ...good, installedAt: 1 },
    "a git record without url": noUrl,
    "a local record without path": { ...local, path: undefined },
    "a local record with a relative path": { ...local, path: "relative" },
    "snapshot on a local source": { ...local, snapshot: `${"a".repeat(40)}-${"b".repeat(16)}` },
    "git record without snapshot": { ...good, snapshot: undefined },
    "git record with short ref": { ...good, ref: "main" },
    "snapshot traversal": { ...good, commit: "a".repeat(40), snapshot: `../${"a".repeat(40)}-${"b".repeat(16)}` },
    "snapshot commit mismatch": { ...good, commit: "c".repeat(40), snapshot: `${"a".repeat(40)}-${"b".repeat(16)}` },
    "snapshot nonce malformed": { ...good, commit: "a".repeat(40), snapshot: `${"a".repeat(40)}-${"B".repeat(16)}` },
  };
  for (const [why, record] of Object.entries(bad)) {
    await writeFile(path.join(h, "sources.json"), JSON.stringify([record]));
    await assert.rejects(readLegacySources(), /malformed/u, why);
  }
  await writeFile(path.join(h, "sources.json"), JSON.stringify({ not: "a list" }));
  await assert.rejects(readLegacySources(), /malformed/u, "not a list");
});

test("atomic writes leave no temp file and a reader never sees a partial file", async () => {
  const dir = await tmp("mg-atomic-");
  const file = path.join(dir, "data.json");
  const big = (n: number): string => JSON.stringify({ n, pad: "x".repeat(200_000) });
  await atomicWrite(file, big(0));
  let stop = false;
  const writer = (async () => {
    // oxlint-disable-next-line no-unmodified-loop-condition -- `stop` is set by the reader below while the writer runs
    for (let i = 1; i <= 40 && !stop; i++) await atomicWrite(file, big(i));
  })();
  let reads = 0;
  for (;;) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { n: number };
    assert.equal(typeof parsed.n, "number");
    reads++;
    if (reads > 400) break;
    if (reads % 20 === 0) await new Promise((r) => setImmediate(r));
  }
  stop = true;
  await writer;
  assert.deepEqual(
    (await readdir(dir)).filter((n) => n.endsWith(".tmp")),
    [],
  );
});

test("a sources.json record with no url, no path, or an unknown kind stops every command that reads it", async () => {
  const env = await setup();
  const dir = await tmp();
  await writeSkill(dir, "alpha", "alpha skill");
  await installLocalDir(env, dir);
  const base = { spec: "x", subpath: "", ref: null, commit: null, installedAt: "now" };
  const records: Record<string, unknown> = {
    "a git record without url": { ...base, id: "bad__git", kind: "git" },
    "a local record without path": { ...base, id: "bad__local", kind: "local" },
    "a record of an unknown kind": { ...base, id: "bad__kind", kind: "svn", url: "u", path: "/p" },
  };
  for (const [why, record] of Object.entries(records)) {
    const db = new DatabaseSync(path.join(env.home, "index.db"));
    db.prepare("UPDATE sources SET record = ?").run(JSON.stringify(record));
    db.close();
    const before = await readFile(path.join(env.home, "index.db"));
    const id = (record as { id: string }).id;
    for (const args of [["update"], ["update", id], ["remove", id], ["reindex"], ["list"]]) {
      const r = await mg(env, args);
      assert.equal(r.code, 1, `${why}: ${args.join(" ")}`);
      assert.match(r.stderr, /malformed source records/u, `${why}: ${args.join(" ")}`);
    }
    assert.deepEqual(await readFile(path.join(env.home, "index.db")), before, `${why}: catalog is unchanged`);
  }
});
