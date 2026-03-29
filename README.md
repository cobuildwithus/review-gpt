# @cobuild/review-gpt

Shared `review:gpt` launcher used across Cobuild repositories.

The CLI is implemented with `incur`, so it now ships with built-in shell completions plus agent-facing `--llms`, `skills add`, and `mcp add` integrations while preserving the existing `cobuild-review-gpt` command surface.

## What It Does

`@cobuild/review-gpt` standardizes ChatGPT review setup across repos:

- builds a fresh audit ZIP from your repo context
- resolves prompt content from repo-local presets plus optional inline `--prompt` text
- opens ChatGPT in a managed Chromium-family browser and stages a draft with the ZIP attached
- pre-fills the composer text, with optional `--send` auto-submit (disabled by default)
- in Deep Research mode, auto-send gives the product up to 60 seconds to auto-start before attempting any `Start` fallback
- can wait for the assistant response, print it to stdout, and optionally write it to a file
- supports a dedicated Deep Research mode on `https://chatgpt.com/deep-research`

This package does not own project prompts. Prompt presets remain in each consuming repository.
Preset names no longer need to be shared across repos: the consuming repo can register its own presets,
aliases, and grouped presets in `scripts/review-gpt.config.sh`.

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

Example config with repo-specific presets:

```bash
#!/usr/bin/env bash
package_script="scripts/package-audit-context.sh"
browser_binary_path="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"

review_gpt_register_preset "simplify" "agent-docs/prompts/simplify.md" \
  "Complexity and simplification opportunities." \
  "complexity"
review_gpt_register_preset "test-coverage-audit" "agent-docs/prompts/test-coverage-audit.md" \
  "Highest-impact missing tests after the simplify pass."
review_gpt_register_preset "task-finish-review" "agent-docs/prompts/task-finish-review.md" \
  "Final review pass before handoff."
review_gpt_register_preset_group "all" "Run every repo-defined review pass." \
  "simplify" "test-coverage-audit" "task-finish-review"
```

Config helpers exposed by the package:

- `review_gpt_register_preset <name> <file> <description> [alias ...]`
- `review_gpt_register_dir_preset <name> <filename> <description> [alias ...]`
- `review_gpt_register_preset_group <name> <description> <preset ...>`

