#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: cobuild-review-gpt [options] [-- <extra-oracle-args...>]

Packages a fresh audit ZIP, optionally assembles preset review prompt content, and opens ChatGPT via
Oracle browser mode with model/extended-thinking defaults.

Options:
  --config <path>             Optional shell config file for repo-specific defaults/presets
  --preset <name[,name...]>   Preset(s) to include. Repeatable. (default: none)
  --list-presets              Print available preset names and exit
  --send                      Execute Oracle and submit to ChatGPT
  --no-send                   Stage draft (prompt + files) in ChatGPT without auto-submit (default)
  --dry-run                   Print planned Oracle command without launching
  --                          Pass remaining args directly to Oracle
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
  cobuild-review-gpt --send
  cobuild-review-gpt incentives
  cobuild-review-gpt --preset security
  cobuild-review-gpt --preset "security,grief-vectors"
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

print_command() {
  local arg
  printf 'Running:'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    echo "Error: required file not found: $path" >&2
    exit 1
  fi
}

run_keychain_preflight() {
  if [ "$(uname -s)" != "Darwin" ]; then
    return 0
  fi
  if ! command -v security >/dev/null 2>&1; then
    return 0
  fi
  echo "Running macOS keychain preflight for Chrome cookie access..."
  if security find-generic-password -w -a "Chrome" -s "Chrome Safe Storage" >/dev/null 2>&1; then
    echo "Keychain preflight: ok"
    return 0
  fi
  echo "Warning: keychain preflight could not confirm Chrome Safe Storage access." >&2
  echo "If prompted, choose \"Always Allow\" to avoid Oracle cookie timeout failures." >&2
  return 0
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

  ORACLE_DRAFT_REMOTE_PORT="$port" \
  ORACLE_DRAFT_URL="$url" \
  ORACLE_DRAFT_MODEL="$model_target" \
  ORACLE_DRAFT_THINKING="$thinking_level" \
  ORACLE_DRAFT_TIMEOUT_MS="$timeout_ms" \
  ORACLE_DRAFT_PROMPT="$prompt_text" \
  ORACLE_DRAFT_FILES="$files_blob" \
  node <<'EOF'
const fs = require('fs');
const { URL } = require('url');

const remotePort = process.env.ORACLE_DRAFT_REMOTE_PORT;
const chatgptUrl = process.env.ORACLE_DRAFT_URL;
const modelTargetRaw = process.env.ORACLE_DRAFT_MODEL || 'gpt-5.2-pro';
const thinkingTarget = (process.env.ORACLE_DRAFT_THINKING || 'extended').toLowerCase();
const timeoutMs = Number(process.env.ORACLE_DRAFT_TIMEOUT_MS || 90000);
const draftPrompt = process.env.ORACLE_DRAFT_PROMPT || '';
const filesToAttach = (process.env.ORACLE_DRAFT_FILES || '')
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);
const MODEL_BUTTON_SELECTOR = '[data-testid="model-switcher-dropdown-button"]';
const MENU_CONTAINER_SELECTOR = '[role="menu"], [data-radix-collection-root]';
const MENU_ITEM_SELECTOR = 'button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]';

if (!remotePort) {
  throw new Error('Missing ORACLE_DRAFT_REMOTE_PORT');
}
if (!chatgptUrl) {
  throw new Error('Missing ORACLE_DRAFT_URL');
}
if (filesToAttach.length === 0) {
  throw new Error('No draft files provided for upload');
}

for (const filePath of filesToAttach) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Draft attachment missing: ${filePath}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${remotePort}${path}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}`);
  }
  return res.json();
}

function urlHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

function urlMatches(targetUrl, desiredUrl) {
  if (!targetUrl) return false;
  if (targetUrl === desiredUrl) return true;
  const targetHost = urlHost(targetUrl);
  const desiredHost = urlHost(desiredUrl);
  if (targetHost && desiredHost && targetHost === desiredHost) return true;
  return false;
}

async function pickTarget(desiredUrl) {
  const targets = await fetchJson('/json/list');
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  const exact = pages.filter((target) => target.url === desiredUrl).pop();
  if (exact) return exact;
  const sameHost = pages.filter((target) => urlMatches(target.url, desiredUrl)).pop();
  if (sameHost) return sameHost;
  const latest = pages[pages.length - 1];
  if (latest) return latest;
  return null;
}

async function openNewTarget(desiredUrl) {
  const endpoint = `/json/new?${encodeURIComponent(desiredUrl)}`;
  const openWithMethod = async (method) => {
    const response = await fetch(`http://127.0.0.1:${remotePort}${endpoint}`, { method });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${endpoint} (${method})`);
    }
    return response.json();
  };

  try {
    let created;
    try {
      // Matches modern Chrome /json/new behavior (PUT-only).
      created = await openWithMethod('PUT');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('405')) {
        throw error;
      }
      // Fallback for older Chrome versions that still allow GET.
      created = await openWithMethod('GET');
    }
    if (created && created.type === 'page' && created.webSocketDebuggerUrl) {
      return created;
    }
    if (created && created.id) {
      const createdDeadline = Date.now() + 6000;
      while (Date.now() < createdDeadline) {
        const listed = await fetchJson('/json/list');
        const target = listed.find(
          (entry) => entry.type === 'page' && entry.id === created.id && entry.webSocketDebuggerUrl
        );
        if (target) return target;
        await sleep(200);
      }
    }
  } catch {
    // Fall through to existing target discovery when /json/new is unavailable.
  }
  return null;
}

