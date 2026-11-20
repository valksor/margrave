# Margrave v0.2.1 store fixture

The v0.2.1 CLI created this store from one synthetic Git source. The SQLite index includes the schema and indexed skill that the release wrote. The test copies the store, then changes only the indexed absolute skill path to match the temporary location.

To reproduce the fixture, use the source at tag `v0.2.1` and the Node version in its `.nvmrc`.

1. In a temporary directory under `/tmp`, make a Git repository with branch `master`. Copy the fixture's `release-upgrade/SKILL.md` to `release-upgrade/SKILL.md` in that repository. Commit the file with a synthetic Git identity.
2. Use `fakeRipwire()` and `runCli()` from that tag's `test/helpers.ts` to run `install https://example.invalid/fixtures/margrave-upgrade.git` with an empty `MARGRAVE_HOME` under `/tmp`. Set `GIT_CONFIG_COUNT=1`. Set `GIT_CONFIG_KEY_0` to `url.file://<absolute repository path>.insteadOf` and `GIT_CONFIG_VALUE_0` to `https://example.invalid/fixtures/margrave-upgrade.git`. Git uses the temporary repository for the install.
3. Copy `index.db`, `sources.json`, `snapshots/`, and `sources/` from that home to `store/`. Preserve the relative symlink under `sources/`. The release assigns a new snapshot suffix and installation time on each run.
