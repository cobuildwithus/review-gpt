#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: cobuild-review-gpt [options]

Packages a fresh audit ZIP, optionally assembles preset review prompt content, and opens ChatGPT via
managed Chrome draft staging.

Options:
  --config <path>             Optional shell config file for repo-specific defaults/presets
  --preset <name[,name...]>   Preset(s) to include. Repeatable. (default: none)
  --prompt <text>             Append custom prompt text inline (repeatable)
  --list-presets              Print available preset names and exit
  --no-send                   Backward-compatible no-op (draft staging is always no-send)
  --dry-run                   Build ZIP and print staging plan without launching browser
  -h, --help                  Show this help text

Presets:
  all
  security
  simplify
  bad-code
  grief-vectors
  incentives

Examples:
  cobuild-review-gpt
  cobuild-review-gpt incentives
  cobuild-review-gpt --preset security
  cobuild-review-gpt --preset "security,grief-vectors"
  cobuild-review-gpt --prompt "Audit callback authorization and reentrancy"
EOF
}

normalize_token() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}

list_presets() {
  cat <<'EOF'
Available presets:
  all                 - Include all audit preset sections.
  security            - Security review: auth, funds, callbacks, invariants.
  simplify            - Complexity and simplification opportunities.
  bad-code            - Combined code quality + anti-patterns pass.
  grief-vectors       - Griefing/liveness/DoS vectors.
  incentives          - Incentive compatibility and economic attack surfaces.
EOF
}

contains_preset() {
  local candidate="$1"
  shift
  local existing
  for existing in "$@"; do
    if [ "$existing" = "$candidate" ]; then
      return 0
    fi
  done
  return 1
}

add_preset() {
  local candidate="$1"
  if ! contains_preset "$candidate" "${selected_presets[@]-}"; then
    selected_presets+=("$candidate")
  fi
}

expand_preset_token() {
  local token="$1"
  case "$token" in
    all)
      add_preset security
      add_preset simplify
      add_preset bad-code
      add_preset grief-vectors
      add_preset incentives
      ;;
    security|security-audit)
      add_preset security
      ;;
    simplify|complexity|complexity-simplification)
      add_preset simplify
      ;;
    anti-patterns|antipatterns|bad-practices|anti-patterns-and-bad-practices)
      # Backward-compatible alias: anti-patterns now rolls into bad-code.
      add_preset bad-code
      ;;
    bad-code|code-quality|bad-code-quality)
      add_preset bad-code
      ;;
    grief-vectors|grief|dos|liveness)
      add_preset grief-vectors
      ;;
    incentives|economic-security|economics|economic-security-and-incentives)
      add_preset incentives
      ;;
    *)
      echo "Error: unknown preset '$token'." >&2
      echo "Run --list-presets to see valid names." >&2
      exit 1
      ;;
  esac
}

preset_file() {
  local preset="$1"
  case "$preset" in
    security)
      printf '%s\n' "$preset_dir/security-audit.md"
      ;;
    simplify)
      printf '%s\n' "$preset_dir/complexity-simplification.md"
      ;;
    anti-patterns)
      printf '%s\n' "$preset_dir/bad-code-quality.md"
      ;;
    bad-code)
      printf '%s\n' "$preset_dir/bad-code-quality.md"
      ;;
    grief-vectors)
      printf '%s\n' "$preset_dir/grief-vectors.md"
      ;;
    incentives|economic-security)
      printf '%s\n' "$preset_dir/incentives.md"
      ;;
    *)
      echo "Error: no prompt file mapping for preset '$preset'." >&2
      exit 1
      ;;
  esac
}

require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo "Error: required file not found: $path" >&2
    exit 1
  fi
}

