const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const remotePort = process.env.ORACLE_DRAFT_REMOTE_PORT;
const chatgptUrl = process.env.ORACLE_DRAFT_URL;
const draftMode = String(process.env.ORACLE_DRAFT_MODE || 'chat').trim().toLowerCase() || 'chat';
const isDeepResearchMode = draftMode === 'deep-research';
const normalizeSelectionTarget = (value, fallback = 'current') => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};
const modelTargetRaw = normalizeSelectionTarget(
  process.env.ORACLE_DRAFT_MODEL,
  isDeepResearchMode ? 'current' : 'gpt-5.4-pro'
);
const thinkingTarget = normalizeSelectionTarget(process.env.ORACLE_DRAFT_THINKING, 'current').toLowerCase();
const timeoutMs = Number(process.env.ORACLE_DRAFT_TIMEOUT_MS || 90000);
const shouldWaitForResponse = /^(1|true|yes|on)$/i.test(String(process.env.ORACLE_DRAFT_WAIT_RESPONSE || '0'));
const responseTimeoutMs = Number(
  process.env.ORACLE_DRAFT_RESPONSE_TIMEOUT_MS || timeoutMs || (isDeepResearchMode ? 2_400_000 : 600_000)
);
const responseFile = String(process.env.ORACLE_DRAFT_RESPONSE_FILE || '').trim();
const draftPrompt = process.env.ORACLE_DRAFT_PROMPT || '';
const shouldSend = /^(1|true|yes|on)$/i.test(String(process.env.ORACLE_DRAFT_SEND || '0'));
const filesToAttach = (process.env.ORACLE_DRAFT_FILES || '')
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);
const shouldAttachFiles = filesToAttach.length > 0;
const COMPOSER_TEXTAREA_SELECTORS = [
  '#prompt-textarea',
  'textarea[name="prompt-textarea"]',
  'textarea[data-id="prompt-textarea"]',
  'textarea[placeholder*="Send a message"]',
  'textarea[aria-label="Message ChatGPT"]',
  'textarea:not([disabled])',
];
const COMPOSER_EDITABLE_SELECTORS = [
  '.ProseMirror',
  '[contenteditable="true"][data-virtualkeyboard="true"]',
  '[contenteditable="true"][role="textbox"]',
  '[data-testid*="composer"] [contenteditable="true"]',
  'form [contenteditable="true"]',
];
const ATTACHMENT_UI_SELECTORS = [
  '[data-testid*="attachment"]',
  '[data-testid*="upload"]',
  '[data-testid*="progress"]',
  '[data-testid*="file"]',
  'button[aria-label*="Remove"]',
  'button[aria-label*="remove"]',
];
const ATTACHMENT_PROGRESS_SELECTORS = [
  '[data-state="loading"]',
  '[data-state="uploading"]',
  '[data-state="pending"]',
  '[aria-busy="true"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
];
const MODEL_BUTTON_SELECTOR = '[data-testid="model-switcher-dropdown-button"]';
const MENU_CONTAINER_SELECTOR = '[role="menu"], [data-radix-collection-root]';
const MENU_ITEM_SELECTOR = 'button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]';
const ENTER_KEY_EVENT = {
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
};
const ENTER_KEY_TEXT = '\r';
const RESPONSE_MARKER_BEGIN = '----- REVIEW_GPT_RESPONSE_BEGIN -----';
const RESPONSE_MARKER_END = '----- REVIEW_GPT_RESPONSE_END -----';
const SAFE_RETRY_STAGES = new Set([
  'connect',
  'initial-ready',
  'auth-probe',
  'model-selection',
  'thinking-selection',
  'prompt-prefill',
  'attachments',
]);

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

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizePathname(pathname) {
  if (!pathname) return '/';
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed || '/';
}

function extractChatId(pathname) {
  if (!pathname) return '';
  const match = pathname.match(/\/c\/([^/?#]+)/i);
  return match?.[1] || '';
}

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPromptMatchCandidates(prompt) {
  const normalized = normalizeComparableText(prompt);
  if (!normalized) return [];
  const candidates = [240, 160, 96, 48]
    .map((length) => normalized.slice(0, Math.min(length, normalized.length)))
    .filter((value) => value.length >= 12);
  return Array.from(new Set(candidates));
}

function promptSignatureMatches(signature, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return false;
  const normalizedSignature = normalizeComparableText(signature);
  if (!normalizedSignature) return false;
  return candidates.some((candidate) => normalizedSignature.includes(candidate) || candidate.includes(normalizedSignature));
}

function normalizeModelPickerText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function modelPickerTextHasWord(value, word) {
  const normalizedValue = normalizeModelPickerText(value);
  const normalizedWord = normalizeModelPickerText(word);
  if (!normalizedValue || !normalizedWord) return false;
  return ` ${normalizedValue} `.includes(` ${normalizedWord} `);
}

function modelPickerLabelMatchesTarget(label, target) {
  const normalizedLabel = normalizeModelPickerText(label);
  const desiredVersion = String(target?.desiredVersion || '').trim();
  const wantsPro = Boolean(target?.wantsPro);
  const wantsInstant = Boolean(target?.wantsInstant);
  const wantsThinking = Boolean(target?.wantsThinking);
  if (!normalizedLabel) return false;

  const hasWord = (word) => modelPickerTextHasWord(normalizedLabel, word);
  const hasProWord = hasWord('pro');
  const hasInstantWord = hasWord('instant');
  const hasThinkingWord = hasWord('thinking');
  const hasExtendedPro = normalizedLabel.includes('extended pro');
  const hasOtherExplicitVersion =
    normalizedLabel.includes('5 0') ||
    normalizedLabel.includes('5 1') ||
    normalizedLabel.includes('5 2');
  const matchesCompactPro54 =
    desiredVersion === '5-4' &&
    wantsPro &&
    hasProWord &&
    !hasInstantWord &&
    !hasThinkingWord &&
    !hasOtherExplicitVersion;

  if (desiredVersion) {
    if (desiredVersion === '5-4' && !normalizedLabel.includes('5 4') && !hasExtendedPro && !matchesCompactPro54) {
      return false;
    }
    if (desiredVersion === '5-2' && !normalizedLabel.includes('5 2')) return false;
    if (desiredVersion === '5-1' && !normalizedLabel.includes('5 1')) return false;
    if (desiredVersion === '5-0' && !normalizedLabel.includes('5 0')) return false;
  }

  if (wantsPro && !hasProWord && !hasExtendedPro && !matchesCompactPro54) return false;
  if (wantsInstant && !hasInstantWord) return false;
  if (wantsThinking && !hasThinkingWord) return false;
  if (!wantsPro && (hasProWord || hasExtendedPro || matchesCompactPro54)) return false;
  if (!wantsInstant && hasInstantWord) return false;
  if (!wantsThinking && hasThinkingWord) return false;
  return true;
}

function modelPickerSelectionStateMatches(snapshot) {
  const ariaChecked = String(snapshot?.ariaChecked || '').toLowerCase();
  const ariaSelected = String(snapshot?.ariaSelected || '').toLowerCase();
  const ariaCurrent = String(snapshot?.ariaCurrent || '').toLowerCase();
  const dataSelected = String(snapshot?.dataSelected || '').toLowerCase();
  const dataState = normalizeModelPickerText(snapshot?.dataState || '');
  const trailingText = normalizeModelPickerText(snapshot?.trailingText || '');
  const selectedStates = new Set(['checked', 'selected', 'on', 'true']);

  if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') {
    return true;
  }
  if (dataSelected === 'true' || selectedStates.has(dataState)) {
    return true;
  }
  if (snapshot?.hasCheckIcon) {
    return true;
  }
  if (snapshot?.hasTrailingSpriteIcon && !trailingText) {
    return true;
  }
  return false;
}

function normalizeResponseText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isLikelyPromptEcho(text, candidates) {
  const normalizedText = normalizeComparableText(text);
  if (!normalizedText) return false;
  if (!promptSignatureMatches(normalizedText, candidates)) return false;
  const longestCandidate = Array.isArray(candidates)
    ? candidates.reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest), '')
    : '';
  const threshold = Math.max(longestCandidate.length + 64, Math.floor(longestCandidate.length * 1.25));
  return normalizedText.length <= threshold;
}

