#!/usr/bin/env bash
set -euo pipefail

COBUILD_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

consumer_shell_path=""
for candidate in \
  "$COBUILD_REPO_ROOT/node_modules/@cobuild/repo-tools/src/consumer-shell.sh" \
  "$COBUILD_REPO_ROOT/../repo-tools/src/consumer-shell.sh"
do
  if [ -f "$candidate" ]; then
    consumer_shell_path="$candidate"
    break
  fi
done

if [ -z "$consumer_shell_path" ]; then
  echo "Error: missing repo-tools consumer shell helper. Install dependencies first." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$consumer_shell_path"

export COBUILD_COMMITTER_EXAMPLE='fix(review-gpt): tighten selector fallback'
export COBUILD_RELEASE_PACKAGE_NAME='@cobuild/review-gpt'
export COBUILD_RELEASE_REPOSITORY_URL='git+https://github.com/cobuildwithus/review-gpt.git'
export COBUILD_RELEASE_COMMIT_TEMPLATE='release: v%s'
export COBUILD_RELEASE_TAG_MESSAGE_TEMPLATE='release: v%s'
export COBUILD_RELEASE_POST_PUSH_CMD='./scripts/sync-dependent-repos.sh --version "$COBUILD_RELEASE_VERSION" --wait-for-publish'
export COBUILD_RELEASE_POST_PUSH_SKIP_ENV='REVIEW_GPT_SKIP_UPSTREAM_SYNC'