Each consuming repo must register its own presets. If the config does not register any presets, `--list-presets` will report none configured and any `--preset` use will fail.

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
cobuild-review-gpt --config scripts/review-gpt.config.sh --preset simplify
cobuild-review-gpt --config scripts/review-gpt.config.sh --prompt "Focus on callback auth and griefing"
cobuild-review-gpt --config scripts/review-gpt.config.sh --prompt-file audit-packages/review-gpt-nozip-comprehensive-a-goals-interfaces.md
cobuild-review-gpt --config scripts/review-gpt.config.sh --no-zip --prompt-file audit-packages/review-gpt-nozip-comprehensive-a-goals-interfaces.md
cobuild-review-gpt --config scripts/review-gpt.config.sh --model gpt-5.2-thinking --thinking extended
cobuild-review-gpt --config scripts/review-gpt.config.sh --send
cobuild-review-gpt --config scripts/review-gpt.config.sh --wait --response-file audit-packages/review-response.md
cobuild-review-gpt --config scripts/review-gpt.config.sh --deep-research --wait
cobuild-review-gpt --config scripts/review-gpt.config.sh --send --chat 69a86c41-cca8-8327-975a-1716caa599cf
cobuild-review-gpt --config scripts/review-gpt.config.sh --chat-url https://chatgpt.com/c/69a86c41-cca8-8327-975a-1716caa599cf
```

The config file remains a sourced shell file that can override defaults, register preset mappings, and adjust path settings.
Model selection now defaults to `gpt-5.4-pro`, while `--model` can override that for operators who want a different model or do not have the Pro plan. Thinking still defaults to `current`. Deep Research mode uses the dedicated page and ignores normal model/thinking forcing.

In addition to the review-gpt options above, the incur runtime also exposes:

- `cobuild-review-gpt completions <bash|zsh|fish>`
- `cobuild-review-gpt --llms`
- `cobuild-review-gpt skills add`
- `cobuild-review-gpt mcp add`

Thread follow-up helpers ship through the main incur CLI:

- `cobuild-review-gpt thread export --chat-url <url> --output <path>`
- `cobuild-review-gpt thread download --chat-url <url> --attachment-text <label> --output-dir <dir>`
- `cobuild-review-gpt thread wake --delay 70m --chat-url <url> --session-id <id>`

Browser notes:

- `browser_binary_path` is the preferred config knob for the browser executable. `browser_chrome_path` remains supported for backward compatibility.
- Chromium-family browsers are supported as long as the binary is Chromium-compatible. Chrome, Brave, Chromium, Edge, and Vivaldi all work with the managed-profile launch flow.
- The launcher also checks `CHROME_PATH`, `BROWSER_BINARY_PATH`, and `--browser-path` for one-off browser overrides.
- The managed browser profile now defaults to `$HOME/.review-gpt/managed-chromium`. If an older `$HOME/.oracle/remote-chrome` profile already exists, the launcher reuses it automatically instead of forcing a new sign-in.
- You can override the managed profile location with `managed_browser_user_data_dir` and the profile name with `managed_browser_profile`.
- On first run with a fresh managed profile, sign in to ChatGPT in the opened browser window once, then rerun the command.

Response-capture notes:

- `--wait` implies auto-send and uses a longer timeout budget (`10m` by default, `40m` in Deep Research mode).
- When `--wait` is enabled, `review-gpt` stays attached until the assistant finishes or the wait timeout is hit; Deep Research runs can stay quiet for a long time before the final report arrives.
- Deep Research auto-send now gives the product up to 60 seconds to auto-start, then only falls back to the approval-card `Start` action if that gate is still present.
- Captured assistant output is printed between `REVIEW_GPT_RESPONSE_BEGIN/END` markers so callers can parse it reliably.
- `--response-file <path>` writes the captured assistant response to a file after the run finishes.

## Delayed Follow-Up

For long-running ChatGPT work, the package also includes thread follow-up helpers that read an existing ChatGPT conversation from the same managed Chromium session, download `.patch`, `.diff`, or `.zip` attachments, and optionally resume a Codex session later.

Examples:

```bash
cobuild-review-gpt thread export \
  --chat-url https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536 \
  --output output-packages/thread.json

cobuild-review-gpt thread download \
  --chat-url https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536 \
  --attachment-text assistant-unified-final-pass-fixes.patch \
  --output-dir output-packages/downloads

cobuild-review-gpt thread wake \
  --delay 70m \
  --chat-url https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536 \
  --session-id 019d36e3-f6a2-7873-910a-2bdbd4f9748c
```

Resume notes:

- `cobuild-review-gpt thread wake` does not touch the managed browser until the configured `--delay` has elapsed, so scheduling a 60m or 100m follow-up does not immediately reopen or navigate the ChatGPT tab.
- After the delay elapses, the thread helpers refresh the existing ChatGPT tab before exporting or downloading so stale tab state does not hide later patch attachments.
- `cobuild-review-gpt thread wake` resolves the local `codex` executable itself, so launchd/tmux/nohup runs do not depend on your interactive shell PATH still containing the Codex CLI.
- `cobuild-review-gpt thread wake` captures the current working directory and resumes Codex from that directory later, because `codex exec resume` itself does not accept `-C`.
- If you omit `--codex-home`, the wake command searches `CODEX_HOME`, `~/.codex`, and `~/.codex-*` homes for evidence of the target session ID and refuses to resume if more than one home matches.
- If you already know the owner home, pass `--codex-home <path>` to skip discovery and make the resume target explicit.
- `--skip-resume` still exports the thread and downloads any patch attachments, but it does not call `codex exec resume`.
- If you want the sleep/wake process to survive terminal exit, launch it under `nohup`, `tmux`, `screen`, `launchd`, or another supervisor.


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
