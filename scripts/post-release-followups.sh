#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

sync_cmd="${REVIEW_GPT_POST_RELEASE_SYNC_CMD:-./scripts/sync-dependent-repos.sh}"

set +e
"$sync_cmd" "$@"
sync_status=$?
set -e

if [ "$sync_status" -ne 0 ]; then
  echo "Warning: @cobuild/review-gpt published successfully, but downstream repo sync failed (exit $sync_status)." >&2
  echo "Run pnpm run sync:repos -- $* after npm visibility and sibling repo state are ready." >&2
fi

exit 0
