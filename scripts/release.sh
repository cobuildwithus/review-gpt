#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/release.sh <patch|minor|major|x.y.z> [--dry-run] [--no-push]

Releases @cobuild/review-gpt by:
  1) verifying local repo/auth state
  2) bumping package version (commit + git tag via npm version)
  3) publishing to npm as public scoped package
  4) pushing main and tags

Options:
  --dry-run   Validate and compute next version without creating commit/tag/publish
  --no-push   Publish but skip pushing git commits/tags
  -h, --help  Show help
EOF
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
    [0-9]*.[0-9]*.[0-9]*)
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
  echo "Error: missing version bump argument (patch|minor|major|x.y.z)." >&2
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
if [[ "$package_name" != @cobuild/* ]]; then
  echo "Error: package must be scoped to @cobuild (found: $package_name)." >&2
  exit 1
fi

if [ "$package_name" != "@cobuild/review-gpt" ]; then
  echo "Error: unexpected package name '$package_name' (expected @cobuild/review-gpt)." >&2
  exit 1
fi

if ! npm whoami >/dev/null 2>&1; then
  echo "Error: npm auth missing. Run 'npm login' and retry." >&2
  exit 1
fi

echo "Running release checks..."
bash -n src/review-gpt.sh
npm pack --dry-run >/dev/null

current_version="$(node -p "require('./package.json').version")"
echo "Current version: $current_version"

if [ "$dry_run" -eq 1 ]; then
  next_tag="$(npm version "$bump_arg" --no-git-tag-version)"
  next_version="${next_tag#v}"
  git restore package.json >/dev/null 2>&1 || true
  echo "Dry run only."
  echo "Would release: $package_name@$next_version"
  exit 0
fi

echo "Bumping version ($bump_arg)..."
new_tag="$(npm version "$bump_arg" -m "release: v%s")"
new_version="${new_tag#v}"

echo "Publishing $package_name@$new_version to npm..."
npm publish --access public

if [ "$no_push" -eq 1 ]; then
  echo "Skipping git push (--no-push)."
else
  echo "Pushing main + tags to origin..."
  git push origin main --follow-tags
fi

echo "Release complete: $package_name@$new_version"