async function ensureTarget(desiredUrl) {
  const created = await openNewTarget(desiredUrl);
  if (created) {
    return created;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const existing = await pickTarget(desiredUrl);
    if (existing) return existing;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for a ChatGPT target on port ${remotePort}`);
}

async function connectTargetWebSocket(desiredUrl) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const target = await ensureTarget(desiredUrl);
    try {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
        ws.addEventListener('close', () => reject(new Error('CDP socket closed unexpectedly')), { once: true });
      });
      return ws;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError || new Error('Unable to attach to ChatGPT target via CDP');
}

async function main() {
  const ws = await connectTargetWebSocket(chatgptUrl);

  const pending = new Map();
  let nextId = 0;

  const closed = new Promise((_, reject) => {
    ws.addEventListener('close', () => reject(new Error('CDP socket closed unexpectedly')));
    ws.addEventListener('error', (event) => reject(event.error || new Error('CDP socket error')));
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    if (message.error) {
      slot.reject(new Error(message.error.message || 'CDP command failed'));
      return;
    }
    slot.resolve(message.result || {});
  });

  const cdp = async (method, params = {}) => {
    const id = ++nextId;
    const payload = JSON.stringify({ id, method, params });
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    ws.send(payload);
    return Promise.race([response, closed]);
  };

  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result?.value;
  };

  const evaluateHandle = async (expression) => {
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: false,
      awaitPromise: true,
    });
    return result.result || null;
  };

  const buildClickDispatcher = (functionName = 'dispatchClickSequence') => {
    const clickTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const typesLiteral = JSON.stringify(clickTypes);
    return `function ${functionName}(target){
      if(!target || !(target instanceof EventTarget)) return false;
      const types = ${typesLiteral};
      for (const type of types) {
        const common = { bubbles: true, cancelable: true, view: window };
        let event;
        if (type.startsWith('pointer') && 'PointerEvent' in window) {
          event = new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' });
        } else {
          event = new MouseEvent(type, common);
        }
        target.dispatchEvent(event);
      }
      return true;
    }`;
  };

  const buildModelMatchersLiteral = (targetModel) => {
    const base = String(targetModel || '').trim().toLowerCase();
    const labelTokens = new Set();
    const testIdTokens = new Set();
    const push = (value, set) => {
      const normalized = String(value || '').trim();
      if (normalized) {
        set.add(normalized);
      }
    };

    push(base, labelTokens);
    push(base.replace(/\s+/g, ' '), labelTokens);
    const collapsed = base.replace(/\s+/g, '');
    push(collapsed, labelTokens);
    const dotless = base.replace(/[.]/g, '');
    push(dotless, labelTokens);
    push(`chatgpt ${base}`, labelTokens);
    push(`chatgpt ${dotless}`, labelTokens);
    push(`gpt ${base}`, labelTokens);
    push(`gpt ${dotless}`, labelTokens);

    if (base.includes('5.1') || base.includes('5-1') || base.includes('51')) {
      push('5.1', labelTokens);
      push('gpt-5.1', labelTokens);
      push('gpt5.1', labelTokens);
      push('gpt-5-1', labelTokens);
      push('gpt5-1', labelTokens);
      push('gpt51', labelTokens);
      push('chatgpt 5.1', labelTokens);
      testIdTokens.add('gpt-5-1');
      testIdTokens.add('gpt5-1');
      testIdTokens.add('gpt51');
    }

    if (base.includes('5.0') || base.includes('5-0') || base.includes('50')) {
      push('5.0', labelTokens);
      push('gpt-5.0', labelTokens);
      push('gpt5.0', labelTokens);
      push('gpt-5-0', labelTokens);
      push('gpt5-0', labelTokens);
      push('gpt50', labelTokens);
      push('chatgpt 5.0', labelTokens);
      testIdTokens.add('gpt-5-0');
      testIdTokens.add('gpt5-0');
      testIdTokens.add('gpt50');
    }

    if (base.includes('5.2') || base.includes('5-2') || base.includes('52')) {
      push('5.2', labelTokens);
      push('gpt-5.2', labelTokens);
      push('gpt5.2', labelTokens);
      push('gpt-5-2', labelTokens);
      push('gpt5-2', labelTokens);
      push('gpt52', labelTokens);
      push('chatgpt 5.2', labelTokens);
      if (base.includes('thinking')) {
        push('thinking', labelTokens);
        testIdTokens.add('model-switcher-gpt-5-2-thinking');
        testIdTokens.add('gpt-5-2-thinking');
        testIdTokens.add('gpt-5.2-thinking');
      }
      if (base.includes('instant')) {
        push('instant', labelTokens);
        testIdTokens.add('model-switcher-gpt-5-2-instant');
        testIdTokens.add('gpt-5-2-instant');
        testIdTokens.add('gpt-5.2-instant');
      }
      if (!base.includes('thinking') && !base.includes('instant') && !base.includes('pro')) {
        testIdTokens.add('model-switcher-gpt-5-2');
      }
      testIdTokens.add('gpt-5-2');
      testIdTokens.add('gpt5-2');
      testIdTokens.add('gpt52');
    }

    if (base.includes('pro')) {
      push('proresearch', labelTokens);
      push('research grade', labelTokens);
      push('advanced reasoning', labelTokens);
      if (base.includes('5.1') || base.includes('5-1') || base.includes('51')) {
        testIdTokens.add('gpt-5.1-pro');
        testIdTokens.add('gpt-5-1-pro');
        testIdTokens.add('gpt51pro');
      }
      if (base.includes('5.0') || base.includes('5-0') || base.includes('50')) {
        testIdTokens.add('gpt-5.0-pro');
        testIdTokens.add('gpt-5-0-pro');
        testIdTokens.add('gpt50pro');
      }
      if (base.includes('5.2') || base.includes('5-2') || base.includes('52')) {
        testIdTokens.add('gpt-5.2-pro');
        testIdTokens.add('gpt-5-2-pro');
        testIdTokens.add('gpt52pro');
      }
      testIdTokens.add('pro');
      testIdTokens.add('proresearch');
    }

    base
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .forEach((token) => {
        push(token, labelTokens);
      });

    const hyphenated = base.replace(/\s+/g, '-');
    push(hyphenated, testIdTokens);
    push(collapsed, testIdTokens);
    push(dotless, testIdTokens);
    push(`model-switcher-${hyphenated}`, testIdTokens);
    push(`model-switcher-${collapsed}`, testIdTokens);
    push(`model-switcher-${dotless}`, testIdTokens);

    if (!labelTokens.size) {
      labelTokens.add(base);
    }
    if (!testIdTokens.size) {
      testIdTokens.add(base.replace(/\s+/g, '-'));
    }

    return {
      labelTokens: Array.from(labelTokens).filter(Boolean),
      testIdTokens: Array.from(testIdTokens).filter(Boolean),
    };
  };

  const buildModelSelectionExpression = (targetModel, strategy = 'select') => {
    const matchers = buildModelMatchersLiteral(targetModel);
    const labelLiteral = JSON.stringify(matchers.labelTokens);
    const idLiteral = JSON.stringify(matchers.testIdTokens);
    const primaryLabelLiteral = JSON.stringify(targetModel);
    const strategyLiteral = JSON.stringify(strategy);
    const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
    const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);

    return `(() => {
      ${buildClickDispatcher()}
      const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
      const LABEL_TOKENS = ${labelLiteral};
      const TEST_IDS = ${idLiteral};
      const PRIMARY_LABEL = ${primaryLabelLiteral};
      const MODEL_STRATEGY = ${strategyLiteral};
      const INITIAL_WAIT_MS = 150;
      const REOPEN_INTERVAL_MS = 400;
      const MAX_WAIT_MS = 20000;
      const normalizeText = (value) => {
        if (!value) return '';
        return value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
      };
      const normalizedTarget = normalizeText(PRIMARY_LABEL);
      const normalizedTokens = Array.from(new Set([normalizedTarget, ...LABEL_TOKENS]))
        .map((token) => normalizeText(token))
        .filter(Boolean);
      const targetWords = normalizedTarget.split(' ').filter(Boolean);
      const desiredVersion = normalizedTarget.includes('5 2')
        ? '5-2'
        : normalizedTarget.includes('5 1')
          ? '5-1'
          : normalizedTarget.includes('5 0')
            ? '5-0'
            : null;
      const wantsPro = normalizedTarget.includes(' pro') || normalizedTarget.endsWith(' pro') || normalizedTokens.includes('pro');
      const wantsInstant = normalizedTarget.includes('instant');
      const wantsThinking = normalizedTarget.includes('thinking');

      const button = document.querySelector(BUTTON_SELECTOR);
      if (!button) {
        return { status: 'button-missing' };
      }

      const getButtonLabel = () => (button.textContent ?? '').trim();
      if (MODEL_STRATEGY === 'current') {
        return { status: 'already-selected', label: getButtonLabel() };
      }
      const buttonMatchesTarget = () => {
        const normalizedLabel = normalizeText(getButtonLabel());
        if (!normalizedLabel) return false;
        if (desiredVersion) {
          if (desiredVersion === '5-2' && !normalizedLabel.includes('5 2')) return false;
          if (desiredVersion === '5-1' && !normalizedLabel.includes('5 1')) return false;
          if (desiredVersion === '5-0' && !normalizedLabel.includes('5 0')) return false;
        }
        if (wantsPro && !normalizedLabel.includes(' pro')) return false;
        if (wantsInstant && !normalizedLabel.includes('instant')) return false;
        if (wantsThinking && !normalizedLabel.includes('thinking')) return false;
        if (!wantsPro && normalizedLabel.includes(' pro')) return false;
        if (!wantsInstant && normalizedLabel.includes('instant')) return false;
        if (!wantsThinking && normalizedLabel.includes('thinking')) return false;
        return true;
      };

      if (buttonMatchesTarget()) {
        return { status: 'already-selected', label: getButtonLabel() };
      }

      let lastPointerClick = 0;
      const pointerClick = () => {
        if (dispatchClickSequence(button)) {
          lastPointerClick = performance.now();
        }
      };

      const getOptionLabel = (node) => node?.textContent?.trim() ?? '';
      const optionIsSelected = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const ariaChecked = node.getAttribute('aria-checked');
        const ariaSelected = node.getAttribute('aria-selected');
        const ariaCurrent = node.getAttribute('aria-current');
        const dataSelected = node.getAttribute('data-selected');
        const dataState = (node.getAttribute('data-state') ?? '').toLowerCase();
        const selectedStates = ['checked', 'selected', 'on', 'true'];
        if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') {
          return true;
        }
        if (dataSelected === 'true' || selectedStates.includes(dataState)) {
          return true;
        }
        if (node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]')) {
          return true;
        }
        return false;
      };

      const scoreOption = (normalizedText, testid) => {
        if (!normalizedText && !testid) {
          return 0;
        }
        let score = 0;
        const normalizedTestId = (testid ?? '').toLowerCase();
        if (normalizedTestId) {
          if (desiredVersion) {
            const has52 =
              normalizedTestId.includes('5-2') ||
              normalizedTestId.includes('5.2') ||
              normalizedTestId.includes('gpt-5-2') ||
              normalizedTestId.includes('gpt-5.2') ||
              normalizedTestId.includes('gpt52');
            const has51 =
              normalizedTestId.includes('5-1') ||
              normalizedTestId.includes('5.1') ||
              normalizedTestId.includes('gpt-5-1') ||
              normalizedTestId.includes('gpt-5.1') ||
              normalizedTestId.includes('gpt51');
            const has50 =
              normalizedTestId.includes('5-0') ||
              normalizedTestId.includes('5.0') ||
              normalizedTestId.includes('gpt-5-0') ||
              normalizedTestId.includes('gpt-5.0') ||
              normalizedTestId.includes('gpt50');
            const candidateVersion = has52 ? '5-2' : has51 ? '5-1' : has50 ? '5-0' : null;
            if (candidateVersion && candidateVersion !== desiredVersion) {
              return 0;
            }
            if (normalizedTestId.includes('submenu') && candidateVersion === null) {
              return 0;
            }
          }
          const exactMatch = TEST_IDS.find((id) => id && normalizedTestId === id);
          if (exactMatch) {
            score += 1500;
            if (exactMatch.startsWith('model-switcher-')) score += 200;
          } else {
            const matches = TEST_IDS.filter((id) => id && normalizedTestId.includes(id));
            if (matches.length > 0) {
              const best = matches.reduce((acc, token) => (token.length > acc.length ? token : acc), '');
              score += 200 + Math.min(900, best.length * 25);
              if (best.startsWith('model-switcher-')) score += 120;
              if (best.includes('gpt-')) score += 60;
            }
          }
        }
        if (normalizedText && normalizedTarget) {
          if (normalizedText === normalizedTarget) {
            score += 500;
          } else if (normalizedText.startsWith(normalizedTarget)) {
            score += 420;
          } else if (normalizedText.includes(normalizedTarget)) {
            score += 380;
          }
        }
        for (const token of normalizedTokens) {
          if (token && normalizedText.includes(token)) {
            const tokenWeight = Math.min(120, Math.max(10, token.length * 4));
            score += tokenWeight;
          }
        }
        if (targetWords.length > 1) {
          let missing = 0;
          for (const word of targetWords) {
            if (!normalizedText.includes(word)) {
              missing += 1;
            }
          }
          score -= missing * 12;
        }
        if (wantsPro) {
          if (!normalizedText.includes(' pro')) {
            score -= 80;
          }
        } else if (normalizedText.includes(' pro')) {
          score -= 40;
        }
        if (wantsThinking) {
          if (!normalizedText.includes('thinking') && !normalizedTestId.includes('thinking')) {
            score -= 80;
          }
        } else if (normalizedText.includes('thinking') || normalizedTestId.includes('thinking')) {
          score -= 40;
        }
        if (wantsInstant) {
          if (!normalizedText.includes('instant') && !normalizedTestId.includes('instant')) {
            score -= 80;
          }
        } else if (normalizedText.includes('instant') || normalizedTestId.includes('instant')) {
          score -= 40;
        }
        return Math.max(score, 0);
      };

      const findBestOption = () => {
        let bestMatch = null;
        const menus = Array.from(document.querySelectorAll(${menuContainerLiteral}));
        for (const menu of menus) {
          const buttons = Array.from(menu.querySelectorAll(${menuItemLiteral}));
          for (const option of buttons) {
            const text = option.textContent ?? '';
            const normalizedText = normalizeText(text);
            const testid = option.getAttribute('data-testid') ?? '';
            const score = scoreOption(normalizedText, testid);
            if (score <= 0) {
              continue;
            }
            const label = getOptionLabel(option);
            if (!bestMatch || score > bestMatch.score) {
              bestMatch = { node: option, label, score, testid, normalizedText };
            }
          }
        }
        return bestMatch;
      };

      return new Promise((resolve) => {
        const start = performance.now();
        const detectTemporaryChat = () => {
          try {
            const url = new URL(window.location.href);
            const flag = (url.searchParams.get('temporary-chat') ?? '').toLowerCase();
            if (flag === 'true' || flag === '1' || flag === 'yes') return true;
          } catch {}
          const title = (document.title || '').toLowerCase();
          if (title.includes('temporary chat')) return true;
          const body = (document.body?.innerText || '').toLowerCase();
          return body.includes('temporary chat');
        };
        const collectAvailableOptions = () => {
          const menuRoots = Array.from(document.querySelectorAll(${menuContainerLiteral}));
          const nodes = menuRoots.length > 0
            ? menuRoots.flatMap((root) => Array.from(root.querySelectorAll(${menuItemLiteral})))
            : Array.from(document.querySelectorAll(${menuItemLiteral}));
          const labels = nodes
            .map((node) => (node?.textContent ?? '').trim())
            .filter(Boolean)
            .filter((label, index, arr) => arr.indexOf(label) === index);
          return labels.slice(0, 12);
        };
        const ensureMenuOpen = () => {
          const menuOpen = document.querySelector('[role="menu"], [data-radix-collection-root]');
          if (!menuOpen && performance.now() - lastPointerClick > REOPEN_INTERVAL_MS) {
            pointerClick();
          }
        };

        pointerClick();
        const openDelay = () => new Promise((r) => setTimeout(r, INITIAL_WAIT_MS));
        let initialized = false;
        const attempt = async () => {
          if (!initialized) {
            initialized = true;
            await openDelay();
          }
          ensureMenuOpen();
          const match = findBestOption();
          if (match) {
            if (optionIsSelected(match.node)) {
              resolve({ status: 'already-selected', label: getButtonLabel() || match.label });
              return;
            }
            dispatchClickSequence(match.node);
            const isSubmenu = (match.testid ?? '').toLowerCase().includes('submenu');
            if (isSubmenu) {
              setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
              return;
            }
            setTimeout(() => {
              if (buttonMatchesTarget()) {
                resolve({ status: 'switched', label: getButtonLabel() || match.label });
                return;
              }
              attempt();
            }, Math.max(120, INITIAL_WAIT_MS));
            return;
          }
          if (performance.now() - start > MAX_WAIT_MS) {
            resolve({
              status: 'option-not-found',
              hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
            });
            return;
          }
          setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
        };
        attempt();
      });
    })()`;
  };

  const buildThinkingTimeExpression = (level) => {
    const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
    const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
    const targetLevelLiteral = JSON.stringify(String(level || 'extended').toLowerCase());
    return `(async () => {
      ${buildClickDispatcher()}

      const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
      const MENU_ITEM_SELECTOR = ${menuItemLiteral};
      const TARGET_LEVEL = ${targetLevelLiteral};

      const CHIP_SELECTORS = [
        '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
        'button.__composer-pill[aria-haspopup="menu"]',
        '.__composer-pill-composite button[aria-haspopup="menu"]',
      ];

      const INITIAL_WAIT_MS = 150;
      const MAX_WAIT_MS = 10000;

      const normalize = (value) => (value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();

      const findThinkingChip = () => {
        for (const selector of CHIP_SELECTORS) {
          const buttons = document.querySelectorAll(selector);
          for (const btn of buttons) {
            if (btn.getAttribute?.('aria-haspopup') !== 'menu') continue;
            const aria = normalize(btn.getAttribute?.('aria-label') ?? '');
            const text = normalize(btn.textContent ?? '');
            if (aria.includes('thinking') || text.includes('thinking')) {
              return btn;
            }
            if (aria.includes('pro') || text.includes('pro')) {
              return btn;
            }
          }
        }
        return null;
      };

      const chip = findThinkingChip();
      if (!chip) {
        return { status: 'chip-not-found' };
      }

      dispatchClickSequence(chip);

      return new Promise((resolve) => {
        const start = performance.now();

        const findMenu = () => {
          const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="group"]');
          for (const menu of menus) {
            const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
            if (normalize(label?.textContent ?? '').includes('thinking time')) {
              return menu;
            }
            const text = normalize(menu.textContent ?? '');
            if (text.includes('standard') && text.includes('extended')) {
              return menu;
            }
          }
          return null;
        };

        const findTargetOption = (menu) => {
          const items = menu.querySelectorAll(MENU_ITEM_SELECTOR);
          for (const item of items) {
            const text = normalize(item.textContent ?? '');
            if (text.includes(TARGET_LEVEL)) {
              return item;
            }
          }
          return null;
        };

        const optionIsSelected = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const ariaChecked = node.getAttribute('aria-checked');
          const dataState = (node.getAttribute('data-state') || '').toLowerCase();
          if (ariaChecked === 'true') return true;
          if (dataState === 'checked' || dataState === 'selected' || dataState === 'on') return true;
          return false;
        };

        const attempt = () => {
          const menu = findMenu();
          if (!menu) {
            if (performance.now() - start > MAX_WAIT_MS) {
              resolve({ status: 'menu-not-found' });
              return;
            }
            setTimeout(attempt, 100);
            return;
          }

          const targetOption = findTargetOption(menu);
          if (!targetOption) {
            resolve({ status: 'option-not-found' });
            return;
          }

          const alreadySelected =
            optionIsSelected(targetOption) ||
            optionIsSelected(targetOption.querySelector?.('[aria-checked="true"], [data-state="checked"], [data-state="selected"]'));
          const label = targetOption.textContent?.trim?.() || null;
          dispatchClickSequence(targetOption);
          resolve({ status: alreadySelected ? 'already-selected' : 'switched', label });
        };

        setTimeout(attempt, INITIAL_WAIT_MS);
      });
    })()`;
  };

  const ensureDraftModelSelected = async () => {
    const result = await evaluate(buildModelSelectionExpression(modelTargetRaw, 'select'));
    switch (result?.status) {
      case 'already-selected':
      case 'switched':
      case 'switched-best-effort':
        return { ok: true, label: result?.label || modelTargetRaw };
      case 'option-not-found':
        return { ok: false, reason: 'option-not-found', details: result };
      default:
        return { ok: false, reason: result?.status || 'selection-failed', details: result };
    }
  };

  const ensureDraftThinkingSelected = async () => {
    const result = await evaluate(buildThinkingTimeExpression(thinkingTarget));
    switch (result?.status) {
      case 'already-selected':
      case 'switched':
        return { ok: true, label: result?.label || thinkingTarget };
      case 'chip-not-found':
      case 'menu-not-found':
      case 'option-not-found':
        return { ok: false, reason: result.status, details: result };
      default:
        return { ok: false, reason: result?.status || 'selection-failed', details: result };
    }
  };

  const setDraftComposerPrompt = async (prompt) => {
    const promptLiteral = JSON.stringify(String(prompt));
    return evaluate(`(() => {
      try {
        const textareaSelectors = [
          '#prompt-textarea',
          'textarea[name="prompt-textarea"]',
          'textarea[data-id="prompt-textarea"]',
          'textarea[placeholder*="Send a message"]',
          'textarea[aria-label="Message ChatGPT"]',
          'textarea:not([disabled])'
        ];
        const editableSelectors = [
          '[data-testid*="composer"] [contenteditable="true"]',
          'form [contenteditable="true"]',
          '[contenteditable="true"][role="textbox"]'
        ];
        const visible = (node) => {
          if (!node || typeof node.getBoundingClientRect !== 'function') return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const pickFirst = (nodes) => nodes.find((node) => visible(node)) || nodes[0] || null;
        const pickBySelectors = (selectors) => pickFirst(selectors.map((s) => document.querySelector(s)).filter(Boolean));

        const value = ${promptLiteral};
        const textarea = pickBySelectors(textareaSelectors);
        if (textarea && String(textarea.tagName || '').toUpperCase() === 'TEXTAREA') {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(textarea, value);
          } else {
            textarea.value = value;
          }
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          textarea.focus();
          return { ok: true, mode: 'textarea', length: value.length };
        }

        const editorCandidates = [];
        if (textarea && String(textarea.tagName || '').toUpperCase() !== 'TEXTAREA') {
          editorCandidates.push(textarea);
        }
        const editor = pickFirst([
          ...editorCandidates,
          ...editableSelectors.map((s) => document.querySelector(s)).filter(Boolean)
        ]);
        if (!editor) {
          return { ok: false, reason: 'composer-input-not-found' };
        }
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const replaced = document.execCommand('insertText', false, value);
        if (!replaced) {
          editor.textContent = value;
        }
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, mode: 'contenteditable', length: value.length };
      } catch (error) {
        return {
          ok: false,
          reason: 'exception',
          message: String((error && error.message) || error || 'unknown')
        };
      }
    })()`);
  };

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('DOM.enable');
  await cdp('Page.bringToFront');

  const readyDeadline = Date.now() + timeoutMs;
  let ready = null;
  while (Date.now() < readyDeadline) {
    ready = await evaluate(`(() => {
      const textareaSelectors = [
        '#prompt-textarea',
        'textarea[name="prompt-textarea"]',
        'textarea[data-id="prompt-textarea"]',
        'textarea[placeholder*="Send a message"]',
        'textarea[aria-label="Message ChatGPT"]',
        'textarea:not([disabled])'
      ];
      const visible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const pickFirst = (nodes) => nodes.find((node) => visible(node)) || nodes[0] || null;
      const textareas = textareaSelectors.map((s) => document.querySelector(s)).filter(Boolean);
      const textarea = pickFirst(textareas);
      const composerRoot =
        (textarea && textarea.closest('[data-testid*="composer"], form')) ||
        document.querySelector('[data-testid*="composer"]') ||
        document.querySelector('form');

      const inputCandidates = [];
      if (composerRoot) {
        inputCandidates.push(...composerRoot.querySelectorAll('input[type="file"]'));
      }
      inputCandidates.push(...document.querySelectorAll('[data-testid*="composer"] input[type="file"]'));
      inputCandidates.push(...document.querySelectorAll('form input[type="file"]'));
      inputCandidates.push(...document.querySelectorAll('input[type="file"]'));
      const deduped = [];
      const seen = new Set();
      for (const node of inputCandidates) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        deduped.push(node);
      }
      const fileInput = pickFirst(deduped);
      const composerText = composerRoot ? (composerRoot.innerText || '') : '';

      return {
        ready: Boolean(textarea && fileInput),
        textareaReady: Boolean(textarea),
        fileInputReady: Boolean(fileInput),
        composerText: composerText.slice(0, 20000),
        href: location.href
      };
    })()`);

    if (ready?.ready) {
      break;
    }
    await sleep(300);
  }

  if (!ready?.ready) {
    throw new Error(`Composer was not ready for draft staging (textarea=${Boolean(ready?.textareaReady)}, fileInput=${Boolean(ready?.fileInputReady)}).`);
  }

  const modelSelection = await ensureDraftModelSelected();
  if (modelSelection?.ok) {
    console.log(`Draft model selected: ${modelSelection.label}`);
  } else {
    console.warn(`Draft model selection warning (${modelTargetRaw}): ${JSON.stringify(modelSelection?.details || modelSelection)}`);
  }

  const thinkingSelection = await ensureDraftThinkingSelected();
  if (thinkingSelection?.ok) {
    console.log(`Draft thinking selected: ${thinkingSelection.label}`);
  } else {
    console.warn(`Draft thinking selection warning (${thinkingTarget}): ${JSON.stringify(thinkingSelection?.details || thinkingSelection)}`);
  }

  if (draftPrompt.length > 0) {
    const promptSetResult = await setDraftComposerPrompt(draftPrompt);
    if (promptSetResult?.ok) {
      console.log(`Draft prompt prefilled in composer (${promptSetResult.length} chars, mode=${promptSetResult.mode}).`);
    } else {
      console.warn(`Draft prompt prefill warning: ${JSON.stringify(promptSetResult || { ok: false })}`);
    }
  }

  const fileInputHandle = await evaluateHandle(`(() => {
    const textareaSelectors = [
      '#prompt-textarea',
      'textarea[name="prompt-textarea"]',
      'textarea[data-id="prompt-textarea"]',
      'textarea[placeholder*="Send a message"]',
      'textarea[aria-label="Message ChatGPT"]',
      'textarea:not([disabled])'
    ];
    const visible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const pickFirst = (nodes) => nodes.find((node) => visible(node)) || nodes[0] || null;
    const textareas = textareaSelectors.map((s) => document.querySelector(s)).filter(Boolean);
    const textarea = pickFirst(textareas);
    const composerRoot =
      (textarea && textarea.closest('[data-testid*="composer"], form')) ||
      document.querySelector('[data-testid*="composer"]') ||
      document.querySelector('form');
    const inputCandidates = [];
    if (composerRoot) {
      inputCandidates.push(...composerRoot.querySelectorAll('input[type="file"]'));
    }
    inputCandidates.push(...document.querySelectorAll('[data-testid*="composer"] input[type="file"]'));
    inputCandidates.push(...document.querySelectorAll('form input[type="file"]'));
    inputCandidates.push(...document.querySelectorAll('input[type="file"]'));
    const deduped = [];
    const seen = new Set();
    for (const node of inputCandidates) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      deduped.push(node);
    }
    return pickFirst(deduped);
  })()`);
  const uploadObjectId = fileInputHandle?.objectId;
  if (!uploadObjectId) {
    throw new Error('Could not resolve composer file input object for draft upload');
  }

  await cdp('DOM.setFileInputFiles', {
    objectId: uploadObjectId,
    files: filesToAttach,
  });

  const expectedNames = filesToAttach
    .map((value) => String(value).split(/[\\\\/]/).pop())
    .filter(Boolean);

  const attachDeadline = Date.now() + Math.max(20_000, timeoutMs / 2);
  let attachedCount = 0;
  let namesVisible = false;
  while (Date.now() < attachDeadline) {
    const counts = await evaluate(`(() => {
      const textareaSelectors = [
        '#prompt-textarea',
        'textarea[name="prompt-textarea"]',
        'textarea[data-id="prompt-textarea"]',
        'textarea[placeholder*="Send a message"]',
        'textarea[aria-label="Message ChatGPT"]',
        'textarea:not([disabled])'
      ];
      const visible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const pickFirst = (nodes) => nodes.find((node) => visible(node)) || nodes[0] || null;
      const textareas = textareaSelectors.map((s) => document.querySelector(s)).filter(Boolean);
      const textarea = pickFirst(textareas);
      const composerRoot =
        (textarea && textarea.closest('[data-testid*="composer"], form')) ||
        document.querySelector('[data-testid*="composer"]') ||
        document.querySelector('form');
      const inputCandidates = [];
      if (composerRoot) {
        inputCandidates.push(...composerRoot.querySelectorAll('input[type="file"]'));
      }
      inputCandidates.push(...document.querySelectorAll('[data-testid*="composer"] input[type="file"]'));
      inputCandidates.push(...document.querySelectorAll('form input[type="file"]'));
      inputCandidates.push(...document.querySelectorAll('input[type="file"]'));
      const deduped = [];
      const seen = new Set();
      for (const node of inputCandidates) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        deduped.push(node);
      }
      const fileInput = pickFirst(deduped);
      return {
        attached: fileInput?.files?.length || 0,
        composerText: (composerRoot?.innerText || '').slice(0, 20000)
      };
    })()`);
    attachedCount = Number(counts?.attached || 0);
    const composerText = String(counts?.composerText || '').toLowerCase();
    namesVisible = expectedNames.every((name) => composerText.includes(String(name).toLowerCase()));
    if (attachedCount >= filesToAttach.length && namesVisible) {
      break;
    }
    await sleep(250);
  }

  if (attachedCount < filesToAttach.length || !namesVisible) {
    throw new Error(`Composer attachments not fully visible (staged=${attachedCount}/${filesToAttach.length}, namesVisible=${namesVisible})`);
  }

  console.log(`Draft prepared in ChatGPT tab: attachments staged (${attachedCount}/${filesToAttach.length}).`);
  ws.close();
}

main().catch((error) => {
  console.error(`Draft staging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
