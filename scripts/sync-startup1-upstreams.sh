#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOT'
Usage:
  scripts/sync-startup1-upstreams.sh --version <x.y.z[-channel.n]> [options]

Updates sibling startup repos to a specific @cobuild/review-gpt version.

Options:
  --version <version>     Required target package version
  --root <path>           Root containing sibling repos (default: parent of this repo)
  --repos <csv>           Comma-separated repo names
  --wait-for-publish      Wait until npm reports package@version before updating repos
  --timeout-sec <n>       Max seconds to wait for publish (default: 600)
  --interval-sec <n>      Poll interval while waiting (default: 10)
  --dry-run               Print planned actions without running pnpm
  -h, --help              Show this help text

Environment overrides:
  REVIEW_GPT_SYNC_ROOT
  REVIEW_GPT_SYNC_REPOS
  REVIEW_GPT_SYNC_WAIT_TIMEOUT_SEC
  REVIEW_GPT_SYNC_WAIT_INTERVAL_SEC
EOT
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE_ROOT="$ROOT/templates/startup1"

PACKAGE_NAME="$(node -p "require(process.argv[1]).name" "$ROOT/package.json")"
DEFAULT_SYNC_ROOT="$(cd "$ROOT/.." && pwd)"

TARGET_VERSION=""
SYNC_ROOT="${REVIEW_GPT_SYNC_ROOT:-$DEFAULT_SYNC_ROOT}"
REPO_CSV="${REVIEW_GPT_SYNC_REPOS:-v1-core,interface,cli,chat-api,wire,indexer}"
WAIT_FOR_PUBLISH=0
WAIT_TIMEOUT_SEC="${REVIEW_GPT_SYNC_WAIT_TIMEOUT_SEC:-600}"
WAIT_INTERVAL_SEC="${REVIEW_GPT_SYNC_WAIT_INTERVAL_SEC:-10}"
DRY_RUN=0

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
    --root)
      if [ "$#" -lt 2 ]; then
        echo "Error: missing value for --root." >&2
        exit 2
      fi
      SYNC_ROOT="$2"
      shift 2
      ;;
    --repos)
      if [ "$#" -lt 2 ]; then
        echo "Error: missing value for --repos." >&2
        exit 2
      fi
      REPO_CSV="$2"
      shift 2
      ;;
    --wait-for-publish)
      WAIT_FOR_PUBLISH=1
      shift
      ;;
    --timeout-sec)
      if [ "$#" -lt 2 ]; then
        echo "Error: missing value for --timeout-sec." >&2
        exit 2
      fi
      WAIT_TIMEOUT_SEC="$2"
      shift 2
      ;;
    --interval-sec)
      if [ "$#" -lt 2 ]; then
        echo "Error: missing value for --interval-sec." >&2
        exit 2
      fi
      WAIT_INTERVAL_SEC="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
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

if [ -z "$TARGET_VERSION" ]; then
  echo "Error: --version is required." >&2
  usage >&2
  exit 2
fi

