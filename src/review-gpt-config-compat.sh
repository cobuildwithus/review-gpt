#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: review-gpt-config-compat.sh <repo-root> <config-path>" >&2
  exit 2
fi

REVIEW_GPT_ROOT="$1"
CONFIG_PATH="$2"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Error: required file not found: $CONFIG_PATH" >&2
  exit 1
fi

normalize_token() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}

find_preset_index() {
  local candidate="$1"
  local index
  for index in "${!preset_names[@]}"; do
    if [ "${preset_names[$index]}" = "$candidate" ]; then
      printf '%s\n' "$index"
      return 0
    fi
  done
  return 1
}

find_preset_alias_target() {
  local candidate="$1"
  local index
  for index in "${!preset_alias_inputs[@]}"; do
    if [ "${preset_alias_inputs[$index]}" = "$candidate" ]; then
      printf '%s\n' "${preset_alias_targets[$index]}"
      return 0
    fi
  done
  return 1
}

find_preset_group_index() {
  local candidate="$1"
  local index
  for index in "${!preset_group_names[@]}"; do
    if [ "${preset_group_names[$index]}" = "$candidate" ]; then
      printf '%s\n' "$index"
      return 0
    fi
  done
  return 1
}

resolve_registered_preset_name() {
  local token="$1"
  if find_preset_index "$token" >/dev/null 2>&1; then
    printf '%s\n' "$token"
    return 0
  fi
  if find_preset_alias_target "$token" >/dev/null 2>&1; then
    find_preset_alias_target "$token"
    return 0
  fi
  return 1
}

review_gpt_register_alias() {
  local alias_name canonical_name existing_target index
  alias_name="$(normalize_token "${1:-}")"
  canonical_name="$(normalize_token "${2:-}")"

  if [ -z "$alias_name" ] || [ -z "$canonical_name" ]; then
    echo "Error: preset alias registration requires alias and canonical name." >&2
    exit 1
  fi

  if ! find_preset_index "$canonical_name" >/dev/null 2>&1; then
    echo "Error: preset alias '$alias_name' targets unknown preset '$canonical_name'." >&2
    exit 1
  fi

  existing_target="$(find_preset_alias_target "$alias_name" || true)"
  if [ -n "$existing_target" ]; then
    if [ "$existing_target" != "$canonical_name" ]; then
      echo "Error: preset alias '$alias_name' already maps to '$existing_target'." >&2
      exit 1
    fi
    return 0
  fi

  for index in "${!preset_group_names[@]}"; do
    if [ "${preset_group_names[$index]}" = "$alias_name" ]; then
      echo "Error: preset alias '$alias_name' conflicts with preset group '$alias_name'." >&2
      exit 1
    fi
  done

  preset_alias_inputs+=("$alias_name")
  preset_alias_targets+=("$canonical_name")
}

review_gpt_register_preset() {
  local name path description alias index
  name="$(normalize_token "${1:-}")"
  path="${2:-}"
  description="${3:-}"
  shift 3 || true

  if [ -z "$name" ] || [ -z "$path" ]; then
    echo "Error: preset registration requires name and file path." >&2
    exit 1
  fi

  if find_preset_index "$name" >/dev/null 2>&1; then
    echo "Error: preset '$name' is already registered." >&2
    exit 1
  fi

  for index in "${!preset_group_names[@]}"; do
    if [ "${preset_group_names[$index]}" = "$name" ]; then
      echo "Error: preset '$name' conflicts with preset group '$name'." >&2
      exit 1
    fi
  done

  preset_names+=("$name")
  preset_paths+=("$path")
  preset_descriptions+=("$description")
  review_gpt_register_alias "$name" "$name"

  for alias in "$@"; do
    alias="$(normalize_token "$alias")"
    if [ -n "$alias" ]; then
      review_gpt_register_alias "$alias" "$name"
    fi
  done
}

