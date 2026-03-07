# AGENTS.md

## Purpose

This file sets the working rules for agent changes in `review-gpt`.
Keep it lightweight. Prefer direct execution over process overhead.

## Precedence

1. Explicit user instruction in the current chat turn.
2. `Hard Rules` in this file.
3. Everything else in this file.

If those conflict, ask before acting.

## Hard Rules

- Never access `.env` or `.env*` files.
- Never print or commit full secrets, tokens, or raw `Authorization` headers.
- Do not run release, publish, or tag-push flows unless the user explicitly asks in the current turn.
- Never revert or overwrite edits you did not make unless the user explicitly asks.
- When changing CLI behavior, keep `README.md` and help text aligned in the same change.
- Use `pnpm` for installs, script execution, and lockfile management in this repo. Do not introduce `package-lock.json`.

## How To Work

- Keep changes small and pragmatic.
- Prefer editing the package directly over adding process docs or scaffolding.
- If the CLI surface or release flow changes, update the matching shell scripts, tests, and docs together.
- If a task is done in the same turn and checks are green, agents are expected to autocommit.

## Commit And Handoff

- Same-turn completion counts as acceptance unless the user says `review first` or `do not commit`.
- Use `scripts/committer` only; do not use manual `git commit`.
- Use Conventional Commits for agent-authored commit messages.
- Commit only the files touched in the current turn.

## Required Checks

- Always run:
  - `pnpm typecheck`
  - `pnpm test`
- If release scripts, package metadata, or release docs changed, also run:
  - `pnpm release:check`