if ! [[ "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: invalid --version '$TARGET_VERSION' (expected semantic version)." >&2
  exit 2
fi

if ! [[ "$WAIT_TIMEOUT_SEC" =~ ^[0-9]+$ ]] || ! [[ "$WAIT_INTERVAL_SEC" =~ ^[0-9]+$ ]] || [ "$WAIT_INTERVAL_SEC" -le 0 ]; then
  echo "Error: --timeout-sec and --interval-sec must be positive integers." >&2
  exit 2
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required to update sibling repositories." >&2
  exit 1
fi

if [ "$WAIT_FOR_PUBLISH" -eq 1 ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is required for --wait-for-publish checks." >&2
    exit 1
  fi
  package_spec="${PACKAGE_NAME}@${TARGET_VERSION}"
  deadline=$(( $(date +%s) + WAIT_TIMEOUT_SEC ))
  while true; do
    if npm view "$package_spec" version --silent >/dev/null 2>&1; then
      echo "Publish detected: $package_spec"
      break
    fi
    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      echo "Error: timed out waiting for npm publish of $package_spec." >&2
      exit 1
    fi
    echo "Waiting for npm publish: $package_spec"
    sleep "$WAIT_INTERVAL_SEC"
  done
fi

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

repo_has_dep() {
  local package_json="$1"
  local dep_name="$2"
  node -e '
const [packagePath, dep] = process.argv.slice(1);
const pkg = require(packagePath);
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const hasDep = sections.some((section) => pkg[section] && Object.prototype.hasOwnProperty.call(pkg[section], dep));
process.exit(hasDep ? 0 : 1);
' "$package_json" "$dep_name"
}

sync_repo_templates() {
  local repo_dir="$1"
  local wrapper_template="$TEMPLATE_ROOT/chatgpt-oracle-review.sh"
  local ensure_template="$TEMPLATE_ROOT/review-gpt-ensure-published.sh"
  local wrapper_target="$repo_dir/scripts/chatgpt-oracle-review.sh"
  local ensure_target="$repo_dir/scripts/review-gpt-ensure-published.sh"

  if [ ! -f "$wrapper_template" ] || [ ! -f "$ensure_template" ]; then
    echo "Error: startup1 wrapper templates are missing under $TEMPLATE_ROOT." >&2
    return 1
  fi

  mkdir -p "$repo_dir/scripts"
  cp "$wrapper_template" "$wrapper_target"
  cp "$ensure_template" "$ensure_target"
  chmod +x "$wrapper_target" "$ensure_target"
}

IFS=',' read -r -a repos_raw <<<"$REPO_CSV"
repos=()
for token in "${repos_raw[@]}"; do
  repo_name="$(trim "$token")"
  if [ -n "$repo_name" ]; then
    repos+=("$repo_name")
  fi
done

if [ "${#repos[@]}" -eq 0 ]; then
  echo "Error: no repos resolved from --repos input." >&2
  exit 2
fi

echo "Sync root: $SYNC_ROOT"
echo "Target package: ${PACKAGE_NAME}@${TARGET_VERSION}"
echo "Repo set: ${repos[*]}"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "Mode: dry-run"
fi

updated_repos=()
skipped_repos=()
failed_repos=()

for repo in "${repos[@]}"; do
  repo_dir="$SYNC_ROOT/$repo"
  package_json="$repo_dir/package.json"

  if [ ! -d "$repo_dir" ]; then
    echo "Skip $repo: repo directory not found ($repo_dir)"
    skipped_repos+=("$repo")
    continue
  fi

  if [ ! -f "$package_json" ]; then
    echo "Skip $repo: package.json not found"
    skipped_repos+=("$repo")
    continue
  fi

  if ! repo_has_dep "$package_json" "$PACKAGE_NAME"; then
    echo "Skip $repo: $PACKAGE_NAME is not a direct dependency"
    skipped_repos+=("$repo")
    continue
  fi

  update_cmd=(pnpm up "${PACKAGE_NAME}@${TARGET_VERSION}")
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "Would update $repo: (cd $repo_dir && ${update_cmd[*]})"
    echo "Would sync wrapper templates into $repo/scripts/"
    continue
  fi

  echo "Updating $repo..."
  if ! (cd "$repo_dir" && "${update_cmd[@]}"); then
    echo "Error: failed updating $repo" >&2
    failed_repos+=("$repo")
    continue
  fi

  if ! sync_repo_templates "$repo_dir"; then
    echo "Error: failed syncing wrapper templates for $repo" >&2
    failed_repos+=("$repo")
    continue
  fi

  updated_repos+=("$repo")
done

echo "Updated repos (${#updated_repos[@]}): ${updated_repos[*]:-(none)}"
echo "Skipped repos (${#skipped_repos[@]}): ${skipped_repos[*]:-(none)}"
echo "Failed repos (${#failed_repos[@]}): ${failed_repos[*]:-(none)}"

if [ "${#failed_repos[@]}" -gt 0 ]; then
  exit 1
fi
