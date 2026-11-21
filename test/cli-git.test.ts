import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { catalogRecords, disposableHome, fakeRipwire, git, head, makeRepo, runCli, tmp, writeSkill } from "./helpers.ts";

test("CLI Git direct install, check, update, list and remove", async (t) => {
  const home = await disposableHome(t);
  const fakeBin = await fakeRipwire();
  const repo = await makeRepo();
  const away = `${repo.dir}-away`;
  t.after(async () => {
    await Promise.all([repo.dir, away, fakeBin].map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const cli = (args: string[], extra: Record<string, string> = {}) => runCli(args, { home, fakeBin, extra });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const ref = "refs/heads/main";
  const oldCommit = await head(repo.dir);
  const installArgs = ["install", repo.url, "--ref", ref];
  const refused = await cli(installArgs, { FAKE_RIPWIRE_EXIT: "2" });
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /^margrave: refused: /u);
  assert.match(refused.stderr, /\nre-run with --allow-unsafe to override for this one command\n$/u);
  const installed = await cli([...installArgs, "--allow-unsafe"], { FAKE_RIPWIRE_EXIT: "2" });
  const record = catalogRecords(home)[0]!;
  const id = record.id;
  assert.equal(installed.code, 0);
  assert.equal(installed.stdout, `installed ${id} (3 skills)\n  ${id}/docker-compose\n  ${id}/postgres-tuning\n  ${id}/react-perf\n`);
  assert.match(installed.stderr, /--allow-unsafe: overriding refusal/u);
  assert.equal(record.ref, ref);
  assert.equal(record.commit, oldCommit);

  const exported = await cli(["lock", "export", "--source", id]);
  assert.equal(exported.code, 0);
  assert.equal(exported.stderr, "");
  const lock = JSON.parse(exported.stdout) as { version: number; sources: { id: string; commit: string; ref: string }[] };
  assert.equal(lock.version, 2);
  assert.deepEqual(
    lock.sources.map(({ id: sourceId, commit, ref: sourceRef }) => ({ id: sourceId, commit, ref: sourceRef })),
    [{ id, commit: oldCommit, ref }],
  );
  assert.deepEqual(await cli(["lock", "export", "--source", "missing", "--source", id]), {
    code: 1,
    stdout: "",
    stderr: "margrave: --source must be an installed Git source ID\n",
  });
  const restoreHome = await disposableHome(t);
  const lockFile = path.join(restoreHome, "lock.json");
  await writeFile(lockFile, exported.stdout);
  const restoreArgs = ["lock", "restore", lockFile];
  const restoreRefused = await runCli(restoreArgs, { home: restoreHome, fakeBin, extra: { FAKE_RIPWIRE_EXIT: "2" } });
  assert.equal(restoreRefused.code, 1);
  assert.equal(restoreRefused.stdout, "");
  assert.match(restoreRefused.stderr, /margrave: refused: ripwire reported CRITICAL but no critical finding row was parsed \(exit 2\)/u);
  assert.match(restoreRefused.stderr, /\nre-run with --allow-unsafe to override for this one command\n$/u);
  assert.equal(existsSync(path.join(restoreHome, "index.db")), false);
  assert.equal(existsSync(path.join(restoreHome, "catalog-published")), false);
  assert.equal(existsSync(path.join(restoreHome, "sources.json")), false);
  assert.deepEqual(await runCli(restoreArgs, { home: restoreHome, fakeBin }), { code: 0, stdout: `restored ${id}\n`, stderr: "" });
  for (const name of ["docker-compose", "postgres-tuning", "react-perf"]) {
    assert.deepEqual(
      await readFile(path.join(restoreHome, "sources", id, "skills", name, "SKILL.md")),
      await readFile(path.join(repo.dir, "skills", name, "SKILL.md")),
    );
  }

  const snapshotFile = path.join(home, "snapshots", id, record.snapshot!, "skills", "react-perf", "SKILL.md");
  const original = await readFile(snapshotFile, "utf8");
  await rm(path.join(repo.dir, "skills", "docker-compose"), { recursive: true });
  await writeSkill(path.join(repo.dir, "skills"), "react-perf", "changed React skill", "# React\nFAKE-CRIT new-rule\n");
  await writeSkill(path.join(repo.dir, "skills"), "new-skill", "new skill");
  await git(repo.dir, "add", "-A");
  await git(repo.dir, "commit", "-q", "-m", "update skills");
  const newCommit = await head(repo.dir);
  assert.equal(await readFile(snapshotFile, "utf8"), original);
  assert.deepEqual(await cli(["check", id]), {
    code: 1,
    stdout: `${id}: update available (${oldCommit.slice(0, 7)} → ${newCommit.slice(0, 7)})\n`,
    stderr: "",
  });
  assert.deepEqual(await cli(["check", id, "--json"]), {
    code: 1,
    stdout: json([{ id, updateAvailable: true, added: [], changed: [], removed: [], error: null }]),
    stderr: "",
  });
  const refusedUpdate = await cli(["update", id, "--ref", ref]);
  assert.equal(refusedUpdate.code, 1);
  assert.equal(refusedUpdate.stdout, "");
  assert.match(
    refusedUpdate.stderr,
    /^scan: no accepted baseline\. Applying install rules\nmargrave: refused: ripwire found CRITICAL findings \(exit 2\)\n/u,
  );
  assert.match(refusedUpdate.stderr, /\nre-run with --allow-unsafe to override for this one command\n$/u);
  assert.deepEqual(catalogRecords(home), [record]);
  assert.equal(await readFile(snapshotFile, "utf8"), original);
  const updated = await cli(["update", id, "--ref", ref, "--allow-unsafe"]);
  assert.equal(updated.code, 0);
  assert.equal(
    updated.stdout,
    `${id}: ${oldCommit.slice(0, 7)} → ${newCommit.slice(0, 7)}\n  added: ${id}/new-skill\n  changed: ${id}/react-perf\n  removed: ${id}/docker-compose\n`,
  );
  assert.match(updated.stderr, /--allow-unsafe: overriding refusal/u);
  assert.equal(catalogRecords(home)[0]!.ref, ref);
  assert.equal(catalogRecords(home)[0]!.commit, newCommit);
  assert.deepEqual(await cli(["list"]), {
    code: 0,
    stdout: `${id}  git  ref=${ref}  commit=${newCommit.slice(0, 7)}  skills=3\n`,
    stderr: "",
  });
  const localDir = await tmp("mg-cli-git-local-");
  t.after(() => rm(localDir, { recursive: true, force: true }));
  await writeSkill(localDir, "local-skill", "Local skill");
  assert.equal((await cli(["install", localDir])).code, 0);
  const records = catalogRecords(home);
  const local = records.find((source) => source.kind === "local")!;
  const currentGit = records.find((source) => source.id === id)!;
  assert.notEqual(local.id, id);
  const gitSkillId = `${id}/react-perf`;
  const localSkillId = `${local.id}/local-skill`;
  const db = new DatabaseSync(path.join(home, "index.db"), { readOnly: true });
  let revisions: { id: string; hash: string }[];
  try {
    revisions = db.prepare("SELECT id, hash FROM skills WHERE id IN (?, ?) ORDER BY id").all(gitSkillId, localSkillId) as unknown as {
      id: string;
      hash: string;
    }[];
  } finally {
    db.close();
  }
  assert.equal(revisions.length, 2);
  const gitRevision = revisions.find((row) => row.id === gitSkillId)!.hash;
  const localRevision = revisions.find((row) => row.id === localSkillId)!.hash;
  const gitFile = path.join(home, "snapshots", id, currentGit.snapshot!, "skills", "react-perf", "SKILL.md");
  const localFile = path.join(localDir, "local-skill", "SKILL.md");
  const gitBytes = await readFile(gitFile);
  const localBytes = await readFile(localFile);
  try {
    await writeFile(gitFile, Buffer.concat([gitBytes, Buffer.from("changed\n")]));
    await writeFile(localFile, Buffer.concat([localBytes, Buffer.from("changed\n")]));
    assert.deepEqual(await cli(["load", gitSkillId, "--file", "SKILL.md", "--revision", gitRevision]), {
      code: 1,
      stdout: "",
      stderr: "margrave: installed Git files differ from the accepted revision. Restore a verified lock or a known-good backup\n",
    });
    assert.deepEqual(await cli(["load", localSkillId, "--revision", localRevision]), {
      code: 1,
      stdout: "",
      stderr: "margrave: skill files changed since indexing; ask the store operator to run margrave reindex, then search again\n",
    });
  } finally {
    await writeFile(gitFile, gitBytes);
    await writeFile(localFile, localBytes);
  }
  await rename(repo.dir, away);
  assert.deepEqual(await cli(["check", id, "--json"]), {
    code: 1,
    stdout: json([{ id, updateAvailable: false, added: [], changed: [], removed: [], error: "cannot read remote tracking ref" }]),
    stderr: "",
  });
  assert.deepEqual(await cli(["remove", id]), { code: 0, stdout: `removed ${id}\n`, stderr: "" });
});
