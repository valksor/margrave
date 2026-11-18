# margrave

[![Test](https://github.com/valksor/margrave/actions/workflows/test.yml/badge.svg)](https://github.com/valksor/margrave/actions/workflows/test.yml)
[![CodeQL](https://github.com/valksor/margrave/actions/workflows/codeql.yml/badge.svg)](https://github.com/valksor/margrave/actions/workflows/codeql.yml)
[![Coverage Status](https://coveralls.io/repos/github/valksor/margrave/badge.svg?branch=master)](https://coveralls.io/github/valksor/margrave?branch=master)

margrave keeps agent skills (folders with a `SKILL.md`) in one store. It does not install them into any agent. An agent asks for what it needs in plain words, gets ranked suggestions, and loads one skill from the store.

- `margrave find "<task>"` returns ranked skills.
- `margrave load <id>` prints one skill.
- `margrave mcp` runs a stdio MCP server with the same functions, for agents that use MCP.
- `margrave/hosted` exports the same MCP tools over HTTP, for a server that hosts its own skill store.

Skills are not loaded into the agent by default, so 1000+ installed skills cost nothing per session.

## 1. Install margrave itself

The release bundles and the Homebrew formula need no Node. The npm package and a build from source need Node 24 or newer. The repo pins `26.13.0` in `.nvmrc`: `nvm use` selects it, and the release binary embeds that version.

```sh
nvm use && pnpm install --frozen-lockfile && pnpm run build && pnpm add -g "$PWD"
```

`pnpm run build` also makes sure ripwire is available (see [Where ripwire comes from](#where-ripwire-comes-from)). `pnpm add -g` needs pnpm's global bin directory on `PATH`. If it is not there yet, run `pnpm setup` once and open a new shell.

### From a release

Every push to `master` publishes a release at https://github.com/valksor/margrave/releases with these assets. The bundles need no Node. The npm package needs Node 24 or newer.

| Asset                                                                                | Contents                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `margrave-v<version>-linux-x64.tar.gz`, `-linux-arm64.tar.gz`, `-macos-arm64.tar.gz` | A `margrave/` directory with the standalone binary `bin/margrave` (it embeds Node 26), ripwire in `vendor/ripwire/`, `package.json`, and the license files. Nothing else to install.                                             |
| `margrave-v<version>.tgz`                                                            | The npm package. It does not carry ripwire: run `node <package dir>/scripts/ensure-ripwire.mjs` once to fetch the pinned one. Without it, margrave falls back to `ripwire` on `PATH`, which must be at least the pinned version. |

Homebrew (macOS arm64, Linux):

```sh
brew install valksor/tap/margrave
```

The tap checks for new releases every 6 hours, so `brew upgrade` can trail a release by up to 6 hours. If you installed a bundle before, remove its `~/.local/bin/margrave` symlink: the first `margrave` on `PATH` wins.

Bundle:

```sh
gh release download --repo valksor/margrave --pattern 'margrave-v*-linux-x64.tar.gz'   # or curl -LO <asset URL>
gh attestation verify margrave-v*-linux-x64.tar.gz --repo valksor/margrave
tar -xzf margrave-v*-linux-x64.tar.gz
mkdir -p ~/.local/bin
ln -s "$PWD/margrave/bin/margrave" ~/.local/bin/margrave
```

Symlink `margrave/bin/margrave`. Do not copy it: margrave finds `vendor/ripwire` next to the real binary.

The Linux bundles embed the official glibc build of Node. A musl host (Alpine) or a host with an old glibc must use the npm package.

`~/.local/bin` must be on `PATH`. If it is not, add `export PATH="$HOME/.local/bin:$PATH"` to your shell's rc file and open a new shell.

#### Upgrading from 0.1.x

The bundle no longer has `dist/cli.js`. Do both of these:

1. Point the old `~/.local/bin/margrave` symlink at `margrave/bin/margrave`.
2. Run `margrave wrap <agent>` again and apply its output. Old agent configs run `node .../dist/cli.js mcp`, which no longer exists.

Package:

```sh
pnpm add -g ./margrave-v<version>.tgz
```

On macOS, the bundle's `margrave` and ripwire are signed with a Developer ID and notarized. Gatekeeper checks the notarization online at the first run, so a browser download that you use offline can still be blocked. In that case, run `gh attestation verify` on the file first, extract that same file, then clear the quarantine flag on the bundled `margrave` and ripwire only: `xattr -d com.apple.quarantine margrave/bin/margrave margrave/vendor/ripwire/ripwire`.

## 2. Install a skill source

```sh
margrave install vercel-labs/agent-skills     # GitHub repo (skills.sh format)
margrave install ~/.agents/skills             # local directory
margrave install https://example.com/team/skills.git --ref v2
```

`install` prints the source id and the skill ids it found. Skills live in `~/.margrave` (set `MARGRAVE_HOME` to move it).

## 3. Connect an agent

`margrave wrap <agent>` prints setup text and writes nothing. It uses absolute paths, so the agent's own PATH and nvm state do not matter. From a release binary it prints the absolute path of that binary (the path you ran it by, so a Homebrew upgrade keeps working). From the npm package or a source build it prints `process.execPath` and the absolute `dist/cli.js`. It passes `MARGRAVE_HOME` when that is set.

```sh
margrave wrap claude    # a `claude mcp add` command, then the instruction snippet
margrave wrap codex     # a [mcp_servers.margrave] block for ~/.codex/config.toml, then the snippet
margrave wrap bb        # the claude command line, with a note that bb runs the provider's MCP config
margrave wrap generic   # the plain command line, then the snippet
```

Example for a release binary (`margrave wrap claude`):

```sh
claude mcp add margrave -- /home/you/.local/bin/margrave mcp
```

The same command from the npm package or a source build:

```sh
claude mcp add margrave -- /usr/local/bin/node /path/to/margrave/dist/cli.js mcp
```

Run the printed command yourself, and add the snippet to the agent's instructions.

## 4. Check it

```sh
margrave find "react performance"
margrave load <id from the result>
```

## Commands

| Command                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `margrave install <spec> [--ref R] [--allow-unsafe]` | Add a source. A git source is cloned into staging, scanned, indexed, then moved into the store. Any failure leaves the store and `sources.json` unchanged. A source with 0 valid skills is a failure. An id that already exists is an error. `--ref` is a branch or tag. It is not allowed with a local source.                                                                                                                                                                                 |
| `margrave update [source] [--allow-unsafe]`          | Git: fresh `git clone --depth 1` of the stored ref into staging, scan (against the installed copy, see below), then swap. A source installed without `--ref` is pinned to the branch the remote's default pointed to at install time, so `update` never jumps to a new default branch. Prints `old → new` commits and the skill ids added, changed (by `SKILL.md` hash), and removed. On any error the old copy stays untouched. Local: reindex only. With no argument it updates every source. |
| `margrave remove <source>`                           | Git: deletes `sources/<id>` after checking it is a direct child of `sources/`. Local: unregisters only. It never deletes your directory.                                                                                                                                                                                                                                                                                                                                                        |
| `margrave list [--skills] [--json]`                  | Sources with kind, ref, commit, and skill count. `--skills` adds every skill id and its description.                                                                                                                                                                                                                                                                                                                                                                                            |
| `margrave find "<task>" [--limit N] [--json]`        | Top N by BM25 (default 5, clamped to 1..25). Prints qualified id, score, and description, then `load: margrave load <id>`. With no match it exits 0 and prints `no match`.                                                                                                                                                                                                                                                                                                                      |
| `margrave load <id> [--json]`                        | Prints a header and the `SKILL.md` body. The header has `skill:`, `source:`, `commit:`, `base:` (the absolute skill directory, so relative references such as `references/x.md` resolve), the raw frontmatter, and the file list.                                                                                                                                                                                                                                                               |
| `margrave load <id> --file <rel>`                    | Prints one file in the skill directory. See "Path guard".                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `margrave reindex`                                   | Rescan all sources and rebuild `index.db`. It also removes a legacy `index.json`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `margrave mcp`                                       | stdio MCP server (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `margrave wrap <claude\|codex\|bb\|generic>`         | Print setup text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
- The stored copy of a git source keeps no `.git` directory. A copy installed by an earlier version drops it at the next `margrave update`.
- Local sources follow directory symlinks. A symlinked `SKILL.md` is skipped. A set of visited real paths stops cycles.

### Path guard

`load --file` and the MCP `read_skill_file` tool refuse absolute paths and any path whose real path does not start with the real path of the skill directory plus a path separator. A symlink out of the skill directory is refused. A path that has a `.git` component is refused.

### Terminal output

Names, descriptions, and the `load` header lose control characters and ANSI escapes in human output. `--json` output and `load` bodies are never changed. Scan warnings on stderr show control characters as `\xNN`.

## Install scan and `--allow-unsafe`

`install` and `update` scan the new content before it reaches the store, with ripwire:

```sh
ripwire security --scan-skills=<dir>
```

This syntax was checked against `ripwire --help` and against a clean directory (exit 0, `<skillscan files="1" findings="0" verdict="clean">`).

| ripwire exit                                                                                                                                | margrave                       |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 0                                                                                                                                           | continue, no output            |
| 1 (WARN)                                                                                                                                    | print the summary and continue |
| 2 (CRITICAL), 3 (could not read), any other code, output that cannot be parsed, or ripwire found neither on `PATH` nor in `vendor/ripwire/` | refuse                         |
| no `vendor/ripwire/`, and `ripwire` on `PATH` is older than the pinned version or prints no version                                         | refuse                         |

`--allow-unsafe` overrides a refusal for that one `install` or `update` and prints what it overrode. Git sources are scanned in staging, so `update` never leaves an unscanned revision live. Local sources are scanned on `install`. `update` on a local source only reindexes.

### Where ripwire comes from

margrave runs `vendor/ripwire/ripwire` in the package root first, so a ripwire on `PATH` cannot make the scan weaker. It runs `ripwire` from `PATH` only when there is no vendored copy. `pnpm run build` and `node scripts/ensure-ripwire.mjs` always make sure `vendor/ripwire/` holds the pinned version, whatever `ripwire` is on `PATH`. The script does nothing when `vendor/ripwire/` already holds it. Otherwise it downloads the pinned ripwire release (0.6.10 from [redhat-et/ripwire](https://github.com/redhat-et/ripwire)), checks the SHA-256 that is hard-coded in the script, and unpacks only the binary and its `LICENSE` into `vendor/ripwire/` (git-ignored). A failed download or checksum fails the build.

The npm package has no vendored copy. Run `node <package dir>/scripts/ensure-ripwire.mjs` once rather than relying on `PATH`. The `PATH` fallback reads only a first `--version` line of the form `ripwire X.Y.Z`. It refuses a `ripwire` that is older than the pinned version (a pre-release of the pinned version, such as `0.6.10-rc.1`, counts as older), that prints no such line, or whose `--version` fails or takes longer than 10 seconds, and tells you to run that script or update ripwire. A vendored copy whose `vendor/ripwire/VERSION` does not match the pinned version is refused too; run `node scripts/ensure-ripwire.mjs`. `--allow-unsafe` overrides these refusals like any other.

A vendored binary that exists but cannot run (for example a quarantined macOS download, see the `xattr` note above) makes `install` and `update` refuse with `ripwire failed`. margrave does not fall back to `PATH` in that case.

Prebuilt ripwire exists for linux-x64, linux-arm64, and macos-arm64. On any other platform the build prints a warning and you install ripwire yourself (see its `INSTALL.md`) and put it on `PATH`. Without ripwire, `install` and `update` refuse.

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

| Situation                                                                      | Outcome                                                                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| The new copy is clean, or every finding is in the installed copy               | continue                                                                                        |
| New findings, all warn                                                         | continue, new findings listed                                                                   |
| Any new critical finding, or a finding whose line cannot be read               | refuse, new findings listed                                                                     |
| The new scan fails (exit 3, another code, unparseable output, ripwire missing) | refuse                                                                                          |
| No baseline: the installed copy is missing, or its scan fails                  | print `scan: no baseline (<reason>); every finding counts as new` and apply the `install` rules |

A flagged line cannot be read when its file is a symlink or has a symlink in its path, is outside the scan root, is not valid UTF-8, or the line number does not exist. Such a finding always counts as new, in the new copy and in the baseline. Output is unparseable when it has no `<skillscan>` element, its row count differs from `findings=`, it reports CRITICAL without a critical row, or it exits 1 without a row.

Limit: the baseline compares the flagged line, not the lines around it. A known flagged line can be moved into a new context (for example out of an example block and into a "run this first" step) and the scan sees no change. To make this visible, the summary lists `known findings in changed files` (path, rule, count): known findings whose file differs between the two copies. Check those files before you trust `0 new`.

## MCP server

`margrave mcp` is read-only. `install`, `update`, and `remove` are not exposed. It opens `index.db` on every call, so a new install shows up without a restart. After you upgrade margrave, restart running `margrave mcp` sessions: a session started by an older version still reads `index.json`.

| Tool              | Input            | Result                                                                                     |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `find_skills`     | `task`, `limit?` | Ranked skill ids with descriptions. No match is an empty result with a hint, not an error. |
| `load_skill`      | `id`             | The same text as `margrave load`.                                                          |
| `read_skill_file` | `id`, `path`     | One file, with the same guard as `--file`.                                                 |

### Hosted MCP

`import { handleHostedMcp } from "margrave/hosted"` gives a `(Request) => Promise<Response>` handler for MCP Streamable HTTP. margrave starts no server. The host app mounts the handler on one route.

It has the same three tools and the same inputs as `margrave mcp`. It reads the store in `MARGRAVE_HOME` of the host process on every call. It needs read access to `MARGRAVE_HOME`; it does not need write access, so a read-only mount or a separate user works. It is stateless and POST-only. Other methods get 405.

To upgrade (see also [Upgrading](#upgrading)):

1. Upgrade the `margrave` CLI and the `margrave` package that the host app uses.
2. Run `margrave reindex`.
3. Restart the host app, and any running `margrave mcp` sessions.

Known limit: if a CLI write is killed during its transaction, a hot `index.db-journal` stays next to `index.db`. A read-only connection cannot roll it back, so every reader fails until the next CLI write or `margrave reindex` rolls the journal back. `margrave find`, `load`, and `list` and the stdio MCP server return `<path> has an unfinished write from a stopped margrave process; run: margrave reindex`; the hosted handler logs it and returns the generic server error. This happens in a writable directory too, not only on a read-only mount. margrave never deletes the journal.

A remote client sees these differences:

- `load_skill` has no `base:` line and no install spec on the `source:` line, and the tool descriptions point to the file list.
- `find_skills` hints name tools, not CLI commands.
- With no skills installed, the text is `no skills are installed on this server`.
- An error caused by the client's input (unknown id, bad path) keeps its text. Any other error returns `the skill store on this server is not available; the server log has details`, and the full error goes to `console.error`.

The handler serves every skill in the store, including any installed with `--allow-unsafe`. Skill ids carry the source id (see [Ids](#ids)), so a remote client sees the basename of a local source's directory, and the host and repository path of a git source (GitHub `owner/repo` with any subpath, `https://`, `git@`, and `file://` specs alike).

margrave does no auth, TLS, CORS, Host/Origin checks, or rate limiting. The host app must do them. Do not expose the handler without auth.

Example (Node, `node:http`):

```ts
import { createServer } from "node:http";
import { handleHostedMcp } from "margrave/hosted";

createServer(async (incoming, outgoing) => {
  try {
    if (new URL(incoming.url ?? "/", "http://localhost").pathname !== "/mcp") {
      outgoing.writeHead(404).end("not found");
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const method = incoming.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
    const res = await handleHostedMcp(new Request("http://localhost/mcp", { method, headers, body }));
    outgoing.writeHead(res.status, Object.fromEntries(res.headers));
    outgoing.end(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.error(err);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}).listen(8080);
```

## Ranking

The index is a SQLite FTS5 table in `index.db` (the built-in `node:sqlite` module). Ranking is FTS5 BM25 per column, with k1 = 1.2 and b = 0.75 fixed by FTS5. Column weights: name 3, description 2, headings 1, body 0.3. The first 2000 body tokens are indexed. Tokens are lowercased, split on non-alphanumerics, stripped of stopwords, and stemmed with the Porter algorithm (the `stemmer` package). The stopword check runs on the word and again on its stem. margrave builds the tokens itself, so FTS5 only splits on spaces.

An exact match of the query to a name or id (case-insensitive) ranks first. Its shown score has a fixed bonus of 10. Ties break by id in byte order (the UTF-8 bytes of the id). A query uses at most 32 distinct tokens, in the order they appear; later tokens are dropped.

FTS5 sets the IDF of a term that is in half or more of the skills to almost zero. On a small store, or for a common word, scores can show as `0.000`. Scores rank the results of one query; do not use them as absolute thresholds.

Scores have a different scale from earlier versions (per-column BM25 replaced BM25F), so re-tune any score threshold that you apply to `find --json`.

## Store

```
~/.margrave/
  sources/<source-id>/   git clones
  staging/               in-progress clones (deleted on success and on failure)
  sources.json           [{id, kind, spec, url|path, subpath, ref, commit, installedAt}]
  index.db               SQLite FTS5 index: one row per skill
```

A missing `sources.json` is an empty list. A malformed one is an error, and margrave writes nothing. A missing, legacy, or schema-less `index.db` (`user_version` 0 and an empty schema) is an error that tells you to run `margrave reindex`; `reindex` and the first `install` into an empty store initialize such a file in place. margrave never deletes `index.db`. A file that is not a margrave index (not a SQLite database, a `user_version` other than 0 and 1, `user_version` 0 with any table, view, index, or trigger, or `user_version` 1 with the `skills` or `fts` table missing) is refused by every command, including `reindex`: move it aside, then run `margrave reindex`. `sources.json` is written by an atomic rename (temp file in the same directory, then rename). `index.db` is written in SQLite transactions with the `DELETE` journal, so readers need only read access. An `install`, `update`, `remove`, or `reindex` takes the write lock, re-reads `sources.json` under it, and writes both; a second writer waits up to 30 seconds.

## Upgrading

From a version that stored `index.json`:

1. Upgrade the margrave CLI and the `margrave` package that the host app uses, so that they are on the same version.
2. Run `margrave reindex` once. It builds `index.db` and removes `index.json`. Until then, `find`, `load`, `list`, `install`, `update`, and `remove` stop with `index.json is from an older margrave; run: margrave reindex`.
3. Restart running `margrave mcp` sessions and the host app that mounts the hosted handler.

A `margrave mcp` session that an older version started says `index.json is missing; run: margrave reindex` after the upgrade. Restart that session.

margrave never deletes `index.db`. If `index.db` is not a margrave index (for example another program wrote it, or its `user_version` is not 0 or 1, or it is 0 and the file already has a schema), every command stops with `<path> is not a margrave index; move it aside, then run: margrave reindex`. Move the file aside yourself, then run `margrave reindex`.

## Exit codes

| Code | Meaning                             |
| ---- | ----------------------------------- |
| 0    | ok                                  |
| 1    | error (including a ripwire refusal) |
| 2    | usage error                         |

## Development

```sh
nvm use && pnpm install --frozen-lockfile
pnpm run build  # tsrs, chmod +x dist/cli.js, then scripts/ensure-ripwire.mjs
pnpm run build:sea  # build, then bundle it into the standalone binary build/margrave
pnpm test       # node --test test/ under c8 (runs the .ts sources directly; no network, temp MARGRAVE_HOME); fails when line, branch, function, or statement coverage of src/ is below 100%
```

## License

margrave is licensed under the [BSD-3-Clause license](LICENSE).

The release bundles also contain ripwire (`vendor/ripwire/`), which is a separate project under the Apache-2.0 license: [redhat-et/ripwire](https://github.com/redhat-et/ripwire). Its license text is in `vendor/ripwire/LICENSE`. For the licenses of the code inside the ripwire binary, see its [THIRD_PARTY.md at v0.6.10](https://github.com/redhat-et/ripwire/blob/v0.6.10/THIRD_PARTY.md).
