import assert from "node:assert/strict";
import fsp, { mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";
import { insertSkills } from "../src/catalog.ts";
import { checkIndex, commit, repairAliases } from "../src/source-files.ts";
import type { SourceRecord } from "../src/store-files.ts";
import {
  assertWriterAvailable,
  catalogRecords,
  disposableHome,
  gitSourceRecord,
  indexRows,
  newEntry,
  realClose,
  realExec,
  seedIndex,
} from "./helpers.ts";

function local(home: string, id: string): SourceRecord {
  return {
    id,
    kind: "local",
    spec: path.join(home, id),
    path: path.join(home, id),
    subpath: "",
    ref: null,
    commit: null,
    installedAt: "now",
  };
}

function target(id: string, snapshot: string): string {
  return path.join("..", "snapshots", id, snapshot);
}

function warning(id: string, message: string): string {
  return `warning: source "${id}" was published, but its compatibility link could not be updated: ${message}`;
}

async function noTemps(home: string): Promise<void> {
  assert.deepEqual(
    (await readdir(home)).filter((name) => name.startsWith(".catalog-")),
    [],
  );
}

test("source files publication direct repair selects git records and leaves correct and absent aliases alone", async (t) => {
  const home = await disposableHome(t);
  const root = path.join(home, "sources");
  await mkdir(root);
  const old = gitSourceRecord("old");
  const correct = gitSourceRecord("correct");
  const desired = gitSourceRecord("desired", "desired", `${"c".repeat(40)}-${"d".repeat(16)}`);
  await symlink(target(old.id, old.snapshot!), path.join(root, old.id));
  await symlink(target(correct.id, correct.snapshot!), path.join(root, correct.id));
  const realLstat = fsp.lstat;
  const realRm = fsp.rm;
  const realSymlink = fsp.symlink;
  const probes: string[] = [];
  const removals: string[] = [];
  const creations: string[] = [];
  const ls = mock.method(fsp, "lstat", ((file: string, ...args: unknown[]) => {
    if (path.dirname(file) === root) probes.push(file);
    return (realLstat as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fsp.lstat);
  const rs = mock.method(fsp, "rm", ((file: string, options: unknown) => {
    if (path.dirname(file) === root) removals.push(file);
    return realRm(file, options as Parameters<typeof fsp.rm>[1]);
  }) as typeof fsp.rm);
  const ss = mock.method(fsp, "symlink", ((value: string, file: string, ...args: unknown[]) => {
    if (path.dirname(file) === root) creations.push(file);
    return (realSymlink as (...args: unknown[]) => unknown)(value, file, ...args);
  }) as typeof fsp.symlink);
  syncBuiltinESMExports();
  try {
    await repairAliases(
      [old, gitSourceRecord("absent"), correct],
      [gitSourceRecord("first"), local(home, "old"), local(home, "local"), desired, correct],
    );
    assert.equal(probes.includes(path.join(root, "local")), false);
    assert.equal(removals.includes(path.join(root, "old")), true);
    assert.equal(removals.includes(path.join(root, "absent")), false);
    assert.equal(removals.includes(path.join(root, "correct")), false);
    assert.equal(
      creations.some((file) => file.startsWith(path.join(root, "correct") + ".")),
      false,
    );
    assert.equal(await readlink(path.join(root, "desired")), target("desired", desired.snapshot!));
    assert.equal(await readlink(path.join(root, "correct")), target("correct", correct.snapshot!));
    await assert.rejects(readlink(path.join(root, "old")), { code: "ENOENT" });
  } finally {
    ls.mock.restore();
    rs.mock.restore();
    ss.mock.restore();
    syncBuiltinESMExports();
  }
});

test("source files publication direct repair reports lstat failures and failed alias publication", async (t) => {
  const home = await disposableHome(t);
  const root = path.join(home, "sources");
  await mkdir(root);
  const old = gitSourceRecord("blocked");
  const next = gitSourceRecord("blocked", "blocked", `${"c".repeat(64)}-${"d".repeat(16)}`);
  const alias = path.join(root, old.id);
  const oldTarget = target(old.id, old.snapshot!);
  await symlink(oldTarget, alias);
  const destination = path.join(home, "snapshots", next.id, next.snapshot!);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "content"), "destination");
  const errors = t.mock.method(console, "error", () => {});
  const realLstat = fsp.lstat;
  const denial = Object.assign(new Error("denied"), { code: "EACCES" });
  const ls = mock.method(fsp, "lstat", ((file: string, ...args: unknown[]) =>
    file === alias ? Promise.reject(denial) : (realLstat as (...args: unknown[]) => unknown)(file, ...args)) as typeof fsp.lstat);
  syncBuiltinESMExports();
  try {
    await repairAliases([old], [next]);
    assert.equal(await readlink(alias), oldTarget);
    assert.deepEqual(
      errors.mock.calls.map((c) => c.arguments),
      [[warning("blocked", "denied")]],
    );
  } finally {
    ls.mock.restore();
    syncBuiltinESMExports();
  }
  errors.mock.resetCalls();
  const realRename = fsp.rename;
  const realRm = fsp.rm;
  const failure = new Error("rename denied");
  const renames: string[] = [];
  const removals: string[] = [];
  const rename = mock.method(fsp, "rename", (async (from: string, to: string) => {
    if (to === alias && from.startsWith(`${alias}.`) && /^[0-9a-f]{16}\.new$/u.test(from.slice(alias.length + 1))) {
      renames.push(from);
      throw failure;
    }
    return realRename(from, to);
  }) as typeof fsp.rename);
  const remove = mock.method(fsp, "rm", ((file: string, options: unknown) => {
    if (path.dirname(file) === root) removals.push(file);
    return realRm(file, options as Parameters<typeof fsp.rm>[1]);
  }) as typeof fsp.rm);
  syncBuiltinESMExports();
  try {
    await repairAliases([old], [next]);
    assert.equal(await readlink(alias), oldTarget);
    assert.equal(await readFile(path.join(destination, "content"), "utf8"), "destination");
    assert.equal(renames.length, 1);
    assert.deepEqual(removals, renames);
    await assert.rejects(readlink(renames[0]!), { code: "ENOENT" });
    assert.deepEqual(
      errors.mock.calls.map((c) => c.arguments),
      [[warning("blocked", "rename denied")]],
    );
    assert.deepEqual(await readdir(root), ["blocked"]);
  } finally {
    rename.mock.restore();
    remove.mock.restore();
    errors.mock.restore();
    syncBuiltinESMExports();
  }
});

test("source files publication direct repair discovers only managed orphan names and targets", async (t) => {
  const home = await disposableHome(t);
  const root = path.join(home, "sources");
  await mkdir(root);
  const good40 = `${"a".repeat(40)}-${"b".repeat(16)}`;
  const good64 = `${"c".repeat(64)}-${"d".repeat(16)}`;
  const invalid = ["a-" + "b".repeat(16), "g".repeat(64) + "-" + "b".repeat(16), path.join("prefix", good40), path.join(good64, "suffix")];
  const links: Record<string, string> = {
    orphan40: target("orphan40", good40),
    orphan64: target("orphan64", good64),
    "!prefix": target("!prefix", good40),
    "suffix!": target("suffix!", good64),
    foreign: path.join("..", "foreign"),
  };
  invalid.forEach((value, i) => {
    links[`invalid${i}`] = target(`invalid${i}`, value);
  });
  for (const [name, value] of Object.entries(links)) await symlink(value, path.join(root, name));
  await writeFile(path.join(root, "ordinary"), "keep");
  const errors = mock.method(console, "error", () => {});
  try {
    await repairAliases([], []);
    assert.equal(errors.mock.callCount(), 0);
    for (const name of ["orphan40", "orphan64"]) await assert.rejects(readlink(path.join(root, name)), { code: "ENOENT" });
    for (const [name, value] of Object.entries(links))
      if (!name.startsWith("orphan")) assert.equal(await readlink(path.join(root, name)), value);
    assert.equal(await readFile(path.join(root, "ordinary"), "utf8"), "keep");
    for (let i = 0; i < invalid.length; i++) {
      const id = `invalid${i}`;
      await repairAliases([gitSourceRecord(id)], []);
      assert.equal(await readlink(path.join(root, id)), links[id]);
    }
    assert.deepEqual(
      errors.mock.calls.map((c) => c.arguments),
      invalid.map((_, i) => [warning(`invalid${i}`, "unexpected link")]),
    );
    const realRm = fsp.rm;
    const realSymlink = fsp.symlink;
    const touched: string[] = [];
    const remove = mock.method(fsp, "rm", ((file: string, options: unknown) => {
      if (file === path.join(root, "foreign")) touched.push(file);
      return realRm(file, options as Parameters<typeof fsp.rm>[1]);
    }) as typeof fsp.rm);
    const create = mock.method(fsp, "symlink", ((value: string, file: string, ...args: unknown[]) => {
      if (file.startsWith(path.join(root, "foreign") + ".")) touched.push(file);
      return (realSymlink as (...args: unknown[]) => unknown)(value, file, ...args);
    }) as typeof fsp.symlink);
    syncBuiltinESMExports();
    try {
      await repairAliases([gitSourceRecord("foreign")], [gitSourceRecord("foreign")]);
      assert.deepEqual(touched, []);
      assert.equal(await readlink(path.join(root, "foreign")), links["foreign"]);
      assert.deepEqual(errors.mock.calls.at(-1)?.arguments, [warning("foreign", "unexpected link")]);
    } finally {
      remove.mock.restore();
      create.mock.restore();
      syncBuiltinESMExports();
    }
    const stale = gitSourceRecord("stale", "stale", good64);
    const updated = gitSourceRecord("stale", "stale", good40);
    await symlink(target("stale", good64), path.join(root, "stale"));
    await repairAliases([stale], [updated]);
    assert.equal(await readlink(path.join(root, "stale")), target("stale", good40));
  } finally {
    errors.mock.restore();
  }
});

test("source files publication direct checkIndex bypasses empty sources and closes a valid reader", async (t) => {
  const home = await disposableHome(t);
  const source = local(home, "source");
  await checkIndex([]);
  await assert.rejects(checkIndex([source]));
  await writeFile(path.join(home, "index.db"), "foreign");
  await checkIndex([]);
  await assert.rejects(checkIndex([source]));
  await rm(path.join(home, "index.db"));
  await seedIndex([], [source]);
  const realPrepare = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare")!.value as typeof DatabaseSync.prototype.prepare;
  const readers = new Map<string, DatabaseSync>();
  const indexPath = path.join(home, "index.db");
  let closes = 0;
  const prepare = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (this.location("main") === indexPath) readers.set(indexPath, this);
    return realPrepare.call(this, sql);
  });
  const close = mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (this === readers.get(indexPath)) closes++;
    return realClose.call(this);
  });
  try {
    await checkIndex([source]);
    assert.ok(readers.get(indexPath));
    assert.equal(readers.get(indexPath)?.isOpen, false);
    assert.equal(closes, 1);
  } finally {
    prepare.mock.restore();
    close.mock.restore();
    for (const reader of readers.values()) if (reader.isOpen) realClose.call(reader);
  }
});

