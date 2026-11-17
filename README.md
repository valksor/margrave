# margrave

margrave keeps agent skills (folders with a `SKILL.md`) in one store. It does not install them into any agent. An agent asks for what it needs in plain words, gets ranked suggestions, and loads one skill from the store.

- `margrave find "<task>"` returns ranked skills.
- `margrave load <id>` prints one skill.
- `margrave mcp` runs a stdio MCP server with the same functions, for agents that use MCP.

Skills are not loaded into the agent by default, so 1000+ installed skills cost nothing per session.

## 1. Install margrave itself

Node 27 or newer. The repo pins `27.0.0-alpha.0.1.0` in `.nvmrc`. nvm hides alpha builds by default, so install it with `nvm install --only=alpha 27.0.0-alpha.0.1.0` before `nvm use`.

```sh
nvm use && pnpm install --frozen-lockfile && pnpm run build && pnpm add -g "$PWD"
```

`pnpm add -g` needs pnpm's global bin directory on `PATH`. If it is not there yet, run `pnpm setup` once and open a new shell.

## 2. Install a skill source

```sh
margrave install vercel-labs/agent-skills     # GitHub repo (skills.sh format)
margrave install ~/.agents/skills             # local directory
margrave install https://example.com/team/skills.git --ref v2
```

`install` prints the source id and the skill ids it found. Skills live in `~/.margrave` (set `MARGRAVE_HOME` to move it).

## 3. Connect an agent

`margrave wrap <agent>` prints setup text and writes nothing. It uses absolute paths (`process.execPath` and the absolute `dist/cli.js`), so the agent's own PATH and nvm state do not matter. It passes `MARGRAVE_HOME` when that is set.

```sh
margrave wrap claude    # a `claude mcp add` command, then the instruction snippet
margrave wrap codex     # a [mcp_servers.margrave] block for ~/.codex/config.toml, then the snippet
margrave wrap bb        # the claude command line, with a note that bb runs the provider's MCP config
margrave wrap generic   # the plain command line, then the snippet
```

Run the printed command yourself, and add the snippet to the agent's instructions.

## 4. Check it

```sh
margrave find "react performance"
margrave load <id from the result>
```

## Commands

| Command | What it does |
|---|---|
| `margrave install <spec> [--ref R] [--allow-unsafe]` | Add a source. A git source is cloned into staging, scanned, indexed, then moved into the store. Any failure leaves the store and `sources.json` unchanged. A source with 0 valid skills is a failure. An id that already exists is an error. `--ref` is a branch or tag. It is not allowed with a local source. |
| `margrave update [source] [--allow-unsafe]` | Git: fresh `git clone --depth 1` of the stored ref into staging, scan (against the installed copy, see below), then swap. A source installed without `--ref` is pinned to the branch the remote's default pointed to at install time, so `update` never jumps to a new default branch. Prints `old → new` commits and the skill ids added, changed (by `SKILL.md` hash), and removed. On any error the old copy stays untouched. Local: reindex only. With no argument it updates every source. |
| `margrave remove <source>` | Git: deletes `sources/<id>` after checking it is a direct child of `sources/`. Local: unregisters only. It never deletes your directory. |
| `margrave list [--skills] [--json]` | Sources with kind, ref, commit, and skill count. `--skills` adds every skill id and its description. |
| `margrave find "<task>" [--limit N] [--json]` | BM25 top N (default 5, clamped to 1..25). Prints qualified id, score, and description, then `load: margrave load <id>`. With no match it exits 0 and prints `no match`. |
| `margrave load <id> [--json]` | Prints a header and the `SKILL.md` body. The header has `skill:`, `source:`, `commit:`, `base:` (the absolute skill directory, so relative references such as `references/x.md` resolve), the raw frontmatter, and the file list. |
| `margrave load <id> --file <rel>` | Prints one file in the skill directory. See "Path guard". |
| `margrave reindex` | Rescan all sources and rebuild `index.json`. |
| `margrave mcp` | stdio MCP server (see below). |
| `margrave wrap <claude\|codex\|bb\|generic>` | Print setup text. |

`<source>` is a source id or the original spec you installed it with.

### Specs

Checked in this order:

1. `./`, `../`, `/`, `~`: a local path.
2. `https://`, `git@`, `file://`: a git URL.
3. `owner/repo[/sub/path]`: GitHub (`https://github.com/<owner>/<repo>.git`), even when a relative directory with that name exists.

A spec or `--ref` that starts with `-` is refused. A `..` subpath segment is refused.

### Ids

- Source id: GitHub `owner__repo` (with `__sub__path` for a subpath), git URL `host__path`, local `local__<basename>-<6 hex of sha1(realpath)>`. Characters outside `[A-Za-z0-9._-]` become `-`.
- Skill id: always `<source-id>/<name>`. Installing another source never renames an existing skill.
- A bare `name` works as an alias only when exactly one source has it. An ambiguous name is an error that lists the qualified ids. `find` always prints qualified ids.

### Skills

A skill is a directory with a `SKILL.md` whose frontmatter (YAML) has `name` and `description`. A `SKILL.md` without both is skipped with a warning on stderr. The walk skips `.git` and `node_modules`.

- Git sources follow no symlink. A symlinked skill directory or `SKILL.md` is skipped with a warning.
- Local sources follow directory symlinks. A symlinked `SKILL.md` is skipped. A set of visited real paths stops cycles.

### Path guard

`load --file` and the MCP `read_skill_file` tool refuse absolute paths and any path whose real path does not start with the real path of the skill directory plus a path separator. A symlink out of the skill directory is refused.

