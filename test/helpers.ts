import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { promisify } from "node:util";
import { buildFieldTokens } from "../src/bm25.ts";
import { PINNED_RIPWIRE } from "../src/safety.ts";
import { insertSkills, openIndexWrite } from "../src/store.ts";
import type { NewEntry } from "../src/store.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "src", "cli.ts");
/** Preload that hides a vendored ripwire from margrave. `runCli` puts it in front of every spawned CLI. */
export const NO_VENDORED_PRELOAD = path.join(ROOT, "test", "no-vendored-ripwire.ts");

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

export function newEntry(source: string, name: string, description = `desc ${name}`, body = ""): NewEntry {
  return {
    id: `${source}/${name}`,
    name,
    description,
    source,
    dir: `/x/${source}/${name}`,
    hash: "h",
    tokens: buildFieldTokens({ name, description, headings: [], body }),
  };
}

/** Create index.db under the current MARGRAVE_HOME with these entries. Writes no sources.json. */
export async function seedIndex(entries: NewEntry[]): Promise<void> {
  const db = await openIndexWrite("create");
  try {
    insertSkills(db, entries);
  } finally {
    db.close();
  }
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
