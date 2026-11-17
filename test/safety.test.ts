import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { esc, parseScanXml, runRipwire, scanWithRipwire } from "../src/safety.ts";
import { MargraveError } from "../src/store.ts";
import { fakeRipwire, tmp } from "./helpers.ts";

// ---- parser ----

const xml = (attrs: string, rows: string): string => `<skillscan ${attrs}>${rows}</skillscan>`;

test("parser reads attributes in any order and unescapes named and numeric entities", () => {
  const out = parseScanXml(
    xml(
      'verdict="critical" findings="2" files="3"',
      '<f sev="critical" rule="A:b" p="/r/a &amp; b &lt;x&gt; &quot;q&quot; &apos;s&apos;.md:7"/>' +
        '<f p="/r/&#65;&#x42;.md:9" sev="warn" rule="C:d"/>',
    ),
    2,
  );
  assert.ok(out.ok);
  assert.deepEqual(out.rows, [
    { p: `/r/a & b <x> "q" 's'.md:7`, rule: "A:b", sev: "critical" },
    { p: "/r/AB.md:9", rule: "C:d", sev: "warn" },
  ]);
});

test("parser unescapes once: &amp;quot; stays the text &quot;", () => {
  const out = parseScanXml(xml('findings="1" verdict="warn"', '<f p="/r/&amp;quot;.md:1" rule="R" sev="warn"/>'), 1);
  assert.ok(out.ok);
  assert.equal(out.rows[0]?.p, "/r/&quot;.md:1");
});

test("parser keeps a ':' in the path (the line is after the last ':')", () => {
  const out = parseScanXml(xml('findings="1" verdict="warn"', '<f p="/r/a:b:c.md:12" rule="R" sev="warn"/>'), 1);
  assert.ok(out.ok);
  assert.equal(out.rows[0]?.p, "/r/a:b:c.md:12");
});

test("parser treats warn as warn and every other severity as critical", () => {
  const out = parseScanXml(
    xml(
      'findings="4" verdict="critical"',
      ["warn", "high", "error", "whatever"].map((s) => `<f p="/r/a.md:1" rule="R" sev="${s}"/>`).join(""),
    ),
    2,
  );
  assert.ok(out.ok);
  assert.deepEqual(
    out.rows.map((r) => r.sev),
    ["warn", "critical", "critical", "critical"],
  );
});

test("parser fails closed: no root, count mismatch, CRITICAL without a critical row, WARN without a row", () => {
  const row = '<f p="/r/a.md:1" rule="R" sev="warn"/>';
  const cases: [string, number, RegExp][] = [
    ["no xml at all", 2, /no <skillscan>/u],
    [xml('findings="2" verdict="warn"', row), 1, /declared findings="2" but 1/u],
    [xml('verdict="warn"', row), 1, /declared findings=""/u],
    [xml('findings="1" verdict="warn"', row), 2, /no critical finding row/u],
    [xml('findings="1" verdict="critical"', row), 1, /no critical finding row/u],
    [xml('findings="0" verdict="warn"', ""), 1, /no finding row/u],
  ];
  for (const [input, code, re] of cases) {
    const out = parseScanXml(input, code);
    assert.equal(out.ok, false, input);
    assert.ok(!out.ok && re.test(out.reason), `${input} -> ${out.ok ? "ok" : out.reason}`);
  }
  // the other direction: complete output parses
  assert.ok(parseScanXml(xml('findings="1" verdict="warn"', row), 1).ok);
  assert.ok(parseScanXml('<skillscan files="1" findings="0" verdict="clean"/>', 0).ok);
});

test("esc shows control characters and DEL as \\xNN and leaves other text alone", () => {
  assert.equal(esc("a\u001b[31mb\u007f\u0085\nc é"), "a\\x1b[31mb\\x7f\\x85\\x0ac é");
});

// ---- scanWithRipwire (install mode: no baseline) ----

