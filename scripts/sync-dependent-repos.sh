#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source scripts/repo-tools.config.sh

args=(
  --package @cobuild/review-gpt
  --root "${REVIEW_GPT_SYNC_ROOT:-$ROOT_DIR/..}"
)

if [ -n "${REVIEW_GPT_SYNC_REPOS:-}" ]; then
  args+=(--repos "$REVIEW_GPT_SYNC_REPOS")
fi

if [ -n "${REVIEW_GPT_SYNC_WAIT_TIMEOUT_SEC:-}" ]; then
  args+=(--timeout-sec "$REVIEW_GPT_SYNC_WAIT_TIMEOUT_SEC")
fi

if [ -n "${REVIEW_GPT_SYNC_WAIT_INTERVAL_SEC:-}" ]; then
  args+=(--interval-sec "$REVIEW_GPT_SYNC_WAIT_INTERVAL_SEC")
fi

exec "$(cobuild_repo_tool_bin cobuild-sync-dependent-repos)" "${args[@]}" "$@"