resolve_repo_relative_path() {
  local path="$1"
  if [[ "$path" == /* ]]; then
    printf '%s\n' "$path"
    return 0
  fi
  if [ -f "$path" ]; then
    printf '%s\n' "$path"
    return 0
  fi
  printf '%s\n' "$ROOT/$path"
}

is_remote_chrome_ready() {
  local port="$1"
  curl -sSf "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1
}

start_remote_chrome() {
  local chrome_bin="$1"
  local user_data_dir="$2"
  local profile_dir="$3"
  local port="$4"
  local log_path="$5"
  local start_url="${6:-https://chatgpt.com}"

  mkdir -p "$user_data_dir"
  "$chrome_bin" \
    --user-data-dir="$user_data_dir" \
    --profile-directory="$profile_dir" \
    --remote-debugging-port="$port" \
    --new-window "$start_url" \
    >>"$log_path" 2>&1 &
}

ensure_remote_chrome() {
  local chrome_bin="$1"
  local user_data_dir="$2"
  local profile_dir="$3"
  local port="$4"
  local log_path="$5"
  local start_url="$6"
  local ready=0

  if ! is_remote_chrome_ready "$port"; then
    echo "Starting managed remote Chrome on port $port..."
    start_remote_chrome "$chrome_bin" "$user_data_dir" "$profile_dir" "$port" "$log_path" "$start_url"
    for _ in $(seq 1 50); do
      if is_remote_chrome_ready "$port"; then
        ready=1
        break
      fi
      sleep 0.2
    done
    if [ "$ready" -ne 1 ]; then
      echo "Error: managed remote Chrome failed to start on 127.0.0.1:$port." >&2
      echo "Check log: $log_path" >&2
      exit 1
    fi
  fi
}

open_chrome_window() {
  local chrome_bin="$1"
  local url="$2"
  local profile_dir="$3"
  local user_data_dir="${4:-}"
  declare -a open_cmd
  open_cmd=("$chrome_bin")
  if [ -n "$user_data_dir" ]; then
    open_cmd+=(--user-data-dir="$user_data_dir")
  fi
  if [ -n "$profile_dir" ]; then
    open_cmd+=(--profile-directory="$profile_dir")
  fi
  open_cmd+=(--new-window "$url")
  "${open_cmd[@]}" >/dev/null 2>&1 &
}

prepare_chatgpt_draft() {
  local port="$1"
  local url="$2"
  local model_target="$3"
  local thinking_level="$4"
  local timeout_ms="$5"
  local prompt_text="$6"
  shift 6
  local file_paths=("$@")

  local files_blob=""
  local path
  for path in "${file_paths[@]}"; do
    if [ -z "$files_blob" ]; then
      files_blob="$path"
    else
      files_blob="${files_blob}"$'\n'"$path"
    fi
  done

  local draft_driver="$SCRIPT_DIR/prepare-chatgpt-draft.js"
  require_file "$draft_driver"

  ORACLE_DRAFT_REMOTE_PORT="$port" \
  ORACLE_DRAFT_URL="$url" \
  ORACLE_DRAFT_MODEL="$model_target" \
  ORACLE_DRAFT_THINKING="$thinking_level" \
  ORACLE_DRAFT_TIMEOUT_MS="$timeout_ms" \
  ORACLE_DRAFT_PROMPT="$prompt_text" \
  ORACLE_DRAFT_FILES="$files_blob" \
  node "$draft_driver"
}

detect_chrome_last_used_profile() {
  local local_state="$HOME/Library/Application Support/Google/Chrome/Local State"
  local profile=""

  if [ ! -f "$local_state" ]; then
    return 1
  fi

  if command -v jq >/dev/null 2>&1; then
    profile="$(jq -r '.profile.last_used // .profile.last_active_profiles[0] // .profile.profiles_order[0] // empty' "$local_state" 2>/dev/null || true)"
  fi

  if [ -n "$profile" ] && [ "$profile" != "null" ]; then
    printf '%s\n' "$profile"
    return 0
  fi

  printf '%s\n' "Default"
  return 0
}

find_chrome_browser_binary() {
  local candidate

  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" \
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  for candidate in google-chrome google-chrome-stable chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done

  return 1
}

model="gpt-5.2-pro"
thinking="extended"
name_prefix="cobuild-chatgpt-audit"
out_dir=""
include_tests=0
include_docs=1
chatgpt_url=""
preset_dir=""
package_script=""
config_path=""
browser="chrome"
browser_profile=""
browser_chrome_path=""
remote_managed=1
remote_port="9222"
remote_user_data_dir="$HOME/.oracle/remote-chrome"
remote_profile="Default"
dry_run=0
list_only=0

declare -a selected_presets
declare -a preset_inputs
declare -a extra_prompt_files
declare -a prompt_chunks

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      if [ "$#" -lt 2 ]; then
        echo "Error: --config requires a value." >&2
        exit 1
      fi
      config_path="$2"
      shift 2
      ;;
    --preset)
      if [ "$#" -lt 2 ]; then
        echo "Error: --preset requires a value." >&2
        exit 1
      fi
      preset_inputs+=("$2")
      shift 2
      ;;
    --prompt)
      if [ "$#" -lt 2 ]; then
        echo "Error: --prompt requires a value." >&2
        exit 1
      fi
      prompt_chunks+=("$2")
      shift 2
      ;;
    --list-presets)
      list_only=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --send|--submit)
      echo "Error: --send is no longer supported. Draft staging is no-send only." >&2
      echo "Open ChatGPT draft and press Enter manually when ready." >&2
      exit 1
      ;;
    --no-send)
      # Backward-compatible no-op.
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      echo "Error: forwarding raw Oracle args is no longer supported." >&2
      echo "Use top-level cobuild-review-gpt options only (--preset/--prompt)." >&2
      exit 1
      ;;
    *)
      if [[ "$1" == -* ]]; then
        echo "Error: unknown option '$1'." >&2
        usage >&2
        exit 1
      fi
      # Positional preset shorthand: `review:gpt incentives,security`
      preset_inputs+=("$1")
      shift
      ;;
  esac
done

if ! ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "Error: not inside a git repository." >&2
  exit 1
fi

if [ -n "$config_path" ]; then
  case "$config_path" in
    /*) ;;
    *) config_path="$PWD/$config_path" ;;
  esac
  require_file "$config_path"
  REVIEW_GPT_ROOT="$ROOT"
  # shellcheck source=/dev/null
  . "$config_path"
fi

if [ "$list_only" -eq 1 ]; then
  list_presets
  exit 0
fi

resolved_browser_chrome_path="$browser_chrome_path"
resolved_browser_profile="$browser_profile"
if [ -n "$resolved_browser_chrome_path" ]; then
  if [[ "$resolved_browser_chrome_path" != /* ]]; then
    resolved_browser_chrome_path="$ROOT/$resolved_browser_chrome_path"
  fi
  if [ ! -x "$resolved_browser_chrome_path" ]; then
    echo "Error: configured browser_chrome_path is not executable: $resolved_browser_chrome_path" >&2
    exit 1
  fi
else
  if ! resolved_browser_chrome_path="$(find_chrome_browser_binary)"; then
    echo "Error: no Chrome executable was found." >&2
    exit 1
  fi
fi

if [ -z "$resolved_browser_profile" ]; then
  detected_profile="$(detect_chrome_last_used_profile || true)"
  if [ -n "$detected_profile" ]; then
    resolved_browser_profile="$detected_profile"
  fi
fi

resolved_chatgpt_url="$chatgpt_url"
if [ -z "$resolved_chatgpt_url" ]; then
  resolved_chatgpt_url="https://chatgpt.com"
fi

if [ -z "$preset_dir" ]; then
  preset_dir="$ROOT/scripts/chatgpt-review-presets"
elif [[ "$preset_dir" != /* ]]; then
  preset_dir="$ROOT/$preset_dir"
fi

if [ -z "$package_script" ]; then
  package_script="$ROOT/scripts/package-audit-context.sh"
elif [[ "$package_script" != /* ]]; then
  package_script="$ROOT/$package_script"
fi

require_file "$package_script"

if [ -n "${preset_inputs[*]-}" ]; then
  for raw_input in "${preset_inputs[@]}"; do
    IFS=',' read -r -a preset_tokens <<<"$raw_input"
    for token in "${preset_tokens[@]}"; do
      token="$(normalize_token "$token")"
      if [ -n "$token" ]; then
        expand_preset_token "$token"
      fi
    done
  done

  if [ -z "${selected_presets[*]-}" ]; then
    echo "Error: no presets selected after parsing --preset input." >&2
    exit 1
  fi
fi

declare -a package_cmd
package_cmd=("$package_script" --zip --name "$name_prefix")

if [ -n "$out_dir" ]; then
  package_cmd+=(--out-dir "$out_dir")
fi
if [ "$include_tests" -eq 1 ]; then
  package_cmd+=(--with-tests)
fi
if [ "$include_docs" -eq 0 ]; then
  package_cmd+=(--no-docs)
fi

package_output="$("${package_cmd[@]}")"
printf '%s\n' "$package_output"

zip_path="$(printf '%s\n' "$package_output" | sed -n 's/^ZIP: \(.*\) (.*)$/\1/p' | tail -n1)"
if [ -z "$zip_path" ] || [ ! -f "$zip_path" ]; then
  echo "Error: could not locate generated ZIP path from packaging output." >&2
  exit 1
fi

draft_prompt_text=""
if [ -n "${selected_presets[*]-}" ] || [ -n "${extra_prompt_files[*]-}" ] || [ -n "${prompt_chunks[*]-}" ]; then
  draft_prompt_text="$(
    {
    for token in "${selected_presets[@]-}"; do
      if [ -z "$token" ]; then
        continue
      fi
      preset_path="$(preset_file "$token")"
      require_file "$preset_path"
      cat "$preset_path"
      echo
    done

    for token in "${extra_prompt_files[@]-}"; do
      if [ -z "$token" ]; then
        continue
      fi
      resolved_token="$(resolve_repo_relative_path "$token")"
      require_file "$resolved_token"
      cat "$resolved_token"
      echo
    done

    for token in "${prompt_chunks[@]-}"; do
      if [ -z "$token" ]; then
        continue
      fi
      printf '%s\n' "$token"
      echo
    done
    }
  )"
fi

if [ -n "${selected_presets[*]-}" ]; then
  echo "Prompt presets: ${selected_presets[*]}"
else
  echo "Prompt presets: (none; upload-only prompt)"
fi
if [ -n "${prompt_chunks[*]-}" ]; then
  echo "Custom prompt chunks: ${#prompt_chunks[@]}"
fi
if [ -n "$draft_prompt_text" ]; then
  echo "Prompt staging: inline composer prefill (${#draft_prompt_text} chars)"
else
  echo "Prompt staging: none"
fi
echo "ZIP file: $zip_path"
echo "Browser target: $browser"
if [ "$remote_managed" -eq 1 ]; then
  echo "Remote managed mode: enabled"
  echo "Remote Chrome endpoint: 127.0.0.1:${remote_port}"
  echo "Remote user-data-dir: $remote_user_data_dir"
  echo "Remote profile: $remote_profile"
fi
if [ -n "$resolved_browser_chrome_path" ]; then
  echo "Browser binary: $resolved_browser_chrome_path"
fi
if [ -n "$resolved_browser_profile" ]; then
  echo "Browser profile: $resolved_browser_profile"
fi
echo "ChatGPT URL: $resolved_chatgpt_url"

if [ "$dry_run" -eq 1 ]; then
  echo "Draft mode: always no-send (Oracle removed)"
  exit 0
fi

declare -a draft_files
draft_files=("$zip_path")

if [ "$remote_managed" -eq 1 ]; then
  remote_log="${TMPDIR:-/tmp}/chatgpt-review-remote-chrome.log"
  ensure_remote_chrome "$resolved_browser_chrome_path" "$remote_user_data_dir" "$remote_profile" "$remote_port" "$remote_log" "$resolved_chatgpt_url"
  prepare_chatgpt_draft "$remote_port" "$resolved_chatgpt_url" "$model" "$thinking" "90000" "$draft_prompt_text" "${draft_files[@]}"
else
  open_chrome_window "$resolved_browser_chrome_path" "$resolved_chatgpt_url" "$resolved_browser_profile"
  echo "Warning: remote managed mode disabled; opened ChatGPT only without staged attachments." >&2
fi

echo "Opened ChatGPT in draft-only mode with prompt/files staged."
echo "ZIP file: $zip_path"
exit 0
