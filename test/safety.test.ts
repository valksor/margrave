import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PINNED_RIPWIRE, VERSION_TIMEOUT_MS, esc, parseScanXml, runRipwire, scanWithRipwire } from "../src/safety.ts";
import { MargraveError } from "../src/store.ts";
import { ROOT, fakeRipwire, mkfifo, releaseFifo, tmp } from "./helpers.ts";

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

// ---- ripwire lookup: the vendored binary first, PATH second ----

/**
 * A ripwire stand-in. `--version` prints `versionLine` and exits `versionExit`. A scan exits 3 and names itself on stderr,
 * so a test can tell which binary ran. Every call is appended to `<file>.calls`.
 */
async function standIn(name: string, versionLine: string = `ripwire ${PINNED_RIPWIRE} (fake)`, versionExit = 0): Promise<string> {
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
async function stamp(binary: string, text: string = PINNED_RIPWIRE): Promise<string> {
  await writeFile(path.join(path.dirname(binary), "VERSION"), `${text}\n`);
  return binary;
}

/** The arguments of every call that a stand-in got, or [] when it never ran. */
async function calls(file: string): Promise<string[]> {
  try {
    return (await readFile(`${file}.calls`, "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

const ENSURE = path.join(ROOT, "scripts", "ensure-ripwire.mjs");

async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["PATH"];
  process.env["PATH"] = value;
  try {
    return await fn();
  } finally {
    process.env["PATH"] = prev;
  }
}

test("the pinned ripwire version equals the VERSION in scripts/ensure-ripwire.mjs", async () => {
  const script = await readFile(path.join(ROOT, "scripts", "ensure-ripwire.mjs"), "utf8");
  assert.equal(/^const VERSION = "([^"]+)";$/mu.exec(script)?.[1], PINNED_RIPWIRE);
});

test("the vendored binary wins over PATH, and --version is never run for it", async () => {
  const onPath = await standIn("from-path");
  const vendored = await stamp(await standIn("from-vendor"));
  const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", vendored));
  assert.equal(r.missing, false);
  assert.equal(r.refusal, undefined);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /from-vendor/u);
  assert.deepEqual(await calls(vendored), ["security --scan-skills=/nonexistent"]);
  assert.deepEqual(await calls(onPath), []);
});

test("a vendored binary with a missing or wrong VERSION stamp is refused, and neither it nor PATH runs", async () => {
  for (const [label, text] of [
    ["unstamped", null],
    ["0.4.0", "0.4.0"],
    ["0.4\\x1b[2J", "0.4\u001b[2J"],
  ] as const) {
    const onPath = await standIn("from-path");
    const vendored = await standIn("from-vendor");
    if (text !== null) await stamp(vendored, text);
    const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", vendored));
    assert.equal(r.refusal, `vendored ripwire at ${vendored} is ${label}, not the pinned ${PINNED_RIPWIRE}; run: node ${ENSURE}`, label);
    assert.equal(r.code, null, label);
    assert.equal(r.missing, false, label);
    assert.deepEqual(await calls(vendored), [], label);
    assert.deepEqual(await calls(onPath), [], label);
  }
});

test("a vendored binary that cannot start fails as ripwire failed, not as not found", async () => {
  const vendored = await stamp(await standIn("from-vendor"));
  await writeFile(vendored, "#!/nonexistent/interpreter\n");
  const home = await tmp("mg-home-");
  const empty = await tmp("mg-emptybin-");
  const prevHome = process.env["MARGRAVE_HOME"];
  process.env["MARGRAVE_HOME"] = home;
  try {
    const r = await withPath(empty, () => runRipwire("/nonexistent", vendored));
    assert.equal(r.missing, false);
    await assert.rejects(
      withPath(empty, () => scanWithRipwire(empty, opts([], { vendored }))),
      (err: unknown) => err instanceof MargraveError && err.message.includes("ripwire failed") && !err.message.includes("not found"),
    );
  } finally {
    if (prevHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prevHome;
  }
});

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
        err instanceof MargraveError && err.message.startsWith(`refused: vendored ripwire at ${vendored} is 0.4.0, not the pinned `),
    );
    const r = await withPath(empty, () => scanWithRipwire(empty, opts([], { vendored, allowUnsafe: true })));
    assert.equal(r.overridden, true);
    assert.deepEqual(await calls(vendored), []);
  } finally {
    if (prevHome === undefined) delete process.env["MARGRAVE_HOME"];
    else process.env["MARGRAVE_HOME"] = prevHome;
  }
});