review_gpt_register_dir_preset() {
  local name filename description path
  name="${1:-}"
  filename="${2:-}"
  description="${3:-}"
  shift 3 || true

  if [ -z "$filename" ]; then
    echo "Error: directory preset registration requires a filename." >&2
    exit 1
  fi

  if [[ "$filename" == /* ]]; then
    path="$filename"
  elif [ -n "${preset_dir:-}" ]; then
    path="$preset_dir/$filename"
  else
    path="$filename"
  fi

  review_gpt_register_preset "$name" "$path" "$description" "$@"
}

review_gpt_register_preset_group() {
  local name description members index member resolved_member
  name="$(normalize_token "${1:-}")"
  description="${2:-}"
  shift 2 || true
  members=("$@")

  if [ -z "$name" ] || [ "${#members[@]}" -eq 0 ]; then
    echo "Error: preset group registration requires a name and at least one member." >&2
    exit 1
  fi

  if find_preset_index "$name" >/dev/null 2>&1; then
    echo "Error: preset group '$name' conflicts with preset '$name'." >&2
    exit 1
  fi

  for index in "${!preset_group_names[@]}"; do
    if [ "${preset_group_names[$index]}" = "$name" ]; then
      echo "Error: preset group '$name' is already registered." >&2
      exit 1
    fi
  done

  for member in "${members[@]}"; do
    resolved_member="$(resolve_registered_preset_name "$(normalize_token "$member")" || true)"
    if [ -z "$resolved_member" ]; then
      echo "Error: preset group '$name' references unknown preset '$member'." >&2
      exit 1
    fi
  done

  preset_group_names+=("$name")
  preset_group_descriptions+=("$description")
  preset_group_members+=("${members[*]}")
}

join_lines() {
  local first=1
  local value
  for value in "$@"; do
    if [ "$first" -eq 1 ]; then
      printf '%s' "$value"
      first=0
    else
      printf '\n%s' "$value"
    fi
  done
}

name_prefix=""
out_dir=""
include_tests=""
include_docs=""
chatgpt_url=""
preset_dir=""
package_script=""
browser=""
browser_profile=""
browser_chrome_path=""
browser_binary_path=""
browser_path=""
remote_managed=""
remote_port=""
managed_browser_user_data_dir=""
managed_browser_profile=""
managed_browser_port=""
draft_timeout_ms=""
response_timeout_ms=""
response_file=""
model=""
thinking=""

declare -a preset_names=()
declare -a preset_paths=()
declare -a preset_descriptions=()
declare -a preset_alias_inputs=()
declare -a preset_alias_targets=()
declare -a preset_group_names=()
declare -a preset_group_descriptions=()
declare -a preset_group_members=()

# shellcheck source=/dev/null
. "$CONFIG_PATH"

export REVIEW_GPT_CFG_NAME_PREFIX="${name_prefix:-}"
export REVIEW_GPT_CFG_OUT_DIR="${out_dir:-}"
export REVIEW_GPT_CFG_INCLUDE_TESTS="${include_tests:-}"
export REVIEW_GPT_CFG_INCLUDE_DOCS="${include_docs:-}"
export REVIEW_GPT_CFG_CHATGPT_URL="${chatgpt_url:-}"
export REVIEW_GPT_CFG_PRESET_DIR="${preset_dir:-}"
export REVIEW_GPT_CFG_PACKAGE_SCRIPT="${package_script:-}"
export REVIEW_GPT_CFG_BROWSER="${browser:-}"
export REVIEW_GPT_CFG_BROWSER_PROFILE="${browser_profile:-}"
export REVIEW_GPT_CFG_BROWSER_CHROME_PATH="${browser_chrome_path:-}"
export REVIEW_GPT_CFG_BROWSER_BINARY_PATH="${browser_binary_path:-}"
export REVIEW_GPT_CFG_BROWSER_PATH="${browser_path:-}"
export REVIEW_GPT_CFG_REMOTE_MANAGED="${remote_managed:-}"
export REVIEW_GPT_CFG_REMOTE_PORT="${remote_port:-}"
export REVIEW_GPT_CFG_MANAGED_BROWSER_USER_DATA_DIR="${managed_browser_user_data_dir:-}"
export REVIEW_GPT_CFG_MANAGED_BROWSER_PROFILE="${managed_browser_profile:-}"
export REVIEW_GPT_CFG_MANAGED_BROWSER_PORT="${managed_browser_port:-}"
export REVIEW_GPT_CFG_DRAFT_TIMEOUT_MS="${draft_timeout_ms:-}"
export REVIEW_GPT_CFG_RESPONSE_TIMEOUT_MS="${response_timeout_ms:-}"
export REVIEW_GPT_CFG_RESPONSE_FILE="${response_file:-}"
export REVIEW_GPT_CFG_MODEL="${model:-}"
export REVIEW_GPT_CFG_THINKING="${thinking:-}"
export REVIEW_GPT_CFG_PRESET_NAMES="$(join_lines "${preset_names[@]}")"
export REVIEW_GPT_CFG_PRESET_PATHS="$(join_lines "${preset_paths[@]}")"
export REVIEW_GPT_CFG_PRESET_DESCRIPTIONS="$(join_lines "${preset_descriptions[@]}")"
export REVIEW_GPT_CFG_PRESET_ALIAS_INPUTS="$(join_lines "${preset_alias_inputs[@]}")"
export REVIEW_GPT_CFG_PRESET_ALIAS_TARGETS="$(join_lines "${preset_alias_targets[@]}")"
export REVIEW_GPT_CFG_PRESET_GROUP_NAMES="$(join_lines "${preset_group_names[@]}")"
export REVIEW_GPT_CFG_PRESET_GROUP_DESCRIPTIONS="$(join_lines "${preset_group_descriptions[@]}")"
export REVIEW_GPT_CFG_PRESET_GROUP_MEMBERS="$(join_lines "${preset_group_members[@]}")"

node <<'EOF'
const splitLines = (value) => {
  if (!value) return [];
  return String(value)
    .split('\n')
    .map((entry) => entry.trimEnd())
    .filter((entry, index, list) => !(entry === '' && index === list.length - 1));
};

const names = splitLines(process.env.REVIEW_GPT_CFG_PRESET_NAMES);
const paths = splitLines(process.env.REVIEW_GPT_CFG_PRESET_PATHS);
const descriptions = splitLines(process.env.REVIEW_GPT_CFG_PRESET_DESCRIPTIONS);
const aliasInputs = splitLines(process.env.REVIEW_GPT_CFG_PRESET_ALIAS_INPUTS);
const aliasTargets = splitLines(process.env.REVIEW_GPT_CFG_PRESET_ALIAS_TARGETS);
const groupNames = splitLines(process.env.REVIEW_GPT_CFG_PRESET_GROUP_NAMES);
const groupDescriptions = splitLines(process.env.REVIEW_GPT_CFG_PRESET_GROUP_DESCRIPTIONS);
const groupMembers = splitLines(process.env.REVIEW_GPT_CFG_PRESET_GROUP_MEMBERS);

const data = {
  namePrefix: process.env.REVIEW_GPT_CFG_NAME_PREFIX || '',
  outDir: process.env.REVIEW_GPT_CFG_OUT_DIR || '',
  includeTests: process.env.REVIEW_GPT_CFG_INCLUDE_TESTS || '',
  includeDocs: process.env.REVIEW_GPT_CFG_INCLUDE_DOCS || '',
  chatgptUrl: process.env.REVIEW_GPT_CFG_CHATGPT_URL || '',
  presetDir: process.env.REVIEW_GPT_CFG_PRESET_DIR || '',
  packageScript: process.env.REVIEW_GPT_CFG_PACKAGE_SCRIPT || '',
  browser: process.env.REVIEW_GPT_CFG_BROWSER || '',
  browserProfile: process.env.REVIEW_GPT_CFG_BROWSER_PROFILE || '',
  browserChromePath: process.env.REVIEW_GPT_CFG_BROWSER_CHROME_PATH || '',
  browserBinaryPath: process.env.REVIEW_GPT_CFG_BROWSER_BINARY_PATH || '',
  browserPath: process.env.REVIEW_GPT_CFG_BROWSER_PATH || '',
  remoteManaged: process.env.REVIEW_GPT_CFG_REMOTE_MANAGED || '',
  remotePort: process.env.REVIEW_GPT_CFG_REMOTE_PORT || '',
  managedBrowserUserDataDir: process.env.REVIEW_GPT_CFG_MANAGED_BROWSER_USER_DATA_DIR || '',
  managedBrowserProfile: process.env.REVIEW_GPT_CFG_MANAGED_BROWSER_PROFILE || '',
  managedBrowserPort: process.env.REVIEW_GPT_CFG_MANAGED_BROWSER_PORT || '',
  draftTimeoutMs: process.env.REVIEW_GPT_CFG_DRAFT_TIMEOUT_MS || '',
  responseTimeoutMs: process.env.REVIEW_GPT_CFG_RESPONSE_TIMEOUT_MS || '',
  responseFile: process.env.REVIEW_GPT_CFG_RESPONSE_FILE || '',
  model: process.env.REVIEW_GPT_CFG_MODEL || '',
  thinking: process.env.REVIEW_GPT_CFG_THINKING || '',
  presets: names.map((name, index) => ({
    name,
    path: paths[index] || '',
    description: descriptions[index] || '',
  })),
  presetAliases: aliasInputs.map((input, index) => ({
    input,
    target: aliasTargets[index] || '',
  })),
  presetGroups: groupNames.map((name, index) => ({
    name,
    description: groupDescriptions[index] || '',
    members: (groupMembers[index] || '')
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  })),
};

process.stdout.write(`${JSON.stringify(data)}\n`);
EOF
