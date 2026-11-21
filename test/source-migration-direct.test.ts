import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import type { TestContext } from "node:test";
import { SCHEMA_VERSION } from "../src/catalog.ts";
import { scanInstalledSource } from "../src/source-files.ts";
import { migrateStore } from "../src/source-migration.ts";
import type { SourceRecord } from "../src/store.ts";
import {
  assertWriterAvailable,
  catalogRecords,
  copyLegacyStoreFixture,
  realExec,
  seedIndex,
  tmp,
  useHome,
  writeIndexRows,
  writeSkill,
} from "./helpers.ts";

const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

async function fixture(t: TestContext) {
  const parent = await tmp("mg-migration-direct-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  await copyLegacyStoreFixture(home);
  useHome(t, home);
  const sourcesFile = path.join(home, "sources.json");
  const sourcesBytes = await readFile(sourcesFile);
  const sources = JSON.parse(sourcesBytes.toString()) as SourceRecord[];
  const source = sources[0]!;
  const skill = path.join(home, "snapshots", source.id, source.snapshot!, "release-upgrade", "SKILL.md");
  return { parent, home, sourcesFile, sourcesBytes, sources, source, skill };
}

function rows(home: string) {
  const db = new DatabaseSync(path.join(home, "index.db"), { readOnly: true });
  try {
    return db
      .prepare("SELECT id, name, description, source, dir, hash, manifest, frontmatter FROM skills ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function matches(home: string, term: string) {
  const db = new DatabaseSync(path.join(home, "index.db"), { readOnly: true });
  try {
    return db
      .prepare("SELECT skills.id FROM fts JOIN skills ON skills.rowid = fts.rowid WHERE fts MATCH ? ORDER BY skills.id")
      .all(term)
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function observe<T>(action: () => Promise<T>): Promise<{ value: T; output: string }> {
  let output = "";
  const observer = mock.method(process.stderr, "write", ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stderr.write);
  try {
    return { value: await action(), output };
  } finally {
    observer.mock.restore();
  }
}

async function withoutWriterLock<T>(action: () => Promise<T>): Promise<T> {
  const statements: string[] = [];
  const spy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    statements.push(sql);
    return realExec.call(this, sql);
  });
  try {
    return await action();
  } finally {
    spy.mock.restore();
    assert.equal(statements.includes("BEGIN IMMEDIATE"), false);
  }
}

test("source migration direct upgrades the released store once with its exact backup", async (t) => {
  const f = await fixture(t);
  const index = await readFile(path.join(f.home, "index.db"));
  const skillBytes = await readFile(f.skill);
  const alias = path.join(f.home, "sources", f.source.id);
  const aliasTarget = await readlink(alias);
  assert.equal(aliasTarget, path.join("..", "snapshots", f.source.id, f.source.snapshot!));
  await rm(alias);
  const before = rows(f.home);
  const revision = before[0]!["hash"];
  const result = await observe(() => migrateStore());
  assert.equal(result.value, true);
  assertWriterAvailable(f.home);
  const backups = (await readdir(f.parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-"));
  assert.equal(backups.length, 1);
  const backup = path.join(f.parent, backups[0]!);
  assert.equal(result.output, `margrave: store upgraded. Backup: ${backup}\n`);
  const archive = path.join(backup, "store.tar");
  const manifest = JSON.parse(await readFile(path.join(backup, "manifest.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest).sort(), [
    "archiveSha256",
    "from",
    "indexSha256",
    "inventorySha256",
    "kind",
    "sourcesSha256",
    "store",
    "version",
  ]);
  assert.equal(manifest["kind"], "margrave-store-backup");
  assert.equal(manifest["version"], 1);
  assert.equal(manifest["from"], 2);
  assert.equal(manifest["store"], f.home);
  assert.equal(manifest["indexSha256"], digest(index));
  assert.equal(manifest["sourcesSha256"], digest(f.sourcesBytes));
  assert.equal(manifest["archiveSha256"], digest(await readFile(archive)));
  assert.match(String(manifest["inventorySha256"]), /^[0-9a-f]{64}$/u);
  assert.deepEqual(execFileSync("/usr/bin/tar", ["-xOf", archive, "./index.db"]), index);
  assert.deepEqual(execFileSync("/usr/bin/tar", ["-xOf", archive, "./sources.json"]), f.sourcesBytes);
  const key = digest(JSON.stringify([f.home, 2, manifest["indexSha256"], manifest["sourcesSha256"], manifest["inventorySha256"]]));
  assert.match(backups[0]!, new RegExp(`^\\.margrave-upgrade-v2-${key}-[A-Za-z0-9]{6}$`, "u"));
  assert.deepEqual(catalogRecords(f.home), f.sources);
  assert.deepEqual(rows(f.home), [{ ...before[0], dir: "release-upgrade", hash: revision }]);
  assert.deepEqual(await readFile(f.skill), skillBytes);
  assert.equal(await readlink(alias), aliasTarget);
  const db = new DatabaseSync(path.join(f.home, "index.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA user_version").get()!["user_version"], SCHEMA_VERSION);
    assert.equal(db.prepare("PRAGMA integrity_check").get()!["integrity_check"], "ok");
  } finally {
    db.close();
  }
  for (const term of ["releas", "upgrad", "surviv"]) assert.deepEqual(matches(f.home, term), [{ id: `${f.source.id}/release-upgrade` }]);
  const current = await readFile(path.join(f.home, "index.db"));
  const files = (await readdir(f.parent)).sort();
  assert.deepEqual(await withoutWriterLock(() => observe(() => migrateStore())), { value: false, output: "" });
  assert.deepEqual((await readdir(f.parent)).sort(), files);
  assert.deepEqual(await readFile(path.join(f.home, "index.db")), current);
});

test("source migration direct handles absent catalogs and legacy sources", async (t) => {
  const parent = await tmp("mg-migration-empty-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  useHome(t, home);
  assert.deepEqual(await withoutWriterLock(() => observe(() => migrateStore())), { value: false, output: "" });
  assert.deepEqual(await readdir(parent), []);
  await mkdir(home);
  assert.deepEqual(await withoutWriterLock(() => observe(() => migrateStore())), { value: false, output: "" });
  assert.deepEqual(await readdir(home), []);
  const marker = path.join(home, "catalog-published");
  await writeFile(marker, "published\n");
  await withoutWriterLock(() => assert.rejects(migrateStore(), { message: "index.db is missing. Restore the complete store backup" }));
  assert.deepEqual(await readFile(marker), Buffer.from("published\n"));
  assert.deepEqual(await readdir(home), ["catalog-published"]);
  await rm(marker);
  const sources = Buffer.from("[]\n");
  await writeFile(path.join(home, "sources.json"), sources);
  await assert.rejects(migrateStore(), {
    message: `cannot upgrade the store because ${path.join(home, "index.db")} is missing. Restore the complete v0.2.1 backup`,
  });
  assert.deepEqual(await readFile(path.join(home, "sources.json")), sources);
  assert.deepEqual((await readdir(parent)).sort(), ["store"]);
  assertWriterAvailable(home);
});

test("source migration direct rejects independent source record conflicts", async (t) => {
  const f = await fixture(t);
  const index = await readFile(path.join(f.home, "index.db"));
  const skill = await readFile(f.skill);
  const variants: SourceRecord[][] = [
    [{ ...f.source, url: "https://example.invalid/other.git" }],
    [{ ...f.source, subpath: "other" }],
    [{ ...f.source, id: "other" }],
    [{ ...f.source, spec: path.join(f.parent, "local") }],
    [f.source, f.source],
  ];
  for (const records of variants) {
    const bytes = Buffer.from(JSON.stringify(records));
    await writeFile(f.sourcesFile, bytes);
    const expectedSnapshot = path.join(f.home, "snapshots", records[0]!.id, records[0]!.snapshot!);
    let lookups = 0;
    const nativeLstat = fs.lstat;
    const observer = mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === expectedSnapshot) lookups++;
      return nativeLstat(...args);
    }) as typeof fs.lstat);
    syncBuiltinESMExports();
    try {
      await assert.rejects(migrateStore(), {
        message: `cannot upgrade source "${records[0]!.id}" because its source record, index, or files disagree. Restore a known-good backup or restore a verified lock into a new MARGRAVE_HOME. See Upgrading in the README.`,
      });
    } finally {
      observer.mock.restore();
      syncBuiltinESMExports();
    }
    if (records[0]!.id === "other" || records[0]!.subpath === "other") assert.equal(lookups, 0);
    assert.deepEqual(await readFile(f.sourcesFile), bytes);
    assert.deepEqual(await readFile(path.join(f.home, "index.db")), index);
    assert.deepEqual(await readFile(f.skill), skill);
    assert.deepEqual((await readdir(f.parent)).sort(), ["store"]);
    assertWriterAvailable(f.home);
  }
});

test("source migration direct rejects each independent indexed row conflict", async (t) => {
  const f = await fixture(t);
  const before = rows(f.home);
  const skill = await readFile(f.skill);
  for (const column of ["id", "name", "description", "hash", "manifest", "frontmatter", "dir"] as const) {
    writeIndexRows(f.home, (db) => db.prepare(`UPDATE skills SET ${column} = ? WHERE id = ?`).run("wrong", before[0]!["id"] as string));
    const changed = rows(f.home);
    const changedBytes = await readFile(path.join(f.home, "index.db"));
    await assert.rejects(migrateStore(), {
      message: `cannot upgrade source "${f.source.id}" because its source record, index, or files disagree. Restore a known-good backup or restore a verified lock into a new MARGRAVE_HOME. See Upgrading in the README.`,
    });
    assert.deepEqual(rows(f.home), changed);
    assert.deepEqual(await readFile(path.join(f.home, "index.db")), changedBytes);
    assert.deepEqual(await readFile(f.sourcesFile), f.sourcesBytes);
    assert.deepEqual(await readFile(f.skill), skill);
    assert.deepEqual((await readdir(f.parent)).sort(), ["store"]);
    assertWriterAvailable(f.home);
    writeIndexRows(f.home, (db) => db.prepare(`UPDATE skills SET ${column} = ?`).run(before[0]![column] as string));
  }
  writeIndexRows(f.home, (db) =>
    db.exec(
      "INSERT INTO skills(id, id_lc, name, name_lc, description, source, dir, hash, manifest, frontmatter) SELECT 'extra/release-upgrade', 'extra/release-upgrade', name, name_lc, description, source, dir, hash, manifest, frontmatter FROM skills",
    ),
  );
  const extra = await readFile(path.join(f.home, "index.db"));
  await assert.rejects(migrateStore(), {
    message: `cannot upgrade source "${f.source.id}" because its source record, index, or files disagree. Restore a known-good backup or restore a verified lock into a new MARGRAVE_HOME. See Upgrading in the README.`,
  });
  assert.deepEqual(await readFile(path.join(f.home, "index.db")), extra);
  assert.deepEqual(await readFile(f.sourcesFile), f.sourcesBytes);
  assert.deepEqual(await readFile(f.skill), skill);
  assert.deepEqual((await readdir(f.parent)).sort(), ["store"]);
  assertWriterAvailable(f.home);
});

test("source migration direct rejects invalid snapshot metadata before scanning", async (t) => {
  const f = await fixture(t);
  const snapshot = path.dirname(path.dirname(f.skill));
  const canonicalHome = await realpath(f.home);
  const canonicalSnapshot = await realpath(snapshot);
  const index = await readFile(path.join(f.home, "index.db"));
  const skill = await readFile(f.skill);
  for (const variant of ["type", "path"] as const) {
    let stats = 0;
    let paths = 0;
    let scans = 0;
    const nativeLstat = fs.lstat;
    const nativeRealpath = fs.realpath;
    const nativeReaddir = fs.readdir;
    const statSpy = mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await nativeLstat(...args);
      if (args[0] === snapshot && ++stats === 1 && variant === "type") {
        const altered = Object.create(stat) as typeof stat;
        altered.isDirectory = () => false;
        return altered;
      }
      return stat;
    }) as typeof fs.lstat);
    const pathSpy = mock.method(fs, "realpath", (async (...args: Parameters<typeof fs.realpath>) => {
      if (args[0] === snapshot && ++paths === 1 && variant === "path") return canonicalHome;
      return nativeRealpath(...args);
    }) as typeof fs.realpath);
    const scanSpy = mock.method(fs, "readdir", (async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === snapshot) scans++;
      return nativeReaddir(...args);
    }) as typeof fs.readdir);
    syncBuiltinESMExports();
    try {
      await assert.rejects(migrateStore(), {
        message: `cannot upgrade source "${f.source.id}" because its source record, index, or files disagree. Restore a known-good backup or restore a verified lock into a new MARGRAVE_HOME. See Upgrading in the README.`,
      });
    } finally {
      statSpy.mock.restore();
      pathSpy.mock.restore();
      scanSpy.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(stats, 1);
    assert.equal(paths, variant === "type" ? 0 : 1);
    assert.equal(scans, 0);
    assert.equal(await realpath(f.home), canonicalHome);
    assert.equal(await realpath(snapshot), canonicalSnapshot);
    assert.deepEqual(await readFile(path.join(f.home, "index.db")), index);
    assert.deepEqual(await readFile(f.sourcesFile), f.sourcesBytes);
    assert.deepEqual(await readFile(f.skill), skill);
    assert.deepEqual((await readdir(f.parent)).sort(), ["store"]);
    assertWriterAvailable(f.home);
  }
});

