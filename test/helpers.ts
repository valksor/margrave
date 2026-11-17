import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "src", "cli.ts");

export async function tmp(prefix = "mg-"): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

/** A fake ripwire that exits with $FAKE_RIPWIRE_EXIT (default 0) and prints a marker line. */
export async function fakeRipwire(): Promise<string> {
  const dir = await tmp("mg-fakebin-");
  const file = path.join(dir, "ripwire");
  await writeFile(file, '#!/bin/sh\necho "fake ripwire: $*"\nexit "${FAKE_RIPWIRE_EXIT:-0}"\n');
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
}

export function runCli(args: string[], opts: RunOptions): Promise<Run> {
  const PATH = `${opts.fakeBin === undefined ? "" : `${opts.fakeBin}:`}${process.env["PATH"] ?? ""}`;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
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
