import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import fsp, { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { handleHostedMcp } from "../src/hosted.ts";
import { buildFieldTokens } from "../src/bm25.ts";
import { PINNED_RIPWIRE, scanWithRipwire as scan } from "../src/safety.ts";
import { catalogSources, deleteSourceSkills, indexDbFile, insertSkills, putCatalogSources, temporaryCatalog } from "../src/store.ts";
import type { NewEntry, SourceRecord } from "../src/store.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "src", "cli.ts");
export const hasDirectoryAcl = (dir: string): boolean =>
  execFileSync("/bin/ls", ["-lde", dir], { encoding: "utf8" }).trimEnd().includes("\n");
/** Preload that hides a vendored ripwire from margrave. `runCli` puts it in front of every spawned CLI. */
// No vendored ripwire for these tests: a developer's real vendor/ripwire must not change what they check.
export const NO_VENDORED_PRELOAD = path.join(ROOT, "test", "no-vendored-ripwire.ts");

export function stdioTestEnv(env: Record<string, string>): Record<string, string> {
  const mutant = process.env["__STRYKER_ACTIVE_MUTANT__"];
  return mutant === undefined ? env : { ...env, __STRYKER_ACTIVE_MUTANT__: mutant };
}

const execFileAsync = promisify(execFile);

/** Make a FIFO (named pipe) at `file`. Node has no mkfifo API. */
export async function mkfifo(file: string): Promise<void> {
  await execFileAsync("mkfifo", [file]);
}

/** Open and close the write end of a FIFO, so a reader that is blocked in open() returns. The test's after hook calls this, because the test body cannot reach a finally block while the open blocks. Without a waiting reader the open fails with ENXIO, which is ignored. */
export async function releaseFifo(file: string): Promise<void> {
  try {
    await (await open(file, constants.O_WRONLY | constants.O_NONBLOCK)).close();
  } catch {
    // no reader is waiting
  }
}

export async function tmp(prefix = "mg-"): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

export async function copyLegacyStoreFixture(destination: string): Promise<void> {
  const fixture = path.join(ROOT, "test/fixtures/store-v0.2.1/store");
  // Stryker omits the tracked directory symlink from the sandbox.
  await fsp.cp(fixture, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => source !== path.join(fixture, "sources"),
  });
  const sources = JSON.parse(await readFile(path.join(destination, "sources.json"), "utf8")) as { id: string; snapshot: string }[];
  for (const source of sources) {
    await link(path.join("..", "snapshots", source.id, source.snapshot), path.join(destination, "sources", source.id));
  }
}

/**
 * A fake ripwire, content-driven. It reads --scan-skills=<dir> and finds the marker lines
 * `FAKE-CRIT <rule>` and `FAKE-WARN <rule>` in that dir (symlinked files included). It prints real-shaped XML (absolute paths, findings=, verdict=)
 * on stdout, a tally line on stderr, and exits 2, 1, or 0 to match. Env knobs:
 *   FAKE_RIPWIRE_EXIT=<n>        force the exit code (3 and above print no XML)
 *   FAKE_RIPWIRE_DROP_ROW=1      drop the last row, so findings= no longer matches
 *   FAKE_RIPWIRE_SEV=<sev>       override every row's severity
 *   FAKE_RIPWIRE_SEV_ON=<text>   with SEV: only when the scanned dir path contains <text>
 *   FAKE_RIPWIRE_FAIL_ON=<text>  exit 3 when the scanned dir path contains <text>
 * `--version` prints the pinned version, so margrave accepts the fake as a PATH ripwire.
 * POSIX sh only: it must run under macOS /bin/sh with BSD grep and sed. The script has no `${` so
 * that String.raw keeps it readable.
 */
const FAKE_RIPWIRE = String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then echo "ripwire @VERSION@ (fake)"; exit 0; fi
dir=
for a in "$@"; do
  case "$a" in --scan-skills=*) dir=$(printf '%s' "$a" | cut -c15-) ;; esac
done
echo "fake ripwire: $*" >&2
if [ -n "$FAKE_RIPWIRE_FAIL_ON" ]; then
  case "$dir" in *"$FAKE_RIPWIRE_FAIL_ON"*) echo "fake ripwire: cannot read $dir" >&2; exit 3 ;; esac