test("source migration direct checks legacy Git path boundaries and unknown indexed sources", async (t) => {
  const f = await fixture(t);
  const before = rows(f.home);
  const skill = await readFile(f.skill);
  const originalDir = before[0]!["dir"] as string;
  const marker = `${path.sep}snapshots${path.sep}${f.source.id}${path.sep}${f.source.snapshot}`;
  const at = originalDir.lastIndexOf(marker);
  assert.ok(at >= 0);
  const wrongSeparator = originalDir.slice(0, at) + marker + "\\" + originalDir.slice(at + marker.length + 1);
  writeIndexRows(f.home, (db) => db.prepare("UPDATE skills SET dir = ?").run(wrongSeparator));
  const changed = await readFile(path.join(f.home, "index.db"));
  await assert.rejects(migrateStore(), {
    message: `cannot upgrade source "${f.source.id}" because its source record, index, or files disagree. Restore a known-good backup or restore a verified lock into a new MARGRAVE_HOME. See Upgrading in the README.`,
  });
  assert.deepEqual(await readFile(path.join(f.home, "index.db")), changed);
  for (const invalid of [
    `relative${marker}/release-upgrade`,
    `/${"x".repeat(marker.length - 2)}/release-upgrade`,
    originalDir.slice(0, at) + marker + "/different",
  ]) {
    writeIndexRows(f.home, (db) => db.prepare("UPDATE skills SET dir = ?").run(invalid));
    const rejected = await readFile(path.join(f.home, "index.db"));
    await assert.rejects(migrateStore(), {
      message: `cannot upgrade source "${f.source.id}" because its source record, index, or files disagree. Restore a known-good backup or restore a verified lock into a new MARGRAVE_HOME. See Upgrading in the README.`,
    });
    assert.deepEqual(await readFile(path.join(f.home, "index.db")), rejected);
    assert.deepEqual(await readFile(f.sourcesFile), f.sourcesBytes);
    assert.deepEqual(await readFile(f.skill), skill);
    assert.deepEqual((await readdir(f.parent)).sort(), ["store"]);
  }
  writeIndexRows(f.home, (db) => {
    db.prepare("UPDATE skills SET dir = ?").run(originalDir);
    db.exec(
      "INSERT INTO skills(id, id_lc, name, name_lc, description, source, dir, hash, manifest, frontmatter) SELECT 'unknown/release-upgrade', 'unknown/release-upgrade', name, name_lc, description, 'unknown', dir, hash, manifest, frontmatter FROM skills",
    );
  });
  const mixed = await readFile(path.join(f.home, "index.db"));
  await assert.rejects(migrateStore(), { message: "cannot upgrade the v0.2.1 catalog: index contains an unknown source" });
  assert.deepEqual(await readFile(path.join(f.home, "index.db")), mixed);
  assert.deepEqual(await readFile(f.sourcesFile), f.sourcesBytes);
  assert.deepEqual(await readFile(f.skill), skill);
  assert.deepEqual((await readdir(f.parent)).sort(), ["store"]);
  assertWriterAvailable(f.home);
  writeIndexRows(f.home, (db) => {
    db.exec("DELETE FROM skills WHERE source = 'unknown'");
    db.prepare("UPDATE skills SET dir = ?").run(originalDir.slice(at));
  });
  assert.equal((rows(f.home)[0]!["dir"] as string).indexOf(marker), 0);
  assert.equal(await migrateStore(), true);
  assert.deepEqual(rows(f.home), [{ ...before[0], dir: "release-upgrade" }]);
});

