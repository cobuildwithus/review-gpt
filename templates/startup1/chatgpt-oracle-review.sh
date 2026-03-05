#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_REVIEW_GPT_ROOT="${REVIEW_GPT_LOCAL_DIR:-$SCRIPT_DIR/../../review-gpt-cli}"
LOCAL_REVIEW_GPT_BIN="$LOCAL_REVIEW_GPT_ROOT/bin/cobuild-review-gpt"

repo_declares_review_gpt_dep() {
  node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const name = "@cobuild/review-gpt";
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
process.exit(sections.some((section) => pkg[section] && typeof pkg[section][name] === "string") ? 0 : 1);
' "$REPO_ROOT/package.json"
}

if [ "${1-}" = "--" ]; then
  shift
fi

if [ "${REVIEW_GPT_USE_LOCAL:-0}" = "1" ]; then
  if [ -x "$LOCAL_REVIEW_GPT_BIN" ]; then
    exec "$LOCAL_REVIEW_GPT_BIN" --config "$SCRIPT_DIR/review-gpt.config.sh" "$@"
  fi
  echo "Error: REVIEW_GPT_USE_LOCAL=1 but local cobuild-review-gpt was not found at $LOCAL_REVIEW_GPT_BIN" >&2
  exit 1
fi

if command -v pnpm >/dev/null 2>&1 && repo_declares_review_gpt_dep; then
  exec pnpm exec cobuild-review-gpt --config "$SCRIPT_DIR/review-gpt.config.sh" "$@"
fi

if command -v cobuild-review-gpt >/dev/null 2>&1; then
  exec cobuild-review-gpt --config "$SCRIPT_DIR/review-gpt.config.sh" "$@"
fi

if [ "${REVIEW_GPT_USE_PUBLISHED:-0}" = "1" ]; then
  echo "Error: REVIEW_GPT_USE_PUBLISHED=1 but published cobuild-review-gpt was not available." >&2
  exit 1
fi

if [ -x "$LOCAL_REVIEW_GPT_BIN" ]; then
  echo "Warning: falling back to local review-gpt-cli checkout at $LOCAL_REVIEW_GPT_ROOT" >&2
  exec "$LOCAL_REVIEW_GPT_BIN" --config "$SCRIPT_DIR/review-gpt.config.sh" "$@"
fi

echo "Error: cobuild-review-gpt is not available. Install dependencies first." >&2
exit 1