EOF
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
oracle_bin=""
preset_dir=""
package_script=""
config_path=""
browser="chrome"
browser_profile=""
browser_chrome_path=""
browser_manual_login=0
manual_login_fallback=0
browser_cookie_wait="5s"
keychain_timeout_ms="${ORACLE_KEYCHAIN_PROBE_TIMEOUT_MS:-10000}"
oracle_force=1
keychain_preflight=0
remote_managed=1
remote_port="9222"
remote_user_data_dir="$HOME/.oracle/remote-chrome"
remote_profile="Default"
dry_run=0
list_only=0
send_mode=0

declare -a selected_presets
declare -a preset_inputs
declare -a extra_prompt_files
declare -a oracle_extra_args
declare -a extra_prompt_chunks

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
    --list-presets)
      list_only=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --send|--submit)
      send_mode=1
      shift
      ;;
    --no-send)
      send_mode=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        oracle_extra_args+=("$1")
        shift
      done
      break
      ;;
    *)
      if [[ "$1" == -* ]]; then
        echo "Error: unknown option '$1'." >&2
        echo "Tip: pass advanced Oracle flags after '--' to forward them directly." >&2
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
if ! resolved_browser_chrome_path="$(find_chrome_browser_binary)"; then
  echo "Error: no Chrome executable was found." >&2
  exit 1
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

