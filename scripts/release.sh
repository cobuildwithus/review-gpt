#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOT'
Usage:
  scripts/release.sh check
  scripts/release.sh <patch|minor|major|prepatch|preminor|premajor|prerelease|x.y.z[-channel.n]> [--preid <alpha|beta|rc>] [--dry-run] [--no-push] [--allow-non-main]

Prepares a release for @cobuild/review-gpt by:
  1) running release checks
  2) bumping package version (without auto commit/tag)
  3) updating CHANGELOG.md for the new version
  4) committing release metadata and creating git tag v<version>
  5) optionally pushing main + tags

Publishing is handled by the GitHub Actions tag-release workflow.

Options:
  --preid           Pre-release channel for pre* bumps (alpha|beta|rc)
  --dry-run         Validate and compute next version without creating commit/tag
  --no-push         Create commit/tag locally, but do not push
  --allow-non-main  Permit running outside main
  -h, --help        Show help
EOT
}

ACTION="${1:-}"
if [ -z "$ACTION" ]; then
  usage >&2
  exit 1
fi
shift || true

PREID=""
DRY_RUN=false
PUSH_TAGS=true
ALLOW_NON_MAIN=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --preid)
      if [ "$#" -lt 2 ]; then
        echo "Error: missing value for --preid." >&2
        exit 2
      fi
      PREID="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      PUSH_TAGS=false
      shift
      ;;
    --no-push)
      PUSH_TAGS=false
      shift
      ;;
    --allow-non-main)
      ALLOW_NON_MAIN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'." >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

assert_clean_worktree() {
  if [ -n "$(git status --porcelain)" ]; then
    echo "Error: git working tree must be clean before release." >&2
    exit 1
  fi
}

assert_main_branch() {
  if [ "$ALLOW_NON_MAIN" = true ]; then
    return
  fi
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "main" ]; then
    echo "Error: releases must run from main (current: $branch)." >&2
    exit 1
  fi
}

assert_origin_remote() {
  if ! git remote get-url origin >/dev/null 2>&1; then
    echo "Error: git remote 'origin' is not configured." >&2
    exit 1
  fi
}

assert_package_name() {
  package_name="$(node -p "require('./package.json').name")"
  if [ "$package_name" != "@cobuild/review-gpt" ]; then
    echo "Error: unexpected package name '$package_name' (expected @cobuild/review-gpt)." >&2
    exit 1
  fi
}

run_release_checks() {
  echo "Running release checks..."
  npm run release:check
}

is_exact_version() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]]
}

resolve_npm_tag() {
  local version="$1"
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo ""
    return 0
  fi
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$ ]]; then
    echo "alpha"
    return 0
  fi
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]]; then
    echo "beta"
    return 0
  fi
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]]; then
    echo "rc"
    return 0
  fi
  echo "Unsupported release version format: $version" >&2
  echo "Expected x.y.z or x.y.z-(alpha|beta|rc).n" >&2
  exit 1
}

if [ "$ACTION" = "check" ]; then
  assert_package_name
  run_release_checks
  echo "Release checks passed."
  exit 0
fi

case "$ACTION" in
  patch|minor|major|prepatch|preminor|premajor|prerelease)
    ;;
  *)
    if ! is_exact_version "$ACTION"; then
      echo "Error: unsupported release action or version '$ACTION'." >&2
      usage >&2
      exit 2
    fi
    ;;
esac

if [ -n "$PREID" ]; then
  if ! [[ "$PREID" =~ ^(alpha|beta|rc)$ ]]; then
    echo "Error: --preid must be one of alpha|beta|rc." >&2
    exit 2
  fi

  case "$ACTION" in
    prepatch|preminor|premajor|prerelease)
      ;;
    *)
      echo "Error: --preid is only valid with prepatch/preminor/premajor/prerelease." >&2
      exit 2
      ;;
  esac
fi

assert_clean_worktree
assert_main_branch
assert_origin_remote
assert_package_name
run_release_checks

current_version="$(node -p "require('./package.json').version")"
echo "Current version: $current_version"

npm_version_args=("$ACTION" "--no-git-tag-version")
if [ -n "$PREID" ]; then
  npm_version_args+=("--preid" "$PREID")
fi

next_tag="$(npm version "${npm_version_args[@]}" | tail -n1 | tr -d '\r')"
next_version="${next_tag#v}"
npm_dist_tag="$(resolve_npm_tag "$next_version")"
if [ -n "$npm_dist_tag" ]; then
  echo "Release channel: $npm_dist_tag"
else
  echo "Release channel: latest"
fi

if [ "$DRY_RUN" = true ]; then
  git restore --worktree --staged package.json >/dev/null 2>&1 || true
  echo "Dry run only."
  echo "Would prepare release: @cobuild/review-gpt@$next_version"
  echo "Would create tag: v$next_version"
  exit 0
fi

echo "Updating CHANGELOG.md for $next_version..."
"$SCRIPT_DIR/update-changelog.sh" "$next_version"

git add package.json CHANGELOG.md
git commit -m "release: v$next_version"
git tag -a "v$next_version" -m "release: v$next_version"

if [ "$PUSH_TAGS" = true ]; then
  echo "Pushing main + tags to origin..."
  git push origin main --follow-tags
else
  echo "Release prepared locally. Skipping push."
fi

echo "Release prepared: @cobuild/review-gpt@$next_version"
echo "GitHub Actions will publish tag v$next_version to npm."
