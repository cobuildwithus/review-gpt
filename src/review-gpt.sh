#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: cobuild-review-gpt [options]

Packages a fresh audit ZIP, optionally assembles preset review prompt content, and opens ChatGPT via
managed Chromium-family browser draft staging.

Options:
  --config <path>             Optional shell config file for repo-specific defaults/presets
  --preset <name[,name...]>   Preset(s) to include. Repeatable. (default: none)
  --prompt <text>             Append custom prompt text inline (repeatable)
  --prompt-file <path>        Append prompt content from a local file (repeatable)
  --model <name|current>      Draft model target (default: current selected ChatGPT model)
  --thinking <level|current>  Draft thinking target (default: current setting)
  --chat <url-or-id>          Target ChatGPT URL or chat ID (e.g. 69... or https://chatgpt.com/c/69...)
  --chat-url <url>            Alias for --chat with an explicit URL value
  --chat-id <id>              Alias for --chat with an explicit chat ID
  --send, --submit            Auto-submit after staging prompt/files (default: disabled)
  --no-zip                    Skip ZIP packaging/upload and stage prompt-only draft
  --list-presets              Print available preset names and exit
  --no-send                   Disable auto-submit (default; useful to override shared aliases)
  --dry-run                   Build enabled packaging artifacts and print staging plan without launching browser
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
  cobuild-review-gpt --prompt-file audit-packages/review-gpt-nozip-comprehensive-a-goals-interfaces.md
EOF
}

normalize_token() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}

is_current_target() {
  local normalized
  normalized="$(normalize_token "${1:-}")"
  [ -z "$normalized" ] || [ "$normalized" = "current" ] || [ "$normalized" = "keep" ] || [ "$normalized" = "skip" ]
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

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

extract_url_origin() {
  local url="$1"
  if [[ "$url" =~ ^https?://[^/]+ ]]; then
    printf '%s\n' "${BASH_REMATCH[0]}"
    return 0
  fi
  printf '%s\n' "https://chatgpt.com"
}

resolve_chat_target_url() {
  local raw_target="$1"
  local base_url="$2"
  local target
  target="$(trim_whitespace "$raw_target")"

  if [ -z "$target" ]; then
    echo "Error: chat target cannot be empty." >&2
    exit 1
  fi

  if [[ "$target" =~ ^https?:// ]]; then
    printf '%s\n' "$target"
    return 0
  fi

  if [[ "$target" =~ ^/c/ ]]; then
    printf '%s%s\n' "${base_url%/}" "$target"
    return 0
  fi

  if [[ "$target" =~ ^c/ ]]; then
    printf '%s/%s\n' "${base_url%/}" "$target"
    return 0
  fi

  if [[ "$target" =~ ^[A-Za-z0-9._-]+$ ]]; then
    printf '%s/c/%s\n' "${base_url%/}" "$target"
    return 0
  fi

  echo "Error: invalid --chat target '$raw_target' (expected full URL or chat ID)." >&2
  exit 1
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
    echo "Starting managed browser on port $port..."
    start_remote_chrome "$chrome_bin" "$user_data_dir" "$profile_dir" "$port" "$log_path" "$start_url"
    for _ in $(seq 1 50); do
      if is_remote_chrome_ready "$port"; then
        ready=1
        break
      fi
      sleep 0.2
    done
    if [ "$ready" -ne 1 ]; then
      echo "Error: managed browser failed to start on 127.0.0.1:$port." >&2
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
  local should_send="$7"
  shift 7
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
  ORACLE_DRAFT_SEND="$should_send" \
  ORACLE_DRAFT_FILES="$files_blob" \
  node "$draft_driver"
}

detect_browser_family_from_path() {
  local browser_path="$1"
  local normalized
  normalized="$(printf '%s' "$browser_path" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    *brave*)
      printf '%s\n' "brave"
      ;;
    *edge*|*msedge*)
      printf '%s\n' "edge"
      ;;
    *chromium*)
      printf '%s\n' "chromium"
      ;;
    *)
      printf '%s\n' "chrome"
      ;;
  esac
}

browser_local_state_path() {
  local browser_family="$1"
  case "$browser_family" in
    brave)
      if [[ "${OSTYPE:-}" == darwin* ]]; then
        printf '%s\n' "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/Local State"
      else
        printf '%s\n' "$HOME/.config/BraveSoftware/Brave-Browser/Local State"
      fi
      ;;
    edge)
      if [[ "${OSTYPE:-}" == darwin* ]]; then
        printf '%s\n' "$HOME/Library/Application Support/Microsoft Edge/Local State"
      else
        printf '%s\n' "$HOME/.config/microsoft-edge/Local State"
      fi
      ;;
    chromium)
      if [[ "${OSTYPE:-}" == darwin* ]]; then
        printf '%s\n' "$HOME/Library/Application Support/Chromium/Local State"
      else
        printf '%s\n' "$HOME/.config/chromium/Local State"
      fi
      ;;
    *)
      if [[ "${OSTYPE:-}" == darwin* ]]; then
        printf '%s\n' "$HOME/Library/Application Support/Google/Chrome/Local State"
      else
        printf '%s\n' "$HOME/.config/google-chrome/Local State"
      fi
      ;;
  esac
}