if [ "$remote_managed" -eq 1 ]; then
  browser_manual_login=0
  keychain_preflight=0
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
if [ -n "${selected_presets[*]-}" ] || [ -n "${extra_prompt_files[*]-}" ] || [ -n "${extra_prompt_chunks[*]-}" ]; then
  prompt_text="$(
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
      require_file "$token"
      cat "$token"
      echo
    done

    for token in "${extra_prompt_chunks[@]-}"; do
      if [ -z "$token" ]; then
        continue
      fi
      printf '%s\n' "$token"
      echo
    done
    }
  )"
  draft_prompt_text="$prompt_text"
else
  # Oracle browser mode rejects empty/whitespace prompts; use a minimal placeholder.
  prompt_text="."
fi

declare -a oracle_launcher
if [ -n "$oracle_bin" ]; then
  oracle_launcher=("$oracle_bin")
elif command -v oracle >/dev/null 2>&1; then
  oracle_launcher=("oracle")
elif command -v npx >/dev/null 2>&1; then
  oracle_launcher=("npx" "-y" "@steipete/oracle")
else
  echo "Error: oracle is not installed and npx is unavailable." >&2
  echo "Install oracle or ensure npx is available, then retry." >&2
  exit 1
fi

declare -a oracle_cmd
oracle_cmd=(
  "${oracle_launcher[@]}"
  --engine browser
  --model "$model"
  --browser-model-strategy select
  --browser-thinking-time "$thinking"
  --browser-attachments always
  --browser-cookie-wait "$browser_cookie_wait"
  --prompt "$prompt_text"
  --file "$zip_path"
)