fi
forced=$FAKE_RIPWIRE_EXIT
case "$forced" in ""|0|1|2) ;; *) exit "$forced" ;; esac
tab=$(printf '\t')
rows=$(find "$dir" -name .git -prune -o \( -type f -o -type l \) -exec grep -naE 'FAKE-(CRIT|WARN) ' {} /dev/null \; 2>/dev/null \
  | sed -E "s/^(.*):([0-9]+):.*FAKE-(CRIT|WARN) ([^ ]*).*\$/\1$tab\2$tab\3$tab\4/")
n=0; crit=0; body=; prev=
while IFS="$tab" read -r p l m r; do
  [ -n "$p" ] || continue
  if [ "$m" = CRIT ]; then sev=critical; crit=$((crit + 1)); else sev=warn; fi
  if [ -n "$FAKE_RIPWIRE_SEV" ]; then
    case "$dir" in *"$FAKE_RIPWIRE_SEV_ON"*) sev=$FAKE_RIPWIRE_SEV ;; esac
  fi
  pe=$(printf '%s' "$p" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g')
  n=$((n + 1))
  prev=$body
  body="$body<f p=\"$pe:$l\" rule=\"$r\" sev=\"$sev\"/>"
done <<ROWS
$rows
ROWS
if [ "$FAKE_RIPWIRE_DROP_ROW" = 1 ] && [ "$n" -gt 0 ]; then body=$prev; fi
if [ "$crit" -gt 0 ]; then code=2; verdict=critical; elif [ "$n" -gt 0 ]; then code=1; verdict=warn; else code=0; verdict=clean; fi
if [ -n "$forced" ]; then
  code=$forced
  case "$code" in 2) verdict=critical ;; 1) verdict=warn ;; *) verdict=clean ;; esac
fi
echo "ripwire scan: $n finding(s) total" >&2
printf '<skillscan files="1" findings="%s" skipped="0" verdict="%s">%s</skillscan>\n' "$n" "$verdict" "$body"
exit "$code"
`;

export async function fakeRipwire(): Promise<string> {
  const dir = await tmp("mg-fakebin-");
  const file = path.join(dir, "ripwire");
  await writeFile(file, FAKE_RIPWIRE.replace("@VERSION@", PINNED_RIPWIRE));
  await chmod(file, 0o755);
  return dir;
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** MARGRAVE_HOME for the child. Tests never use the real ~/.margrave. */
  home: string;
  /** A directory put first on PATH (holds the fake ripwire). */
  fakeBin?: string;
  extra?: Record<string, string>;
  cwd?: string;
  /** Extra node options, put after the no-vendored-ripwire preload and before the CLI path (for example a `--import` of a preload). */
  nodeArgs?: string[];
}

export function runCli(args: string[], opts: RunOptions): Promise<Run> {
  const PATH = `${opts.fakeBin === undefined ? "" : `${opts.fakeBin}:`}${process.env["PATH"] ?? ""}`;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", NO_VENDORED_PRELOAD, ...(opts.nodeArgs ?? []), CLI, ...args],
      {
        cwd: opts.cwd ?? ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH,
          MARGRAVE_HOME: opts.home,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          ...opts.extra,
        },
      },
      (err, stdout, stderr) => {
        const raw = err === null ? 0 : (err as { code?: unknown }).code;
        resolve({ code: typeof raw === "number" ? raw : 1, stdout, stderr });
      },
    );
  });
}

export function skillMd(name: string, description: string, body = `# ${name}\n\nBody of ${name}.\n`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

export async function writeSkill(dir: string, name: string, description: string, body?: string): Promise<string> {
  const d = path.join(dir, name);
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, "SKILL.md"), skillMd(name, description, body));
  return d;
}

export function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
      (err, stdout, stderr) => (err === null ? resolve(stdout) : reject(new Error(`git ${args.join(" ")}: ${stderr}`))),
    );
  });
}