test("source migration direct accepts a Git skill at the snapshot root", async (t) => {
  const f = await fixture(t);
  const before = rows(f.home);
  const skill = await readFile(f.skill);
  const snapshot = path.dirname(path.dirname(f.skill));
  await rename(f.skill, path.join(snapshot, "SKILL.md"));
  await rm(path.dirname(f.skill), { recursive: true });
  writeIndexRows(f.home, (db) => db.prepare("UPDATE skills SET dir = ?").run(snapshot));
  assert.equal(await migrateStore(), true);
  assert.deepEqual(rows(f.home), [{ ...before[0], dir: "" }]);
  assert.deepEqual(catalogRecords(f.home), f.sources);
  assert.deepEqual(await readFile(path.join(snapshot, "SKILL.md")), skill);
});

test("source migration direct ignores a Git directory symlink warning", async (t) => {
  const f = await fixture(t);
  const before = rows(f.home);
  const link = path.join(path.dirname(path.dirname(f.skill)), "linked-skill");
  await symlink("release-upgrade", link);
  const result = await observe(() => migrateStore());
  assert.equal(result.value, true);
  const backups = (await readdir(f.parent)).filter((name) => name.startsWith(".margrave-upgrade-v2-"));
  assert.equal(backups.length, 1);
  assert.equal(result.output, `margrave: store upgraded. Backup: ${path.join(f.parent, backups[0]!)}\n`);
  assert.deepEqual(rows(f.home), [{ ...before[0], dir: "release-upgrade" }]);
  assert.equal(await readlink(link), "release-upgrade");
});

