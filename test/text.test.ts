import assert from "node:assert/strict";
import test from "node:test";
import { clean, cleanBlock, formatFind, formatLoad, shellQuote } from "../src/skills.ts";
import type { LoadResult } from "../src/skills.ts";

test("clean strips ANSI escapes and C0/C1 control characters", () => {
  assert.equal(clean("\u001b[31mred\u001b[0m text"), "red text");
  assert.equal(clean("a\u0000b\u0007c\u007fd\u0085e\u009bf"), "abcdef");
  assert.equal(clean("title\u001b]0;evil\u0007 end"), "title end");
  assert.equal(clean("line1\nline2\tx\r"), "line1 line2 x");
  assert.equal(clean("plain ünïcode ✓"), "plain ünïcode ✓");
});

test("cleanBlock keeps newlines and tabs", () => {
  assert.equal(cleanBlock("a: \u001b[1mb\u001b[0m\n\tc\u0007"), "a: b\n\tc");
});

test("find output is cleaned", () => {
  const text = formatFind([{ id: "s/\u001b[31mx\u001b[0m", name: "x", description: "bad \u0007desc\u001b[2J", score: 1.5 }]);
  // oxlint-disable-next-line no-control-regex -- intentional: the test looks for control characters
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text.replace(/\n/gu, "")), false);
  assert.match(text, /^1\. s\/x {2}\(score 1\.500\)\n {3}bad desc\nload: margrave load s\/x$/u);
});

test("find with no hits says no match and suggests list --skills", () => {
  assert.match(formatFind([]), /^no match\n.*margrave list --skills/u);
});

test("load cleans the header but never changes the body", () => {
  const body = "# Title\n\u001b[31mcolored\u001b[0m \u0007 bell\n";
  const r: LoadResult = {
    id: "s/\u001b[31mname",
    source: "s",
    spec: "o/r",
    commit: "abc123",
    base: "/base/dir",
    frontmatter: "name: x\ndescription: \u001b[31mevil\u001b[0m",
    files: ["SKILL.md", "ref\u0007.md"],
    body,
  };
  const text = formatLoad(r);
  assert.ok(text.endsWith(`body:\n${body}`), "body is byte-for-byte unchanged");
  const header = text.slice(0, text.length - body.length);
  // oxlint-disable-next-line no-control-regex -- intentional: the test looks for control characters
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(header.replace(/\n/gu, "")), false);
  assert.match(header, /^skill: s\/name\nsource: s \(o\/r\)\ncommit: abc123\nbase: \/base\/dir\nfrontmatter:\n---\nname: x\n/u);
  assert.match(header, /files:\n- SKILL\.md\n- ref\.md\nbody:\n$/u);
});

test("shellQuote leaves safe text alone and quotes the rest", () => {
  assert.equal(shellQuote("/usr/bin/node"), "/usr/bin/node");
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("load omits the spec in parentheses when there is none, and caps the file list at 200", () => {
  const r: LoadResult = {
    id: "s/big",
    source: "s",
    spec: "",
    commit: null,
    base: "/base",
    frontmatter: "name: big",
    files: Array.from({ length: 205 }, (_, i) => `f${String(i).padStart(3, "0")}.md`),
    body: "text\n",
  };
  const text = formatLoad(r);
  assert.match(text, /^skill: s\/big\nsource: s\ncommit: none \(local directory\)\n/u);
  assert.ok(text.includes("- f199.md\n- ... 5 more\nbody:\n"));
  assert.ok(!text.includes("f200.md"));
});