/** A git repo with 3 skills, committed on `main`. */
export async function makeRepo(): Promise<{ dir: string; url: string }> {
  const dir = await tmp("mg-repo-");
  await git(dir, "init", "-q", "-b", "main");
  await writeSkill(path.join(dir, "skills"), "react-perf", "Optimize React rendering performance and bundle size");
  await writeSkill(path.join(dir, "skills"), "postgres-tuning", "Tune PostgreSQL queries, indexes, and vacuum settings");
  await writeSkill(path.join(dir, "skills"), "docker-compose", "Write Docker Compose files for local services");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "initial");
  return { dir, url: `file://${dir}` };
}

export async function head(dir: string): Promise<string> {
  return (await git(dir, "rev-parse", "HEAD")).trim();
}

export async function link(target: string, at: string): Promise<void> {
  await mkdir(path.dirname(at), { recursive: true });
  await symlink(target, at);
}

/** Every row of index.db in `home`, by id. Opens its own read-only connection. */
export function indexRows(home: string): { id: string; name: string; source: string; hash: string }[] {
  const db = new DatabaseSync(path.join(home, "index.db"), { readOnly: true });
  try {
    return db.prepare("SELECT id, name, source, hash FROM skills ORDER BY id").all() as unknown as {
      id: string;
      name: string;
      source: string;
      hash: string;
    }[];
  } finally {
    db.close();
  }
}

export const indexIds = (home: string): string[] => indexRows(home).map((r) => r.id);

export function catalogRecords(home: string): SourceRecord[] {
  const db = new DatabaseSync(path.join(home, "index.db"), { readOnly: true });
  try {
    return catalogSources(db);
  } finally {
    db.close();
  }
}

export function writeCatalogRecords(home: string, records: SourceRecord[]): void {
  const db = new DatabaseSync(path.join(home, "index.db"));
  try {
    putCatalogSources(db, records);
  } finally {
    db.close();
  }
}

export function newEntry(source: string, name: string, description = `desc ${name}`, body = ""): NewEntry {
  return {
    id: `${source}/${name}`,
    name,
    description,
    source,
    dir: `/x/${source}/${name}`,
    revision: "h",
    manifest: "[]",
    frontmatter: "",
    tokens: buildFieldTokens({ name, description, headings: [], body }),
  };
}

/** Create index.db under the current MARGRAVE_HOME with these entries. Writes no sources.json. */
export async function seedIndex(entries: NewEntry[], sources?: SourceRecord[]): Promise<void> {
  const { db, file } = await temporaryCatalog();
  try {
    insertSkills(db, entries);
    putCatalogSources(
      db,
      sources ??
        [...new Set(entries.map((entry) => entry.source))].map((id) => ({
          id,
          kind: "local",
          spec: `/x/${id}`,
          path: `/x/${id}`,
          subpath: "",
          ref: null,
          commit: null,
          installedAt: "2026-01-01T00:00:00.000Z",
        })),
    );
  } finally {
    db.close();
  }
  await rename(file, indexDbFile());
  await rm(`${file}.owner`);
}

/** A second connection that holds the write lock of `home`'s index.db until `release()`. In-process: the caller must not touch the lock holder's database synchronously. */
export function holdWriteLock(home: string, mode: "IMMEDIATE" | "EXCLUSIVE" = "IMMEDIATE"): { db: DatabaseSync; release: () => void } {
  const db = new DatabaseSync(path.join(home, "index.db"), { timeout: 100 });
  db.exec(`BEGIN ${mode}`);
  return {
    db,
    release: () => {
      if (!db.isOpen) return;
      if (db.isTransaction) db.exec("COMMIT");
      db.close();
    },
  };
}

/** A child that starts a write transaction on index.db with a tiny page cache, so SQLite writes a journal, and then waits. */
const JOURNAL_WRITER = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
db.exec("PRAGMA cache_size = 10");
db.exec("BEGIN IMMEDIATE");
db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) " +
  "INSERT INTO skills(id, id_lc, name, name_lc, description, source, dir, hash, manifest, frontmatter) " +
  "SELECT 'k' || i, 'k' || i, 'n', 'n', hex(randomblob(400)), 'zz', '/x', 'h', '[]', '' FROM n");
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;

/** Leave a hot rollback journal next to `file`: a writer opens a transaction, writes a journal, and is killed with SIGKILL. */
export async function leaveHotJournal(file: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", JOURNAL_WRITER, file], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([once(child.stdout, "data").then(() => true), exited.then(() => false)]);
    assert.equal(ready, true, "the writer exited before its transaction was open");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}