### Terminal output

Names, descriptions, and the `load` header lose control characters and ANSI escapes in human output. `--json` output and `load` bodies are never changed.

## Install scan and `--allow-unsafe`

`install` and `update` scan the new content before it reaches the store, with ripwire:

```sh
ripwire security --scan-skills=<dir>
```

This syntax was checked against `ripwire --help` and against a clean directory (exit 0, `<skillscan files="1" findings="0" verdict="clean">`).

| ripwire exit | margrave |
|---|---|
| 0 | continue, no output |
| 1 (WARN) | print the summary and continue |
| 2 (CRITICAL), 3 (could not read), any other code, output that cannot be parsed, or ripwire not on `PATH` | refuse |

`--allow-unsafe` overrides a refusal for that one `install` or `update` and prints what it overrode. Git sources are scanned in staging, so `update` never leaves an unscanned revision live. Local sources are scanned on `install`. `update` on a local source only reindexes.

### Short output

Every scan prints a summary, never the raw XML:

```
scan: CRITICAL — 157 finding(s) (156 critical, 1 warn) in 41 skill(s); 0 new vs installed copy
  by rule:   EXFILTRATE:net-exfil 150 · EXFILTRATE:ssh-aws-creds 3 · …
  top skills: testing-for-sensitive-data-exposure 14 · exploiting-idor-vulnerabilities 13 · …
  new findings:            (update only, up to 20)
  known findings in changed files:   (update only, up to 10)
  full report: <MARGRAVE_HOME>/reports/<source-id>.xml
```

For every scan that is not clean, ripwire's raw XML for the new copy is written to `reports/<source-id>.xml` (the latest one only). Paths, skill names, and rules from the scanned repo are shown with control characters replaced by `\xNN`. The report file is not changed. When ripwire fails (exit 3, another code, unparseable output), margrave shows ripwire's stderr, or its output when stderr is empty, up to 40 lines.

### Baseline on `update`

The baseline is the installed copy in `sources/<id>/`: what you accepted, either because it was clean or because you installed it with `--allow-unsafe`. `update` of a git source scans both the installed copy and the new copy, then refuses only on findings that the installed copy does not have. Nothing is stored for this. A source installed before this rule gets its baseline from its first `update`. `update` therefore runs ripwire twice (the baseline scan is skipped when the new copy is clean).

A finding is identified by `(path inside the source, rule, severity, sha256 of the trimmed flagged line)`. The line number is not part of it, so an edit elsewhere in a file creates no new finding. Findings are compared as a multiset: a second copy of a known line is new. Severity `warn` is warn; any other value counts as critical, and a rise from warn to critical is new.

| Situation | Outcome |
|---|---|
| The new copy is clean, or every finding is in the installed copy | continue |
| New findings, all warn | continue, new findings listed |
| Any new critical finding, or a finding whose line cannot be read | refuse, new findings listed |
| The new scan fails (exit 3, another code, unparseable output, ripwire missing) | refuse |
| No baseline: the installed copy is missing, or its scan fails | print `scan: no baseline (<reason>); every finding counts as new` and apply the `install` rules |

A flagged line cannot be read when its file is a symlink or has a symlink in its path, is outside the scan root, is not valid UTF-8, or the line number does not exist. Such a finding always counts as new, in the new copy and in the baseline. Output is unparseable when it has no `<skillscan>` element, its row count differs from `findings=`, it reports CRITICAL without a critical row, or it exits 1 without a row.

Limit: the baseline compares the flagged line, not the lines around it. A known flagged line can be moved into a new context (for example out of an example block and into a "run this first" step) and the scan sees no change. To make this visible, the summary lists `known findings in changed files` (path, rule, count): known findings whose file differs between the two copies. Check those files before you trust `0 new`.

## MCP server

`margrave mcp` is read-only. `install`, `update`, and `remove` are not exposed. It reads `index.json` on every call, so a new install shows up without a restart.

| Tool | Input | Result |
|---|---|---|
| `find_skills` | `task`, `limit?` | Ranked skill ids with descriptions. No match is an empty result with a hint, not an error. |
| `load_skill` | `id` | The same text as `margrave load`. |
| `read_skill_file` | `id`, `path` | One file, with the same guard as `--file`. |

## Ranking

BM25F with k1 = 1.2 and b = 0.75. Field weights: name 3, description 2, headings 1, body 0.3. The first 2000 body tokens are indexed. Tokens are lowercased, split on non-alphanumerics, stripped of stopwords, and stemmed with the Porter algorithm (the `stemmer` package). The stopword check runs on the word and again on its stem. An exact match of the query to a name or id adds a fixed bonus. Ties break by id ascending.

## Store

```
~/.margrave/
  sources/<source-id>/   git clones
  staging/               in-progress clones (deleted on success and on failure)
  sources.json           [{id, kind, spec, url|path, subpath, ref, commit, installedAt}]
  index.json             one entry per skill, plus BM25 corpus stats
```

A missing `sources.json` is an empty list. A malformed one is an error, and margrave writes nothing. A malformed `index.json` is an error that tells you to run `margrave reindex`. Both files are written atomically (temp file in the same directory, then rename).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | error (including a ripwire refusal) |
| 2 | usage error |

## Development

```sh
nvm use && pnpm install --frozen-lockfile
pnpm run build  # tsrs, then chmod +x dist/cli.js
pnpm test       # node --test test/ (runs the .ts sources directly; no network, temp MARGRAVE_HOME)
```