test("ripwire on PATH runs when there is no vendored binary, after its --version", async () => {
  const onPath = await standIn("from-path");
  const none = path.join(await tmp("mg-novendor-"), "ripwire");
  const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", none));
  assert.equal(r.missing, false);
  assert.equal(r.refusal, undefined);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /from-path/u);
  assert.deepEqual(await calls(onPath), ["--version", "security --scan-skills=/nonexistent"]);
});

test("ripwire is missing only when PATH and the vendored path both lack it", async () => {
  const none = path.join(await tmp("mg-novendor-"), "ripwire");
  const r = await withPath(await tmp("mg-emptybin-"), () => runRipwire("/nonexistent", none));
  assert.equal(r.missing, true);
  assert.equal(r.refusal, undefined);
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

test("a ripwire on PATH older than the pinned version is refused with the reason, and the scan does not run", async () => {
  for (const older of ["0.6.9", "0.5.99", "0.4.0", "0.0.1"]) {
    const onPath = await standIn("from-path", `ripwire ${older} (Release, built_from=abc)`);
    const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", NO_VENDOR));
    assert.equal(r.missing, false, older);
    assert.equal(r.code, null, older);
    assert.equal(
      r.refusal,
      `ripwire on PATH reports ${older}, older than the pinned ${PINNED_RIPWIRE}; run: node ${path.join(ROOT, "scripts", "ensure-ripwire.mjs")}, or update ripwire`,
    );
    assert.deepEqual(await calls(onPath), ["--version"], older);
  }
});

test("a ripwire on PATH with no parseable version is refused", async () => {
  const head = `ripwire on PATH reports no version, older than the pinned ${PINNED_RIPWIRE}; run: node `;
  const tail = "ensure-ripwire.mjs, or update ripwire";
  for (const line of ["ripwire dev build", "", "ripwire 1.2", "ripwire v0.7.0", "xripwire 0.7.0"]) {
    const onPath = await standIn("from-path", line);
    const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", NO_VENDOR));
    assert.ok(r.refusal?.startsWith(head) === true && r.refusal.endsWith(tail), `${line} -> ${r.refusal}`);
    assert.deepEqual(await calls(onPath), ["--version"], line);
  }
});

test("only the first line of --version counts, and only as `ripwire X.Y.Z`", async () => {
  const cases: [string, string][] = [
    ["wrapper 9.9.9 runs ripwire 0.4.0", "no version"],
    ["ripwire 0.4.0 (built with tool 9.9.9)", "0.4.0"],
    ["banner\nripwire 0.6.10", "no version"],
  ];
  for (const [text, shown] of cases) {
    const onPath = await standIn("from-path", text);
    const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", NO_VENDOR));
    assert.match(
      r.refusal ?? "",
      new RegExp(`^ripwire on PATH reports ${shown.replaceAll(".", "\\.")}, older than the pinned `, "u"),
      text,
    );
    assert.deepEqual(await calls(onPath), ["--version"], text);
  }
  const real = await standIn("from-path", "ripwire 0.6.10 (Release, AppleClang 21.0.0.21000101, emit=std::print, built_from=ac869640e)");
  const r = await withPath(path.dirname(real), () => runRipwire("/nonexistent", NO_VENDOR));
  assert.equal(r.refusal, undefined);
  assert.equal(r.code, 3);
});

test("a pre-release of the pinned version is older, and a pre-release of a newer version is not", async () => {
  for (const pre of [`${PINNED_RIPWIRE}-rc.1`, `${PINNED_RIPWIRE}-dev`]) {
    const onPath = await standIn("from-path", `ripwire ${pre} (fake)`);
    const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", NO_VENDOR));
    assert.ok(r.refusal?.startsWith(`ripwire on PATH reports ${pre}, older than the pinned ${PINNED_RIPWIRE}; run: node `), pre);
    assert.deepEqual(await calls(onPath), ["--version"], pre);
  }
  const newer = await standIn("from-path", "ripwire 0.7.0-rc.1 (fake)");
  const r = await withPath(path.dirname(newer), () => runRipwire("/nonexistent", NO_VENDOR));
  assert.equal(r.refusal, undefined);
  assert.equal(r.code, 3);
});

test("a --version that cannot run is refused with the cause", async () => {
  const head = (why: string): string => `ripwire on PATH could not report its version (${why}); run: node `;
  const tail = "ensure-ripwire.mjs, or update ripwire";
  const check = async (onPath: string, why: string, timeoutMs?: number): Promise<void> => {
    const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", NO_VENDOR, timeoutMs));
    assert.ok(r.refusal?.startsWith(head(why)) === true && r.refusal.endsWith(tail), `${why} -> ${r.refusal}`);
    assert.equal(r.missing, false, why);
    assert.equal(r.code, null, why);
  };

  const exits = await standIn("from-path", `ripwire ${PINNED_RIPWIRE}`, 1);
  await check(exits, "exit 1");
  assert.deepEqual(await calls(exits), ["--version"]);

  const noExec = await standIn("from-path");
  await chmod(noExec, 0o644);
  await check(noExec, "EACCES");

  const killed = await standIn("from-path");
  await writeFile(killed, "#!/bin/sh\nkill -9 $$\n");
  await check(killed, "SIGKILL");

  // More than Node's 1 MiB maxBuffer: execFile kills the child, which is not a timeout.
  const loud = await standIn("from-path");
  await writeFile(loud, "#!/bin/sh\nexec /usr/bin/head -c 2000000 /dev/zero\n");
  await check(loud, "output too large");
});

test("the --version time limit is 10 seconds by default", () => {
  assert.equal(VERSION_TIMEOUT_MS, 10_000);
});

test("a --version that hangs is killed at the time limit and refused", async () => {
  const slow = await standIn("from-path");
  // exec, so the SIGKILL at the time limit reaches the sleeping process itself.
  await writeFile(slow, `#!/bin/sh\necho "$*" >> "$0.calls"\nexec /bin/sleep 30\n`);
  const started = Date.now();
  const r = await withPath(path.dirname(slow), () => runRipwire("/nonexistent", NO_VENDOR, 200));
  assert.ok(Date.now() - started < 10_000);
  assert.ok(r.refusal?.startsWith("ripwire on PATH could not report its version (timed out); run: node ") === true, String(r.refusal));
  assert.deepEqual(await calls(slow), ["--version"]);
});

test("a ripwire on PATH at the pinned version or newer is accepted and runs the scan", async () => {
  for (const ok of [PINNED_RIPWIRE, "0.6.11", "0.7.0", "0.10.0", "1.0.0"]) {
    const onPath = await standIn("from-path", `ripwire ${ok} (fake)`);
    const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", NO_VENDOR));
    assert.equal(r.refusal, undefined, ok);
    assert.equal(r.code, 3, ok);
    assert.match(r.stderr, /from-path/u, ok);
  }
});

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

/** A directory with a `ripwire` that prints the given text and exits as told, or kills itself with a signal. `--version` prints the pinned version. */
async function scriptedRipwire(spec: { code?: number; stdout?: string; stderr?: string; signal?: boolean }): Promise<string> {
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
