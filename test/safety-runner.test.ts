import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PINNED_RIPWIRE, esc } from "../src/safety-runner.ts";
import { VERSION_TIMEOUT_MS, parseScanXml, runRipwire } from "../src/safety.ts";
import { MargraveError } from "../src/store.ts";
import {
  ROOT,
  NO_VENDOR,
  calls,
  opts,
  scanDir,
  scanWithRipwire,
  scriptedRipwire,
  stamp,
  standIn,
  tmp,
  withPath,
  withScripted,
  xml,
} from "./helpers.ts";

export const ENSURE = path.join(ROOT, "scripts", "ensure-ripwire.mjs");

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

test("parser accepts whitespace before equals and uses the first root and finding rows", () => {
  const input = `<unrelated findings="99"/><skillscan findings ="1" verdict\t= 'warn'><unrelated p="ignored"/><f p ="/r/a.md:1" rule\t= 'R' sev ="warn"/></skillscan><skillscan findings="0" verdict="critical"/>`;
  assert.deepEqual(parseScanXml(input, 1), { ok: true, rows: [{ p: "/r/a.md:1", rule: "R", sev: "warn" }] });
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
    assert.deepEqual(
      r,
      {
        code: null,
        stdout: "",
        stderr: "",
        missing: false,
        refusal: `vendored ripwire at ${vendored} is ${label}, not the pinned ${PINNED_RIPWIRE}; run: node ${ENSURE}`,
      },
      label,
    );
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
  assert.deepEqual(r, { code: "ENOENT", stdout: "", stderr: "", missing: true });
});

test("a successful scan returns complete distinct output beyond the default buffer", async () => {
  const stdout = `scan:${"x".repeat(1024 * 1024 + 100)}`;
  const stderr = "scan warning";
  const bin = await scriptedRipwire({ stdout, stderr });
  const r = await withScripted(bin, () => runRipwire("/nonexistent", NO_VENDOR));
  assert.deepEqual(r, { code: 0, stdout, stderr, missing: false, version: PINNED_RIPWIRE });
});

test("a PATH binary removed after its version reports the scan as missing", async () => {
  const bin = await tmp("mg-vanishing-");
  const executable = path.join(bin, "ripwire");
  await writeFile(executable, `#!/bin/sh\n/bin/mv "$0" "$0.moved"\nprintf 'ripwire ${PINNED_RIPWIRE}\\n'\n`);
  await chmod(executable, 0o755);
  const r = await withPath(bin, () => runRipwire("/nonexistent", NO_VENDOR));
  assert.deepEqual(r, { code: "ENOENT", stdout: "", stderr: "", missing: true, version: PINNED_RIPWIRE });
});

test("an invalid scan path rejects with the spawn argument error", async () => {
  const bin = await scriptedRipwire({});
  await assert.rejects(
    withScripted(bin, () => runRipwire("/synthetic/\0path", NO_VENDOR)),
    { code: "ERR_INVALID_ARG_VALUE" },
  );
});

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
  await writeFile(slow, '#!/bin/sh\n[ "$*" = "--version" ] || exit 2\nexec /bin/sleep 1\n');
  const started = Date.now();
  const r = await withPath(path.dirname(slow), () => runRipwire("/nonexistent", NO_VENDOR, 200));
  assert.ok(Date.now() - started < 10_000);
  assert.ok(r.refusal?.startsWith("ripwire on PATH could not report its version (timed out); run: node ") === true, String(r.refusal));
  assert.equal(r.code, null);
  assert.equal(r.missing, false);
});

test("a ripwire on PATH at the pinned version or newer is accepted and runs the scan", async () => {
  for (const ok of [PINNED_RIPWIRE, "0.6.11", "0.7.0", "0.10.0", "1.0.0"]) {
    const onPath = await standIn("from-path", `ripwire ${ok} (fake)`);
    const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", NO_VENDOR));
    assert.equal(r.refusal, undefined, ok);
    assert.equal(r.code, 3, ok);
    assert.match(r.stderr, /from-path/u, ok);
  }
  const onPath = await standIn("from-path", "ripwire 12.0.0");
  const r = await withPath(path.dirname(onPath), () => runRipwire("/nonexistent", NO_VENDOR));
  assert.equal(r.version, "12.0.0");
  assert.equal(r.code, 3);
});

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

test("a finding row without p or rule attributes parses with empty strings", () => {
  const out = parseScanXml(xml('findings="1" verdict="warn"', '<f sev="warn"/>'), 1);
  assert.ok(out.ok);
  assert.deepEqual(out.rows, [{ p: "", rule: "", sev: "warn" }]);
});
