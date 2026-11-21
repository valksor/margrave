import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp, { chmod, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { PINNED_RIPWIRE, scanInventory, scanWithRipwire as scan } from "../src/safety.ts";
import { MargraveError, validScan } from "../src/store.ts";
import {
  xml,
  fakeRipwire,
  scanDir,
  opts,
  scanWithRipwire,
  standIn,
  stamp,
  calls,
  withPath,
  scriptedRipwire,
  withScripted,
  mkfifo,
  releaseFifo,
  tmp,
} from "./helpers.ts";

export async function env(): Promise<{ bin: string; run: <T>(fn: () => Promise<T>, extra?: Record<string, string>) => Promise<T> }> {
  const bin = await fakeRipwire();
  const home = await tmp("mg-home-");
  return {
    bin,
    run: async (fn, extra = {}) => {
      const keys = ["PATH", "MARGRAVE_HOME", ...Object.keys(extra)];
      const prev = keys.map((k) => process.env[k]);
      process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
      process.env["MARGRAVE_HOME"] = home;
      Object.assign(process.env, extra);
      try {
        return await fn();
      } finally {
        keys.forEach((k, i) => {
          if (prev[i] === undefined) delete process.env[k];
          else process.env[k] = prev[i];
        });
      }
    },
  };
}

// ---- scanWithRipwire (install mode: no baseline) ----

test("accepted scan records retain verdicts and native relative fingerprints", async () => {
  const e = await env();
  const clean = await scanDir({ "a/SKILL.md": "clean\n" });
  const warn = await scanDir({ "a/back\\slash.md": "x FAKE-WARN INJECTION:eval\n" });
  const critical = await scanDir({ "a/SKILL.md": "x FAKE-CRIT EXFILTRATE:net-exfil\n" });
  const a = await e.run(() => scan(clean, { ...opts([]), verifyContent: true }));
  const b = await e.run(() => scan(warn, { ...opts([]), verifyContent: true }));
  const c = await e.run(() => scan(critical, { ...opts([], { allowUnsafe: true }), verifyContent: true }));
  const d = await e.run(() => scan(clean, { ...opts([], { allowUnsafe: true }), verifyContent: true }), { FAKE_RIPWIRE_EXIT: "3" });
  assert.deepEqual([a.verdict, b.verdict, c.verdict, d.verdict], ["clean", "warn", "critical", "failed"]);
  assert.deepEqual([a.overridden, b.overridden, c.overridden, d.overridden], [false, false, true, true]);
  for (const result of [a, b, c, d]) {
    assert.equal(result.version, PINNED_RIPWIRE);
    assert.ok(result.tree);
    assert.ok(validScan(JSON.parse(JSON.stringify(result))));
    assert.ok(!JSON.stringify(result).includes(clean));
  }
  assert.equal(b.files[0]?.[0], "a/back\\slash.md");
  assert.equal(validScan({ ...b, keys: [[JSON.stringify(["x", "rule", "warn", 123]), 1]] }), false);
  for (const value of [
    null,
    {},
    { ...b, extra: 1 },
    { ...b, tree: "bad" },
    { ...b, tree: 12 },
    { ...b, version: 1 },
    { ...b, overridden: "yes" },
    { ...b, verdict: "unknown" },
    { ...b, code: 0 },
    { ...a, code: 1 },
    { ...c, code: 1 },
    { ...d, code: "bad" },
    { ...b, keys: null },
    { ...b, files: null },
    { ...b, keys: [null] },
    { ...b, keys: [["bad"]] },
    { ...b, keys: [[0, 1]] },
    { ...b, keys: [["bad", 0]] },
    { ...b, keys: [["not json", 1]] },
    ...[
      null,
      [],
      ["x"],
      ["/absolute", "r", "warn", "a".repeat(64)],
      ["../escape", "r", "warn", "a".repeat(64)],
      ["x", 2, "warn", "a".repeat(64)],
      ["x", "r", "other", "a".repeat(64)],
      ["x", "r", "warn", "bad"],
    ].map((key) => ({ ...b, keys: [[JSON.stringify(key), 1]] })),
    ...[null, [], ["/absolute", "a".repeat(64)], ["../escape", "a".repeat(64)], ["x", 1], ["x", "bad"]].map((item) => ({
      ...b,
      files: [item],
    })),
  ])
    assert.equal(validScan(value), false);
  const logs: string[] = [];
  await assert.rejects(
    e.run(() => scan(critical, { ...opts(logs), baseline: d })),
    /refused: ripwire found CRITICAL[^\n]*\nscan: CRITICAL — 1 finding\(s\) \(1 critical\) in/u,
  );
  assert.equal(logs[0], "scan: no accepted baseline. Applying install rules");
});

test("verified scans reject changed trees and non-file entries", async (t) => {
  const dir = await scanDir({ "a/SKILL.md": "clean\n" });
  const bin = await tmp("mg-mutating-scanner-");
  const executable = path.join(bin, "ripwire");
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'ripwire ${PINNED_RIPWIRE}'; exit 0; fi\ndir=\${2#--scan-skills=}; printf changed > "$dir/added.txt"; exit 0\n`,
  );
  await chmod(executable, 0o755);
  await assert.rejects(
    withPath(bin, () => scan(dir, { ...opts([]), verifyContent: true })),
    /staged skills changed during scan/u,
  );
  const fifo = path.join(dir, "pipe");
  await mkfifo(fifo);
  t.after(() => releaseFifo(fifo));
  await assert.rejects(scan(dir, { ...opts([]), verifyContent: true }), /staged skills changed during scan/u);
});

test("clean scan continues without logging and writes no report", async () => {
  const e = await env();
  const dir = await scanDir({ "a/SKILL.md": "nothing here\n" });
  const logs: string[] = [];
  const r = await e.run(() => scanWithRipwire(dir, opts(logs)));
  assert.equal(r.code, 0);
  assert.equal(r.verdict, "clean");
  assert.equal(r.overridden, false);
  assert.deepEqual(logs, []);
});

test("WARN prints the short summary, not the XML, and continues", async () => {
  const e = await env();
  const dir = await scanDir({ "a/SKILL.md": "x FAKE-WARN INJECTION:eval\n" });
  const logs: string[] = [];
  const r = await e.run(() => scanWithRipwire(dir, opts(logs)));
  assert.equal(r.code, 1);
  assert.equal(r.overridden, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /^scan: WARN — 1 finding\(s\) \(1 warn\) in 0 skill\(s\)\n/u);
  assert.match(logs[0] ?? "", /by rule:   INJECTION:eval 1/u);
  assert.match(logs[0] ?? "", /full report: .*reports\/src\.xml/u);
  assert.doesNotMatch(logs[0] ?? "", /<skillscan/u);
});

test("exit 2 refuses with the summary; --allow-unsafe overrides and says so; the report holds the XML", async () => {
  const e = await env();
  const dir = await scanDir({ "a/SKILL.md": "x FAKE-CRIT EXFILTRATE:net-exfil\ny FAKE-WARN INJECTION:eval\n" });
  await assert.rejects(
    e.run(() => scanWithRipwire(dir, opts([]))),
    (err: unknown) =>
      err instanceof MargraveError &&
      /refused: ripwire found CRITICAL findings \(exit 2\)/u.test(err.message) &&
      /scan: CRITICAL — 2 finding\(s\) \(1 critical, 1 warn\)/u.test(err.message) &&
      !/<skillscan/u.test(err.message) &&
      /--allow-unsafe/u.test(err.message),
  );
  const logs: string[] = [];
  const r = await e.run(() => scanWithRipwire(dir, opts(logs, { allowUnsafe: true })));
  assert.equal(r.overridden, true);
  assert.equal(r.code, 2);
  assert.match(logs.join("\n"), /--allow-unsafe: overriding refusal/u);
  const report = await e.run(async () => readFile(path.join(process.env["MARGRAVE_HOME"] ?? "", "reports", "src.xml"), "utf8"));
  assert.match(report, /^<skillscan files="1" findings="2"/u);
});

for (const code of [3, 7]) {
  test(`exit ${code} refuses and shows ripwire's stderr; --allow-unsafe overrides`, async () => {
    const e = await env();
    const dir = await scanDir({ "a/SKILL.md": "x\n" });
    const extra = { FAKE_RIPWIRE_EXIT: String(code) };
    await assert.rejects(
      e.run(() => scanWithRipwire(dir, opts([])), extra),
      (err: unknown) =>
        err instanceof MargraveError && /refused/u.test(err.message) && /fake ripwire: security --scan-skills=/u.test(err.message),
    );
    const logs: string[] = [];
    const r = await e.run(() => scanWithRipwire(dir, opts(logs, { allowUnsafe: true })), extra);
    assert.equal(r.overridden, true);
    assert.equal(r.code, code);
  });
}

test("unparseable output refuses like exit 3, whatever the exit code", async () => {
  const e = await env();
  const dir = await scanDir({ "a/SKILL.md": "x FAKE-WARN R:1\ny FAKE-WARN R:2\n" });
  await assert.rejects(
    e.run(() => scanWithRipwire(dir, opts([])), { FAKE_RIPWIRE_DROP_ROW: "1" }),
    /refused: ripwire declared findings="2" but 1 finding row\(s\) were parsed/u,
  );
  const clean = await scanDir({ "a/SKILL.md": "x\n" });
  await assert.rejects(
    e.run(() => scanWithRipwire(clean, opts([])), { FAKE_RIPWIRE_EXIT: "2" }),
    /refused: ripwire reported CRITICAL but no critical finding row/u,
  );
  await assert.rejects(
    e.run(() => scanWithRipwire(clean, opts([])), { FAKE_RIPWIRE_EXIT: "1" }),
    /refused: ripwire exited 1/u,
  );
});

test("ripwire missing from PATH refuses; --allow-unsafe overrides", async () => {
  const empty = await tmp("mg-emptybin-");
  const home = await tmp("mg-home-");
  const prev = { PATH: process.env["PATH"], HOME: process.env["MARGRAVE_HOME"] };
  process.env["PATH"] = empty;
  process.env["MARGRAVE_HOME"] = home;
  try {
    await assert.rejects(scanWithRipwire(empty, opts([])), /ripwire was not found on PATH/u);
    const logs: string[] = [];
    const r = await scanWithRipwire(empty, opts(logs, { allowUnsafe: true }));
    assert.equal(r.overridden, true);
    assert.equal(r.code, null);
    assert.match(logs.join("\n"), /not found on PATH/u);
  } finally {
    process.env["PATH"] = prev.PATH;
    if (prev.HOME === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prev.HOME;
  }
});

// ---- ripwire lookup: the vendored binary first, PATH second ----

test("--allow-unsafe overrides a wrong VERSION stamp", async () => {
  const vendored = await stamp(await standIn("from-vendor"), "0.4.0");
  const home = await tmp("mg-home-");
  const empty = await tmp("mg-emptybin-");
  const prevHome = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = home;
  try {
    await assert.rejects(
      withPath(empty, () => scanWithRipwire(empty, opts([], { vendored }))),
      (err: unknown) =>
        err instanceof MargraveError &&
        err.message.startsWith(`refused: vendored ripwire at ${vendored} is 0.4.0, not the pinned `) &&
        err.message.split("\n").length === 2,
    );
    const r = await withPath(empty, () => scanWithRipwire(empty, opts([], { vendored, allowUnsafe: true })));
    assert.equal(r.overridden, true);
    assert.deepEqual(await calls(vendored), []);
  } finally {
    if (prevHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prevHome;
  }
});

test("the refusal for a missing ripwire names the vendored path", async () => {
  const empty = await tmp("mg-emptybin-");
  const home = await tmp("mg-home-");
  const vendored = path.join(await tmp("mg-novendor-"), "ripwire");
  const prevHome = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = home;
  try {
    await assert.rejects(
      withPath(empty, () => scanWithRipwire(empty, opts([], { vendored }))),
      (err: unknown) => err instanceof MargraveError && err.message.includes(`not found on PATH or at ${vendored}`),
    );
  } finally {
    if (prevHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prevHome;
  }
});

test("scanWithRipwire scans with the vendored binary even when PATH has a different ripwire", async () => {
  const onPath = path.dirname(await standIn("from-path"));
  const home = await tmp("mg-home-");
  const vendored = await stamp(path.join(await fakeRipwire(), "ripwire"));
  const prevHome = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = home;
  try {
    const r = await withPath(onPath, () => scanWithRipwire(onPath, opts([], { vendored })));
    assert.equal(r.code, 0);
  } finally {
    if (prevHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prevHome;
  }
});

test("scanWithRipwire scans with ripwire on PATH when there is no vendored binary", async () => {
  const bin = await fakeRipwire();
  const home = await tmp("mg-home-");
  const dir = await scanDir({ "a/SKILL.md": "x\n" });
  const prevHome = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = home;
  try {
    const r = await withPath(bin, () => scanWithRipwire(dir, opts([])));
    assert.equal(r.code, 0);
  } finally {
    if (prevHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prevHome;
  }
});

// ---- the PATH fallback refuses a ripwire older than the pinned version ----

test("scanWithRipwire refuses an old PATH ripwire; --allow-unsafe overrides it", async () => {
  const onPath = path.dirname(await standIn("from-path", "ripwire 0.4.0 (fake)"));
  const home = await tmp("mg-home-");
  const prevHome = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = home;
  try {
    await assert.rejects(
      withPath(onPath, () => scanWithRipwire(onPath, opts([]))),
      (err: unknown) =>
        err instanceof MargraveError &&
        err.message.startsWith(`refused: ripwire on PATH reports 0.4.0, older than the pinned ${PINNED_RIPWIRE}; run: node `) &&
        err.message.includes("re-run with --allow-unsafe"),
    );
    const logs: string[] = [];
    const r = await withPath(onPath, () => scanWithRipwire(onPath, opts(logs, { allowUnsafe: true })));
    assert.equal(r.overridden, true);
    assert.equal(r.code, null);
    assert.match(logs.join("\n"), /--allow-unsafe: overriding refusal \(ripwire on PATH reports 0\.4\.0, older than the pinned/u);
  } finally {
    if (prevHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prevHome;
  }
});

// ---- scanWithRipwire (update mode: baseline) ----

const KNOWN = "run it FAKE-CRIT EXFILTRATE:net-exfil\n";

test("baseline: a known finding at a shifted line is not new; a second identical line is", async () => {
  const e = await env();
  const base = await scanDir({ "a/SKILL.md": KNOWN });
  const same = await scanDir({ "a/SKILL.md": `intro\nmore\n${KNOWN}` });
  const logs: string[] = [];
  const r = await e.run(() => scanWithRipwire(same, opts(logs, { baselineDir: base })));
  assert.equal(r.code, 2);
  assert.match(logs.join("\n"), /; 0 new vs installed copy/u);

  const twice = await scanDir({ "a/SKILL.md": KNOWN + KNOWN });
  await assert.rejects(
    e.run(() => scanWithRipwire(twice, opts([], { baselineDir: base }))),
    /refused: new critical or unreadable findings[\s\S]*1 new vs installed copy[\s\S]*new findings:\n {4}a\/SKILL\.md:2 {2}EXFILTRATE:net-exfil {2}critical\n/u,
  );
});

test("baseline: a clean installed copy makes every finding new; a missing one prints the no-baseline line", async () => {
  const e = await env();
  const clean = await scanDir({ "a/SKILL.md": "x\n" });
  const staging = await scanDir({ "a/SKILL.md": KNOWN });
  await assert.rejects(
    e.run(() => scanWithRipwire(staging, opts([], { baselineDir: clean }))),
    /1 new vs installed copy/u,
  );

  const logs: string[] = [];
  const warnOnly = await scanDir({ "a/SKILL.md": "x FAKE-WARN INJECTION:eval\n" });
  const r = await e.run(() => scanWithRipwire(warnOnly, opts(logs, { baselineDir: null })));
  assert.equal(r.code, 1);
  assert.equal(logs[0], "scan: no accepted baseline. Applying install rules");
  await assert.rejects(
    e.run(() => scanWithRipwire(staging, opts([], { baselineDir: null }))),
    /refused: ripwire found CRITICAL findings \(exit 2\)/u,
  );
});

test("baseline: a flagged symlink is unreadable and counts as new, even as a warn", async () => {
  const e = await env();
  const base = await scanDir({ "a/SKILL.md": "x FAKE-WARN INJECTION:eval\n" });
  const next = await scanDir({ "a/SKILL.md": "x FAKE-WARN INJECTION:eval\n" });
  await symlink("SKILL.md", path.join(next, "a", "link.md"));
  await assert.rejects(
    e.run(() => scanWithRipwire(next, opts([], { baselineDir: base }))),
    /refused: [\s\S]*a\/link\.md:1 {2}INJECTION:eval {2}warn \(unreadable\)/u,
  );
  // the same finding without the symlink is known and proceeds
  const logs: string[] = [];
  const ok = await e.run(() => scanWithRipwire(base, opts(logs, { baselineDir: base })));
  assert.equal(ok.code, 1);
  assert.match(logs.join("\n"), /; 0 new vs installed copy/u);
  assert.doesNotMatch(logs.join("\n"), /known findings in changed files:/u);
});

// ---- a scripted ripwire: fixed stdout, stderr, and exit code ----

test("a scan root that cannot be resolved refuses, and --allow-unsafe overrides", async () => {
  const gone = path.join(await tmp(), "does-not-exist");
  const bin = await scriptedRipwire({});
  await assert.rejects(
    withScripted(bin, () => scanWithRipwire(gone, opts([]))),
    /refused: cannot resolve the scan root/u,
  );
  const logs: string[] = [];
  const r = await withScripted(bin, () => scanWithRipwire(gone, opts(logs, { allowUnsafe: true })));
  assert.equal(r.code, null);
  assert.equal(r.verdict, "failed");
  assert.equal(r.overridden, true);
});

test("ripwire's own output is shown cut to 40 lines of 500 characters", async () => {
  const stderr = `${"w".repeat(600)}\n${Array.from({ length: 49 }, (_, i) => `line ${i + 2}`).join("\n")}\n`;
  const bin = await scriptedRipwire({ code: 4, stderr });
  const dir = await scanDir({ "a/SKILL.md": "x\n" });
  await assert.rejects(
    withScripted(bin, () => scanWithRipwire(dir, opts([]))),
    (err: unknown) => {
      const m = err instanceof MargraveError ? err.message : "";
      return (
        m.includes(`refused: ripwire failed (exit 4)\n${"w".repeat(500)}…\nline 2\n`) &&
        m.includes("line 40\n… 10 more line(s)\n") &&
        !m.includes("line 41")
      );
    },
  );
});

test("a finding row that does not point at a readable line of a file in the scan root counts as unreadable", async () => {
  const dir = await scanDir({ "a/SKILL.md": "one line\n" });
  const file = `${dir}/a/SKILL.md`;
  const row = (p: string, rule: string): string => `<f p="${p}" rule="${rule}" sev="critical"/>`;
  const rows = [
    row(file, "no-colon"),
    row("a/SKILL.md:1", "relative"),
    row(`${file}:abc`, "not-a-number"),
    row(`${file}:0`, "line-zero"),
    row(`${file}:99`, "past-the-end"),
    row("/etc/passwd:1", "outside"),
    row(`${dir}:1`, "the-root-itself"),
    row(`${dir}/..:1`, "the-parent"),
    row(`${dir}/gone.md:1`, "missing-file"),
    // eleven more distinct rules, all readable: more than 10 rules shows an ellipsis
    ...Array.from({ length: 11 }, (_, i) => row(`${file}:1`, `readable-${String(i).padStart(2, "0")}`)),
  ];
  const total = rows.length;
  const bin = await scriptedRipwire({
    code: 2,
    stdout: xml(`files="1" findings="${total}" skipped="0" verdict="critical"`, rows.join("")),
  });
  const clean = await scanDir({ "a/SKILL.md": "x\n" });
  await assert.rejects(
    withScripted(bin, () => scanWithRipwire(dir, opts([], { baselineDir: clean }))),
    (err: unknown) => {
      const m = err instanceof MargraveError ? err.message : "";
      return (
        m.includes(`${total} finding(s)`) &&
        m.includes("new findings:\n") &&
        m.includes("    /etc/passwd:1  outside  critical (unreadable)\n") &&
        m.includes("    a/SKILL.md:NaN  not-a-number  critical (unreadable)\n") &&
        m.includes("    a/SKILL.md:0  line-zero  critical (unreadable)\n") &&
        m.includes("    a/SKILL.md:99  past-the-end  critical (unreadable)\n") &&
        m.includes("    a/SKILL.md:1  relative  critical (unreadable)\n") &&
        m.includes("    a/SKILL.md:0  no-colon  critical (unreadable)\n") &&
        m.includes(`    ${dir}:1  the-root-itself  critical (unreadable)\n`) &&
        m.includes(`    ${dir}/..:1  the-parent  critical (unreadable)\n`) &&
        m.includes("    gone.md:1  missing-file  critical (unreadable)\n") &&
        m.includes(" · …\n")
      );
    },
  );
});

// The fake ripwire reports only regular files and symlinks, so this ripwire also reports a FIFO: a row for a/SKILL.md, and one for a/pipe.md when it exists.
const FIFO_RIPWIRE = String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then echo "ripwire @VERSION@ (fake)"; exit 0; fi
dir=
for a in "$@"; do
  case "$a" in --scan-skills=*) dir=$(printf '%s' "$a" | cut -c15-) ;; esac
done
n=1
rows="<f p=\"$dir/a/SKILL.md:1\" rule=\"INJECTION:eval\" sev=\"warn\"/>"
if [ -p "$dir/a/pipe.md" ]; then
  n=2
  rows="$rows<f p=\"$dir/a/pipe.md:1\" rule=\"INJECTION:eval\" sev=\"warn\"/>"
fi
printf '<skillscan files="1" findings="%s" skipped="0" verdict="warn">%s</skillscan>\n' "$n" "$rows"
exit 1
`;

test("baseline: a flagged FIFO is unreadable and counts as new, and does not block the read", { timeout: 10_000 }, async (t) => {
  const bin = await tmp("mg-fifo-ripwire-");
  await writeFile(path.join(bin, "ripwire"), FIFO_RIPWIRE.replace("@VERSION@", PINNED_RIPWIRE));
  await chmod(path.join(bin, "ripwire"), 0o755);
  const base = await scanDir({ "a/SKILL.md": "x\n" });
  const next = await scanDir({ "a/SKILL.md": "x\n" });
  const fifo = path.join(next, "a", "pipe.md");
  await mkfifo(fifo);
  t.after(() => releaseFifo(fifo));
  await assert.rejects(
    withScripted(bin, () => scanWithRipwire(next, opts([], { baselineDir: base }))),
    /refused: [\s\S]*a\/pipe\.md:1 {2}INJECTION:eval {2}warn \(unreadable\)/u,
  );
  // the same finding without the FIFO is known and proceeds
  const logs: string[] = [];
  const ok = await withScripted(bin, () => scanWithRipwire(base, opts(logs, { baselineDir: base })));
  assert.equal(ok.code, 1);
  assert.match(logs.join("\n"), /; 0 new vs installed copy/u);
});

test("more than 20 new findings are cut with a count, and so are more than 10 known groups in changed files", async () => {
  const e = await env();
  const files = (n: number, text: string): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`a/f${String(i).padStart(2, "0")}.md`, text]));

  const many = await scanDir(files(21, "x FAKE-CRIT EXFILTRATE:net-exfil\n"));
  const clean = await scanDir({ "a/x.md": "x\n" });
  await assert.rejects(
    e.run(() => scanWithRipwire(many, opts([], { baselineDir: clean }))),
    /new findings:\n(?: {4}a\/f\d\d\.md:1 {2}EXFILTRATE:net-exfil {2}critical\n){20} {4}… 1 more\n/u,
  );

  // The same warn finding in 11 files, each file changed since the installed copy: all known, 11 groups.
  const base = await scanDir(files(11, "x FAKE-WARN INJECTION:eval\n"));
  const next = await scanDir(files(11, "intro\nx FAKE-WARN INJECTION:eval\n"));
  const logs: string[] = [];
  const r = await e.run(() => scanWithRipwire(next, opts(logs, { baselineDir: base })));
  assert.equal(r.code, 1);
  assert.match(logs.join("\n"), /; 0 new vs installed copy/u);
  assert.match(logs.join("\n"), /known findings in changed files:\n(?: {4}a\/f\d\d\.md · INJECTION:eval · 1\n){10} {4}… 1 more\n/u);
});

test("scripted findings retain only safely readable lines and cache each path", async (t) => {
  const dir = await realpath(
    await scanDir({ "a/text": "  first  \n\nlast", "a/terminated": "end\n", "a/close": "close\n", "a/bad": "x", "a/dir/child": "x" }),
  );
  await writeFile(path.join(dir, "a/bad"), Buffer.from([0xff]));
  await symlink("dir", path.join(dir, "a/link"));
  const entries = [
    ["a/text:1", "first"],
    ["a/text:1", "first"],
    ["a/text:2", "blank"],
    ["a/text:3", "last"],
    ["a/text:4", "past"],
    ["a/terminated:2", "terminal"],
    ["a/text:0", "zero"],
    ["a/text:1.5", "fraction"],
    ["a/bad:1", "bad"],
    ["a/link/child:1", "link"],
    ["a/dir:1", "directory"],
    ["a/close:1", "close"],
  ];
  const rows =
    entries.map(([p, rule]) => `<f p="${dir}/${p}" rule="${rule}" sev="warn"/>`).join("") + '<f p=":1" rule="empty" sev="warn"/>';
  const bin = await scriptedRipwire({ code: 1, stdout: xml(`files="6" findings="13" skipped="0" verdict="warn"`, rows) });
  const originalOpen = fsp.open;
  const opens = new Map<string, number>();
  let directoryReads = 0;
  t.mock.method(
    fsp,
    "open",
    async (file: Parameters<typeof fsp.open>[0], flags: Parameters<typeof fsp.open>[1], mode?: Parameters<typeof fsp.open>[2]) => {
      const name = String(file);
      if (name.startsWith(dir + path.sep)) opens.set(name, (opens.get(name) ?? 0) + 1);
      const handle = await originalOpen(file, flags, mode);
      if (name === path.join(dir, "a/dir")) {
        const read = handle.readFile.bind(handle);
        t.mock.method(handle, "readFile", async () => {
          directoryReads++;
          return read();
        });
      }
      if (name === path.join(dir, "a/close")) {
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          await close();
          throw new Error("close failed");
        });
      }
      return handle;
    },
  );
  syncBuiltinESMExports();
  try {
    const logs: string[] = [];
    const result = await withScripted(bin, () =>
      scan(dir, {
        ...opts(logs),
        baseline: { code: 0, overridden: false, version: null, verdict: "clean", keys: [], files: [], tree: "tree" },
        allowUnsafe: true,
      }),
    );
    const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
    assert.deepEqual(result.keys, [
      [JSON.stringify(["a/text", "first", "warn", hash("first")]), 2],
      [JSON.stringify(["a/text", "blank", "warn", hash("")]), 1],
      [JSON.stringify(["a/text", "last", "warn", hash("last")]), 1],
    ]);
    assert.deepEqual(result.files, [["a/text", hash("  first  \n\nlast")]]);
    for (const fragment of [
      "a/text:4  past",
      "a/terminated:2  terminal",
      "a/text:0  zero",
      "a/text:1.5  fraction",
      "a/bad:1  bad",
      "a/link/child:1  link",
      "a/dir:1  directory",
      "a/close:1  close",
      ":1  empty",
    ]) {
      assert.ok(logs.join("\n").includes(`\n    ${fragment}  warn (unreadable)\n`), fragment);
    }
    assert.deepEqual([...opens.values()], [1, 1, 1, 1, 1, 1]);
    assert.equal(directoryReads, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("inventory hashes sorted paths, file bytes, directories, and relative links", async (t) => {
  const dir = await realpath(await scanDir({ z: "last", a: "first", "nested/data": "placeholder" }));
  await writeFile(path.join(dir, "nested/data"), Buffer.from([0, 255, 42]));
  await symlink("../a", path.join(dir, "nested/link"));
  const originalReadDir = fsp.readdir;
  const originalOpen = fsp.open;
  const streams: unknown[] = [];
  const closed = new Set<string>();
  t.mock.method(fsp, "readdir", async (p: Parameters<typeof fsp.readdir>[0]) =>
    (await originalReadDir(p, { withFileTypes: true })).reverse(),
  );
  t.mock.method(
    fsp,
    "open",
    async (file: Parameters<typeof fsp.open>[0], flags: Parameters<typeof fsp.open>[1], mode?: Parameters<typeof fsp.open>[2]) => {
      const handle = await originalOpen(file, flags, mode);
      const stream = handle.createReadStream.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(handle, "createReadStream", (options: Parameters<typeof stream>[0]) => {
        streams.push(options);
        return stream(options);
      });
      t.mock.method(handle, "close", async () => {
        closed.add(String(file));
        await close();
      });
      return handle;
    },
  );
  syncBuiltinESMExports();
  try {
    const hash = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
    const tuples = [
      ["a", "file", hash("first")],
      ["nested", "dir"],
      ["nested/data", "file", hash(Buffer.from([0, 255, 42]))],
      ["nested/link", "link", "../a"],
      ["z", "file", hash("last")],
    ];
    assert.equal(await scanInventory(dir), hash(tuples.map((tuple) => JSON.stringify(tuple)).join("")));
    assert.deepEqual(streams, [{ autoClose: false }, { autoClose: false }, { autoClose: false }]);
    assert.deepEqual(closed, new Set([path.join(dir, "a"), path.join(dir, "nested/data"), path.join(dir, "z")]));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("inventory rejects a file replaced by a directory before opening", async (t) => {
  const dir = await scanDir({ file: "data" });
  const originalOpen = fsp.open;
  t.mock.method(fsp, "open", async (file: Parameters<typeof fsp.open>[0], flags: Parameters<typeof fsp.open>[1]) => {
    await fsp.unlink(file);
    await fsp.mkdir(file);
    return originalOpen(file, flags);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(scanInventory(dir), /staged skills changed during scan/u);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("scan failures preserve exact details and write malformed XML", async () => {
  const dir = await scanDir({ "a/file": "x" });
  const suffix = "\nre-run with --allow-unsafe to override for this one command";
  const gone = path.join(dir, "missing");
  const empty = await scriptedRipwire({ code: 3 });
  const noScanner = await tmp("mg-emptybin-");
  const missingVendor = path.join(noScanner, "missing-vendor");
  await assert.rejects(
    withScripted(empty, () => withPath(noScanner, () => scan(dir, opts([], { vendored: missingVendor })))),
    { message: `refused: ripwire was not found on PATH or at ${missingVendor}${suffix}` },
  );
  await assert.rejects(
    withScripted(empty, () => scan(dir + "/missing", opts([]))),
    { message: `refused: cannot resolve the scan root ${gone}${suffix}` },
  );
  await assert.rejects(
    withScripted(empty, () => scan(dir, opts([]))),
    { message: `refused: ripwire could not read the files (exit 3)${suffix}` },
  );
  const fallback = await scriptedRipwire({ code: 3, stderr: "  \n", stdout: "  stdout detail  \n" });
  await assert.rejects(
    withScripted(fallback, () => scan(dir, opts([]))),
    { message: `refused: ripwire could not read the files (exit 3)\nstdout detail${suffix}` },
  );
  const precedence = await scriptedRipwire({ code: 3, stderr: " stderr detail \n", stdout: "stdout detail" });
  await assert.rejects(
    withScripted(precedence, () => scan(dir, opts([]))),
    { message: `refused: ripwire could not read the files (exit 3)\nstderr detail${suffix}` },
  );
  const malformed = "<skillscan broken";
  const bad = await scriptedRipwire({ code: 1, stdout: malformed });
  await withScripted(bad, async () => {
    await assert.rejects(scan(dir, opts([])));
    assert.equal(await readFile(path.join(process.env["MARGRAVE_HOME"]!, "reports/src.xml"), "utf8"), malformed);
  });
  const unavailable = path.join(await tmp(), "ripwire");
  await writeFile(unavailable, "#!/no/such/interpreter\n");
  await chmod(unavailable, 0o755);
  await stamp(unavailable);
  const logs: string[] = [];
  const result = await withScripted(empty, () => scan(dir, { ...opts(logs, { vendored: unavailable }), allowUnsafe: true }));
  assert.equal(result.code, null);
  assert.equal(result.overridden, true);
});

test("detail limits are exclusive at forty lines and five hundred characters", async () => {
  const dir = await scanDir({ x: "x" });
  const detail = ["x".repeat(500), ...Array.from({ length: 39 }, (_, i) => `line ${i + 2}`)].join("\n");
  const bin = await scriptedRipwire({ code: 4, stderr: detail });
  await assert.rejects(
    withScripted(bin, () => scan(dir, opts([]))),
    { message: `refused: ripwire failed (exit 4)\n${detail}\nre-run with --allow-unsafe to override for this one command` },
  );
});

test("accepted baseline warnings and summary rankings retain exact boundaries", async () => {
  const e = await env();
  const files = (n: number, text: string): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`a/f${String(i).padStart(2, "0")}.md`, text]));
  const base = await scanDir(files(10, "x FAKE-WARN R:known\n"));
  const changed = await scanDir(files(10, "intro\nx FAKE-WARN R:known\n"));
  const logs: string[] = [];
  await e.run(() => scanWithRipwire(changed, opts(logs, { baselineDir: base })));
  assert.match(logs.join("\n"), /known findings in changed files:\n(?: {4}a\/f\d\d\.md · R:known · 1\n){10}  full report:/u);
  assert.doesNotMatch(logs.join("\n"), /new findings:|…/u);
  const twenty = await scanDir(files(20, "x FAKE-WARN R:new\n"));
  const freshLogs: string[] = [];
  await e.run(() => scanWithRipwire(twenty, opts(freshLogs, { baselineDir: base })));
  assert.match(freshLogs.join("\n"), /new findings:\n(?: {4}a\/f\d\d\.md:1 {2}R:new {2}warn\n){20}  full report:/u);
  assert.doesNotMatch(freshLogs.join("\n"), /known findings in changed files:|…/u);
  const noTreeLogs: string[] = [];
  const baseline = await e.run(() => scan(base, { ...opts([]), verifyContent: true }));
  await e.run(() => scan(changed, { ...opts(noTreeLogs), baseline: { ...baseline, tree: null } }));
  assert.equal(noTreeLogs[0], "scan: no accepted baseline. Applying install rules");
  assert.doesNotMatch(noTreeLogs.join("\n"), /new vs installed copy/u);
});

test("summary ranks mixed rules and escaped skill names by count and name", async () => {
  const dir = await realpath(await scanDir({ "a/file": "one\n", "b/file": "two\n", outside: "three\n" }));
  const rows = [
    `<f p="${dir}/b/file:1" rule="Z" sev="warn"/>`,
    `<f p="${dir}/a/file:1" rule="A" sev="critical"/>`,
    `<f p="${dir}/a/file:1" rule="A" sev="warn"/>`,
    `<f p="${dir}/outside:1" rule="B" sev="warn"/>`,
    ...Array.from({ length: 8 }, (_, i) => `<f p="${dir}/b/file:1" rule="R${i}" sev="warn"/>`),
  ];
  const bin = await scriptedRipwire({ code: 2, stdout: xml(`files="3" findings="12" skipped="0" verdict="critical"`, rows.join("")) });
  const logs: string[] = [];
  await withScripted(bin, () =>
    scan(dir, {
      ...opts(logs),
      allowUnsafe: true,
      skills: [
        { name: "z\nname", dir: path.join(dir, "b") },
        { name: "a", dir: path.join(dir, "a") },
      ],
    }),
  );
  const output = logs.join("\n");
  assert.match(output, /12 finding\(s\) \(1 critical, 11 warn\) in 2 skill\(s\)/u);
  assert.ok(output.includes("  by rule:   A 2 · B 1 · R0 1 · R1 1 · R2 1 · R3 1 · R4 1 · R5 1 · R6 1 · R7 1 · …\n"));
  assert.ok(output.includes("  top skills: z\\x0aname 9 · a 2 · (outside skills) 1\n"));
  const tenRows = rows.slice(0, -1);
  const ten = await scriptedRipwire({ code: 2, stdout: xml(`files="3" findings="11" skipped="0" verdict="critical"`, tenRows.join("")) });
  const tenLogs: string[] = [];
  await withScripted(ten, () => scan(dir, { ...opts(tenLogs), allowUnsafe: true }));
  assert.ok(tenLogs.join("\n").includes("  by rule:   A 2 · B 1 · R0 1 · R1 1 · R2 1 · R3 1 · R4 1 · R5 1 · R6 1 · Z 1\n"));
});

test("top skills shows ten ranked names and omits the eleventh", async () => {
  const names = Array.from({ length: 11 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  const dir = await realpath(await scanDir(Object.fromEntries(names.map((name) => [`${name}/file`, "x\n"]))));
  const rows = [...names].reverse().map((name) => `<f p="${dir}/${name}/file:1" rule="R" sev="warn"/>`);
  const bin = await scriptedRipwire({ code: 1, stdout: xml(`files="11" findings="11" skipped="0" verdict="warn"`, rows.join("")) });
  const logs: string[] = [];
  await withScripted(bin, () => scan(dir, { ...opts(logs), skills: names.map((name) => ({ name, dir: path.join(dir, name) })) }));
  assert.ok(
    logs.join("\n").includes(
      `  top skills: ${names
        .slice(0, 10)
        .map((name) => `${name} 1`)
        .join(" · ")}\n`,
    ),
  );
  assert.doesNotMatch(logs.join("\n"), /s10 1/u);
});