if [ -n "$resolved_browser_chrome_path" ]; then
  oracle_cmd+=(--browser-chrome-path "$resolved_browser_chrome_path")
fi

if [ -n "$resolved_browser_profile" ]; then
  oracle_cmd+=(--browser-chrome-profile "$resolved_browser_profile")
fi

if [ "$browser_manual_login" -eq 1 ]; then
  oracle_cmd+=(--browser-manual-login)
fi

oracle_cmd+=(--chatgpt-url "$resolved_chatgpt_url")

if [ -n "${oracle_extra_args[*]-}" ]; then
  oracle_cmd+=("${oracle_extra_args[@]}")
fi

if [ "$remote_managed" -eq 1 ]; then
  oracle_cmd+=(--remote-chrome "127.0.0.1:${remote_port}" --browser-no-cookie-sync)
fi

force_enabled="$oracle_force"
for arg in "${oracle_extra_args[@]-}"; do
  if [ "$arg" = "--force" ]; then
    force_enabled=1
    break
  fi
done

if [ "$oracle_force" -eq 1 ]; then
  oracle_cmd+=(--force)
fi

if [ -n "${selected_presets[*]-}" ]; then
  echo "Prompt presets: ${selected_presets[*]}"
else
  echo "Prompt presets: (none; upload-only prompt)"