async function env(): Promise<{ bin: string; run: <T>(fn: () => Promise<T>, extra?: Record<string, string>) => Promise<T> }> {
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

async function scanDir(lines: Record<string, string>): Promise<string> {
  const dir = await tmp("mg-scan-");
  for (const [rel, text] of Object.entries(lines)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

// No vendored ripwire for these tests: a developer's real vendor/ripwire must not change what they check.
const NO_VENDOR = path.join(tmpdir(), "mg-no-vendored-ripwire", "ripwire");

const opts = (logs: string[], over: { allowUnsafe?: boolean; baselineDir?: string | null; vendored?: string } = {}) => ({
  allowUnsafe: over.allowUnsafe ?? false,
  vendored: over.vendored ?? NO_VENDOR,
  log: (m: string) => logs.push(m),
  sourceId: "src",
  skills: [] as { name: string; dir: string }[],
  ...(over.baselineDir === undefined ? {} : { baselineDir: over.baselineDir }),
});

test("clean scan continues without logging and writes no report", async () => {
  const e = await env();
  const dir = await scanDir({ "a/SKILL.md": "nothing here\n" });
  const logs: string[] = [];
  const r = await e.run(() => scanWithRipwire(dir, opts(logs)));
  assert.deepEqual(r, { code: 0, overridden: false });
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

// ---- ripwire lookup: PATH first, vendored binary second ----

/** A ripwire stand-in that exits 3 and names itself on stderr, so a test can tell which binary ran. */
async function namedRipwire(name: string): Promise<string> {
  const dir = await tmp("mg-named-");
  const file = path.join(dir, "ripwire");
  await writeFile(file, `#!/bin/sh\necho ${name} >&2\nexit 3\n`);
  await chmod(file, 0o755);
  return file;
}

async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["PATH"];
  process.env["PATH"] = value;
  try {
    return await fn();
  } finally {
    process.env["PATH"] = prev;
  }
}

test("ripwire on PATH wins over the vendored binary", async () => {
  const onPath = path.dirname(await namedRipwire("from-path"));
  const vendored = await namedRipwire("from-vendor");
  const r = await withPath(onPath, () => runRipwire("/nonexistent", vendored));
  assert.equal(r.missing, false);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /from-path/u);
});

test("the vendored binary runs when PATH has no ripwire", async () => {
  const vendored = await namedRipwire("from-vendor");
  const r = await withPath(await tmp("mg-emptybin-"), () => runRipwire("/nonexistent", vendored));
  assert.equal(r.missing, false);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /from-vendor/u);
});

test("ripwire is missing only when PATH and the vendored path both lack it", async () => {
  const none = path.join(await tmp("mg-novendor-"), "ripwire");
  const r = await withPath(await tmp("mg-emptybin-"), () => runRipwire("/nonexistent", none));
  assert.equal(r.missing, true);
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

test("scanWithRipwire scans with the vendored binary when PATH has no ripwire", async () => {
  const empty = await tmp("mg-emptybin-");
  const home = await tmp("mg-home-");
  const vendored = path.join(await fakeRipwire(), "ripwire");
  const prevHome = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = home;
  try {
    const r = await withPath(empty, () => scanWithRipwire(empty, opts([], { vendored })));
    assert.equal(r.code, 0);
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
  assert.equal(logs[0], "scan: no baseline (the installed copy is missing); every finding counts as new");
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
});

// ---- a scripted ripwire: fixed stdout, stderr, and exit code ----

/** A directory with a `ripwire` that prints the given text and exits as told, or kills itself with a signal. */
async function scriptedRipwire(spec: { code?: number; stdout?: string; stderr?: string; signal?: boolean }): Promise<string> {
  const dir = await tmp("mg-scripted-");
  await writeFile(path.join(dir, "out.txt"), spec.stdout ?? "");
  await writeFile(path.join(dir, "err.txt"), spec.stderr ?? "");
  const tail = spec.signal === true ? "kill -TERM $$" : `exit ${spec.code ?? 0}`;
  const file = path.join(dir, "ripwire");
  await writeFile(file, `#!/bin/sh\nd=$(dirname "$0")\ncat "$d/err.txt" >&2\ncat "$d/out.txt"\n${tail}\n`);
  await chmod(file, 0o755);
  return dir;
}

/** Run `fn` with the scripted ripwire first on PATH and a fresh MARGRAVE_HOME. */
async function withScripted<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prevHome = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = await tmp("mg-home-");
  try {
    return await withPath(`${bin}:${process.env["PATH"] ?? ""}`, fn);
  } finally {
    if (prevHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prevHome;
  }
}

test("parser reads single-quoted attributes and leaves a code point that does not exist as written", () => {
  const out = parseScanXml(xml("findings='1' verdict='warn'", `<f p='/r/a&#1114112;&#x110000;.md:1' rule='R' sev='warn'/>`), 1);
  assert.ok(out.ok);
  assert.equal(out.rows[0]?.p, "/r/a&#1114112;&#x110000;.md:1");
  assert.equal(out.rows[0]?.sev, "warn");
});

test("a ripwire killed by a signal has no exit code and refuses", async () => {
  const bin = await scriptedRipwire({ signal: true });
  const r = await withPath(`${bin}:${process.env["PATH"] ?? ""}`, () => runRipwire("/nonexistent", NO_VENDOR));
  assert.equal(r.code, null);
  assert.equal(r.missing, false);
  const dir = await scanDir({ "a/SKILL.md": "x\n" });
  await assert.rejects(
    withScripted(bin, () => scanWithRipwire(dir, opts([]))),
    /refused: ripwire failed \(exit null\)/u,
  );
});

test("a scan root that cannot be resolved refuses, and --allow-unsafe overrides", async () => {
  const gone = path.join(await tmp(), "does-not-exist");
  const bin = await scriptedRipwire({});
  await assert.rejects(
    withScripted(bin, () => scanWithRipwire(gone, opts([]))),
    /refused: cannot resolve the scan root/u,
  );
  const logs: string[] = [];
  const r = await withScripted(bin, () => scanWithRipwire(gone, opts(logs, { allowUnsafe: true })));
  assert.deepEqual(r, { code: null, overridden: true });
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

test("a finding row without p or rule attributes parses with empty strings", () => {
  const out = parseScanXml(xml('findings="1" verdict="warn"', '<f sev="warn"/>'), 1);
  assert.ok(out.ok);
  assert.deepEqual(out.rows, [{ p: "", rule: "", sev: "warn" }]);
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
