#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOT'
Usage:
  scripts/review-gpt-ensure-published.sh [--version <x.y.z[-tag.n]>]

Defaults to the latest published @cobuild/review-gpt version when --version is omitted.
EOT
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PACKAGE_NAME="@cobuild/review-gpt"
TARGET_VERSION=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      if [ "$#" -lt 2 ]; then
        echo "Error: missing value for --version." >&2
        exit 2
      fi
      TARGET_VERSION="$2"
      shift 2
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

cd "$REPO_ROOT"

dep_ref="$({
  node -e '
const fs = require("node:fs");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packageName = "@cobuild/review-gpt";
if (packageJson.dependencies && typeof packageJson.dependencies[packageName] === "string") {
  process.stdout.write(`dependencies:${packageJson.dependencies[packageName]}`);
  process.exit(0);
}
if (packageJson.devDependencies && typeof packageJson.devDependencies[packageName] === "string") {
  process.stdout.write(`devDependencies:${packageJson.devDependencies[packageName]}`);
  process.exit(0);
}
'
} || true)"

if [[ -z "$dep_ref" ]]; then
  exit 0
fi

section="${dep_ref%%:*}"
current_spec="${dep_ref#*:}"
if [[ -n "$TARGET_VERSION" ]]; then
  latest_version="$TARGET_VERSION"
else
  latest_version="$(pnpm view "$PACKAGE_NAME" version --json | tr -d '"[:space:]')"
fi
if [[ -z "$latest_version" ]]; then
  echo "Failed to resolve target published version for $PACKAGE_NAME." >&2
  exit 1
fi

if ! [[ "$latest_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: invalid target version '$latest_version'." >&2
  exit 2
fi

target_spec="^$latest_version"
if [[ "$current_spec" == "$target_spec" ]]; then
  exit 0
fi

pnpm pkg set "$section.$PACKAGE_NAME=$target_spec"
pnpm install --lockfile-only

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add package.json
  if [[ -f pnpm-lock.yaml ]]; then
    git add pnpm-lock.yaml
  fi
fi

if [[ "$current_spec" == link:* ]] || [[ "$current_spec" == file:* ]] || [[ "$current_spec" == workspace:* ]] || [[ "$current_spec" == *"../review-gpt-cli"* ]]; then
  echo "Replaced local $PACKAGE_NAME spec ($current_spec) with $target_spec."
else
  echo "Updated $PACKAGE_NAME from $current_spec to $target_spec."
fi