fi
if [ -n "$draft_prompt_text" ]; then
  echo "Prompt staging: inline composer prefill (${#draft_prompt_text} chars)"
else
  echo "Prompt staging: none"
fi
echo "ZIP file: $zip_path"
echo "Browser target: $browser"
echo "Browser cookie wait: $browser_cookie_wait"
echo "Keychain timeout (ms): $keychain_timeout_ms"
if [ "$force_enabled" -eq 1 ]; then
  echo "Oracle force mode: enabled"
fi
if [ "$browser_manual_login" -eq 1 ]; then
  echo "Manual login mode: enabled"
elif [ "$manual_login_fallback" -eq 1 ]; then
  echo "Manual login fallback: enabled (auto-retry on cookie-sync failure)"
else
  echo "Manual login fallback: disabled"
fi
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
if [ "$send_mode" -eq 1 ]; then
  echo "Send mode: enabled"
else
  echo "Send mode: disabled (default; add --send to submit)"
fi

if [ "$dry_run" -eq 1 ]; then
  echo "Env: ORACLE_KEYCHAIN_PROBE_TIMEOUT_MS=$keychain_timeout_ms"
  echo "Env: ORACLE_COOKIE_LOAD_TIMEOUT_MS=$keychain_timeout_ms"
  print_command "${oracle_cmd[@]}"
  if [ "$manual_login_fallback" -eq 1 ] && [ "$browser_manual_login" -eq 0 ]; then
    echo "Fallback: retries once with --browser-manual-login if cookie sync fails."
  fi
  exit 0
