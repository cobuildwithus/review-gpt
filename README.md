# @cobuild/review-gpt

Shared `review:gpt` launcher used across Cobuild repositories.

## Usage

```bash
cobuild-review-gpt --config scripts/review-gpt.config.sh --preset security
cobuild-review-gpt --config scripts/review-gpt.config.sh --prompt "Focus on callback auth and griefing"
```

The config file is a sourced shell file that can override defaults, preset mappings, and path settings.

## Release

This package is published as `@cobuild/review-gpt` (npm `@cobuild` scope).

```bash
pnpm run release:check
pnpm run release:dry-run
pnpm run release:patch
# or: pnpm run release:minor
# or: pnpm run release:major
# or: pnpm run release:alpha
```

The local release script:
- requires a clean git working tree on `main`
- verifies package scope (`@cobuild/review-gpt`)
- supports `check`, `pre*` bumps with `--preid`, and strict exact semver input
- bumps version and updates `CHANGELOG.md`
- creates tag `v<version>` and pushes `main` + tags

Publishing is tag-driven in GitHub Actions (`.github/workflows/release.yml`):
- validates tag format and version match with `package.json`
- runs tests/checks, creates a tarball, and creates a GitHub Release with Codex-style notes
- publishes to npm via Trusted Publishing (OIDC + provenance), including prerelease channel tags (`alpha`, `beta`, `rc`)

Before first automated publish, configure npm Trusted Publisher for `@cobuild/review-gpt` to allow `cobuildwithus/review-gpt` GitHub Actions to publish.

Changelog:
```bash
pnpm run changelog:update -- 0.1.1
pnpm run release:notes -- 0.1.1 /tmp/release-notes.md
```
