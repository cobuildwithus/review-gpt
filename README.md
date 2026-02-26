# @cobuild/review-gpt

Shared `review:gpt` launcher used across Cobuild repositories.

## What It Does

`@cobuild/review-gpt` standardizes ChatGPT review setup across repos:

- builds a fresh audit ZIP from your repo context
- resolves prompt content from repo-local presets plus optional inline `--prompt` text
- opens ChatGPT in managed Chrome and stages a draft with the ZIP attached
- pre-fills the composer text, but does not auto-submit

This package does not own project prompts. Prompt presets remain in each consuming repository.

## Why It Is Useful

- one maintained implementation instead of copy/pasted shell scripts in every repo
- consistent operator workflow (`pnpm review:gpt ...`) across codebases
- safer default behavior (draft staging only, no auto-send)
- faster rollout of reliability/security fixes by publishing a new package version once

## Typical Repo Wiring

Install:

```bash
pnpm add -D @cobuild/review-gpt
```

Add a script in the consuming repo:

```json
{
  "scripts": {
    "review:gpt": "cobuild-review-gpt --config scripts/review-gpt.config.sh"
  }
}
```

Keep prompts/presets in the consuming repo (for example under `scripts/prompts/**`) and map them in `scripts/review-gpt.config.sh`.

## Usage

```bash
cobuild-review-gpt --config scripts/review-gpt.config.sh --preset security
cobuild-review-gpt --config scripts/review-gpt.config.sh --prompt "Focus on callback auth and griefing"
cobuild-review-gpt --config scripts/review-gpt.config.sh --prompt-file audit-packages/review-gpt-nozip-comprehensive-a-goals-interfaces.md
cobuild-review-gpt --config scripts/review-gpt.config.sh --no-zip --prompt-file audit-packages/review-gpt-nozip-comprehensive-a-goals-interfaces.md
```

The config file is a sourced shell file that can override defaults, preset mappings, and path settings.

## Release

This package is published as `@cobuild/review-gpt` (npm `@cobuild` scope).

Release ownership note: release/version-bump/publish actions are user-operated by default. Agents should not run release flows unless explicitly instructed in the current chat turn.

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