fi

if [ "$send_mode" -ne 1 ]; then
  declare -a draft_files
  draft_files=("$zip_path")

  if [ "$remote_managed" -eq 1 ]; then
    remote_log="${TMPDIR:-/tmp}/chatgpt-review-remote-chrome.log"
    ensure_remote_chrome "$resolved_browser_chrome_path" "$remote_user_data_dir" "$remote_profile" "$remote_port" "$remote_log" "$resolved_chatgpt_url"
    prepare_chatgpt_draft "$remote_port" "$resolved_chatgpt_url" "$model" "$thinking" "90000" "$draft_prompt_text" "${draft_files[@]}"
  else
    open_chrome_window "$resolved_browser_chrome_path" "$resolved_chatgpt_url" "$resolved_browser_profile"
    echo "Warning: no-send draft staging requires remote managed mode; opened ChatGPT only." >&2
  fi
  echo "Opened ChatGPT in no-send mode with draft staged."
  echo "Oracle auto-submit skipped. Use --send to submit automatically."
  echo "ZIP file: $zip_path"
  exit 0
fi

if [ "$remote_managed" -eq 1 ]; then
  remote_log="${TMPDIR:-/tmp}/chatgpt-review-remote-chrome.log"
  ensure_remote_chrome "$resolved_browser_chrome_path" "$remote_user_data_dir" "$remote_profile" "$remote_port" "$remote_log" "$resolved_chatgpt_url"
