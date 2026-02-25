#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOT'
Usage: scripts/release.sh <patch|minor|major|x.y.z[-prerelease]> [--dry-run] [--no-push]

Prepares a release for @cobuild/review-gpt by:
  1) running release checks
  2) bumping package version (without auto commit/tag)
  3) updating CHANGELOG.md for the new version
  4) committing release metadata and creating git tag v<version>
  5) optionally pushing main + tags

Publishing is handled by the GitHub Actions tag-release workflow.

Options:
  --dry-run   Validate and compute next version without creating commit/tag
  --no-push   Create commit/tag locally, but do not push
  -h, --help  Show help
EOT
}

if [ "$#" -lt 1 ]; then
  usage >&2
  exit 1
fi

bump_arg=""
dry_run=0
no_push=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    patch|minor|major)
      if [ -n "$bump_arg" ]; then
        echo "Error: multiple version bump arguments provided." >&2
        exit 1
      fi
      bump_arg="$1"
      shift
      ;;
    [0-9]*.[0-9]*.[0-9]*|[0-9]*.[0-9]*.[0-9]*-*)
      if [ -n "$bump_arg" ]; then
        echo "Error: multiple version bump arguments provided." >&2
        exit 1
      fi
      bump_arg="$1"
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --no-push)
      no_push=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'." >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$bump_arg" ]; then
  echo "Error: missing version bump argument." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: git working tree must be clean before release." >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "Error: releases must run from main (current: $branch)." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Error: git remote 'origin' is not configured." >&2
  exit 1
fi

package_name="$(node -p "require('./package.json').name")"
if [ "$package_name" != "@cobuild/review-gpt" ]; then
  echo "Error: unexpected package name '$package_name' (expected @cobuild/review-gpt)." >&2
  exit 1
fi

echo "Running release checks..."
npm run release:check

current_version="$(node -p "require('./package.json').version")"
echo "Current version: $current_version"

next_tag="$(npm version "$bump_arg" --no-git-tag-version)"
next_version="${next_tag#v}"

if [ "$dry_run" -eq 1 ]; then
  git restore package.json >/dev/null 2>&1 || true
  echo "Dry run only."
  echo "Would prepare release: $package_name@$next_version"
  echo "Would create tag: v$next_version"
  exit 0
fi

echo "Updating CHANGELOG.md for $next_version..."
"$SCRIPT_DIR/update-changelog.sh" "$next_version"

git add package.json CHANGELOG.md
git commit -m "release: v$next_version"
git tag -a "v$next_version" -m "release: v$next_version"

if [ "$no_push" -eq 1 ]; then
  echo "Release prepared locally. Skipping push (--no-push)."
else
  echo "Pushing main + tags to origin..."
  git push origin main --follow-tags
fi

echo "Release prepared: $package_name@$next_version"
echo "GitHub Actions will publish tag v$next_version to npm."
