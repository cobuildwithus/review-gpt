#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source scripts/repo-tools.config.sh
# `pnpm run ...` can forward pnpm-only config keys into nested npm commands.
# Clear them here so the shared release tool's npm calls stay quiet.
unset npm_config_store_dir NPM_CONFIG_STORE_DIR || true
exec "$(cobuild_repo_tool_bin cobuild-release-package)" "$@"
