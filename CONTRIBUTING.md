# Contributing to margrave

Thank you for your interest in contributing to margrave. Contributions are welcome.

## Getting started

### Prerequisites

- Node 27 or newer. The repo pins `27.0.0-alpha.0.1.0` in `.nvmrc`. nvm hides alpha builds by default, so install it with `nvm install --only=alpha 27.0.0-alpha.0.1.0`, then run `nvm use`.
- pnpm 12. The repo pins the exact version in the `packageManager` field of `package.json`; enable [corepack](https://nodejs.org/api/corepack.html) to use it:
  ```bash
  corepack enable
  ```

### Setup

1. Fork the repository.
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/margrave.git
   cd margrave
   ```
3. Install dependencies and build:
   ```bash
   nvm use
   pnpm install --frozen-lockfile
   pnpm run build
   ```
   `pnpm run build` also downloads the pinned ripwire into `vendor/ripwire/`, whatever `ripwire` is on your `PATH`. margrave runs the vendored copy first. See "Where ripwire comes from" in the README.

## Development

### Available scripts

- `pnpm build` - Compile `src/` to `dist/` with tsrs, then make sure `vendor/ripwire/` holds the pinned ripwire
- `pnpm test` - Run the tests under c8 (`node --test test/`; no network, temporary `MARGRAVE_HOME`). It fails when line, branch, function, or statement coverage of `src/` is below 100%. The coverage gate needs a non-root user, because the tests that need unreadable files skip as root. The run also writes `coverage/lcov.info`, which CI uploads to Coveralls
- `pnpm lint` - Check the code with oxlint, including type-aware rules and type errors in the linted files (via tsrs-lint)
- `pnpm lint:fix` - Apply oxlint's automatic fixes
- `pnpm format` - Format all files with prettier
- `pnpm format:check` - Check formatting without writing
- `pnpm typecheck` - Type-check with `tsrs --noEmit`
- `pnpm knip` - Find unused files, exports, and dependencies

`pnpm install` also sets up a lefthook pre-commit hook. The hook runs oxlint `--fix` and prettier on the staged files and stages the fixed files again. If you stage only some changes of a file, the commit holds only those changes, with the fixes applied. The other changes stay unstaged in your working tree. After an install with `--ignore-scripts`, run `pnpm run prepare` to set up the hook. Do not run `lefthook install` directly: it reads a global `core.hooksPath`.

CI runs the audit of production dependencies, lint, format check, typecheck, tests, and knip on every push and pull request. Run them locally before you open a pull request.

### Project structure

```
src/          # TypeScript sources (cli.ts is the entry point)
test/         # node:test tests; helpers.ts holds a fake ripwire for scan tests
scripts/      # ensure-ripwire.mjs: fetches the pinned ripwire at build time
```

Tests use a fake ripwire, so they do not depend on the ripwire you have installed.

## Pull requests

1. Branch from `master` and keep each pull request to one change.
2. Add or update tests for the behavior you change.
3. Make sure `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm knip` pass.
4. Fill in the pull request template.

By contributing you agree that your contribution is licensed under the project's [BSD-3-Clause license](LICENSE).

## Commit messages and releases

Every push to `master` publishes a release. The first line of the commit message selects the version bump:

- `[major]` in the first line: major bump.
- `[minor]` in the first line: minor bump.
- Anything else: patch bump.

Only the first line counts. A token in the body of the message, such as in a squashed commit, does not change the bump. The release workflow commits the new version to `master` itself, so do not bump the version in `package.json` by hand.

## Reporting issues and conduct

- Report bugs and feature requests with the issue template.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).
- This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