detect_browser_last_used_profile() {
  local browser_family="$1"
  local local_state
  local_state="$(browser_local_state_path "$browser_family")"
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

find_chromium_browser_binary() {
  local candidate

  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" \
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$HOME/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "$HOME/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  for candidate in \
    google-chrome \
    google-chrome-stable \
    chrome \
    chromium \
    chromium-browser \
    brave-browser \
    brave \
    microsoft-edge \
    microsoft-edge-stable; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done

  return 1
}

model="current"
thinking="current"
name_prefix="cobuild-chatgpt-audit"
out_dir=""
include_tests=0
include_docs=1
chatgpt_url=""
preset_dir=""
package_script=""
config_path=""
browser="chromium-family"
browser_profile=""
browser_chrome_path=""
remote_managed=1
remote_port="9222"
default_managed_browser_user_data_dir="$HOME/.review-gpt/managed-chromium"
legacy_managed_browser_user_data_dir="$HOME/.oracle/remote-chrome"
remote_user_data_dir="$default_managed_browser_user_data_dir"
remote_profile="Default"
dry_run=0
list_only=0
attach_zip=1
auto_send=0
chat_target=""

declare -a selected_presets
declare -a preset_inputs
declare -a prompt_file_inputs
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
    --prompt-file)
      if [ "$#" -lt 2 ]; then
        echo "Error: --prompt-file requires a value." >&2
        exit 1
      fi
      prompt_file_inputs+=("$2")
      shift 2
      ;;
    --model)
      if [ "$#" -lt 2 ]; then
        echo "Error: --model requires a value." >&2
        exit 1
      fi
      model="$2"
      shift 2
      ;;
    --thinking)
      if [ "$#" -lt 2 ]; then
        echo "Error: --thinking requires a value." >&2
        exit 1
      fi
      thinking="$2"
      shift 2
      ;;
    --chat|--chat-url|--chat-id)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a value." >&2
        exit 1
      fi
      chat_target="$2"
      shift 2
      ;;
    --send|--submit)
      auto_send=1
      shift
      ;;
    --list-presets)
      list_only=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --no-zip)
      attach_zip=0
      shift
      ;;
    --no-send)
      auto_send=0
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

if [ -n "${browser_binary_path:-}" ]; then
  browser_chrome_path="$browser_binary_path"
fi
if [ -n "${managed_browser_user_data_dir:-}" ]; then
  remote_user_data_dir="$managed_browser_user_data_dir"
fi
if [ -n "${managed_browser_profile:-}" ]; then
  remote_profile="$managed_browser_profile"
fi
if [ -n "${managed_browser_port:-}" ]; then
  remote_port="$managed_browser_port"
fi

if [ -n "${prompt_file_inputs[*]-}" ]; then
  for token in "${prompt_file_inputs[@]-}"; do
    if [ -z "$token" ]; then
      continue
    fi
    resolved_token="$(resolve_repo_relative_path "$token")"
    require_file "$resolved_token"
    extra_prompt_files+=("$resolved_token")
  done
fi

if [ "$list_only" -eq 1 ]; then
  list_presets
  exit 0
fi

resolved_chatgpt_url="$chatgpt_url"
if [ -z "$resolved_chatgpt_url" ]; then
  resolved_chatgpt_url="https://chatgpt.com"
fi
if [ -n "$chat_target" ]; then
  chat_target_origin="$(extract_url_origin "$resolved_chatgpt_url")"
  resolved_chatgpt_url="$(resolve_chat_target_url "$chat_target" "$chat_target_origin")"
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

