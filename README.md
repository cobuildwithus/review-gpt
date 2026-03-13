# @cobuild/review-gpt

Shared `review:gpt` launcher used across Cobuild repositories.

## What It Does

`@cobuild/review-gpt` standardizes ChatGPT review setup across repos:

- builds a fresh audit ZIP from your repo context
- resolves prompt content from repo-local presets plus optional inline `--prompt` text
- opens ChatGPT in a managed Chromium-family browser and stages a draft with the ZIP attached
- pre-fills the composer text, with optional `--send` auto-submit (disabled by default)

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

Recommended consuming-repo entry point:

```json
{
  "scripts": {
    "review:gpt": "cobuild-review-gpt --config scripts/review-gpt.config.sh"
  }
}
```

Use the package binary directly. Avoid repo-local wrapper scripts unless you have a concrete repo-specific need beyond passing `--config`.

## Usage

```bash
cobuild-review-gpt --config scripts/review-gpt.config.sh --preset security
cobuild-review-gpt --config scripts/review-gpt.config.sh --prompt "Focus on callback auth and griefing"
cobuild-review-gpt --config scripts/review-gpt.config.sh --prompt-file audit-packages/review-gpt-nozip-comprehensive-a-goals-interfaces.md
cobuild-review-gpt --config scripts/review-gpt.config.sh --no-zip --prompt-file audit-packages/review-gpt-nozip-comprehensive-a-goals-interfaces.md
cobuild-review-gpt --config scripts/review-gpt.config.sh --model gpt-5.2-pro --thinking extended
cobuild-review-gpt --config scripts/review-gpt.config.sh --send
cobuild-review-gpt --config scripts/review-gpt.config.sh --send --chat 69a86c41-cca8-8327-975a-1716caa599cf
cobuild-review-gpt --config scripts/review-gpt.config.sh --chat-url https://chatgpt.com/c/69a86c41-cca8-8327-975a-1716caa599cf
```

The config file is a sourced shell file that can override defaults, preset mappings, and path settings.
Model/thinking selection defaults to `current`, which keeps the operator's existing ChatGPT selection unless `--model` or `--thinking` is passed (or overridden in config).

Browser notes:

- `browser_binary_path` is the preferred config knob for the browser executable. `browser_chrome_path` remains supported for backward compatibility.
- Chromium-family browsers are supported as long as the binary is Chromium-compatible. Chrome, Brave, Chromium, and Edge all work with the managed-profile launch flow.
- The managed browser profile now defaults to `$HOME/.review-gpt/managed-chromium`. If an older `$HOME/.oracle/remote-chrome` profile already exists, the launcher reuses it automatically instead of forcing a new sign-in.
- You can override the managed profile location with `managed_browser_user_data_dir` and the profile name with `managed_browser_profile`.
- On first run with a fresh managed profile, sign in to ChatGPT in the opened browser window once, then rerun the command.

For local package iteration, prefer package-manager linking or a local file dependency rather than custom wrapper fallbacks.
Examples:

```bash
pnpm add -D file:../review-gpt
# or
pnpm link --global ../review-gpt
pnpm link --global @cobuild/review-gpt
```

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
- uses `pnpm` versioning so `pnpm-lock.yaml` stays authoritative and `package-lock.json` is not recreated
- bumps version and updates `CHANGELOG.md`
- creates release commit `release: v<version>`, tags `v<version>`, and pushes `main` + tags
- after push, waits for npm publish visibility and updates sibling repos under the configured sync root that depend directly on `@cobuild/review-gpt`

Release helpers resolve `@cobuild/repo-tools` from the installed dev dependency in `node_modules` first and fall back to the sibling `repo-tools` checkout in this workspace when testing unreleased shared tooling before the next publish.

You can skip the post-release sibling sync with `--no-sync-upstreams` or `REVIEW_GPT_SKIP_UPSTREAM_SYNC=1`.

Manual sync command:
```bash
pnpm run sync:repos -- --version 0.2.9 --wait-for-publish
```

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