function selectAssistantResponseCandidate(state, baselineAssistantSignatures, promptCandidates) {
  const assistantSnapshots = Array.isArray(state?.assistantSnapshots)
    ? state.assistantSnapshots
        .filter((snapshot) => snapshot && typeof snapshot.signature === 'string')
        .map((snapshot) => ({
          ...snapshot,
          text: normalizeResponseText(snapshot.text),
        }))
        .filter((snapshot) => snapshot.text)
    : [];
  const baselineSet = new Set(
    Array.isArray(baselineAssistantSignatures)
      ? baselineAssistantSignatures.filter((value) => typeof value === 'string' && value.length > 0)
      : []
  );
  const freshSnapshots = assistantSnapshots.filter((snapshot) => !baselineSet.has(snapshot.signature));
  const ordered = freshSnapshots.length > 0 ? freshSnapshots : assistantSnapshots;
  let promptEchoSnapshot = null;

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const snapshot = ordered[index];
    if (!snapshot?.text) continue;
    if (!isLikelyPromptEcho(snapshot.text, promptCandidates)) {
      return {
        snapshot,
        freshSnapshots,
      };
    }
    if (!promptEchoSnapshot) {
      promptEchoSnapshot = snapshot;
    }
  }

  return {
    snapshot: promptEchoSnapshot,
    freshSnapshots,
  };
}

function emitCapturedResponse(text, href, partial = false) {
  const normalized = normalizeResponseText(text);
  if (!normalized) return;

  if (href) {
    console.log(`ChatGPT conversation URL: ${href}`);
  }
  if (partial) {
    console.warn('Assistant response capture timed out before completion; returning the latest partial response.');
  }
  console.log(RESPONSE_MARKER_BEGIN);
  console.log(normalized);
  console.log(RESPONSE_MARKER_END);
}