fi

if [ "$browser_manual_login" -eq 0 ] && [ "$keychain_preflight" -eq 1 ]; then
  run_keychain_preflight
fi

export ORACLE_KEYCHAIN_PROBE_TIMEOUT_MS="$keychain_timeout_ms"
export ORACLE_COOKIE_LOAD_TIMEOUT_MS="$keychain_timeout_ms"
print_command "${oracle_cmd[@]}"
oracle_run_log="$(mktemp -t chatgpt-oracle-review.XXXXXX.log)"
set +e
"${oracle_cmd[@]}" 2>&1 | tee "$oracle_run_log"
oracle_status=${PIPESTATUS[0]}
set -e

if [ "$oracle_status" -eq 0 ]; then
  rm -f "$oracle_run_log"
  exit 0
fi

if grep -q "A session with the same prompt is already running" "$oracle_run_log"; then
  if [ "$force_enabled" -eq 0 ]; then
    echo "Duplicate Oracle session detected; retrying once with --force."
    retry_cmd=("${oracle_cmd[@]}" --force)
    print_command "${retry_cmd[@]}"
    set +e
    "${retry_cmd[@]}"
    retry_status=$?
    set -e
    rm -f "$oracle_run_log"
    exit "$retry_status"
  fi
fi

if grep -q "No ChatGPT cookies were applied from your Chrome profile" "$oracle_run_log"; then
  if [ "$manual_login_fallback" -eq 1 ] && [ "$browser_manual_login" -eq 0 ]; then
    echo "Cookie sync failed; retrying once with --browser-manual-login (persistent profile, no Chrome keychain read)."
    retry_cmd=("${oracle_cmd[@]}" --browser-manual-login)
    print_command "${retry_cmd[@]}"
    set +e
    "${retry_cmd[@]}"
    retry_status=$?
    set -e
    rm -f "$oracle_run_log"
    exit "$retry_status"
  fi
fi

rm -f "$oracle_run_log"
exit "$oracle_status"