if [[ "$remote_user_data_dir" != /* ]]; then
  remote_user_data_dir="$ROOT/$remote_user_data_dir"
fi
if [ "$remote_user_data_dir" = "$default_managed_browser_user_data_dir" ] && [ ! -d "$remote_user_data_dir" ] && [ -d "$legacy_managed_browser_user_data_dir" ]; then
  remote_user_data_dir="$legacy_managed_browser_user_data_dir"
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
zip_path=""
if [ "$attach_zip" -eq 1 ]; then
  # Invoke the wrapper through bash so consumers do not depend on executable bits.
  package_cmd=(bash "$package_script" --zip --name "$name_prefix")

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
if [ "$attach_zip" -eq 1 ]; then
  echo "ZIP file: $zip_path"
else
  echo "ZIP file: (disabled via --no-zip)"
fi
echo "ChatGPT URL: $resolved_chatgpt_url"
if is_current_target "$model"; then
  echo "Draft model target: current"
else
  echo "Draft model target: $model"
fi
if is_current_target "$thinking"; then
  echo "Draft thinking target: current"
else
  echo "Draft thinking target: $thinking"
fi
if [ "$auto_send" -eq 1 ]; then
  echo "Draft send: enabled (auto-submit)"
else
  echo "Draft send: disabled"
fi

resolved_browser_chrome_path="$browser_chrome_path"
resolved_browser_profile="$browser_profile"
if [ -n "$resolved_browser_chrome_path" ]; then
  if [[ "$resolved_browser_chrome_path" != /* ]]; then
    resolved_browser_chrome_path="$ROOT/$resolved_browser_chrome_path"
  fi
  if [ ! -x "$resolved_browser_chrome_path" ]; then
    echo "Error: configured browser path is not executable: $resolved_browser_chrome_path" >&2
    exit 1
  fi
else
  if ! resolved_browser_chrome_path="$(find_chromium_browser_binary)"; then
    echo "Error: no Chromium-compatible browser executable was found." >&2
    echo "Set browser_binary_path (preferred) or browser_chrome_path in your config to Chrome, Brave, Chromium, or Edge." >&2
    exit 1
  fi
fi

resolved_browser_family="$(detect_browser_family_from_path "$resolved_browser_chrome_path")"
if [ -z "$resolved_browser_profile" ]; then
  detected_profile="$(detect_browser_last_used_profile "$resolved_browser_family" || true)"
  if [ -n "$detected_profile" ]; then
    resolved_browser_profile="$detected_profile"
  fi
fi

managed_profile_state="new profile"
if [ -d "$remote_user_data_dir/$remote_profile" ]; then
  managed_profile_state="existing profile"
fi

echo "Browser target: $browser"
echo "Browser family: $resolved_browser_family"
if [ "$remote_managed" -eq 1 ]; then
  echo "Managed browser mode: enabled"
  echo "Managed browser endpoint: 127.0.0.1:${remote_port}"
  echo "Managed browser data dir: $remote_user_data_dir"
  echo "Managed browser profile: $remote_profile"
  echo "Managed browser state: $managed_profile_state"
fi
if [ -n "$resolved_browser_chrome_path" ]; then
  echo "Browser binary: $resolved_browser_chrome_path"
fi
if [ -n "$resolved_browser_profile" ]; then
  echo "Detected local browser profile: $resolved_browser_profile"
fi

if [ "$dry_run" -eq 1 ]; then
  echo "Dry run: browser launch skipped"
  exit 0
fi

declare -a draft_files
if [ "$attach_zip" -eq 1 ]; then
  draft_files=("$zip_path")
else
  draft_files=()
fi

if [ "$remote_managed" -eq 1 ]; then
  remote_log="${TMPDIR:-/tmp}/review-gpt-managed-browser.log"
  ensure_remote_chrome "$resolved_browser_chrome_path" "$remote_user_data_dir" "$remote_profile" "$remote_port" "$remote_log" "$resolved_chatgpt_url"
  if ! prepare_chatgpt_draft "$remote_port" "$resolved_chatgpt_url" "$model" "$thinking" "90000" "$draft_prompt_text" "$auto_send" "${draft_files[@]-}"; then
    echo "Error: failed to stage the ChatGPT draft in the managed browser." >&2
    echo "Managed browser data dir: $remote_user_data_dir" >&2
    echo "Managed browser profile: $remote_profile" >&2
    echo "If ChatGPT is asking you to log in, complete the sign-in in the opened browser window and rerun the command." >&2
    exit 1
  fi
else
  open_chrome_window "$resolved_browser_chrome_path" "$resolved_chatgpt_url" "$resolved_browser_profile"
  echo "Warning: managed browser mode disabled; opened ChatGPT only without staged attachments." >&2
fi

if [ "$auto_send" -eq 1 ]; then
  echo "Opened ChatGPT with prompt/files staged and auto-send enabled."
else
  echo "Opened ChatGPT in draft-only mode with prompt/files staged."
fi
if [ "$attach_zip" -eq 1 ]; then
  echo "ZIP file: $zip_path"
else
  echo "ZIP file: (disabled via --no-zip)"
fi
exit 0