function writeCapturedResponseFile(filePath, text) {
  if (!filePath) return;
  const outputText = normalizeResponseText(text);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${outputText}\n`, 'utf8');
}

function normalizeAttachmentName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const base = raw.split(/[\\/]/).pop() || '';
  return base.trim().toLowerCase();
}

function buildExpectedAttachmentNames(paths) {
  const names = Array.isArray(paths) ? paths.map((value) => normalizeAttachmentName(value)).filter(Boolean) : [];
  return Array.from(new Set(names));
}

function summarizeAttachmentVerification(currentState, baselineState, expectedNames, expectedCount) {
  const normalizedExpectedNames = Array.isArray(expectedNames)
    ? expectedNames.map((value) => normalizeAttachmentName(value)).filter(Boolean)
    : [];
  const normalizedExpectedCount = Math.max(0, Number(expectedCount || normalizedExpectedNames.length || 0));
  const currentComposerText = String(currentState?.composerText || '').toLowerCase();
  const currentAttachmentText = String(currentState?.attachmentText || '').toLowerCase();
  const attachedCount = Math.max(0, Number(currentState?.attachedCount || 0));
  const attachmentUiCount = Math.max(0, Number(currentState?.attachmentUiCount || 0));
  const baselineAttachmentUiCount = Math.max(0, Number(baselineState?.attachmentUiCount || 0));
  const uploading = Boolean(currentState?.uploading);
  const namesVisible = normalizedExpectedNames.every((name) =>
    currentAttachmentText.includes(name) || currentComposerText.includes(name)
  );
  const attachmentUiSignature = String(currentState?.attachmentUiSignature || '').trim();
  const baselineAttachmentUiSignature = String(baselineState?.attachmentUiSignature || '').trim();
  const attachmentUiChanged =
    attachmentUiSignature.length > 0 && attachmentUiSignature !== baselineAttachmentUiSignature;
  const attachmentUiProgressed = uploading || attachmentUiCount > baselineAttachmentUiCount || attachmentUiChanged;
  const attachedEnough = attachedCount >= normalizedExpectedCount;
  const confirmed = Boolean(
    uploading ||
      attachmentUiCount > baselineAttachmentUiCount ||
      (attachmentUiChanged && (attachedEnough || namesVisible)) ||
      (namesVisible && attachedEnough)
  );

  return {
    expectedCount: normalizedExpectedCount,
    attachedCount,
    attachmentUiCount,
    baselineAttachmentUiCount,
    uploading,
    namesVisible,
    attachmentUiChanged,
    attachmentUiProgressed,
    attachedEnough,
    fileInputReady: Boolean(currentState?.fileInputReady),
    readyStateComplete: String(currentState?.readyState || '').toLowerCase() === 'complete',
    confirmed,
    inputOnly: attachedEnough && !attachmentUiProgressed && !namesVisible,
  };
}

function formatAttachmentVerificationSummary(summary) {
  const expectedCount = Math.max(0, Number(summary?.expectedCount || 0));
  const attachedCount = Math.max(0, Number(summary?.attachedCount || 0));
  const attachmentUiCount = Math.max(0, Number(summary?.attachmentUiCount || 0));
  const baselineAttachmentUiCount = Math.max(0, Number(summary?.baselineAttachmentUiCount || 0));
  return [
    `attached=${attachedCount}/${expectedCount}`,
    `ui=${attachmentUiCount} (baseline=${baselineAttachmentUiCount})`,
    `uploading=${Boolean(summary?.uploading)}`,
    `namesVisible=${Boolean(summary?.namesVisible)}`,
    `uiChanged=${Boolean(summary?.attachmentUiChanged)}`,
  ].join(', ');
}

async function pickTarget(desiredUrl) {
  const targets = await fetchJson('/json/list');
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  const exact = pages.filter((target) => target.url === desiredUrl).pop();
  if (exact) return exact;

  const desiredParsed = safeUrl(desiredUrl);
  if (desiredParsed) {
    const desiredOrigin = desiredParsed.origin;
    const desiredPath = normalizePathname(desiredParsed.pathname);
    const desiredSearch = desiredParsed.search;
    const desiredChatId = extractChatId(desiredParsed.pathname);
    const wantsSpecificRoute = desiredPath !== '/' || Boolean(desiredSearch) || Boolean(desiredParsed.hash);

    const sameRoute = pages
      .filter((target) => {
        const parsed = safeUrl(target.url);
        if (!parsed) return false;
        if (parsed.origin !== desiredOrigin) return false;
        if (normalizePathname(parsed.pathname) !== desiredPath) return false;
        if (desiredSearch && parsed.search !== desiredSearch) return false;
        return true;
      })
      .pop();
    if (sameRoute) return sameRoute;

    if (desiredChatId) {
      const sameChat = pages
        .filter((target) => {
          const parsed = safeUrl(target.url);
          if (!parsed) return false;
          if (parsed.origin !== desiredOrigin) return false;
          return extractChatId(parsed.pathname) === desiredChatId;
        })
        .pop();
      if (sameChat) return sameChat;
    }

    if (!wantsSpecificRoute) {
      const sameOrigin = pages
        .filter((target) => {
          const parsed = safeUrl(target.url);
          return Boolean(parsed && parsed.origin === desiredOrigin);
        })
        .pop();
      if (sameOrigin) return sameOrigin;
    }
  }

  const sameHost = pages.filter((target) => urlHost(target.url) && urlHost(target.url) === urlHost(desiredUrl)).pop();
  if (sameHost) return sameHost;

  if (!desiredParsed) {
    const latest = pages[pages.length - 1];
    if (latest) return latest;
  }
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

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isCurrentSelectionTarget(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === 'current' || normalized === 'keep' || normalized === 'skip';
}

function isRetryableSocketError(error) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('cdp socket closed unexpectedly') ||
    message.includes('cdp socket error') ||
    message.includes('websocket') ||
    message.includes('target closed')
  );
}

async function main() {
  let currentStage = 'connect';
  const tagStageError = (error) => {
    if (error && typeof error === 'object' && !error.reviewGptStage) {
      error.reviewGptStage = currentStage;
    }
    return error;
  };

  const ws = await connectTargetWebSocket(chatgptUrl).catch((error) => {
    throw tagStageError(error);
  });
  try {
    try {

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

  const desiredTargetUrl = safeUrl(chatgptUrl);
  const desiredTargetOrigin = desiredTargetUrl?.origin || '';
  const desiredTargetChatId = extractChatId(desiredTargetUrl?.pathname || '').toLowerCase();
  const desiredTargetOriginLiteral = JSON.stringify(desiredTargetOrigin);
  const desiredTargetChatIdLiteral = JSON.stringify(desiredTargetChatId);
  const promptMatchCandidates = buildPromptMatchCandidates(draftPrompt);
  const textareaSelectorsLiteral = JSON.stringify(COMPOSER_TEXTAREA_SELECTORS);
  const editableSelectorsLiteral = JSON.stringify(COMPOSER_EDITABLE_SELECTORS);
  const attachmentUiSelectorsLiteral = JSON.stringify(ATTACHMENT_UI_SELECTORS);
  const attachmentProgressSelectorsLiteral = JSON.stringify(ATTACHMENT_PROGRESS_SELECTORS);
  const buildComposerInspectionSource = () => `
    const TEXTAREA_SELECTORS = ${textareaSelectorsLiteral};
    const EDITABLE_SELECTORS = ${editableSelectorsLiteral};
    const ATTACHMENT_UI_SELECTORS = ${attachmentUiSelectorsLiteral};
    const ATTACHMENT_PROGRESS_SELECTORS = ${attachmentProgressSelectorsLiteral};
    const visible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const signatureize = (value) => normalize(value).slice(0, 320);
    const pickFirst = (nodes) => nodes.find((node) => visible(node)) || nodes[0] || null;
    const dedupeNodes = (nodes) => {
      const deduped = [];
      const seen = new Set();
      for (const node of nodes) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        deduped.push(node);
      }
      return deduped;
    };
    const readValue = (node) => {
      if (!node) return '';
      if (node instanceof HTMLTextAreaElement) return node.value || '';
      return node.innerText || node.textContent || '';
    };
    const findComposerInput = () => {
      const nodes = [
        ...TEXTAREA_SELECTORS.map((selector) => document.querySelector(selector)).filter(Boolean),
        ...EDITABLE_SELECTORS.map((selector) => document.querySelector(selector)).filter(Boolean),
      ];
      return pickFirst(nodes);
    };
    const findComposerRoot = (composerInput) =>
      (composerInput && composerInput.closest('[data-testid*="composer"], form')) ||
      document.querySelector('[data-testid*="composer"]') ||
      document.querySelector('form');
    const collectComposerScopes = (composerRoot, composerInput) => {
      const scopes = [];
      const push = (node) => {
        if (node && typeof node.querySelectorAll === 'function') scopes.push(node);
      };
      push(composerRoot);
      push(composerInput && composerInput.closest('[data-testid*="composer"]'));
      push(composerInput && composerInput.closest('form'));
      return dedupeNodes(scopes);
    };
    const findComposerFileInput = (composerRoot) => {
      const inputCandidates = [];
      if (composerRoot) {
        inputCandidates.push(...composerRoot.querySelectorAll('input[type="file"]'));
      }
      inputCandidates.push(...document.querySelectorAll('[data-testid*="composer"] input[type="file"]'));
      inputCandidates.push(...document.querySelectorAll('form input[type="file"]'));
      inputCandidates.push(...document.querySelectorAll('input[type="file"]'));
      return pickFirst(dedupeNodes(inputCandidates));
    };
    const collectAttachmentSignals = (scopes) => {
      const uiNodes = [];
      const progressNodes = [];
      for (const scope of scopes) {
        for (const selector of ATTACHMENT_UI_SELECTORS) {
          uiNodes.push(...scope.querySelectorAll(selector));
        }
        for (const selector of ATTACHMENT_PROGRESS_SELECTORS) {
          progressNodes.push(...scope.querySelectorAll(selector));
        }
      }
      const visibleUiNodes = dedupeNodes(uiNodes).filter((node) => visible(node));
      const visibleProgressNodes = dedupeNodes(progressNodes).filter((node) => visible(node));
      let uploading = false;
      const textChunks = [];
      const signalNodes = dedupeNodes([...visibleUiNodes, ...visibleProgressNodes]);
      for (const node of signalNodes) {
        const ariaBusy = normalize(node.getAttribute?.('aria-busy'));
        const dataState = normalize(node.getAttribute?.('data-state'));
        const text = normalize(node.innerText || node.textContent || '');
        if (ariaBusy === 'true') uploading = true;
        if (dataState === 'loading' || dataState === 'uploading' || dataState === 'pending') uploading = true;
        if (text.includes('uploading') || text.includes('processing')) uploading = true;
        if (text) {
          textChunks.push(text.slice(0, 300));
        }
      }
      const signatureParts = visibleUiNodes.map((node) => [
        String(node.tagName || ''),
        String(node.getAttribute?.('data-testid') || ''),
        String(node.getAttribute?.('role') || ''),
        String(node.getAttribute?.('aria-label') || ''),
        String(node.getAttribute?.('data-state') || ''),
        String(node.innerText || node.textContent || '').slice(0, 200),
      ].join('|'));
      return {
        uiCount: visibleUiNodes.length,
        uploading,
        text: textChunks.join('\\n').slice(0, 12000),
        signature: signatureize(signatureParts.join('\\n')),
      };
    };
    const href = typeof location === 'object' && location.href ? location.href : '';
    const readyState = document.readyState || '';
    const composerInput = findComposerInput();
    const composerRoot = findComposerRoot(composerInput);
    const scopes = collectComposerScopes(composerRoot, composerInput);
    const fileInput = findComposerFileInput(composerRoot);
    const attachment = collectAttachmentSignals(scopes);
    const desiredOrigin = ${desiredTargetOriginLiteral};
    const desiredChatId = ${desiredTargetChatIdLiteral};
    let targetMatch = false;
    if (!desiredOrigin && !desiredChatId) {
      targetMatch = true;
    } else {
      try {
        const parsedHref = new URL(href);
        const originMatch = !desiredOrigin || parsedHref.origin === desiredOrigin;
        const currentChatId = (parsedHref.pathname.match(/\\/c\\/([^/?#]+)/i)?.[1] || '').toLowerCase();
        const chatMatch = !desiredChatId || currentChatId === desiredChatId;
        targetMatch = originMatch && chatMatch;
      } catch {}
    }
    const composerValue = readValue(composerInput);
    const composerText = composerRoot ? (composerRoot.innerText || composerRoot.textContent || '') : '';
    const fileInputSignature = fileInput
      ? signatureize([
          String(fileInput.getAttribute?.('accept') || ''),
          String(fileInput.getAttribute?.('name') || ''),
          fileInput.multiple ? 'multiple' : 'single',
          fileInput.isConnected ? 'connected' : 'detached',
        ].join('|'))
      : '';
    const composerSignature = signatureize([
      href,
      readyState,
      targetMatch ? 'target-match' : 'target-mismatch',
      String(composerRoot?.tagName || ''),
      String(composerRoot?.getAttribute?.('data-testid') || ''),
      String(composerRoot?.childElementCount || 0),
      String(composerInput?.tagName || ''),
      signatureize(composerValue).slice(0, 120),
      fileInputSignature,
      attachment.signature,
    ].join('|'));
  `;
  const buildReadDraftComposerStateExpression = () => `(() => {
    ${buildComposerInspectionSource()}
    return {
      readyState,
      href,
      targetMatch,
      composerReady: Boolean(composerInput),
      fileInputReady: Boolean(fileInput),
      fileInputConnected: Boolean(fileInput?.isConnected),
      attachedCount: fileInput?.files?.length || 0,
      composerText: composerText.slice(0, 20000),
      attachmentText: attachment.text,
      attachmentUiCount: attachment.uiCount,
      attachmentUiSignature: attachment.signature,
      uploading: attachment.uploading,
      composerSignature,
      fileInputSignature,
    };
  })()`;
  const buildResolveDraftFileInputHandleExpression = () => `(() => {
    ${buildComposerInspectionSource()}
    return fileInput;
  })()`;

  const readDraftComposerState = async () => evaluate(buildReadDraftComposerStateExpression());
  const waitForDraftComposerReady = async (requireFileInput = false) => {
    const deadline = Date.now() + Math.max(8_000, Math.min(30_000, timeoutMs));
    let lastState = null;
    let stableKey = '';
    let stableCount = 0;
    while (Date.now() < deadline) {
      const state = await readDraftComposerState();
      lastState = state;
      const currentStableKey = [
        String(state?.href || ''),
        String(state?.composerSignature || ''),
        requireFileInput ? String(state?.fileInputSignature || '') : '',
      ].join('|');
      if (currentStableKey && currentStableKey === stableKey) {
        stableCount += 1;
      } else {
        stableKey = currentStableKey;
        stableCount = 1;
      }
      const readyStateComplete = String(state?.readyState || '').toLowerCase() === 'complete';
      const targetMatch = Boolean(state?.targetMatch);
      const composerReady = Boolean(state?.composerReady);
      const fileInputReady = !requireFileInput || Boolean(state?.fileInputReady);
      if (readyStateComplete && targetMatch && composerReady && fileInputReady && stableCount >= 3) {
        return {
          status: 'ready',
          state,
        };
      }
      await sleep(200);
    }
    return {
      status: 'context-timeout',
      state: lastState,
    };
  };
  const resolveDraftFileInputObjectId = async () => {
    const fileInputHandle = await evaluateHandle(buildResolveDraftFileInputHandleExpression());
    return fileInputHandle?.objectId || '';
  };
  const verifyDraftAttachments = async (baselineState, expectedNames, expectedCount) => {
    const attachDeadline = Date.now() + Math.max(20_000, timeoutMs / 2);
    let lastState = null;
    let lastSummary = summarizeAttachmentVerification(null, baselineState, expectedNames, expectedCount);
    while (Date.now() < attachDeadline) {
      const state = await readDraftComposerState();
      lastState = state;
      const summary = summarizeAttachmentVerification(state, baselineState, expectedNames, expectedCount);
      lastSummary = summary;
      if (summary.confirmed) {
        return {
          ok: true,
          state,
          summary,
        };
      }
      await sleep(250);
    }
    return {
      ok: false,
      state: lastState,
      summary: lastSummary,
    };
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

    if (base.includes('5.4') || base.includes('5-4') || base.includes('54')) {
      push('5.4', labelTokens);
      push('gpt-5.4', labelTokens);
      push('gpt5.4', labelTokens);
      push('gpt-5-4', labelTokens);
      push('gpt5-4', labelTokens);
      push('gpt54', labelTokens);
      push('chatgpt 5.4', labelTokens);
      push('extended pro', labelTokens);
      push('extendedpro', labelTokens);
      testIdTokens.add('gpt-5-4');
      testIdTokens.add('gpt5-4');
      testIdTokens.add('gpt54');
    }

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
      if (base.includes('5.4') || base.includes('5-4') || base.includes('54')) {
        push('extended pro', labelTokens);
        push('extendedpro', labelTokens);
        testIdTokens.add('gpt-5.4-pro');
        testIdTokens.add('gpt-5-4-pro');
        testIdTokens.add('gpt54pro');
        testIdTokens.add('extended-pro');
        testIdTokens.add('extendedpro');
      }
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
    const normalizeModelPickerTextLiteral = normalizeModelPickerText.toString();
    const modelPickerTextHasWordLiteral = modelPickerTextHasWord.toString();
    const modelPickerLabelMatchesTargetLiteral = modelPickerLabelMatchesTarget.toString();
    const modelPickerSelectionStateMatchesLiteral = modelPickerSelectionStateMatches.toString();

    return `(() => {
      ${buildClickDispatcher()}
      const normalizeModelPickerText = ${normalizeModelPickerTextLiteral};
      const modelPickerTextHasWord = ${modelPickerTextHasWordLiteral};
      const modelPickerLabelMatchesTarget = ${modelPickerLabelMatchesTargetLiteral};
      const modelPickerSelectionStateMatches = ${modelPickerSelectionStateMatchesLiteral};
      const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
      const LABEL_TOKENS = ${labelLiteral};
      const TEST_IDS = ${idLiteral};
      const PRIMARY_LABEL = ${primaryLabelLiteral};
      const MODEL_STRATEGY = ${strategyLiteral};
      const INITIAL_WAIT_MS = 150;
      const REOPEN_INTERVAL_MS = 400;
      const MAX_WAIT_MS = 20000;
      const normalizeText = (value) => normalizeModelPickerText(value);
      const normalizedTarget = normalizeText(PRIMARY_LABEL);
      const normalizedTokens = Array.from(new Set([normalizedTarget, ...LABEL_TOKENS]))
        .map((token) => normalizeText(token))
        .filter(Boolean);
      const targetWords = normalizedTarget.split(' ').filter(Boolean);
      const desiredVersion = normalizedTarget.includes('5 4')
        ? '5-4'
        : normalizedTarget.includes('5 2')
          ? '5-2'
          : normalizedTarget.includes('5 1')
            ? '5-1'
            : normalizedTarget.includes('5 0')
              ? '5-0'
              : null;
      const wantsPro = normalizedTarget.includes(' pro') || normalizedTarget.endsWith(' pro') || normalizedTokens.includes('pro');
      const wantsInstant = normalizedTarget.includes('instant');
      const wantsThinking = normalizedTarget.includes('thinking');
      const targetDescriptor = {
        desiredVersion,
        wantsPro,
        wantsInstant,
        wantsThinking,
      };

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
        return modelPickerLabelMatchesTarget(normalizedLabel, targetDescriptor);
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
        const trailing = node.querySelector('.trailing, [data-trailing-style]');
        return modelPickerSelectionStateMatches({
          ariaChecked: node.getAttribute('aria-checked'),
          ariaSelected: node.getAttribute('aria-selected'),
          ariaCurrent: node.getAttribute('aria-current'),
          dataSelected: node.getAttribute('data-selected'),
          dataState: node.getAttribute('data-state'),
          hasCheckIcon: Boolean(
            node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]')
          ),
          hasTrailingSpriteIcon: Boolean(trailing?.querySelector('svg use[href], svg use[xlink\\:href]')),
          trailingText: trailing?.textContent ?? '',
        });
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
            const has54 =
              normalizedTestId.includes('5-4') ||
              normalizedTestId.includes('5.4') ||
              normalizedTestId.includes('gpt-5-4') ||
              normalizedTestId.includes('gpt-5.4') ||
              normalizedTestId.includes('gpt54') ||
              normalizedTestId.includes('extended-pro') ||
              normalizedTestId.includes('extendedpro');
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
            const candidateVersion = has54 ? '5-4' : has52 ? '5-2' : has51 ? '5-1' : has50 ? '5-0' : null;
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
        const labelMatchesTarget = modelPickerLabelMatchesTarget(normalizedText, targetDescriptor);
        if (labelMatchesTarget) {
          score += 220;
        }
        if (desiredVersion === '5-4' && wantsPro && labelMatchesTarget && modelPickerTextHasWord(normalizedText, 'pro')) {
          score += 480;
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
          if (!modelPickerTextHasWord(normalizedText, 'pro')) {
            score -= 80;
          }
        } else if (modelPickerTextHasWord(normalizedText, 'pro')) {
          score -= 40;
        }
        if (wantsThinking) {
          if (!modelPickerTextHasWord(normalizedText, 'thinking') && !normalizedTestId.includes('thinking')) {
            score -= 80;
          }
        } else if (modelPickerTextHasWord(normalizedText, 'thinking') || normalizedTestId.includes('thinking')) {
          score -= 40;
        }
        if (wantsInstant) {
          if (!modelPickerTextHasWord(normalizedText, 'instant') && !normalizedTestId.includes('instant')) {
            score -= 80;
          }
        } else if (modelPickerTextHasWord(normalizedText, 'instant') || normalizedTestId.includes('instant')) {
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

      const findSelectedTargetOption = () => {
        const menus = Array.from(document.querySelectorAll(${menuContainerLiteral}));
        for (const menu of menus) {
          const buttons = Array.from(menu.querySelectorAll(${menuItemLiteral}));
          for (const option of buttons) {
            const normalizedText = normalizeText(option.textContent ?? '');
            const testid = option.getAttribute('data-testid') ?? '';
            const score = scoreOption(normalizedText, testid);
            if (score <= 0) {
              continue;
            }
            if (optionIsSelected(option)) {
              return {
                node: option,
                label: getOptionLabel(option),
              };
            }
          }
        }
        return null;
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
          const selectedTarget = findSelectedTargetOption();
          if (selectedTarget) {
            resolve({ status: 'already-selected', label: getButtonLabel() || selectedTarget.label || PRIMARY_LABEL });
            return;
          }
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
          const menus = document.querySelectorAll(
            MENU_CONTAINER_SELECTOR +
              ', [role="group"], [role="listbox"], [data-radix-popper-content-wrapper], [data-state="open"]'
          );
          for (const menu of menus) {
            const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
            if (normalize(label?.textContent ?? '').includes('thinking time')) {
              return menu;
            }
            const text = normalize(menu.textContent ?? '');
            if (text.includes('standard') && text.includes('extended')) {
              return menu;
            }
            if (text.includes(TARGET_LEVEL)) {
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
    if (isCurrentSelectionTarget(modelTargetRaw)) {
      const result = await evaluate(buildModelSelectionExpression(modelTargetRaw, 'current'));
      return {
        ok: true,
        label: result?.label || 'current',
        skipped: true,
      };
    }
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
    if (isCurrentSelectionTarget(thinkingTarget)) {
      return {
        ok: true,
        label: 'current',
        skipped: true,
      };
    }
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

  const readAutoSendState = async () => {
    return evaluate(`(() => {
      const textareaSelectors = [
        '#prompt-textarea',
        'textarea[name="prompt-textarea"]',
        'textarea[data-id="prompt-textarea"]',
        'textarea[placeholder*="Send a message"]',
        'textarea[aria-label="Message ChatGPT"]',
        'textarea:not([disabled])',
        '.ProseMirror',
        '[contenteditable="true"][data-virtualkeyboard="true"]',
      ];
      const turnSelector =
        'article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"], ' +
        'article[data-message-author-role], div[data-message-author-role], section[data-message-author-role], ' +
        'article[data-turn], div[data-turn], section[data-turn]';
      const uploadSelectors = [
        '[data-testid*="upload"]',
        '[data-testid*="attachment"]',
        '[data-testid*="progress"]',
        '[data-state="loading"]',
        '[data-state="uploading"]',
        '[data-state="pending"]',
        '[aria-live="polite"]',
        '[aria-live="assertive"]',
      ];
      const normalize = (value) => (value || '').toLowerCase();
      const signatureize = (value) =>
        normalize(value)
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
      const visible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value || '';
        return node.innerText || node.textContent || '';
      };
      const nodes = textareaSelectors
        .map((selector) => document.querySelector(selector))
        .filter(Boolean);
      const visibleNodes = nodes.filter((node) => visible(node));
      const activeNodes = visibleNodes.length > 0 ? visibleNodes : nodes;
      const composerHasText = activeNodes.some((node) => String(readValue(node)).trim().length > 0);
      const composerSignature = signatureize(activeNodes.map((node) => readValue(node)).join('\\n')).slice(0, 320);
      const uploading = uploadSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((node) => {
          const ariaBusy = normalize(node.getAttribute?.('aria-busy'));
          const dataState = normalize(node.getAttribute?.('data-state'));
          if (ariaBusy === 'true') return true;
          if (dataState === 'loading' || dataState === 'uploading' || dataState === 'pending') return true;
          const text = normalize(node.textContent);
          return text.includes('uploading') || text.includes('processing');
        })
      );
      const userTurnSelector =
        'article[data-message-author-role="user"], div[data-message-author-role="user"], section[data-message-author-role="user"], ' +
        'article[data-turn="user"], div[data-turn="user"], section[data-turn="user"], ' +
        'article[data-testid*="conversation-turn-user"], div[data-testid*="conversation-turn-user"], section[data-testid*="conversation-turn-user"]';
      const userTurnNodes = Array.from(document.querySelectorAll(userTurnSelector));
      const userTurnSignatures = [];
      const seenUserTurnSignatures = new Set();
      for (const node of userTurnNodes) {
        const signature = signatureize(node?.innerText || node?.textContent || '').slice(0, 320);
        if (!signature || seenUserTurnSignatures.has(signature)) continue;
        seenUserTurnSignatures.add(signature);
        userTurnSignatures.push(signature);
      }
      const recentUserTurnSignatures = userTurnSignatures.slice(-12);
      const lastUserTurnSignature = recentUserTurnSignatures[recentUserTurnSignatures.length - 1] || '';
      const turnsCount = document.querySelectorAll(turnSelector).length;
      const stopVisible = Boolean(document.querySelector('[data-testid="stop-button"]'));
      const assistantVisible = Boolean(
        document.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]')
      );
      const readyState = document.readyState || '';
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\\/c\\//.test(href);
      const desiredOrigin = ${desiredTargetOriginLiteral};
      const desiredChatId = ${desiredTargetChatIdLiteral};
      let targetMatch = false;
      if (!desiredOrigin && !desiredChatId) {
        targetMatch = true;
      } else {
        try {
          const parsedHref = new URL(href);
          const originMatch = !desiredOrigin || parsedHref.origin === desiredOrigin;
          const currentChatId = (parsedHref.pathname.match(/\\/c\\/([^/?#]+)/i)?.[1] || '').toLowerCase();
          const chatMatch = !desiredChatId || currentChatId === desiredChatId;
          targetMatch = originMatch && chatMatch;
        } catch {}
      }
      return {
        composerHasText,
        composerSignature,
        uploading,
        recentUserTurnSignatures,
        lastUserTurnSignature,
        turnsCount,
        stopVisible,
        assistantVisible,
        readyState,
        inConversation,
        targetMatch,
        href,
      };
    })()`);
  };

  const readAutoSendBaseline = async () => {
    const state = await readAutoSendState();
    const turns = Number(state?.turnsCount);
    const turnCount = Number.isFinite(turns) ? Math.max(0, Math.floor(turns)) : -1;
    const userTurnSignatures = Array.isArray(state?.recentUserTurnSignatures)
      ? state.recentUserTurnSignatures.filter((value) => typeof value === 'string' && value.length > 0)
      : [];
    return {
      turnCount,
      userTurnSignatures,
    };
  };

  const probeAuthenticatedSession = async () => {
    return evaluate(`(async () => {
      try {
        const response = await fetch('/backend-api/me', { credentials: 'include' });
        return {
          ok: response.ok,
          status: response.status,
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          message: String((error && error.message) || error || 'unknown'),
        };
      }
    })()`);
  };

  const readResponseCaptureState = async () => {
    return evaluate(`(() => {
      const assistantTurnSelector =
        'article[data-message-author-role="assistant"], div[data-message-author-role="assistant"], section[data-message-author-role="assistant"], ' +
        'article[data-turn="assistant"], div[data-turn="assistant"], section[data-turn="assistant"], ' +
        'article[data-testid*="conversation-turn-assistant"], div[data-testid*="conversation-turn-assistant"], section[data-testid*="conversation-turn-assistant"]';
      const copySelectors = [
        'button[aria-label*="Copy"]',
        'button[aria-label*="copy"]',
        'button[data-testid*="copy"]',
        'button[title*="Copy"]',
        'button[title*="copy"]',
      ];
      const stopSelectors = [
        '[data-testid="stop-button"]',
        'button[aria-label*="Stop"]',
        'button[aria-label*="stop"]',
      ];
      const statusSelectors = [
        '[role="status"]',
        '[aria-live="polite"]',
        '[aria-live="assertive"]',
        '[data-testid*="status"]',
        '[data-testid*="progress"]',
        '[data-testid*="research"]',
      ];
      const visible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const normalize = (value) => (value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const signatureize = (value) => normalize(value).slice(0, 320);
      const assistantSnapshots = [];
      const assistantNodes = Array.from(document.querySelectorAll(assistantTurnSelector));
      for (const node of assistantNodes) {
        const text = String(node?.innerText || node?.textContent || '').trim();
        const signature = signatureize(text);
        if (!text || !signature) continue;
        let hasCopyButton = false;
        for (const selector of copySelectors) {
          const copyNode = node.querySelector(selector) || node.parentElement?.querySelector?.(selector) || null;
          if (copyNode) {
            hasCopyButton = true;
            break;
          }
        }
        assistantSnapshots.push({
          signature,
          text: text.slice(0, 20000),
          hasCopyButton,
        });
      }
      const statusTexts = [];
      const seenStatusTexts = new Set();
      for (const selector of statusSelectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          if (!visible(node)) continue;
          const rawText = String(node.innerText || node.textContent || '').trim();
          const normalized = normalize(rawText);
          if (!normalized || seenStatusTexts.has(normalized)) continue;
          seenStatusTexts.add(normalized);
          statusTexts.push(rawText.slice(0, 500));
        }
      }
      const normalizedStatusText = normalize(statusTexts.join(' '));
      const statusBusy = /(research|thinking|searching|gathering|analyzing|browsing|writing|reading|processing|loading)/.test(normalizedStatusText);
      const stopVisible = stopSelectors.some((selector) => Array.from(document.querySelectorAll(selector)).some((node) => visible(node)));
      const readyState = document.readyState || '';
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\/c\//.test(href);
      const desiredOrigin = ${desiredTargetOriginLiteral};
      const desiredChatId = ${desiredTargetChatIdLiteral};
      let targetMatch = false;
      if (!desiredOrigin && !desiredChatId) {
        targetMatch = true;
      } else {
        try {
          const parsedHref = new URL(href);
          const originMatch = !desiredOrigin || parsedHref.origin === desiredOrigin;
          const currentChatId = (parsedHref.pathname.match(/\/c\/([^/?#]+)/i)?.[1] || '').toLowerCase();
          const chatMatch = !desiredChatId || currentChatId === desiredChatId;
          targetMatch = originMatch && chatMatch;
        } catch {}
      }
      return {
        assistantSnapshots: assistantSnapshots.slice(-12),
        statusTexts: statusTexts.slice(0, 8),
        statusBusy,
        stopVisible,
        readyState,
        href,
        inConversation,
        targetMatch,
      };
    })()`);
  };

  const readResponseCaptureBaseline = async () => {
    const state = await readResponseCaptureState();
    return {
      assistantTurnSignatures: Array.isArray(state?.assistantSnapshots)
        ? state.assistantSnapshots
            .map((snapshot) => snapshot?.signature)
            .filter((value) => typeof value === 'string' && value.length > 0)
        : [],
    };
  };

  const waitForAssistantResponse = async (baselineSnapshot) => {
    const baselineAssistantSignatures = Array.isArray(baselineSnapshot?.assistantTurnSignatures)
      ? baselineSnapshot.assistantTurnSignatures
      : [];
    const deadline = Date.now() + Math.max(15_000, responseTimeoutMs);
    const minimumCompletionAgeMs = isDeepResearchMode ? 75_000 : 0;
    const stablePollsRequired = isDeepResearchMode ? 4 : 2;
    const startTime = Date.now();
    let lastState = null;
    let bestSnapshot = null;
    let stableSignature = '';
    let stableText = '';
    let stableCount = 0;

    while (Date.now() < deadline) {
      const state = await readResponseCaptureState();
      lastState = state;
      const candidate = selectAssistantResponseCandidate(state, baselineAssistantSignatures, promptMatchCandidates).snapshot;
      if (candidate?.text) {
        bestSnapshot = candidate;
      }

      if (candidate?.signature === stableSignature && candidate?.text === stableText) {
        stableCount += 1;
      } else {
        stableSignature = candidate?.signature || '';
        stableText = candidate?.text || '';
        stableCount = candidate?.text ? 1 : 0;
      }

      const generationActive = Boolean(state?.stopVisible || state?.statusBusy);
      const elapsedMs = Date.now() - startTime;
      const stabilitySatisfied = stableCount >= stablePollsRequired || (candidate?.hasCopyButton && stableCount >= 1);
      if (candidate?.text && !generationActive && stabilitySatisfied && elapsedMs >= minimumCompletionAgeMs) {
        return {
          status: 'completed',
          responseText: candidate.text,
          href: state?.href || '',
        };
      }

      await sleep(generationActive ? 1000 : 500);
    }

    if (bestSnapshot?.text) {
      return {
        status: 'timeout-partial',
        responseText: bestSnapshot.text,
        href: lastState?.href || '',
        partial: true,
      };
    }

    return {
      status: 'timeout-no-response',
      href: lastState?.href || '',
      state: lastState,
    };
  };

  const waitForAutoSendContextReady = async (requireComposerText = false) => {
    const deadline = Date.now() + Math.max(8_000, Math.min(30_000, timeoutMs));
    let lastState = null;
    let stableHref = '';
    let stableHrefCount = 0;
    while (Date.now() < deadline) {
      const state = await readAutoSendState();
      lastState = state;
      const href = String(state?.href || '');
      if (href && href === stableHref) {
        stableHrefCount += 1;
      } else {
        stableHref = href;
        stableHrefCount = 0;
      }
      const readyState = String(state?.readyState || '').toLowerCase();
      const targetMatch = Boolean(state?.targetMatch);
      const readyStateComplete = readyState === 'complete';
      const composerReady = !requireComposerText || Boolean(state?.composerHasText);
      if (readyStateComplete && targetMatch && composerReady && stableHrefCount >= 2) {
        return {
          status: 'ready',
          state,
        };
      }
      await sleep(200);
    }
    return {
      status: 'context-timeout',
      state: lastState,
    };
  };

  const focusComposerInputForSend = async () => {
    return evaluate(`(() => {
      try {
        ${buildClickDispatcher('dispatchClickSequenceForSend')}
        const textareaSelectors = [
          '#prompt-textarea',
          'textarea[name="prompt-textarea"]',
          'textarea[data-id="prompt-textarea"]',
          'textarea[placeholder*="Send a message"]',
          'textarea[aria-label="Message ChatGPT"]',
          'textarea:not([disabled])',
          '.ProseMirror',
          '[contenteditable="true"][data-virtualkeyboard="true"]',
          '[contenteditable="true"][role="textbox"]',
        ];
        const visible = (node) => {
          if (!node || typeof node.getBoundingClientRect !== 'function') return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const nodes = textareaSelectors.map((selector) => document.querySelector(selector)).filter(Boolean);
        const target = nodes.find((node) => visible(node)) || nodes[0] || null;
        if (!target) {
          return { ok: false, reason: 'composer-not-found' };
        }
        dispatchClickSequenceForSend(target);
        if (typeof target.focus === 'function') {
          target.focus();
        }
        const ownerDoc = target.ownerDocument || document;
        const selection = ownerDoc.getSelection?.();
        if (selection && typeof ownerDoc.createRange === 'function') {
          const range = ownerDoc.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: 'focus-exception',
          message: String((error && error.message) || error || 'unknown'),
        };
      }
    })()`);
  };

  const attemptClickSendButton = async () => {
    return evaluate(`(() => {
      try {
        ${buildClickDispatcher('dispatchClickSequenceForSend')}
        const sendSelectors = [
          'button[data-testid="send-button"]',
          'button[data-testid*="composer-send"]',
          'form button[type="submit"]',
          'button[type="submit"][data-testid*="send"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="send"]',
        ];
        const textareaSelectors = [
          '#prompt-textarea',
          'textarea[name="prompt-textarea"]',
          'textarea[data-id="prompt-textarea"]',
          'textarea[placeholder*="Send a message"]',
          'textarea[aria-label="Message ChatGPT"]',
          'textarea:not([disabled])',
          '.ProseMirror',
          '[contenteditable="true"][data-virtualkeyboard="true"]',
        ];
        const visible = (node) => {
          if (!node || typeof node.getBoundingClientRect !== 'function') return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const normalize = (value) => (value || '').toLowerCase();
        const pickFirst = (nodes) => nodes.find((node) => visible(node)) || nodes[0] || null;
        const textareas = textareaSelectors.map((selector) => document.querySelector(selector)).filter(Boolean);
        const textarea = pickFirst(textareas);
        const composerRoot =
          (textarea && textarea.closest('[data-testid*="composer"], form')) ||
          document.querySelector('[data-testid*="composer"]') ||
          document.querySelector('form');
        const candidates = [];
        if (composerRoot) {
          for (const selector of sendSelectors) {
            candidates.push(...composerRoot.querySelectorAll(selector));
          }
        }
        for (const selector of sendSelectors) {
          candidates.push(...document.querySelectorAll(selector));
        }
        const deduped = [];
        const seen = new Set();
        for (const node of candidates) {
          if (!node || seen.has(node)) continue;
          seen.add(node);
          deduped.push(node);
        }
        const scoreButton = (button) => {
          if (!visible(button)) return 0;
          const testid = normalize(button.getAttribute('data-testid'));
          const aria = normalize(button.getAttribute('aria-label'));
          const text = normalize(button.textContent);
          const type = normalize(button.getAttribute('type'));
          let score = 0;
          if (testid === 'send-button') score += 220;
          if (testid.includes('composer-send')) score += 200;
          if (testid.includes('send')) score += 120;
          if (aria.includes('send')) score += 90;
          if (text.includes('send')) score += 60;
          if (type === 'submit') score += 50;
          if (composerRoot && composerRoot.contains(button)) score += 25;
          return score;
        };
        let bestButton = null;
        let bestScore = 0;
        for (const button of deduped) {
          const score = scoreButton(button);
          if (score > bestScore) {
            bestScore = score;
            bestButton = button;
          }
        }
        if (!bestButton || bestScore <= 0) {
          return { status: 'send-button-not-found' };
        }
        const style = window.getComputedStyle(bestButton);
        const ariaDisabled = normalize(bestButton.getAttribute('aria-disabled'));
        const dataDisabled = normalize(bestButton.getAttribute('data-disabled'));
        const disabled =
          Boolean(bestButton.disabled) ||
          bestButton.hasAttribute('disabled') ||
          ariaDisabled === 'true' ||
          dataDisabled === 'true' ||
          style.pointerEvents === 'none' ||
          style.display === 'none';
        if (disabled) {
          return { status: 'send-button-disabled' };
        }
        const clicked = dispatchClickSequenceForSend(bestButton);
        if (!clicked && typeof bestButton.click === 'function') {
          bestButton.click();
        }
        return {
          status: 'clicked',
          label: String(bestButton.getAttribute('aria-label') || bestButton.textContent || '')
            .trim()
            .slice(0, 120),
          href: location.href,
        };
      } catch (error) {
        return {
          status: 'send-exception',
          message: String((error && error.message) || error || 'unknown'),
        };
      }
    })()`);
  };

  const attemptEnterSend = async () => {
    const focusResult = await focusComposerInputForSend();
    if (!focusResult?.ok) {
      return {
        status: 'enter-focus-failed',
        details: focusResult,
      };
    }
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...ENTER_KEY_EVENT,
    });
    return { status: 'enter-dispatched' };
  };

  const verifyAutoSendCommitted = async (baselineSnapshot, maxWaitMs) => {
    const baselineTurns = Number.isFinite(Number(baselineSnapshot?.turnCount))
      ? Math.max(0, Math.floor(Number(baselineSnapshot?.turnCount)))
      : -1;
    const baselineUserTurnSignatures = new Set(
      Array.isArray(baselineSnapshot?.userTurnSignatures) ? baselineSnapshot.userTurnSignatures : []
    );
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const state = await readAutoSendState();
      const turns = Number(state?.turnsCount);
      const hasNewTurn = Number.isFinite(turns) && baselineTurns >= 0 ? turns > baselineTurns : false;
      const userTurnSignatures = Array.isArray(state?.recentUserTurnSignatures)
        ? state.recentUserTurnSignatures.filter((value) => typeof value === 'string' && value.length > 0)
        : [];
      const newUserTurnSignature = userTurnSignatures.find((signature) => !baselineUserTurnSignatures.has(signature)) || '';
      const hasPromptMatchCandidates = promptMatchCandidates.length > 0;
      const newPromptTurnCommitted = hasPromptMatchCandidates
        ? promptSignatureMatches(newUserTurnSignature, promptMatchCandidates)
        : Boolean(newUserTurnSignature);
      const composerCleared = !state?.composerHasText;
      const activityVisible = Boolean(state?.stopVisible || state?.assistantVisible);
      const fallbackCommit =
        composerCleared &&
        (activityVisible || (state?.inConversation ?? false));
      const hasStrongCommitSignal =
        newPromptTurnCommitted &&
        (hasNewTurn || composerCleared || activityVisible);
      if (hasStrongCommitSignal || (!hasPromptMatchCandidates && baselineTurns < 0 && fallbackCommit)) {
        return {
          status: 'committed',
          newUserTurnSignature,
          state,
        };
      }
      await sleep(150);
    }
    return {
      status: 'commit-timeout',
      state: await readAutoSendState(),
    };
  };

  const autoSendDraftMessage = async () => {
    const preflight = await waitForAutoSendContextReady(draftPrompt.length > 0);
    if (preflight?.status !== 'ready') {
      return {
        status: 'send-context-not-ready',
        lastAttempt: preflight,
      };
    }

    const baselineSnapshot = await readAutoSendBaseline();
    const responseBaseline = await readResponseCaptureBaseline();
    const sendDeadline = Date.now() + Math.max(8_000, Math.min(30_000, timeoutMs));
    let lastAttempt = { status: 'send-not-attempted' };
    while (Date.now() < sendDeadline) {
      const stateBeforeSend = await readAutoSendState();
      if (stateBeforeSend?.uploading) {
        lastAttempt = { status: 'send-wait-uploading', state: stateBeforeSend };
        await sleep(200);
        continue;
      }
      if (promptMatchCandidates.length > 0 && !promptSignatureMatches(stateBeforeSend?.composerSignature, promptMatchCandidates)) {
        const refillResult = await setDraftComposerPrompt(draftPrompt);
        lastAttempt = {
          status: 'composer-refilled-before-send',
          stateBeforeSend,
          refillResult,
        };
        await sleep(150);
        continue;
      }

      const clickAttempt = await attemptClickSendButton();
      lastAttempt = clickAttempt || { status: 'send-attempt-unknown' };
      if (clickAttempt?.status === 'clicked') {
        const commitResult = await verifyAutoSendCommitted(baselineSnapshot, Math.min(15_000, timeoutMs));
        if (commitResult?.status === 'committed') {
          return {
            status: 'sent',
            method: 'button',
            label: clickAttempt.label,
            state: commitResult.state,
            committedUserTurnSignature: commitResult.newUserTurnSignature || null,
            responseBaseline,
          };
        }
        return {
          status: 'send-unconfirmed',
          lastAttempt: {
            clickAttempt,
            commitResult,
          },
        };
      }

      if (clickAttempt?.status === 'send-button-not-found') {
        if (shouldAttachFiles) {
          lastAttempt = {
            ...clickAttempt,
            attachmentsPresent: true,
          };
          await sleep(200);
          continue;
        }
        const stateBeforeEnter = await readAutoSendState();
        if (stateBeforeEnter?.composerHasText) {
          const enterAttempt = await attemptEnterSend();
          if (enterAttempt?.status === 'enter-dispatched') {
            const commitResult = await verifyAutoSendCommitted(baselineSnapshot, Math.min(15_000, timeoutMs));
            if (commitResult?.status === 'committed') {
              return {
                status: 'sent',
                method: 'enter',
                state: commitResult.state,
                committedUserTurnSignature: commitResult.newUserTurnSignature || null,
                responseBaseline,
              };
            }
            return {
              status: 'send-unconfirmed',
              lastAttempt: {
                clickAttempt,
                enterAttempt,
                commitResult,
              },
            };
          }
          lastAttempt = {
            ...clickAttempt,
            enterAttempt,
          };
        }
      }

      await sleep(200);
    }
    return {
      status: 'send-timeout',
      lastAttempt,
    };
  };

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('DOM.enable');
  await cdp('Page.bringToFront');

  currentStage = 'auth-probe';
  const authStatus = await probeAuthenticatedSession();
  if (authStatus && (authStatus.status === 401 || authStatus.status === 403)) {
    throw new Error('ChatGPT session is not authenticated in the managed browser profile. Sign in and retry.');
  }

  currentStage = 'initial-ready';
  const initialReady = await waitForDraftComposerReady(false);
  if (initialReady?.status !== 'ready') {
    throw new Error(
      `Composer was not ready for draft staging (composer=${Boolean(initialReady?.state?.composerReady)}, fileInput=${Boolean(initialReady?.state?.fileInputReady)}, targetMatch=${Boolean(initialReady?.state?.targetMatch)}).`
    );
  }

  let modelSelection;
  currentStage = 'model-selection';
  try {
    modelSelection = await ensureDraftModelSelected();
  } catch (error) {
    if (isRetryableSocketError(error)) throw error;
    modelSelection = {
      ok: false,
      reason: 'selection-error',
      details: { message: errorMessage(error) },
    };
  }
  if (modelSelection?.ok) {
    if (modelSelection.skipped) {
      console.log(`Draft model kept: ${modelSelection.label}`);
    } else {
      console.log(`Draft model selected: ${modelSelection.label}`);
    }
  } else {
    console.warn(`Draft model selection warning (${modelTargetRaw}): ${JSON.stringify(modelSelection?.details || modelSelection)}`);
  }
  if (shouldSend && !modelSelection?.ok && !isCurrentSelectionTarget(modelTargetRaw)) {
    throw new Error(`Draft model selection failed before auto-send (${modelTargetRaw}): ${JSON.stringify(modelSelection?.details || modelSelection)}`);
  }

  let thinkingSelection;
  currentStage = 'thinking-selection';
  try {
    thinkingSelection = await ensureDraftThinkingSelected();
  } catch (error) {
    if (isRetryableSocketError(error)) throw error;
    thinkingSelection = {
      ok: false,
      reason: 'selection-error',
      details: { message: errorMessage(error) },
    };
  }
  if (thinkingSelection?.ok) {
    if (thinkingSelection.skipped) {
      console.log(`Draft thinking kept: ${thinkingSelection.label}`);
    } else {
      console.log(`Draft thinking selected: ${thinkingSelection.label}`);
    }
  } else {
    console.warn(`Draft thinking selection warning (${thinkingTarget}): ${JSON.stringify(thinkingSelection?.details || thinkingSelection)}`);
  }
  if (shouldSend && !thinkingSelection?.ok && !isCurrentSelectionTarget(thinkingTarget)) {
    throw new Error(`Draft thinking selection failed before auto-send (${thinkingTarget}): ${JSON.stringify(thinkingSelection?.details || thinkingSelection)}`);
  }

  if (draftPrompt.length > 0) {
    currentStage = 'prompt-prefill';
    const promptSetResult = await setDraftComposerPrompt(draftPrompt);
    if (promptSetResult?.ok) {
      console.log(`Draft prompt prefilled in composer (${promptSetResult.length} chars, mode=${promptSetResult.mode}).`);
    } else {
      console.warn(`Draft prompt prefill warning: ${JSON.stringify(promptSetResult || { ok: false })}`);
    }
  }

  if (shouldAttachFiles) {
    currentStage = 'attachments';
    const expectedNames = buildExpectedAttachmentNames(filesToAttach);
    const expectedCount = filesToAttach.length;
    const maxAttachAttempts = 2;
    let verification = null;

    for (let attempt = 1; attempt <= maxAttachAttempts; attempt += 1) {
      const composerReady = await waitForDraftComposerReady(true);
      if (composerReady?.status !== 'ready') {
        throw new Error(
          `Composer attachment input was not ready (composer=${Boolean(composerReady?.state?.composerReady)}, fileInput=${Boolean(composerReady?.state?.fileInputReady)}, targetMatch=${Boolean(composerReady?.state?.targetMatch)}).`
        );
      }

      const baselineState = composerReady.state || null;
      const uploadObjectId = await resolveDraftFileInputObjectId();
      if (!uploadObjectId) {
        throw new Error('Could not resolve composer file input object for draft upload');
      }

      await cdp('DOM.setFileInputFiles', {
        objectId: uploadObjectId,
        files: filesToAttach,
      });

      verification = await verifyDraftAttachments(baselineState, expectedNames, expectedCount);
      if (verification?.ok) {
        break;
      }

      if (attempt < maxAttachAttempts) {
        console.warn(
          `Draft attachment verification retry ${attempt + 1}/${maxAttachAttempts}: ${formatAttachmentVerificationSummary(verification?.summary)}`
        );
        await sleep(350);
      }
    }

    if (!verification?.ok) {
      throw new Error(`Composer attachments not confirmed (${formatAttachmentVerificationSummary(verification?.summary)})`);
    }

    console.log(
      `Draft prepared in ChatGPT tab: attachments confirmed (${formatAttachmentVerificationSummary(verification.summary)}).`
    );
  } else {
    console.log('Draft prepared in ChatGPT tab: prompt staged (no attachments requested).');
  }

  if (shouldSend) {
    currentStage = 'send';
    const sendResult = await autoSendDraftMessage();
    if (sendResult?.status === 'sent') {
      console.log(`Draft auto-send triggered${sendResult.label ? ` (${sendResult.label})` : ''}.`);
      if (sendResult?.state?.href) {
        console.log(`ChatGPT conversation URL: ${sendResult.state.href}`);
      }
      if (shouldWaitForResponse) {
        currentStage = 'wait-response';
        const responseResult = await waitForAssistantResponse(sendResult.responseBaseline);
        if (responseResult?.status === 'completed' || responseResult?.status === 'timeout-partial') {
          emitCapturedResponse(responseResult.responseText, responseResult.href, Boolean(responseResult.partial));
          if (responseFile) {
            writeCapturedResponseFile(responseFile, responseResult.responseText);
            console.log(`Assistant response written to ${responseFile}`);
          }
        } else {
          throw new Error(`Assistant response capture failed: ${JSON.stringify(responseResult || { status: 'unknown' })}`);
        }
      }
    } else {
      throw new Error(`Auto-send failed: ${JSON.stringify(sendResult?.lastAttempt || sendResult || { status: 'unknown' })}`);
    }
    }
  } catch (error) {
    throw tagStageError(error);
  }
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

async function mainWithRetry() {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        console.warn(`Draft staging retry ${attempt}/${maxAttempts} after socket disconnect.`);
      }
      await main();
      return;
    } catch (error) {
      lastError = error;
      if (
        !isRetryableSocketError(error) ||
        attempt === maxAttempts ||
        !SAFE_RETRY_STAGES.has(String(error?.reviewGptStage || ''))
      ) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }

  throw lastError || new Error('Draft staging failed');
}

function validateRuntimeConfig() {
  if (!remotePort) {
    throw new Error('Missing ORACLE_DRAFT_REMOTE_PORT');
  }
  if (!chatgptUrl) {
    throw new Error('Missing ORACLE_DRAFT_URL');
  }
  if (shouldAttachFiles) {
    for (const filePath of filesToAttach) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Draft attachment missing: ${filePath}`);
      }
    }
  }
}

if (require.main === module) {
  validateRuntimeConfig();
  mainWithRetry().catch((error) => {
    console.error(`Draft staging failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  buildExpectedAttachmentNames,
  formatAttachmentVerificationSummary,
  modelPickerLabelMatchesTarget,
  modelPickerSelectionStateMatches,
  modelPickerTextHasWord,
  normalizeAttachmentName,
  normalizeComparableText,
  normalizeModelPickerText,
  normalizeResponseText,
  buildPromptMatchCandidates,
  isLikelyPromptEcho,
  selectAssistantResponseCandidate,
  promptSignatureMatches,
  summarizeAttachmentVerification,
};
