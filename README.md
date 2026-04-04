# @cobuild/review-gpt

`@cobuild/review-gpt` bundles your repo context, opens ChatGPT in a managed Chromium-family browser, and stages a draft with the right review artifacts already attached.

It is designed to be installed in any repository that wants a repeatable `review:gpt` workflow. You keep prompts and presets in the consuming repo, while this package handles packaging, browser automation, response capture, and thread follow-up.

The CLI is implemented with `incur`, so it also ships with built-in shell completions plus agent-facing `--llms`, `skills add`, and `mcp add` integrations while preserving the existing `cobuild-review-gpt` command surface.

## Why Use It

- turns "open ChatGPT and attach the right repo context" into one command
- packages both `repo.repomix.xml` and `repo.snapshot.zip` from the same curated manifest so the two artifacts stay aligned
- keeps project prompts local to each repo instead of centralizing them in the package
- defaults to draft-only staging, so nothing is sent unless you ask for `--send` or `--wait`
- can capture the final assistant response to stdout or a file
- includes thread export, download, and delayed wake helpers for long-running ChatGPT work

## Quick Start

Install it in the repo where you want to use it:

```bash
pnpm add -D @cobuild/review-gpt
```

Add a repo-local script:

```json
{
  "scripts": {
    "review:gpt": "cobuild-review-gpt --config scripts/review-gpt.config.sh"
  }
}
```

Create a shell config that registers the prompts your repo wants to expose:

```bash
#!/usr/bin/env bash
browser_binary_path="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"

review_gpt_register_preset "architecture" "scripts/prompts/architecture.md" \
  "Architecture review with emphasis on boundaries and coupling."
review_gpt_register_preset "bugs" "scripts/prompts/bugs.md" \
  "Behavioral regressions, edge cases, and missing tests." \
  "regressions"
review_gpt_register_preset_group "full-review" "Run the main review passes." \
  "architecture" "bugs"
```

Then run it:

```bash
pnpm review:gpt --preset architecture
```

On first run with a fresh managed browser profile, sign in to ChatGPT in the opened window once, then rerun the command.

## How It Works

Each run can:

- resolve prompt content from repo-local presets plus optional inline `--prompt` text or `--prompt-file`
- build `repo.repomix.xml` plus `repo.snapshot.zip` from your repo context
- open ChatGPT and stage a draft with the Repomix XML attached first and the ZIP attached second
- optionally auto-submit with `--send`
- optionally wait for the final response with `--wait`
- optionally switch into the dedicated Deep Research flow with `--deep-research`

This package does not own project prompts. Presets, aliases, and preset groups live in the consuming repository, typically through `scripts/review-gpt.config.sh`.

## Common Commands

```bash
# Run a named preset
cobuild-review-gpt --config scripts/review-gpt.config.sh --preset architecture

# Positional preset shorthand
cobuild-review-gpt architecture --config scripts/review-gpt.config.sh

# Add extra inline instructions
cobuild-review-gpt --config scripts/review-gpt.config.sh \
  --preset bugs \
  --prompt "Focus on auth edge cases and rollback behavior"

# Use a prompt file without repo artifacts
cobuild-review-gpt --config scripts/review-gpt.config.sh \
  --prompt-only \
  --prompt-file prompts/release-review.md

# Auto-send and wait for a captured response
cobuild-review-gpt --config scripts/review-gpt.config.sh \
  --wait \
  --response-file review-output.md

# Include or exclude configured test paths
cobuild-review-gpt --config scripts/review-gpt.config.sh --with-tests --preset bugs
cobuild-review-gpt --config scripts/review-gpt.config.sh --no-tests --preset bugs

# Deep Research mode
cobuild-review-gpt --config scripts/review-gpt.config.sh --deep-research --wait

# Re-open an existing thread
cobuild-review-gpt --config scripts/review-gpt.config.sh --chat 69a86c41-cca8-8327-975a-1716caa599cf
cobuild-review-gpt --config scripts/review-gpt.config.sh --chat-url https://chatgpt.com/c/69a86c41-cca8-8327-975a-1716caa599cf
```

Model selection defaults to `gpt-5.4-pro`. Use `--model` to override it. Versioned aliases such as `gpt-5.2-thinking` and `gpt-5.4-pro` still resolve correctly even when the ChatGPT picker currently shows generic rows like `Thinking`, `Instant`, and `Pro`. Thinking defaults to `current`. Deep Research mode uses the dedicated page and ignores normal model and thinking forcing.

By default, each run stages two artifacts: `repo.repomix.xml` as the primary review artifact and `repo.snapshot.zip` as the fidelity fallback. Use `--prompt-only` to disable both artifacts and stage only the prompt text.

## Repo Configuration