/**
 * A second connection to home's index.db: runs `fn` in one transaction, then closes. Synchronous, and it bypasses any
 * exec mock, so a test can use it as "another process changed the store".
 */
export function writeIndexRows(home: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path.join(home, "index.db"), { readBigInts: true, timeout: 5000 });
  try {
    realExec.call(db, "BEGIN IMMEDIATE");
    fn(db);
    realExec.call(db, "COMMIT");
  } finally {
    db.close();
  }
}

/**
 * Mock DatabaseSync.exec so that `change` runs synchronously right before the `nth` BEGIN IMMEDIATE, then the real exec
 * runs. The counters show whether that statement was reached, which tells a check under the lock from one before it.
 * The caller undoes the mock with mock.restoreAll() or at the end of the test.
 */
export function changeAtLock(
  t: { after: (fn: () => void) => void },
  nth: number,
  change: () => void,
): { begins: () => number; fired: () => boolean } {
  let begins = 0;
  let fired = false;
  mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && ++begins === nth) {
      fired = true;
      change();
    }
    return realExec.call(this, sql);
  });
  t.after(() => mock.restoreAll());
  return { begins: () => begins, fired: () => fired };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The real DatabaseSync methods, captured before any test mocks them. */
const methods = DatabaseSync.prototype as unknown as {
  exec: (this: DatabaseSync, sql: string) => void;
  close: (this: DatabaseSync) => void;
};
export const realExec = methods.exec;
export const realClose = methods.close;

export interface Env {
  home: string;
  fakeBin: string;
}

export async function cliSetup(): Promise<Env> {
  return { home: await tmp("mg-home-"), fakeBin: await fakeRipwire() };
}

export const cliMg = (env: Env, args: string[], extra?: Record<string, string>): Promise<Run> =>
  runCli(args, { home: env.home, fakeBin: env.fakeBin, ...(extra === undefined ? {} : { extra }) });

export async function cliSnapshot(home: string): Promise<{ sources: string | null; index: string | null }> {
  const index = await stat(path.join(home, "index.db")).then(
    () => JSON.stringify(indexRows(home)),
    () => null,
  );
  return { sources: index === null ? null : JSON.stringify(catalogRecords(home)), index };
}

export function sourceId(r: Run): string {
  const m = /^installed (\S+) \((\d+) skills\)/mu.exec(r.stdout);
  assert.ok(m?.[1], `no source id in: ${r.stdout}${r.stderr}`);
  return m[1];
}

/** Point MARGRAVE_HOME at `h` for this test only. */
export function useHome(t: { after: (fn: () => void) => void }, h: string): void {
  const prev = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = h;
  t.after(() => {
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
}

export const quiet = { log: (): void => undefined, allowUnsafe: false };

/** Run `fn` in this process with the fake ripwire on PATH, a fresh MARGRAVE_HOME, and no global git config. */
export async function inStore<T>(t: { after: (fn: () => void) => void }, fn: (home: string) => Promise<T>): Promise<T> {
  const keys = ["PATH", "MARGRAVE_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
  const prev = keys.map((k) => process.env[k]);
  const home = await tmp("mg-home-");
  process.env["PATH"] = `${await fakeRipwire()}:${process.env["PATH"] ?? ""}`;
  process.env["MARGRAVE_HOME"] = home;
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    });
  });
  return fn(home);
}

/** Make fs.rename reject whenever `fails(from, to, nth)` says so. Other renames run. */
export function failRename(fails: (from: string, to: string, nth: number) => boolean): void {
  // Drop an earlier mock first: restoring two stacked mocks in creation order would leave the inner one in place.
  mock.restoreAll();
  const real = fsp.rename;
  let nth = 0;
  mock.method(fsp, "rename", (from: string, to: string) =>
    fails(from, to, ++nth) ? Promise.reject(new Error(`mock: cannot rename to ${to}`)) : real(from, to),
  );
  syncBuiltinESMExports();
}

export const passRename = (): void => {
  mock.restoreAll();
  syncBuiltinESMExports();
};