test("source files publication direct commit rolls back undefined and publishes changed rows after closing", async (t) => {
  const home = await disposableHome(t);
  const initial = local(home, "initial");
  const next = local(home, "next");
  await seedIndex([newEntry("initial", "one")], [initial]);
  const bytes = await readFile(path.join(home, "index.db"));
  const rows = indexRows(home);
  const handles = new Map<string, DatabaseSync>();
  const writerPath = path.join(home, "writer-lock.db");
  let tempPath = "";
  const events: string[] = [];
  const execSpy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    const file = this.location("main");
    if (sql === "BEGIN IMMEDIATE" && file === writerPath) handles.set(writerPath, this);
    if (
      sql === "BEGIN IMMEDIATE" &&
      file &&
      path.dirname(file) === home &&
      /^\.catalog-\d+-[0-9a-f]{24}\.tmp$/u.test(path.basename(file))
    ) {
      handles.set(file, this);
      tempPath = file;
    }
    if (this === handles.get(tempPath) && (sql === "COMMIT" || sql === "ROLLBACK")) events.push(sql);
    return realExec.call(this, sql);
  });
  const closeSpy = mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    if (this === handles.get(tempPath)) events.push("close");
    return realClose.call(this);
  });
  const realRename = fsp.rename;
  const renameSpy = mock.method(fsp, "rename", (async (from: string, to: string) => {
    if (from === tempPath && to === path.join(home, "index.db")) {
      assert.equal(handles.get(tempPath)?.isOpen, false);
      events.push("rename");
    }
    return realRename(from, to);
  }) as typeof fsp.rename);
  syncBuiltinESMExports();
  try {
    await commit((fresh, db) => {
      assert.deepEqual(fresh, [initial]);
      insertSkills(db, [newEntry("initial", "discard")]);
      return undefined;
    });
    assert.deepEqual(events, ["ROLLBACK", "close"]);
    assert.deepEqual(await readFile(path.join(home, "index.db")), bytes);
    assert.deepEqual(indexRows(home), rows);
    assert.deepEqual(catalogRecords(home), [initial]);
    await noTemps(home);
    assertWriterAvailable(home);
    events.length = 0;
    await commit((fresh, db) => {
      assert.deepEqual(fresh, [initial]);
      insertSkills(db, [newEntry("next", "two")]);
      return [initial, next];
    });
    assert.deepEqual(events, ["COMMIT", "close", "rename"]);
    assert.deepEqual(catalogRecords(home), [initial, next]);
    assert.deepEqual(
      indexRows(home).map((row) => ({ ...row })),
      [...rows.map((row) => ({ ...row })), { id: "next/two", name: "two", source: "next", hash: "h" }],
    );
    await noTemps(home);
    assertWriterAvailable(home);
  } finally {
    for (const handle of handles.values()) if (handle.isOpen) realClose.call(handle);
    renameSpy.mock.restore();
    closeSpy.mock.restore();
    execSpy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("source files publication direct commit preserves callback errors and releases transaction handles", async (t) => {
  const home = await disposableHome(t);
  const source = local(home, "initial");
  await seedIndex([newEntry("initial", "one")], [source]);
  const bytes = await readFile(path.join(home, "index.db"));
  const rows = indexRows(home);
  for (const mode of ["rollback", "rollback-fails", "no-rollback", "rename"] as const) {
    const failure = new Error(mode);
    const handles = new Map<string, DatabaseSync>();
    const writerPath = path.join(home, "writer-lock.db");
    let tempPath = "";
    let rollbackCalls = 0;
    let sqlRollbacks = 0;
    const execSpy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      const file = this.isOpen ? this.location("main") : null;
      if (sql === "BEGIN IMMEDIATE" && file === writerPath) handles.set(writerPath, this);
      if (
        sql === "BEGIN IMMEDIATE" &&
        file &&
        path.dirname(file) === home &&
        /^\.catalog-\d+-[0-9a-f]{24}\.tmp$/u.test(path.basename(file))
      ) {
        handles.set(file, this);
        tempPath = file;
      }
      if (this === handles.get(tempPath) && sql === "ROLLBACK") {
        sqlRollbacks++;
        if (mode === "rollback-fails") throw new Error("rollback failed");
      }
      return realExec.call(this, sql);
    });
    const realRename = fsp.rename;
    const renameSpy = mock.method(fsp, "rename", (async (from: string, to: string) => {
      if (mode === "rename" && from === tempPath && to === path.join(home, "index.db")) {
        assert.equal(handles.get(tempPath)?.isOpen, false);
        throw failure;
      }
      return realRename(from, to);
    }) as typeof fsp.rename);
    syncBuiltinESMExports();
    try {
      const rollback = () => {
        rollbackCalls++;
        return Promise.resolve();
      };
      await assert.rejects(
        commit(
          (_fresh, db) => {
            insertSkills(db, [newEntry("initial", "discard")]);
            if (mode !== "rename") throw failure;
            return [source];
          },
          mode === "no-rollback" ? undefined : rollback,
        ),
        (error) => error === failure,
      );
      assert.equal(rollbackCalls, mode === "no-rollback" ? 0 : 1);
      assert.equal(sqlRollbacks, mode === "rename" ? 0 : 1);
      assert.ok(handles.get(tempPath));
      assert.equal(handles.get(tempPath)?.isOpen, false);
      assert.equal(handles.get(writerPath)?.isOpen, false);
      assert.deepEqual(await readFile(path.join(home, "index.db")), bytes);
      assert.deepEqual(indexRows(home), rows);
      assert.deepEqual(catalogRecords(home), [source]);
      await noTemps(home);
      assertWriterAvailable(home);
    } finally {
      for (const handle of handles.values()) if (handle.isOpen) realClose.call(handle);
      renameSpy.mock.restore();
      execSpy.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("source files publication direct commit releases writer after initial cleanup failure", async (t) => {
  const home = await disposableHome(t);
  const failure = new Error("staging denied");
  const staging = path.join(home, "staging");
  const realReaddir = fsp.readdir;
  const probes: string[] = [];
  const handles = new Map<string, DatabaseSync>();
  const writerPath = path.join(home, "writer-lock.db");
  const statements: string[] = [];
  const execSpy = mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (this.location("main") === writerPath && sql === "BEGIN IMMEDIATE") handles.set(writerPath, this);
    if (sql === "ROLLBACK") statements.push(sql);
    return realExec.call(this, sql);
  });
  const readSpy = mock.method(fsp, "readdir", ((file: string, ...args: unknown[]) => {
    if (file === home || file === staging) probes.push(file);
    return file === staging ? Promise.reject(failure) : (realReaddir as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fsp.readdir);
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      commit(() => {
        throw new Error("unexpected callback");
      }),
      (error) => error === failure,
    );
    assert.deepEqual(probes, [home, staging]);
    assert.deepEqual(statements, []);
    assert.equal(handles.get(writerPath)?.isOpen, false);
    assertWriterAvailable(home);
  } finally {
    for (const handle of handles.values()) if (handle.isOpen) realClose.call(handle);
    readSpy.mock.restore();
    execSpy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("source files publication direct repair preserves an occupied tracked alias", async (t) => {
  const home = await disposableHome(t);
  const root = path.join(home, "sources");
  const alias = path.join(root, "occupied");
  await mkdir(root);
  await writeFile(alias, "original bytes");
  const errors = t.mock.method(console, "error", () => {});
  await repairAliases([], [gitSourceRecord("occupied")]);
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments),
    [[warning("occupied", "unexpected path")]],
  );
  assert.equal(await readFile(alias, "utf8"), "original bytes");
  assert.deepEqual(await readdir(root), ["occupied"]);
});

test("source files publication direct repair removes the moved temporary link with force", async (t) => {
  const home = await disposableHome(t);
  const root = path.join(home, "sources");
  const alias = path.join(root, "created");
  const desired = gitSourceRecord("created");
  const expectedTarget = target(desired.id, desired.snapshot!);
  const realSymlink = fsp.symlink;
  const realRename = fsp.rename;
  const realRm = fsp.rm;
  const events: string[] = [];
  let temporary = "";
  const errors = t.mock.method(console, "error", () => {});
  const create = mock.method(fsp, "symlink", (async (value: string, file: string) => {
    if (file.startsWith(`${alias}.`) && /^[0-9a-f]{16}\.new$/u.test(file.slice(alias.length + 1))) {
      assert.equal(value, expectedTarget);
      temporary = file;
      events.push("symlink");
    }
    return realSymlink(value, file);
  }) as typeof fsp.symlink);
  const rename = mock.method(fsp, "rename", (async (from: string, to: string) => {
    if (from === temporary && to === alias) {
      events.push("rename");
      assert.equal(await readlink(from), expectedTarget);
    }
    return realRename(from, to);
  }) as typeof fsp.rename);
  const remove = mock.method(fsp, "rm", (async (file: string, options: unknown) => {
    if (file === temporary && temporary !== "") {
      events.push("remove");
      assert.deepEqual(options, { force: true });
      await assert.rejects(readlink(file), { code: "ENOENT" });
      assert.equal(await readlink(alias), expectedTarget);
    }
    return realRm(file, options as Parameters<typeof fsp.rm>[1]);
  }) as typeof fsp.rm);
  syncBuiltinESMExports();
  try {
    await repairAliases([], [desired]);
    assert.notEqual(temporary, "");
    assert.deepEqual(events, ["symlink", "rename", "remove"]);
    assert.equal(errors.mock.callCount(), 0);
    assert.equal(await readlink(alias), expectedTarget);
    assert.deepEqual(await readdir(root), ["created"]);
  } finally {
    create.mock.restore();
    rename.mock.restore();
    remove.mock.restore();
    syncBuiltinESMExports();
  }
});
