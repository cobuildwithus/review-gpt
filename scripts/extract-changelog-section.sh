#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOT'
Usage: scripts/extract-changelog-section.sh <version> <output-file>

Extracts one release section from CHANGELOG.md and writes it to output-file.
EOT
}

if [ "$#" -ne 2 ]; then
  usage >&2
  exit 1
fi

version="$1"
out_path="$2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [ ! -f CHANGELOG.md ]; then
  echo "Error: CHANGELOG.md not found." >&2
  exit 1
fi

if ! awk -v version="$version" '
BEGIN { found=0; in_section=0 }
$0 ~ "^## \\[" version "\\] -" {
  found=1
  in_section=1
  print
  next
}
in_section && /^## \[/ {
  exit
}
in_section {
  print
}
END {
  if (!found) exit 2
}
' CHANGELOG.md > "$out_path"; then
  status=$?
  if [ "$status" -eq 2 ]; then
    echo "Error: no CHANGELOG section found for version $version." >&2
  fi
  exit "$status"
fi
