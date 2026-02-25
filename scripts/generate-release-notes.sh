#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOT'
Usage: scripts/generate-release-notes.sh <version> <output-file> [--from-tag <tag>] [--to-ref <ref>]

Generates Codex-style release notes with sections:
- New Features
- Bug Fixes
- Documentation
- Changelog (with full commit list)
EOT
}

if [ "$#" -lt 2 ]; then
  usage >&2
  exit 1
fi

version="$1"
output_path="$2"
shift 2

from_tag=""
to_ref=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from-tag)
      from_tag="$2"
      shift 2
      ;;
    --to-ref)
      to_ref="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: version must be semantic (e.g. 1.2.3 or 1.2.3-alpha.1)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

release_tag="v$version"

if [ -z "$to_ref" ]; then
  if git rev-parse -q --verify "refs/tags/$release_tag" >/dev/null 2>&1; then
    to_ref="$release_tag"
  else
    to_ref="HEAD"
  fi
fi

if [ -z "$from_tag" ]; then
  if [ "$to_ref" = "$release_tag" ]; then
    from_tag="$(git describe --tags --abbrev=0 --match 'v*' "${release_tag}^" 2>/dev/null || true)"
  else
    from_tag="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
  fi
fi

if [ -n "$from_tag" ]; then
  range="${from_tag}..${to_ref}"
else
  range="$to_ref"
fi

declare -a features

declare -a fixes

declare -a docs

declare -a commit_lines

while IFS=$'\t' read -r sha subject; do
  [ -z "$sha" ] && continue
  [ -z "$subject" ] && continue

  type=""
  text="$subject"
  if printf '%s\n' "$subject" | grep -Eq '^[A-Za-z0-9_-]+(\([^)]*\))?!?:[[:space:]]*'; then
    type="$(printf '%s\n' "$subject" | sed -E 's/^([A-Za-z0-9_-]+)(\([^)]*\))?!?:[[:space:]]*.*/\1/' | tr '[:upper:]' '[:lower:]')"
    text="$(printf '%s\n' "$subject" | sed -E 's/^[A-Za-z0-9_-]+(\([^)]*\))?!?:[[:space:]]*//')"
  fi

  short_sha="$(printf '%s' "$sha" | cut -c1-7)"
  commit_lines+=("- $subject ($short_sha)")

  case "$type" in
    feat)
      features+=("- $text")
      ;;
    fix)
      fixes+=("- $text")
      ;;
    docs)
      docs+=("- $text")
      ;;
  esac
done <<EOF_LOG
$(git log --no-merges --pretty=format:'%H%x09%s' $range)
EOF_LOG

mkdir -p "$(dirname "$output_path")"

{
  echo "$version Latest"

  echo "New Features"
  if [ ${#features[@]} -gt 0 ]; then
    printf '%s\n' "${features[@]}"
  else
    echo "- No major feature additions in this release."
  fi

  echo "Bug Fixes"
  if [ ${#fixes[@]} -gt 0 ]; then
    printf '%s\n' "${fixes[@]}"
  else
    echo "- No major bug fixes called out in this release."
  fi

  echo "Documentation"
  if [ ${#docs[@]} -gt 0 ]; then
    printf '%s\n' "${docs[@]}"
  else
    echo "- No documentation-specific changes called out in this release."
  fi

  echo "Changelog"
  if [ -n "$from_tag" ]; then
    echo "Full Changelog: ${from_tag}...${release_tag}"
  else
    echo "Full Changelog: initial release"
  fi
  echo

  if [ ${#commit_lines[@]} -gt 0 ]; then
    printf '%s\n' "${commit_lines[@]}"
  else
    echo "- No commits found for release range (${range})."
  fi
} > "$output_path"

echo "Generated release notes: $output_path"