The config file is a sourced shell file that can override defaults, register preset mappings, and adjust path settings.

`review-gpt` packages repo context through its installed `@cobuild/repo-tools` dependency by default. Keep `package_script` only for an intentional repo-specific override.

Config helpers exposed by the package:

- `review_gpt_register_preset <name> <file> <description> [alias ...]`
- `review_gpt_register_dir_preset <name> <filename> <description> [alias ...]`
- `review_gpt_register_preset_group <name> <description> <preset ...>`

Each consuming repo must register its own presets. If the config does not register any presets, `--list-presets` reports none configured and any `--preset` use fails.

Recommended repo entry point:

```json
{
  "scripts": {
    "review:gpt": "cobuild-review-gpt --config scripts/review-gpt.config.sh"
  }
}
```

Use the package binary directly. Avoid repo-local wrapper scripts unless you have a concrete repo-specific need beyond passing `--config`.

The CLI still accepts preset shorthand tokens for the top-level command. `cobuild-review-gpt architecture` behaves like `cobuild-review-gpt --preset architecture`, while `thread wake ...` remains unchanged.

## Runtime Extras

In addition to the review workflow, the incur runtime also exposes:

- `cobuild-review-gpt completions <bash|zsh|fish>`
- `cobuild-review-gpt --llms`
- `cobuild-review-gpt skills add`
- `cobuild-review-gpt mcp add`

## Browser Notes

- `browser_binary_path` is the preferred config knob for the browser executable. `browser_chrome_path` remains supported for backward compatibility.
- Chromium-family browsers are supported as long as the binary is Chromium-compatible. Chrome, Brave, Chromium, Edge, and Vivaldi all work with the managed-profile launch flow.
- The launcher also checks `CHROME_PATH`, `BROWSER_BINARY_PATH`, and `--browser-path` for one-off browser overrides.
- The managed browser profile defaults to `$HOME/.review-gpt/managed-chromium`. If an older `$HOME/.oracle/remote-chrome` profile already exists, the launcher reuses it automatically instead of forcing a new sign-in.
- You can override the managed profile location with `managed_browser_user_data_dir` and the profile name with `managed_browser_profile`.
- On first run with a fresh managed profile, sign in to ChatGPT in the opened browser window once, then rerun the command.

## Response Capture

- `--wait` implies auto-send and uses a longer timeout budget: `10m` by default and `40m` in Deep Research mode.
- When `--wait` is enabled, `review-gpt` stays attached until the assistant finishes or the wait timeout is hit. Deep Research runs can stay quiet for a long time before the final report arrives.
- Deep Research auto-send gives the product up to 60 seconds to auto-start, then only falls back to the approval-card `Start` action if that gate is still present.
- Captured assistant output is printed between `REVIEW_GPT_RESPONSE_BEGIN` and `REVIEW_GPT_RESPONSE_END` markers so callers can parse it reliably.
- `--response-file <path>` writes the captured assistant response to a file after the run finishes.

## Thread Follow-Up

Thread helpers ship through the main CLI:

- `cobuild-review-gpt thread export --chat-url <url> --output <path>`
- `cobuild-review-gpt thread download --chat-url <url> --attachment-text <label> --output-dir <dir>`
- `cobuild-review-gpt thread wake --delay 70m --chat-url <url> --session-id <id>`
- `cobuild-review-gpt thread wake --delay 0s --no-poll-until-complete --chat-url <url> --session-id <id>`
- `cobuild-review-gpt thread wake --delay 0s --resume-prompt "<instructions>" --chat-url <url> --session-id <id>`

`thread export`, `thread download`, and `thread wake` require a full ChatGPT conversation URL such as `https://chatgpt.com/c/<thread-id>`. The plain home URL is rejected before browser automation starts.

For long-running ChatGPT work, these commands read an existing conversation from the same managed Chromium session, prefer final assistant-turn patch and file artifacts over earlier uploads, and can optionally launch a follow-up interactive Codex session later.

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

cobuild-review-gpt thread wake \
  --delay 0s \
  --no-poll-until-complete \
  --chat-url https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536 \
  --session-id 019d36e3-f6a2-7873-910a-2bdbd4f9748c

cobuild-review-gpt thread wake \
  --delay 0s \
  --chat-url https://chatgpt.com/c/69c71d43-0e38-8330-9df8-c4e10f5bf536 \
  --session-id 019d36e3-f6a2-7873-910a-2bdbd4f9748c \
  --resume-prompt "After applying the returned patch, run pnpm review:gpt --send against the requested ChatGPT review thread and ask for final bug and simplification feedback."