test("source migration direct preserves a schema 3 Git relative path", async (t) => {
  const f = await fixture(t);
  const entries = await scanInstalledSource(f.source, { log: () => {} });
  await rm(path.join(f.home, "index.db"));
  await rm(f.sourcesFile);
  await seedIndex(entries, f.sources);
  await writeFile(f.sourcesFile, f.sourcesBytes);
  writeIndexRows(f.home, (db) => db.exec("PRAGMA user_version = 3"));
  const before = rows(f.home);
  assert.equal(before[0]!["dir"], "release-upgrade");
  assert.equal(await migrateStore(), true);
  assert.deepEqual(catalogRecords(f.home), f.sources);
  assert.deepEqual(rows(f.home), before);
});

test("source migration direct preserves a schema 2 local absolute path", async (t) => {
  const parent = await tmp("mg-migration-local-v2-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  const local = path.join(parent, "local");
  await mkdir(home);
  await mkdir(local);
  await writeSkill(local, "alpha", "Stable orchard description");
  useHome(t, home);
  const source: SourceRecord = {
    id: "local__alpha-123456",
    kind: "local",
    spec: local,
    path: local,
    subpath: "",
    ref: null,
    commit: null,
    installedAt: "2026-01-01T00:00:00.000Z",
  };
  const entries = await scanInstalledSource(source, { log: () => {} });
  await seedIndex(entries, [source]);
  writeIndexRows(home, (db) => db.exec("DROP TABLE sources; PRAGMA user_version = 2"));
  await writeFile(path.join(home, "sources.json"), JSON.stringify([source]));
  const before = rows(home);
  assert.equal(before[0]!["dir"], path.join(local, "alpha"));
  assert.equal(await migrateStore(), true);
  assert.deepEqual(catalogRecords(home), [source]);
  assert.deepEqual(rows(home), before);
});

test("source migration direct upgrades a schema 3 local catalog", async (t) => {
  const parent = await tmp("mg-migration-v3-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "store");
  const local = path.join(parent, "local");
  await mkdir(home);
  await mkdir(local);
  await writeSkill(local, "alpha", "Stable orchard description", "# Heading\n\nFresh tangerine tokens.\n");
  await writeSkill(local, "beta", "Independent container networking");
  useHome(t, home);
  const source: SourceRecord = {
    id: "local__alpha-123456",
    kind: "local",
    spec: local,
    path: local,
    subpath: "",
    ref: null,
    commit: null,
    installedAt: "2026-01-01T00:00:00.000Z",
  };
  const entries = await scanInstalledSource(source, { log: () => {} });
  await seedIndex(entries, [source]);
  writeIndexRows(home, (db) =>
    db.exec(
      "DROP TABLE fts; CREATE VIRTUAL TABLE fts USING fts5(name, description, headings, body, content='', contentless_delete=1, tokenize='unicode61'); PRAGMA user_version = 3",
    ),
  );
  const before = rows(home);
  assert.equal(before.length, 2);
  const skill = await readFile(path.join(local, "alpha", "SKILL.md"));
  for (const [record, message] of [
    [
      JSON.stringify({ ...source, selection: ["alpha", "beta"] }),
      `cannot upgrade source "${source.id}" because its source record, index, or files disagree. Restore a known-good backup or restore a verified lock into a new MARGRAVE_HOME. See Upgrading in the README.`,
    ],
    ["null", "cannot upgrade the v0.2.1 catalog: malformed source records"],
    [
      "{",
      (() => {
        try {
          JSON.parse("{");
        } catch (err) {
          return (err as Error).message;
        }
        return "";
      })(),
    ],
  ]) {
    writeIndexRows(home, (db) => db.prepare("UPDATE sources SET record = ? WHERE id = ?").run(record!, source.id));
    const rejected = await readFile(path.join(home, "index.db"));
    await assert.rejects(migrateStore(), { message });
    assert.deepEqual(await readFile(path.join(home, "index.db")), rejected);
    assert.deepEqual(rows(home), before);
    assert.deepEqual(await readFile(path.join(local, "alpha", "SKILL.md")), skill);
    assert.deepEqual((await readdir(parent)).sort(), ["local", "store"]);
    assertWriterAvailable(home);
  }
  writeIndexRows(home, (db) => db.prepare("UPDATE sources SET record = ? WHERE id = ?").run(JSON.stringify(source), source.id));
  const index = await readFile(path.join(home, "index.db"));
  const result = await observe(() => migrateStore());
  assert.equal(result.value, true);
  assertWriterAvailable(home);
  assert.deepEqual(catalogRecords(home), [source]);
  assert.deepEqual(rows(home), before);
  const current = new DatabaseSync(path.join(home, "index.db"), { readOnly: true });
  try {
    assert.equal(current.prepare("PRAGMA user_version").get()!["user_version"], SCHEMA_VERSION);
  } finally {
    current.close();
  }
  for (const term of ["alpha", "orchard", "tangerin"]) assert.deepEqual(matches(home, term), [{ id: entries[0]!.id }]);
  await assert.rejects(readFile(path.join(home, "sources.json")), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(home)).filter((name) => name.includes("tmp") || name === "sources.json"),
    [],
  );
  const backupName = (await readdir(parent)).find((name) => name.startsWith(".margrave-upgrade-v3-"));
  assert.ok(backupName);
  const backup = path.join(parent, backupName);
  assert.equal(result.output, `margrave: store upgraded. Backup: ${backup}\n`);
  const manifest = JSON.parse(await readFile(path.join(backup, "manifest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest["from"], 3);
  assert.equal(manifest["sourcesSha256"], null);
  assert.equal(manifest["indexSha256"], digest(index));
  assert.deepEqual(execFileSync("/usr/bin/tar", ["-xOf", path.join(backup, "store.tar"), "./index.db"]), index);
});
