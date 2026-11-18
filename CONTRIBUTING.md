# Contributing to margrave

Thank you for your interest in contributing to margrave. Contributions are welcome.

## Getting started

### Prerequisites

- Node 24 or newer. The repo pins `26.13.1` in `.nvmrc`: run `nvm use`. The release binary embeds that Node version.
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
- `pnpm build:sea` - Run the build, then bundle `dist/cli.js` with esbuild into a Node single executable application, `build/margrave` (ad-hoc signed on macOS). `.nvmrc` decides the embedded Node version
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
scripts/      # ensure-ripwire.mjs: fetches the pinned ripwire at build time; build-sea.mjs: builds build/margrave
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

### macOS signing

Releases sign and notarize the macOS `margrave` binary and ripwire in the `sign-macos` job. A release fails until the signing setup below exists. A failed or unavailable notarization blocks the whole release, Linux included.

1. Create the GitHub Environment `release-signing` (Settings → Environments). Add a deployment-branch rule that allows `master` only, with no tags, before you add any secret. A required reviewer is optional. GitHub also creates this environment by itself, without a branch rule, the first time a workflow run names it, so check that the rule is there before step 2.
2. Add these five secrets to that environment:
   - `MACOS_CERT_P12`: export the Developer ID Application certificate with its private key as a `.p12` file from Keychain Access, then run `base64 -i cert.p12 | pbcopy`.
   - `MACOS_CERT_PASSWORD`: the password you set for that export.
   - `APPLE_API_KEY_P8`: create an App Store Connect API key (Users and Access → Integrations → Team Keys, role Developer) and download the `.p8` file. You can download it only once. Then run `base64 -i AuthKey_XXXX.p8 | pbcopy`.
   - `APPLE_API_KEY_ID`: the key ID of that API key.
   - `APPLE_API_ISSUER_ID`: the issuer ID shown on the same page.

Rotation: when the certificate expires or the API key is revoked, replace the secrets. The next release uses them.

Trust: the valksor Team ID vouches for two binaries. One is upstream ripwire: the job signs only a binary that is byte-identical to the pinned upstream tarball (`scripts/ensure-ripwire.mjs`), which limits that risk. The other is `margrave`, which this repo builds from its own source, its production dependencies, and the Node version in `.nvmrc`, in a CI job that also runs the build tooling from `devDependencies` (tsrs and esbuild, among others). It is signed with `.github/entitlements.plist`: only `allow-jit` and `allow-unsigned-executable-memory`. `disable-library-validation` and `allow-dyld-environment-variables` are left out on purpose, because they allow dylib injection. A native addon would need `disable-library-validation` and a new review. `sea-config.json` sets `execArgvExtension` to `none`, so the signed binary ignores `NODE_OPTIONS`.

Node security releases: the binary embeds the Node version in `.nvmrc`. Dependabot does not track `.nvmrc`. After a Node security release, bump `.nvmrc` and release margrave again.

## Reporting issues and conduct

- Report bugs and feature requests with the issue template.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).
- This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