export const read = async (home: string, file: string): Promise<string | null> => {
  if (file === "sources.json") {
    try {
      return JSON.stringify(catalogRecords(home));
    } catch {
      return null;
    }
  }
  return readFile(path.join(home, file), "utf8").catch(() => null);
};

/** Change one catalog source read while preserving the other SQLite operations. */
export function mockSourcesRead(answer: (nth: number) => { error: unknown } | { empty: true } | undefined): void {
  mock.restoreAll();
  const { prepare: real } = DatabaseSync.prototype as unknown as {
    prepare: (this: DatabaseSync, sql: string) => ReturnType<DatabaseSync["prepare"]>;
  };
  let nth = 0;
  mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "SELECT id, record FROM sources ORDER BY position") {
      const given = answer(++nth);
      if (given !== undefined && "error" in given) throw given.error;
      if (given !== undefined && "empty" in given) return { all: () => [] } as unknown as ReturnType<DatabaseSync["prepare"]>;
    }
    return real.call(this, sql);
  });
}

export async function catalogSetup(): Promise<{
  home: string;
  fakeBin: string;
  dir: string;
  id: string;
  mg: (args: string[]) => Promise<Run>;
}> {
  const home = await tmp("mg-home-");
  const fakeBin = await fakeRipwire();
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, "alpha", "alpha skill for the guard tests");
  const mg = (args: string[]): Promise<Run> => runCli(args, { home, fakeBin });
  const inst = await mg(["install", dir]);
  assert.equal(inst.code, 0, inst.stderr);
  return { home, fakeBin, dir, id: /^installed (\S+)/mu.exec(inst.stdout)?.[1] ?? "", mg };
}

export const xml = (attrs: string, rows: string): string => `<skillscan ${attrs}>${rows}</skillscan>`;

