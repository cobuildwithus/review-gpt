#!/usr/bin/env bash
set -euo pipefail

export COBUILD_COMMITTER_EXAMPLE='fix(review-gpt): tighten selector fallback'
export COMMITTER_ALLOW_NON_CONVENTIONAL=1
export COBUILD_RELEASE_PACKAGE_NAME='@cobuild/review-gpt'
export COBUILD_RELEASE_REPOSITORY_URL='git+https://github.com/cobuildwithus/review-gpt.git'
export COBUILD_RELEASE_COMMIT_TEMPLATE='release: v%s'
export COBUILD_RELEASE_TAG_MESSAGE_TEMPLATE='release: v%s'
export COBUILD_RELEASE_POST_PUSH_CMD='./scripts/sync-dependent-repos.sh --version "$COBUILD_RELEASE_VERSION" --wait-for-publish'
export COBUILD_RELEASE_POST_PUSH_SKIP_ENV='REVIEW_GPT_SKIP_UPSTREAM_SYNC'

cobuild_repo_tool_bin() {
  local bin_name="$1"
  local root_dir local_bin

  root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local_bin="$root_dir/node_modules/.bin/$bin_name"

  # Prefer the repo's installed package so direct script invocations do not depend on pnpm.
  if [ -x "$local_bin" ]; then
    printf '%s\n' "$local_bin"
    return 0
  fi

  if command -v "$bin_name" >/dev/null 2>&1; then
    command -v "$bin_name"
    return 0
  fi

  echo "Error: missing repo-tools executable '$bin_name'. Install dependencies first." >&2
  return 1
}