```

Resume notes:

- `cobuild-review-gpt thread wake` does not touch the managed browser until the configured `--delay` has elapsed, so scheduling a 60m or 100m follow-up does not immediately reopen or navigate the ChatGPT tab.
- Polling is enabled by default. After the initial delay, `thread wake` keeps re-exporting the thread until it no longer looks busy. `--poll-interval` defaults to `1m`, `--poll-timeout` can bound that wait, and `--no-poll-until-complete` restores the old one-shot behavior.
- After the delay elapses, thread export refreshes the existing ChatGPT tab, waits for the reload to finish, and requires real conversation signals before capture so generic ChatGPT chrome does not masquerade as a ready thread. Thread download keeps the hydrated tab alive and activates the visible attachment control inside the page before falling back to a native browser click.
- Thread export and download scope attachment discovery to the conversation body, ignore ChatGPT conversation links that only look like attachments, and prefer the final assistant turn when selecting patch or downloadable file artifacts.
- `thread download` still honors native browser downloads when ChatGPT emits them, but it also falls back to authenticated estuary fetches for inline assistant download controls such as combined patch buttons and native-download cases where the browser never materializes the file on disk.
- `cobuild-review-gpt thread wake` resolves the local `codex` executable itself, so `launchd`, `tmux`, `nohup`, and similar runs do not depend on your interactive shell `PATH`.
- `cobuild-review-gpt thread wake` captures the current working directory and launches a fresh interactive `codex` session with `-C` set to that repo directory, seeded with the built-in wake prompt and the downloaded local patch path.
- Wake submits that seeded prompt through a PTY-backed `expect` launch so the follow-up behaves like a real manual interactive Codex run instead of a piped child process.
- `--resume-prompt` appends extra instructions to the built-in Codex wake prompt instead of replacing the default export/download/apply guidance.
- If you omit `--codex-home`, the wake command searches `CODEX_HOME`, `~/.codex`, and `~/.codex-*` homes for evidence of the target session ID and refuses to resume if more than one home matches.
- If you already know the owner home, pass `--codex-home <path>` to skip discovery and make the resume target explicit.
- The supplied `--session-id` is only used to discover the owning `CODEX_HOME`; wake then starts a fresh interactive session in that same home instead of mutating the original session ID.
- `--full-auto` is now opt-in on `thread wake`; without it, the launched Codex session behaves like a normal manual interactive launch.
- Wake stores the exported thread, downloaded patch artifacts, and `status.json` alongside the follow-up launch.
- `--skip-resume` still exports the thread and downloads any patch attachments, but it does not launch the follow-up Codex session.
- If you want the sleep and wake process to survive terminal exit, run it under `nohup`, `tmux`, `screen`, `launchd`, or another supervisor.

## Local Package Iteration

For local package iteration, prefer package-manager linking or a local file dependency rather than wrapper-script fallbacks:

```bash
pnpm add -D file:../review-gpt
# or
pnpm link --global ../review-gpt
pnpm link --global @cobuild/review-gpt
```

## Release

This package is published as `@cobuild/review-gpt` on npm.

Release ownership note: release, version-bump, and publish actions are user-operated by default. Agents should not run release flows unless explicitly instructed in the current chat turn.

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
- verifies package scope `@cobuild/review-gpt`
- supports `check`, `pre*` bumps with `--preid`, and strict exact semver input
- uses `pnpm` versioning so `pnpm-lock.yaml` stays authoritative and `package-lock.json` is not recreated
- bumps version and updates `CHANGELOG.md`
- creates release commit `release: v<version>`, tags `v<version>`, and pushes `main` plus tags
- after push, waits for npm publish visibility and updates sibling repos under the configured sync root that depend directly on `@cobuild/review-gpt`

Release helpers resolve `@cobuild/repo-tools` from the installed dependency in `node_modules` first and fall back to the sibling `repo-tools` checkout in this workspace when testing unreleased shared tooling before the next publish.

You can skip the post-release sibling sync with `--no-sync-upstreams` or `REVIEW_GPT_SKIP_UPSTREAM_SYNC=1`.

Manual sync command:

```bash
pnpm run sync:repos -- --version 0.2.9 --wait-for-publish
```

Publishing is tag-driven in GitHub Actions at `.github/workflows/release.yml`:

- validates tag format and version match with `package.json`
- runs tests and checks, creates a tarball, and creates a GitHub Release with Codex-style notes
- publishes to npm via Trusted Publishing, including prerelease channel tags such as `alpha`, `beta`, and `rc`

Before first automated publish, configure npm Trusted Publisher for `@cobuild/review-gpt` to allow `cobuildwithus/review-gpt` GitHub Actions to publish.

Changelog helpers:

```bash
pnpm run changelog:update -- 0.1.1
pnpm run release:notes -- 0.1.1 /tmp/release-notes.md
```