export async function scanDir(lines: Record<string, string>): Promise<string> {
  const dir = await tmp("mg-scan-");
  for (const [rel, text] of Object.entries(lines)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

export const NO_VENDOR = path.join(tmpdir(), "mg-no-vendored-ripwire", "ripwire");

export const opts = (logs: string[], over: { allowUnsafe?: boolean; baselineDir?: string | null; vendored?: string } = {}) => ({
  allowUnsafe: over.allowUnsafe ?? false,
  vendored: over.vendored ?? NO_VENDOR,
  log: (m: string) => logs.push(m),
  sourceId: "src",
  skills: [] as { name: string; dir: string }[],
  ...(over.baselineDir === undefined ? {} : { baselineDir: over.baselineDir }),
});

export async function scanWithRipwire(dir: string, options: ReturnType<typeof opts>): ReturnType<typeof scan> {
  const { baselineDir, ...rest } = options;
  const baseline =
    baselineDir === undefined
      ? undefined
      : baselineDir === null
        ? null
        : await scan(baselineDir, { ...rest, allowUnsafe: true, log: () => {}, verifyContent: true });
  return scan(dir, { ...rest, ...(baseline === undefined ? {} : { baseline }) });
}

/**
 * A ripwire stand-in. `--version` prints `versionLine` and exits `versionExit`. A scan exits 3 and names itself on stderr,
 * so a test can tell which binary ran. Every call is appended to `<file>.calls`.
 */
export async function standIn(name: string, versionLine: string = `ripwire ${PINNED_RIPWIRE} (fake)`, versionExit = 0): Promise<string> {
  const dir = await tmp("mg-named-");
  const file = path.join(dir, "ripwire");
  await writeFile(
    file,
    `#!/bin/sh\necho "$*" >> "$0.calls"\nif [ "$1" = "--version" ]; then echo '${versionLine}'; exit ${versionExit}; fi\necho ${name} >&2\nexit 3\n`,
  );
  await chmod(file, 0o755);
  return file;
}

/** Write the VERSION stamp that scripts/ensure-ripwire.mjs puts next to a vendored binary. */
export async function stamp(binary: string, text: string = PINNED_RIPWIRE): Promise<string> {
  await writeFile(path.join(path.dirname(binary), "VERSION"), `${text}\n`);
  return binary;
}

/** The arguments of every call that a stand-in got, or [] when it never ran. */
export async function calls(file: string): Promise<string[]> {
  try {
    return (await readFile(`${file}.calls`, "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

export async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["PATH"];
  process.env["PATH"] = value;
  try {
    return await fn();
  } finally {
    process.env["PATH"] = prev;
  }
}

/** A directory with a `ripwire` that prints the given text and exits as told, or kills itself with a signal. `--version` prints the pinned version. */
export async function scriptedRipwire(spec: { code?: number; stdout?: string; stderr?: string; signal?: boolean }): Promise<string> {
  const dir = await tmp("mg-scripted-");
  await writeFile(path.join(dir, "out.txt"), spec.stdout ?? "");
  await writeFile(path.join(dir, "err.txt"), spec.stderr ?? "");
  const tail = spec.signal === true ? "kill -TERM $$" : `exit ${spec.code ?? 0}`;
  const file = path.join(dir, "ripwire");
  await writeFile(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ripwire ${PINNED_RIPWIRE} (fake)"; exit 0; fi\nd=$(dirname "$0")\ncat "$d/err.txt" >&2\ncat "$d/out.txt"\n${tail}\n`,
  );
  await chmod(file, 0o755);
  return dir;
}

/** Run `fn` with the scripted ripwire first on PATH and a fresh MARGRAVE_HOME. */
export async function withScripted<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prevHome = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  try {
    return await withPath(`${bin}:${process.env["PATH"] ?? ""}`, fn);
  } finally {
    if (prevHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prevHome;
  }
}

export async function names(dir: string): Promise<string[]> {
  return (await readdir(dir).catch((): string[] => [])).sort();
}

export async function installLocalDir(env: Env, dir: string): Promise<string> {
  const r = await cliMg(env, ["install", dir]);
  assert.equal(r.code, 0, r.stderr);
  return sourceId(r);
}

export async function localSource(name: string): Promise<{ dir: string; record: (id: string) => SourceRecord }> {
  const dir = await tmp("mg-localsrc-");
  await writeSkill(dir, name, `${name} skill`);
  return {
    dir,
    record: (id) => ({ id, kind: "local", spec: dir, path: dir, subpath: "", ref: null, commit: null, installedAt: "now" }),
  };
}

export const readSourceRecords = (home: string): SourceRecord[] => catalogRecords(home);

/** The change for the next three tests: another command removed `id` (rows and record) before this command took the lock. */
export function removedByAnother(t: { after: (fn: () => void) => void }, home: string, id: string): ReturnType<typeof changeAtLock> {
  return changeAtLock(t, 1, () => {
    writeIndexRows(home, (db) => deleteSourceSkills(db, id));
    writeCatalogRecords(home, []);
  });
}

export interface ToolText {
  isError: boolean;
  text: string;
}

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolText> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") };
}

/** A client of handleHostedMcp. The fetch goes straight to the handler, so no network is used. */
export async function connectHosted(t: { after: (fn: () => Promise<void>) => void }, allowedSources?: readonly string[]): Promise<Client> {
  const client = new Client({ name: "margrave-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test/mcp?allowedSources=all"), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("allowedSources", "all");
        const response = await handleHostedMcp(
          new Request(url, { ...init, headers }),
          allowedSources === undefined ? {} : { allowedSources },
        );
        if (response.ok) assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/u);
        return response;
      },
    }),
  );
  t.after(() => client.close());
  return client;
}

/** Set MARGRAVE_HOME to a fresh temp dir until the test ends. */
export async function hostedUseHome(t: { after: (fn: () => void) => void }): Promise<string> {
  const prev = process.env["MARGRAVE_HOME"];
  const home = await tmp("mg-home-");
  process.env["MARGRAVE_HOME"] = home;
  t.after(() => {
    mock.restoreAll();
    if (prev === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev;
  });
  return home;
}

export async function disposableHome(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
  const home = await hostedUseHome(t);
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

export function assertWriterAvailable(home: string): void {
  using db = new DatabaseSync(path.join(home, "writer-lock.db"), { timeout: 0 });
  realExec.call(db, "BEGIN IMMEDIATE");
}

export function gitSourceRecord(id: string, spec = id, snapshot = `${"a".repeat(40)}-${"b".repeat(16)}`): SourceRecord {
  const [commit] = snapshot.split("-", 1);
  return { id, kind: "git", spec, url: "u", subpath: "", ref: null, commit: commit!, installedAt: "now", snapshot };
}
