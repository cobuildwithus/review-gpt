const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { appendFileSync } = require('fs');
const { URL } = require('url');
const {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_STOP_SELECTORS,
  CHATGPT_USER_TURN_ATTACHMENT_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  buildChatGptCaptureStateExpression,
  buildDeepResearchResponseInspectionSource,
  canonicalizeChatGptTurnNodes,
  collectChatGptTurnAttachmentTexts,
  chatGptTextIndicatesRateLimit,
  normalizeResponseText,
  sanitizeDeepResearchResponseText,
  threadStatusTextIndicatesBusy,
} = require('./chatgpt-dom-snapshot-shared.js');
const { registerIdleDraftCleanup } = require('./idle-draft-cleaner.js');

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
  isDeepResearchMode ? 'current' : 'gpt-5.6-sol'
);
const thinkingTarget = normalizeSelectionTarget(process.env.ORACLE_DRAFT_THINKING, 'current').toLowerCase();
const appConnectorTarget = normalizeSelectionTarget(process.env.ORACLE_DRAFT_APP_CONNECTOR, 'current');
const timeoutMs = Number(process.env.ORACLE_DRAFT_TIMEOUT_MS || 90000);
const shouldWaitForResponse = /^(1|true|yes|on)$/i.test(String(process.env.ORACLE_DRAFT_WAIT_RESPONSE || '0'));
const responseTimeoutMs = Number(
  process.env.ORACLE_DRAFT_RESPONSE_TIMEOUT_MS || timeoutMs || (isDeepResearchMode ? 2_400_000 : 600_000)
);
const responseFile = String(process.env.ORACLE_DRAFT_RESPONSE_FILE || '').trim();
const captureMetadataFile = String(process.env.REVIEW_GPT_DRAFT_CAPTURE_METADATA_FILE || '').trim();
const responseMarker = String(process.env.ORACLE_DRAFT_RESPONSE_MARKER || '').trim();
const minimumMarkedResponseMs = Number(process.env.ORACLE_DRAFT_MINIMUM_MARKED_RESPONSE_MS || 5 * 60 * 1000);
const shouldSend = /^(1|true|yes|on)$/i.test(String(process.env.ORACLE_DRAFT_SEND || '0'));
const idleDraftTimeoutMs = Number(process.env.REVIEW_GPT_IDLE_DRAFT_TIMEOUT_MS || 0);
const baseDraftPrompt = process.env.ORACLE_DRAFT_PROMPT || '';
const modelAttestationTurnNonce = modelConfirmationRequired({
  isDeepResearchMode,
  shouldSend,
  shouldWaitForResponse,
  targetModel: modelTargetRaw,
})
  ? randomUUID()
  : '';
const draftPrompt = appendModelConfirmationPrompt(baseDraftPrompt, {
  isDeepResearchMode,
  responseMarker,
  shouldSend,
  shouldWaitForResponse,
  targetModel: modelTargetRaw,
  turnNonce: modelAttestationTurnNonce,
});
const filesToAttach = (process.env.ORACLE_DRAFT_FILES || '')
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);
const cleanupFilePaths = (process.env.REVIEW_GPT_DRAFT_CLEANUP_FILES || '')
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
const MODEL_BUTTON_SELECTORS = [
  '[data-testid="model-switcher-dropdown-button"]',
  '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
  'button.__composer-pill[aria-haspopup="menu"]',
  '.__composer-pill-composite button[aria-haspopup="menu"]',
];
const MENU_CONTAINER_SELECTOR = '[role="menu"], [data-radix-collection-root]';
const MENU_ITEM_SELECTOR = 'button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]';
const ENTER_KEY_EVENT = {
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
};
const ENTER_KEY_TEXT = '\r';
const DEEP_RESEARCH_START_HOTSPOT = {
  xRatio: 0.883,
  yRatio: 0.746,
};
const DEEP_RESEARCH_AUTO_START_GRACE_MS = 60_000;
const DEEP_RESEARCH_AUTO_START_POLL_MS = 1000;
const DEEP_RESEARCH_START_RETRY_DELAY_MS = 2000;
const DEEP_RESEARCH_START_ATTEMPTS = 3;
const MODEL_CONFIRMATION_UNKNOWN_FALLBACK_MS = 5 * 60 * 1000;
const HARD_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const SAFE_RETRY_STAGES = new Set([
  'connect',
  'initial-ready',
  'auth-probe',
  'model-selection',
  'thinking-selection',
  'app-connector-selection',
  'prompt-prefill',
  'attachments',
]);
const {
  buildAttachmentNameMatcher,
  buildExpectedAttachmentNames,
  emitCapturedResponse,
  formatAttachmentVerificationSummary,
  normalizeAttachmentName,
  normalizeAttachmentSearchText,
  removeConfirmedAttachmentFiles,
  summarizeAttachmentVerification,
  writeCapturedResponseFile,
} = require('./prepare-chatgpt-draft-helpers.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const configuredDraftTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90000;
const browserTransportTimeoutMs = Math.min(configuredDraftTimeoutMs, 15000);
const pageCommandTimeoutMs = Math.min(configuredDraftTimeoutMs, 30000);
const targetCleanupTimeoutMs = Math.min(browserTransportTimeoutMs, 5000);
const targetCleanupAttemptTimeoutMs = Math.min(targetCleanupTimeoutMs, 1000);
const targetOwnershipReconciliationTimeoutMs = Math.min(configuredDraftTimeoutMs, 6000);
const targetOwnershipUrlPrefix = 'about:blank#review-gpt-owned-';
const socketCloseTimeoutMs = Math.min(browserTransportTimeoutMs, 1000);
let ownedTargetSignalCleanup = null;

async function withTimeout(promise, durationMs, message, onTimeout) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new Error(message));
      }
    }, Math.max(1, durationMs));
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createWebSocketOwner() {
  const sockets = new Set();
  const create = (url) => {
    const socket = new WebSocket(url);
    sockets.add(socket);
    socket.addEventListener('close', () => sockets.delete(socket), { once: true });
    return socket;
  };
  const close = (socket) => {
    if (!socket || !sockets.has(socket)) return;
    try {
      socket.close();
    } catch {
      sockets.delete(socket);
    }
  };
  const closeAll = async () => {
    const closing = [...sockets];
    for (const socket of closing) close(socket);
    if (closing.length === 0) return;
    await Promise.race([
      Promise.all(closing.map((socket) => new Promise((resolve) => {
        if (!sockets.has(socket)) {
          resolve();
          return;
        }
        socket.addEventListener('close', resolve, { once: true });
      }))),
      sleep(socketCloseTimeoutMs),
    ]);
  };
  return { close, closeAll, create };
}

async function flushProcessOutput() {
  const pending = [process.stdout, process.stderr]
    .filter((stream) => stream?.writableNeedDrain)
    .map((stream) => new Promise((resolve) => stream.once('drain', resolve)));
  if (pending.length > 0) {
    await Promise.race([Promise.all(pending), sleep(1000)]);
  }
}

let confirmedAttachmentCleanupFinished = false;
function cleanupConfirmedDraftAttachments(reason) {
  if (confirmedAttachmentCleanupFinished || cleanupFilePaths.length === 0) return;
  confirmedAttachmentCleanupFinished = true;
  const result = removeConfirmedAttachmentFiles(cleanupFilePaths);
  if (result.removedCount > 0) {
    console.log(
      `Removed ${result.removedCount} generated local attachment artifact(s) after ChatGPT confirmed ${reason}.`
    );
  }
}

async function fetchJson(path, requestTimeoutMs = browserTransportTimeoutMs) {
  const controller = new AbortController();
  const requestDeadline = Date.now() + requestTimeoutMs;
  const res = await withTimeout(
    fetch(`http://127.0.0.1:${remotePort}${path}`, { signal: controller.signal }),
    requestTimeoutMs,
    `Timed out fetching browser endpoint ${path}`,
    () => controller.abort()
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}`);
  }
  return withTimeout(
    res.json(),
    Math.max(1, requestDeadline - Date.now()),
    `Timed out reading browser endpoint ${path}`,
    () => controller.abort()
  );
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

function normalizeConversationId(value) {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9_-]+$/u.test(normalized) ? normalized : '';
}

function extractConversationHref(value, fallbackOrigin = '') {
  const parsed = safeUrl(value);
  if (parsed) {
    const chatId = normalizeConversationId(extractChatId(parsed.pathname));
    return chatId ? `${parsed.origin}/c/${chatId}` : '';
  }

  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  const chatId = normalizeConversationId(extractChatId(normalized));
  if (!chatId) {
    return '';
  }

  const originMatch = normalized.match(/^(https?:\/\/[^/]+)/i);
  const origin = originMatch?.[1] || fallbackOrigin;
  if (!origin) {
    return '';
  }

  return `${origin}/c/${chatId}`;
}

async function resolveAcceptedConversationAfterSend({
  commitResult,
  desiredTargetOrigin,
  maxWaitMs,
  waitForConversationStateAfterSend,
}) {
  const conversationStateResult = await waitForConversationStateAfterSend(
    commitResult?.state,
    maxWaitMs,
  );
  return {
    conversationHref: extractConversationHref(
      conversationStateResult?.href || commitResult?.state?.href,
      desiredTargetOrigin,
    ),
    conversationStateResult,
  };
}

function selectExactAcceptedTarget(targets, targetId, chatUrl) {
  const normalizedTargetId = String(targetId || '').trim();
  const normalizedChatUrl = extractConversationHref(chatUrl);
  if (!normalizedTargetId || !normalizedChatUrl || !Array.isArray(targets)) return null;
  const matches = targets.filter(
    (target) =>
      target?.type === 'page' &&
      String(target?.id || '').trim() === normalizedTargetId &&
      Boolean(target?.webSocketDebuggerUrl) &&
      extractConversationHref(target?.url) === normalizedChatUrl,
  );
  if (matches.length > 1) {
    throw new Error('Browser exposed multiple debuggable pages for the exact accepted target and thread.');
  }
  return matches[0] || null;
}

function selectUniqueDeepResearchIframeTarget(targets, parentTargetId) {
  const normalizedParentTargetId = String(parentTargetId || '').trim();
  if (!normalizedParentTargetId || !Array.isArray(targets)) return null;
  const matches = targets.filter((target) => {
    if (
      target?.type !== 'iframe' ||
      String(target?.parentId || '').trim() !== normalizedParentTargetId ||
      !target?.webSocketDebuggerUrl
    ) {
      return false;
    }
    const metadata = `${target?.title || ''}\n${target?.url || ''}`.toLowerCase();
    return (
      metadata.includes('deep research') ||
      metadata.includes('deep-research') ||
      metadata.includes('deep_research') ||
      metadata.includes('connector_openai_deep_research')
    );
  });
  if (matches.length > 1) {
    throw new Error(
      `Originating Deep Research iframe target resolved to ${matches.length} frames before the report identity was known; refusing ambiguous response capture.`,
    );
  }
  return matches[0] || null;
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
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bin\s+tant\b/g, 'instant')
    .replace(/\blate\s+t\b/g, 'latest')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAppConnectorText(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function appConnectorTargetAliases(target) {
  const normalizedTarget = normalizeAppConnectorText(target);
  if (!normalizedTarget) return [];
  const aliases = {
    github: ['github', 'git hub', 'gh'],
    'git hub': ['github', 'git hub', 'gh'],
    'openai platform': ['openai platform', 'open ai platform', 'platform'],
    'open ai platform': ['openai platform', 'open ai platform', 'platform'],
    'agent mode': ['agent mode', 'agent'],
  };
  return aliases[normalizedTarget] || [normalizedTarget];
}

function appConnectorLabelMatchesTarget(label, target) {
  const normalizedLabel = normalizeAppConnectorText(label);
  const normalizedTarget = normalizeAppConnectorText(target);
  if (!normalizedLabel || !normalizedTarget) return false;
  if (normalizedLabel === normalizedTarget) return true;

  const targetAliases = appConnectorTargetAliases(normalizedTarget);
  return targetAliases.some((alias) => {
    const normalizedAlias = normalizeAppConnectorText(alias);
    return (
      normalizedLabel === normalizedAlias ||
      normalizedLabel.startsWith(`${normalizedAlias} `) ||
      normalizedLabel.endsWith(` ${normalizedAlias}`) ||
      normalizedLabel.includes(` ${normalizedAlias} `)
    );
  });
}

function appConnectorMentionText(target) {
  const rawTarget = String(target || '').trim();
  const normalizedTarget = normalizeAppConnectorText(rawTarget);
  if (!normalizedTarget) return '';
  if (normalizedTarget === 'github' || normalizedTarget === 'git hub' || normalizedTarget === 'gh') {
    return '@github';
  }
  return `@${rawTarget}`;
}

function modelPickerTextHasWord(value, word) {
  const normalizedValue = normalizeModelPickerText(value);
  const normalizedWord = normalizeModelPickerText(word);
  if (!normalizedValue || !normalizedWord) return false;
  return ` ${normalizedValue} `.includes(` ${normalizedWord} `);
}

function modelPickerTargetAllowsExplicitSol(target) {
  const desiredVersion = String(target?.desiredVersion || '').trim();
  return Boolean(
    target?.wantsSol ||
    (target?.wantsPro && (!desiredVersion || desiredVersion === '5-6'))
  );
}

function modelPickerExplicitVersions(value) {
  const tokens = normalizeModelPickerText(value).split(' ').filter(Boolean);
  const versions = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1] || '';
    if (/^\d+$/.test(token) && /^\d+$/.test(nextToken)) {
      versions.add(`${token}-${nextToken}`);
    }
    const compactMatch = token.match(/^gpt(\d)(\d+)$/);
    if (compactMatch) {
      versions.add(`${compactMatch[1]}-${compactMatch[2]}`);
    }
    const prefixedMajorMatch = token.match(/^gpt(\d+)$/);
    if (prefixedMajorMatch && /^\d+$/.test(nextToken)) {
      versions.add(`${prefixedMajorMatch[1]}-${nextToken}`);
    }
  }
  return Array.from(versions);
}

function modelPickerHasMatchingExplicitSol(label, testId, target) {
  if (!modelPickerTargetAllowsExplicitSol(target)) {
    return false;
  }
  const normalizedLabel = normalizeModelPickerText(label);
  const normalizedTestId = normalizeModelPickerText(testId);
  const optionText = `${normalizedLabel} ${normalizedTestId}`.trim();
  const desiredVersion = String(target?.desiredVersion || '5-6').trim() || '5-6';
  const explicitVersions = modelPickerExplicitVersions(optionText);
  const hasSolSignal =
    modelPickerTextHasWord(normalizedLabel, 'sol') ||
    modelPickerTextHasWord(normalizedTestId, 'sol');
  const hasExtendedProSignal =
    normalizedLabel.includes('extended pro') ||
    normalizedLabel.includes('pro extended') ||
    normalizedTestId.includes('extended pro') ||
    normalizedTestId.includes('pro extended') ||
    normalizedTestId.includes('extendedpro');
  return Boolean(
    hasSolSignal &&
    !hasExtendedProSignal &&
    explicitVersions.length === 1 &&
    explicitVersions[0] === desiredVersion
  );
}

function modelPickerOptionMatchesTarget(label, testId, target) {
  const normalizedLabel = normalizeModelPickerText(label);
  const normalizedTestId = normalizeModelPickerText(testId);
  if (
    modelPickerTextHasWord(normalizedLabel, 'effort') ||
    modelPickerTextHasWord(normalizedTestId, 'effort')
  ) {
    return false;
  }
  const desiredVersion = String(target?.desiredVersion || '').trim();
  const wantsPro = Boolean(target?.wantsPro);
  const wantsSol = Boolean(target?.wantsSol);
  const wantsInstant = Boolean(target?.wantsInstant);
  const wantsThinking = Boolean(target?.wantsThinking);
  const hasWord = (word) => modelPickerTextHasWord(normalizedLabel, word);
  const hasProSignal =
    hasWord('pro') ||
    normalizedLabel.includes('extended pro') ||
    modelPickerTextHasWord(normalizedTestId, 'pro') ||
    normalizedTestId.includes('pro') ||
    normalizedTestId.includes('extendedpro') ||
    normalizedTestId.includes('extended pro');
  const hasExtendedProSignal =
    normalizedLabel.includes('extended pro') ||
    normalizedLabel.includes('pro extended') ||
    normalizedTestId.includes('extendedpro') ||
    normalizedTestId.includes('extended pro') ||
    normalizedTestId.includes('pro extended');
  const hasInstantSignal = hasWord('instant') || modelPickerTextHasWord(normalizedTestId, 'instant');
  const hasThinkingSignal = hasWord('thinking') || modelPickerTextHasWord(normalizedTestId, 'thinking');
  const hasMatchingExplicitSol = modelPickerHasMatchingExplicitSol(label, testId, target);
  const optionText = `${normalizedLabel} ${normalizedTestId}`.trim();
  const explicitVersions = modelPickerExplicitVersions(optionText);
  const hasDesiredVersionSignal =
    !desiredVersion ||
    (explicitVersions.length === 1 && explicitVersions[0] === desiredVersion);
  const hasExplicitVersionSignal = explicitVersions.length > 0;
  const hasDesiredInstantVersion =
    desiredVersion === '5-5' &&
    (normalizedTestId.includes('5 5') ||
      normalizedTestId.includes('5-5') ||
      normalizedTestId.includes('5.5') ||
      normalizedTestId.includes('gpt55'));

  if (wantsSol) {
    return (
      (hasProSignal || hasMatchingExplicitSol) &&
      !hasExtendedProSignal &&
      !hasInstantSignal &&
      !hasThinkingSignal &&
      (!hasExplicitVersionSignal || hasDesiredVersionSignal)
    );
  }

  if (wantsPro) {
    if (hasExtendedProSignal) {
      return false;
    }
    if (hasExplicitVersionSignal) {
      const expectedVersion = desiredVersion || '5-6';
      if (explicitVersions.length !== 1 || explicitVersions[0] !== expectedVersion) {
        return false;
      }
    }
    return (hasProSignal || hasMatchingExplicitSol) && !hasInstantSignal && !hasThinkingSignal;
  }
  if (hasProSignal) {
    return false;
  }
  if (wantsThinking) {
    return hasThinkingSignal && !hasInstantSignal;
  }
  if (hasThinkingSignal) {
    return false;
  }
  if (wantsInstant) {
    return hasInstantSignal || hasDesiredInstantVersion;
  }
  if (hasInstantSignal && desiredVersion !== '5-5') {
    return false;
  }
  return true;
}

function modelPickerLabelMatchesTarget(label, target) {
  const normalizedLabel = normalizeModelPickerText(label);
  if (modelPickerTextHasWord(normalizedLabel, 'effort')) {
    return false;
  }
  const desiredVersion = String(target?.desiredVersion || '').trim();
  const wantsPro = Boolean(target?.wantsPro);
  const wantsSol = Boolean(target?.wantsSol);
  const wantsInstant = Boolean(target?.wantsInstant);
  const wantsThinking = Boolean(target?.wantsThinking);
  if (!normalizedLabel) return false;

  const hasWord = (word) => modelPickerTextHasWord(normalizedLabel, word);
  const hasProWord = hasWord('pro');
  const hasExtendedPro =
    normalizedLabel.includes('extended pro') ||
    normalizedLabel.includes('pro extended');
  const hasPlainProWord = hasProWord && !hasExtendedPro;
  const hasInstantWord = hasWord('instant');
  const hasThinkingWord = hasWord('thinking');
  const hasMatchingExplicitSol = modelPickerHasMatchingExplicitSol(label, '', target);
  const explicitVersions = modelPickerExplicitVersions(normalizedLabel);
  const hasExplicitVersion = explicitVersions.length > 0;
  const matchesGenericPro =
    wantsPro &&
    hasPlainProWord &&
    !hasInstantWord &&
    !hasThinkingWord &&
    !hasExplicitVersion;
  const matchesGenericThinking =
    wantsThinking &&
    hasThinkingWord &&
    !hasInstantWord &&
    !hasProWord &&
    !hasExtendedPro &&
    !hasExplicitVersion;
  const matchesGenericInstant =
    wantsInstant &&
    hasInstantWord &&
    !hasThinkingWord &&
    !hasProWord &&
    !hasExtendedPro &&
    !hasExplicitVersion;

  if (wantsSol) {
    const desiredLabel = desiredVersion.replace('-', ' ');
    return (
      (hasPlainProWord || hasMatchingExplicitSol) &&
      !hasInstantWord &&
      !hasThinkingWord &&
      (!hasExplicitVersion || !desiredLabel ||
        (explicitVersions.length === 1 && explicitVersions[0] === desiredVersion))
    );
  }

  if (
    wantsPro &&
    !desiredVersion &&
    hasExplicitVersion &&
    (explicitVersions.length !== 1 || explicitVersions[0] !== '5-6')
  ) {
    return false;
  }

  if (desiredVersion) {
    const desiredLabel = desiredVersion.replace('-', ' ');
    if (
      desiredLabel &&
      (explicitVersions.length !== 1 || explicitVersions[0] !== desiredVersion) &&
      !matchesGenericPro &&
      !matchesGenericThinking &&
      !matchesGenericInstant
    ) {
      return false;
    }
  }

  if (wantsPro && !hasPlainProWord && !hasMatchingExplicitSol) return false;
  if (wantsInstant && !hasInstantWord) return false;
  if (wantsThinking && !hasThinkingWord) return false;
  if (!wantsPro && (hasProWord || hasExtendedPro)) return false;
  if (!wantsInstant && hasInstantWord) return false;
  if (!wantsThinking && hasThinkingWord) return false;
  return true;
}

function modelPickerOptionIsFinalTarget(label, testId, target, opensSubmenu = false) {
  if (!target?.wantsSol && !target?.wantsPro) return true;
  return !opensSubmenu && modelPickerOptionMatchesTarget(label, testId, target);
}

function modelPickerOptionCanTraverseTarget(label, testId, target, opensSubmenu = false) {
  const normalizedLabel = normalizeModelPickerText(label);
  if (!normalizedLabel || modelPickerTextHasWord(normalizedLabel, 'effort')) {
    return false;
  }
  if (normalizedLabel === 'advanced') {
    return true;
  }
  if (!opensSubmenu) {
    return false;
  }
  const isModelSummary = normalizedLabel === 'model' || normalizedLabel.startsWith('model ');
  return (
    isModelSummary ||
    ((target?.wantsSol || target?.wantsPro) && modelPickerHasMatchingExplicitSol(label, testId, target))
  );
}

function modelPickerSummarySelectionProof(snapshot, target) {
  if (snapshot?.visible !== true || snapshot?.unavailable || snapshot?.opensSubmenu !== true) {
    return false;
  }
  const normalizedLabel = normalizeModelPickerText(snapshot?.label);
  if (
    !normalizedLabel ||
    modelPickerTextHasWord(normalizedLabel, 'effort') ||
    (normalizedLabel !== 'model' && !normalizedLabel.startsWith('model '))
  ) {
    return false;
  }
  return (
    modelPickerHasMatchingExplicitSol(snapshot?.label, '', target) &&
    modelPickerOptionMatchesTarget(snapshot?.label, '', target)
  );
}

function modelPickerOptionElementCanParticipate(snapshot) {
  const role = String(snapshot?.role || '').trim().toLowerCase();
  const inputType = String(snapshot?.inputType || '').trim().toLowerCase();
  return Boolean(
    role !== 'slider' &&
    inputType !== 'range' &&
    snapshot?.insideSlider !== true &&
    snapshot?.containsSlider !== true
  );
}

function modelPickerOptionSelectionProof(snapshot, target) {
  if (
    snapshot?.visible !== true ||
    snapshot?.unavailable ||
    !modelPickerOptionElementCanParticipate(snapshot)
  ) {
    return false;
  }
  if (modelPickerSummarySelectionProof(snapshot, target)) {
    return true;
  }
  if (!modelPickerOptionMatchesTarget(snapshot?.label, snapshot?.testId, target)) {
    return false;
  }
  if (modelPickerOptionIsFinalTarget(snapshot?.label, snapshot?.testId, target, snapshot?.opensSubmenu)) {
    return snapshot?.selected === true;
  }
  return false;
}

function modelPickerControlLabelCanProveTarget(label, target) {
  const normalizedLabel = normalizeModelPickerText(label);
  // The current split picker uses the bare composer label `Pro` for Effort,
  // while the selected model lives under Advanced. Only a selected model row
  // or an explicit model summary can prove the model in that ambiguous state.
  return normalizedLabel !== 'pro' && modelPickerLabelMatchesTarget(normalizedLabel, target);
}

function modelPickerControlSelectionProof(snapshot, target) {
  const disabled =
    snapshot?.disabled === true ||
    String(snapshot?.ariaDisabled || '').toLowerCase() === 'true' ||
    snapshot?.dataDisabled === true ||
    normalizeModelPickerText(snapshot?.dataState || '') === 'disabled' ||
    snapshot?.inert === true;
  return Boolean(
    snapshot?.visible === true &&
    !disabled &&
    !snapshot?.unavailable &&
    modelPickerControlLabelCanProveTarget(snapshot?.label ?? snapshot?.text, target)
  );
}

function modelPickerSelectionStateMatches(snapshot) {
  const ariaChecked = String(snapshot?.ariaChecked || '').toLowerCase();
  const ariaSelected = String(snapshot?.ariaSelected || '').toLowerCase();
  const ariaCurrent = String(snapshot?.ariaCurrent || '').toLowerCase();
  const dataSelected = String(snapshot?.dataSelected || '').toLowerCase();
  const dataState = normalizeModelPickerText(snapshot?.dataState || '');
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
  return false;
}

function modelPickerUnavailableReason(value) {
  const raw = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = normalizeModelPickerText(raw);
  if (!normalized) return '';
  const unavailableSignals = [
    'limit reached',
    'reached your limit',
    'you have reached',
    'you ve reached',
    'try again after',
    'rate limit',
    'rate limited',
    'usage limit',
    'message cap',
    'cap reached',
    'not available',
    'unavailable',
    'temporarily unavailable',
    'disabled',
    'upgrade required',
    'requires upgrade',
  ];
  return unavailableSignals.some((signal) => normalized.includes(signal)) ? raw : '';
}

function formatModelSelectionFailureMessage(targetModel, selection) {
  const target = normalizeSelectionTarget(targetModel, 'requested');
  const details = selection?.details || selection || {};
  const unavailableCandidate =
    details?.reason ||
    details?.message ||
    details?.text ||
    details?.unavailableMessage ||
    '';
  const unavailableReason = modelPickerUnavailableReason(unavailableCandidate) || String(unavailableCandidate || '').trim();
  const unavailable =
    selection?.reason === 'model-unavailable' ||
    selection?.status === 'model-unavailable' ||
    details?.status === 'model-unavailable' ||
    Boolean(modelPickerUnavailableReason(unavailableCandidate));

  if (unavailable) {
    return `Requested ChatGPT model is not available (${target})${unavailableReason ? `: ${unavailableReason}` : '.'}`;
  }

  return `Draft model selection failed before auto-send (${target}): ${JSON.stringify(details)}`;
}

function sanitizeDeepResearchAssistantSnapshot(snapshot, committedAssistantAnchor = null) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }
  const text = sanitizeDeepResearchResponseText(snapshot.text);
  if (!text) {
    return null;
  }
  return {
    ...snapshot,
    ...(committedAssistantAnchor
      ? {
          afterLastUserMessage: committedAssistantAnchor.afterLastUserMessage,
          assistantTurnId: committedAssistantAnchor.assistantTurnId,
          assistantTurnIndex: committedAssistantAnchor.assistantTurnIndex,
          contentSource: 'deep-research-iframe',
          deepResearchParentAnchor: {
            signature: committedAssistantAnchor.signature,
            text: committedAssistantAnchor.text,
          },
          precedingUserMessageSignature: committedAssistantAnchor.precedingUserMessageSignature,
          precedingUserTurnId: committedAssistantAnchor.precedingUserTurnId,
          precedingUserTurnIndex: committedAssistantAnchor.precedingUserTurnIndex,
        }
      : {}),
    text,
    signature: normalizeComparableText(text).slice(0, 320) || String(snapshot.signature || '').trim(),
  };
}

function buildDeepResearchStartClickPoint(targetBounds, hotspot = DEEP_RESEARCH_START_HOTSPOT) {
  const left = Number(targetBounds?.left);
  const top = Number(targetBounds?.top);
  const width = Number(targetBounds?.width);
  const height = Number(targetBounds?.height);
  const xRatio = Number(hotspot?.xRatio);
  const yRatio = Number(hotspot?.yRatio);
  if (![left, top, width, height, xRatio, yRatio].every(Number.isFinite)) {
    return null;
  }
  return {
    x: Math.round(left + width * xRatio),
    y: Math.round(top + height * yRatio),
  };
}

function scoreDeepResearchStartButtonCandidate(snapshot) {
  const label = normalizeComparableText(snapshot?.label);
  if (!label || snapshot?.disabled) return 0;

  let score = 0;
  if (label === 'start') score += 280;
  if (label.startsWith('start ')) score += 260;
  if (label.includes(' start ')) score += 180;
  if (snapshot?.hasCancelSibling) score += 120;
  if (snapshot?.hasEditSibling) score += 60;
  if (snapshot?.withinPlanCard) score += 80;
  if (snapshot?.isButtonElement) score += 20;
  return score;
}

function shouldAttemptDeepResearchStartFallback({
  kickoffState,
  elapsedMs,
  graceMs = DEEP_RESEARCH_AUTO_START_GRACE_MS,
}) {
  const status = String(kickoffState?.status || '');
  if (status === 'generation-active') {
    return false;
  }
  if (!Number.isFinite(Number(elapsedMs)) || Number(elapsedMs) < Math.max(0, Number(graceMs) || 0)) {
    return false;
  }
  return status === 'start-button-visible' || status === 'start-iframe-visible';
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

function evaluateAutoSendCommitState({
  baselineSnapshot,
  promptCandidates,
  state,
}) {
  const baselineTurns = Number.isFinite(Number(baselineSnapshot?.turnCount))
    ? Math.max(0, Math.floor(Number(baselineSnapshot?.turnCount)))
    : -1;
  const baselineUserTurnSignatures = new Set(
    Array.isArray(baselineSnapshot?.userTurnSignatures) ? baselineSnapshot.userTurnSignatures : []
  );
  const baselineUserTurnIds = new Set(
    Array.isArray(baselineSnapshot?.userTurnIds) ? baselineSnapshot.userTurnIds : []
  );
  const turns = Number(state?.turnsCount);
  const hasNewTurn = Number.isFinite(turns) && baselineTurns >= 0 ? turns > baselineTurns : false;
  const userTurnSignatures = Array.isArray(state?.recentUserTurnSignatures)
    ? state.recentUserTurnSignatures.filter((value) => typeof value === 'string' && value.length > 0)
    : [];
  const hasPromptMatchCandidates = Array.isArray(promptCandidates) && promptCandidates.length > 0;
  const recentUserTurns = Array.isArray(state?.recentUserTurns) ? state.recentUserTurns : [];
  const newUserTurns = recentUserTurns.filter(
    (turn) => typeof turn?.turnId === 'string' && turn.turnId && !baselineUserTurnIds.has(turn.turnId),
  );
  const newUserTurnSignatures = newUserTurns.length > 0
    ? newUserTurns.map((turn) => turn.signature).filter(Boolean)
    : userTurnSignatures.filter((signature) => !baselineUserTurnSignatures.has(signature));
  const matchingNewUserTurnSignature = hasPromptMatchCandidates
    ? [...newUserTurnSignatures]
        .reverse()
        .find((signature) => promptSignatureMatches(signature, promptCandidates)) || ''
    : '';
  const newUserTurnSignature = matchingNewUserTurnSignature || newUserTurnSignatures.at(-1) || '';
  const matchingUserTurns = (newUserTurns.length > 0 ? newUserTurns : recentUserTurns).filter(
    (turn) => turn?.signature === newUserTurnSignature,
  );
  const committedUserTurn = matchingUserTurns.length === 1 ? matchingUserTurns[0] : null;
  const newPromptTurnCommitted = hasPromptMatchCandidates
    ? Boolean(matchingNewUserTurnSignature)
    : Boolean(newUserTurnSignature);
  const composerCleared = !state?.composerHasText;
  const activityVisible = Boolean(state?.stopVisible || state?.assistantVisible);
  const fallbackCommit =
    composerCleared &&
    (activityVisible || (state?.inConversation ?? false));
  const hasStrongCommitSignal =
    newPromptTurnCommitted &&
    (hasNewTurn || composerCleared || activityVisible);

  return {
    committed: Boolean(hasStrongCommitSignal || (!hasPromptMatchCandidates && baselineTurns < 0 && fallbackCommit)),
    committedUserTurn,
    newUserTurnSignature,
  };
}

function committedTurnAttachmentVerification(committedUserTurn, expectedNames) {
  const expected = Array.isArray(expectedNames) ? expectedNames : [];
  const attachmentText = normalizeAttachmentSearchText(
    Array.isArray(committedUserTurn?.attachmentTexts)
      ? committedUserTurn.attachmentTexts.join(' ')
      : '',
  );
  const matchedNames = expected.filter((name) => buildAttachmentNameMatcher(name).test(attachmentText));
  return {
    confirmed: expected.length === 0 || (
      Boolean(committedUserTurn?.turnId) &&
      matchedNames.length === expected.length
    ),
    expectedNames: expected,
    matchedNames,
    turnId: String(committedUserTurn?.turnId || ''),
  };
}

const responseStatusTextIndicatesBusy = threadStatusTextIndicatesBusy;

function responseStatusTextsIndicateBusy(statusTexts) {
  return Array.isArray(statusTexts) && statusTexts.some((text) => threadStatusTextIndicatesBusy(text));
}

function responseStateIndicatesChatGptRateLimit(state) {
  const candidates = [
    ...(Array.isArray(state?.assistantFailureTexts) ? state.assistantFailureTexts : []),
    ...(Array.isArray(state?.statusTexts) ? state.statusTexts : []),
    ...(Array.isArray(state?.assistantSnapshots) ? state.assistantSnapshots.map((snapshot) => snapshot?.text) : []),
    state?.bodyText,
  ];
  return candidates.some((value) => chatGptTextIndicatesRateLimit(value));
}

function responseStateAssistantFailureText(state) {
  if (!Array.isArray(state?.assistantFailureTexts)) {
    return '';
  }
  return String(state.assistantFailureTexts.find((value) => String(value || '').trim().length > 0) || '').trim();
}

/**
 * True when a deadline snapshot cannot be a completed response because the
 * required completion marker is absent. This takes precedence over model
 * attestation: partial text has no MODEL_CONFIRMATION line yet, so attesting
 * first would misreport a wait timeout as a model mismatch.
 */
function timeoutSnapshotMissingResponseMarker(responseMarkerValue, snapshotText) {
  const marker = String(responseMarkerValue || '');
  if (!marker) return false;
  return !String(snapshotText || '').includes(marker);
}

function missingResponseMarkerMessage(responseMarkerValue, result) {
  const rateLimitSuffix = result?.rateLimited
    ? ' ChatGPT also exposed a rate/usage-limit signal; cool down before retrying.'
    : ' Treat this as incomplete or hidden rate-limited output, not a review result.';
  return `Assistant response did not contain required completion marker "${responseMarkerValue}" before the wait timeout.${rateLimitSuffix}`;
}

function normalizeModelConfirmationName(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^chatgpt\s+/u, '')
    .replace(/[^a-z0-9]+/gu, '');

  // The package's GPT-5.6 Sol alias maps to the current Pro backend
  // data-message-model-slug `gpt-5-6-pro` on the resulting response.
  return normalized === 'gpt56sol' || normalized === 'pro' ? 'gpt56pro' : normalized;
}

function responseModelSlugMatchesExpected(responseModelSlug, expectedModel) {
  const reported = normalizeModelConfirmationName(responseModelSlug);
  if (reported === expectedModel) {
    return true;
  }

  // The current ChatGPT UI labels the selected model as GPT-5.6 Sol while
  // response turns can expose the internal `gpt-5-6-thinking` backend slug.
  // Keep this comparison directional so an explicitly requested Thinking
  // target is not reinterpreted as Sol/Pro.
  return expectedModel === 'gpt56pro' && reported === 'gpt56thinking';
}

function modelConfirmationRequired(input) {
  return Boolean(
    input?.shouldSend &&
      input?.shouldWaitForResponse &&
      !input?.isDeepResearchMode &&
      !isCurrentSelectionTarget(input?.targetModel),
  );
}

function modelConfirmationPromptBlock(targetModel, responseMarkerValue = '', turnNonce = '') {
  const target = String(targetModel || '').trim();
  const normalizedTurnNonce = String(turnNonce || '').trim();
  const lines = normalizedTurnNonce
    ? [`REVIEW_GPT_TURN_NONCE: ${normalizedTurnNonce}`]
    : [];
  lines.push(
    `Complete the requested work even if you cannot independently identify the active model.`,
    `If you can confirm the active model is ${target}, include this exact line in your final response:`,
    `MODEL_CONFIRMATION: ${target}`,
    `If you cannot confirm the active model is ${target}, include this exact line in your final response instead:`,
    `MODEL_CONFIRMATION: UNKNOWN`,
    `Do not stop or shorten the requested work because model confirmation is unknown.`,
  );
  if (responseMarkerValue) {
    lines.push(`Include ${responseMarkerValue} only after the requested work is complete.`);
  }
  return lines.join('\n');
}

function appendModelConfirmationPrompt(prompt, input) {
  const value = String(prompt || '');
  if (!modelConfirmationRequired(input)) {
    return value;
  }
  const normalizedTurnNonce = String(input?.turnNonce || '').trim();
  const turnNonceLine = normalizedTurnNonce
    ? `REVIEW_GPT_TURN_NONCE: ${normalizedTurnNonce}`
    : '';
  if (turnNonceLine && value.includes(turnNonceLine)) {
    return value;
  }
  return `${modelConfirmationPromptBlock(
    input.targetModel,
    input.responseMarker,
    normalizedTurnNonce,
  )}\n\n${value}`;
}

function extractModelConfirmationValues(responseText) {
  const values = [];
  let fenceCharacter = '';
  let fenceLength = 0;
  for (const line of String(responseText || '').split(/\r?\n/u)) {
    if (fenceCharacter) {
      const closingFence = line.match(/^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/u);
      const marker = closingFence?.[1] || '';
      if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = '';
        fenceLength = 0;
      }
      continue;
    }
    const openingFence = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/u);
    if (openingFence && (openingFence[1][0] !== '`' || !openingFence[2].includes('`'))) {
      fenceCharacter = openingFence[1][0];
      fenceLength = openingFence[1].length;
      continue;
    }
    const match = line.match(/^[ ]{0,3}MODEL_CONFIRMATION\s*:\s*(.+?)\s*$/iu);
    const value = String(match?.[1] || '').trim();
    if (value) values.push(value);
  }
  return values;
}

function extractModelConfirmationValue(responseText) {
  return extractModelConfirmationValues(responseText)[0] || '';
}

function modelConfirmationFailure(
  targetModel,
  modelConfirmationText,
  responseModelSlug = '',
  generationElapsedMs = 0,
) {
  if (isCurrentSelectionTarget(targetModel)) {
    return '';
  }

  const expected = normalizeModelConfirmationName(targetModel);
  const confirmations = extractModelConfirmationValues(modelConfirmationText);
  if (confirmations.length === 0) {
    return `Assistant response did not include MODEL_CONFIRMATION for requested model ${targetModel}.`;
  }
  if (confirmations.length !== 1) {
    return `Assistant response included multiple MODEL_CONFIRMATION lines for requested model ${targetModel}.`;
  }
  const actual = confirmations[0];
  const actualNormalized = normalizeModelConfirmationName(actual);
  const reportedSlug = normalizeModelConfirmationName(responseModelSlug);
  const reportedSlugMatches = responseModelSlugMatchesExpected(responseModelSlug, expected);
  const acceptsPlatformVerifiedUnknown =
    actualNormalized === 'unknown' &&
    expected.startsWith('gpt') &&
    reportedSlugMatches;
  const acceptsTimedUnknown =
    actualNormalized === 'unknown' &&
    Number.isFinite(Number(generationElapsedMs)) &&
    Number(generationElapsedMs) >= MODEL_CONFIRMATION_UNKNOWN_FALLBACK_MS;
  if (actualNormalized !== expected && !acceptsPlatformVerifiedUnknown && !acceptsTimedUnknown) {
    return `Assistant response confirmed model ${actual}, expected ${targetModel}.`;
  }

  if (expected.startsWith('gpt') && reportedSlug && !reportedSlugMatches) {
    return `Assistant response DOM reported model ${responseModelSlug}, expected ${targetModel}.`;
  }
  return '';
}

function markedResponseDurationFailure({
  targetModel,
  responseMarker: requiredMarker,
  responseElapsedMs,
  minimumResponseMs = 5 * 60 * 1000,
  hasConcreteModelEvidence = false,
}) {
  if (!requiredMarker || isCurrentSelectionTarget(targetModel) || hasConcreteModelEvidence) {
    return '';
  }

  const elapsedMs = Number(responseElapsedMs);
  const requiredMinimumMs = Number(minimumResponseMs);
  if (
    Number.isFinite(elapsedMs) &&
    Number.isSafeInteger(requiredMinimumMs) &&
    requiredMinimumMs > 0 &&
    elapsedMs >= requiredMinimumMs
  ) {
    return '';
  }

  const elapsedSeconds = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.round(elapsedMs / 1000))
    : 0;
  const minimumLabel = Number.isSafeInteger(requiredMinimumMs) && requiredMinimumMs > 0
    ? formatDurationMs(requiredMinimumMs)
    : 'invalid configured duration';
  return `Assistant response reached the required completion marker after ${elapsedSeconds}s, below the ${minimumLabel} minimum for a marked concrete-model review without compatible response-model metadata. The response is untrusted and was not attested.`;
}

function formatDurationMs(durationMs) {
  if (durationMs % 60_000 === 0) return `${durationMs / 60_000}m`;
  if (durationMs % 1000 === 0) return `${durationMs / 1000}s`;
  return `${durationMs}ms`;
}

function assertMarkedResponseDurationTrusted(responseResult, responseFilePath = '') {
  if (responseResult?.status !== 'response-too-fast') return;
  if (responseFilePath && responseResult.responseText) {
    writeCapturedResponseFile(responseFilePath, responseResult.responseText);
  }
  throw new Error(responseResult.responseDurationFailure || 'Assistant response completed too quickly to trust.');
}

function capturedResponseFileText(responseText) {
  return `${normalizeResponseText(responseText)}\n`;
}

function modelAttestationForSnapshot(
  targetModel,
  snapshot,
  includeEvidence = false,
  committedUserTurnSignature = '',
  generationElapsedMs = 0,
) {
  if (!isCurrentSelectionTarget(targetModel)) {
    const expectedUserTurnSignature = String(committedUserTurnSignature || '').trim();
    if (
      expectedUserTurnSignature &&
      snapshot?.precedingUserMessageSignature !== expectedUserTurnSignature
    ) {
      return {
        evidence: null,
        failure: `Assistant response was not bound to the committed user turn for requested model ${targetModel}.`,
      };
    }
    if (!expectedUserTurnSignature && snapshot?.afterLastUserMessage !== true) {
      return {
        evidence: null,
        failure: `Assistant response was not captured from the new assistant turn for requested model ${targetModel}.`,
      };
    }
  }

  const failure = modelConfirmationFailure(
    targetModel,
    snapshot?.modelConfirmationText,
    snapshot?.modelSlug,
    generationElapsedMs,
  );
  if (failure || !includeEvidence) {
    return { evidence: null, failure };
  }

  const requestedModel = String(targetModel || '').trim();
  const responseModelSlug = String(snapshot?.modelSlug || '').trim();
  if (
    isCurrentSelectionTarget(requestedModel) ||
    !normalizeModelConfirmationName(requestedModel).startsWith('gpt') ||
    !responseModelSlug
  ) {
    return { evidence: null, failure: '' };
  }
  const responseBytes = capturedResponseFileText(snapshot?.text);
  return {
    evidence: {
      schemaVersion: 1,
      requestedModel,
      responseModelSlug,
      responseSha256: createHash('sha256').update(responseBytes, 'utf8').digest('hex'),
    },
    failure: '',
  };
}

function writePrivateFileAtomically(filePath, contents) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function captureIdentityDigest(value) {
  return `sha256:${createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function sanitizedCaptureTurnId(value) {
  const raw = String(value || '');
  const marker = ':signature:';
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) return raw;
  let hash = 0x811c9dc5;
  for (const character of raw.slice(markerIndex + marker.length)) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${raw.slice(0, markerIndex)}:hash32:${hash.toString(16).padStart(8, '0')}`;
}

function sanitizedArtifactCaptureLabel(attachment) {
  return captureIdentityDigest(artifactCaptureLabel(attachment));
}

function artifactCaptureLabel(attachment) {
  const text = String(attachment?.text || '').trim();
  const href = String(attachment?.href || '').trim();
  let hrefLabel = '';
  try {
    hrefLabel = decodeURIComponent(new URL(href, 'https://chatgpt.com').pathname.split('/').filter(Boolean).at(-1) || '');
  } catch {
    hrefLabel = decodeURIComponent(href.split('/').filter(Boolean).at(-1) || '');
  }
  const patchNamePattern = /\.(patch|diff|patched)\b/i;
  if (hrefLabel && patchNamePattern.test(hrefLabel) && !patchNamePattern.test(text)) return hrefLabel;
  return text || hrefLabel;
}

function isCapturedAssistantArtifact(attachment) {
  const text = String(attachment?.text || '').trim();
  const href = String(attachment?.href || '').trim();
  const label = artifactCaptureLabel(attachment);
  const artifactNamePattern = /\.(patch|diff|zip|txt|json|md|patched)\b/i;
  const hasConcreteHref = Boolean(
    href &&
      (href.startsWith('sandbox:/mnt/data/') ||
        href.startsWith('blob:') ||
        href.startsWith('data:') ||
        artifactNamePattern.test(href)),
  );
  return Boolean(
    attachment?.download ||
      hasConcreteHref ||
      (attachment?.behaviorButton &&
        (artifactNamePattern.test(text) || artifactNamePattern.test(label) || /\bdownload\b/i.test(text))),
  );
}

function declaredPatchArtifactNames(responseText) {
  return Array.from(new Set([
    ...String(responseText || '').matchAll(
      /(?:^|\n)\s*patch artifact\s*:\s*`?([^\s`]+\.(?:patch|diff|patched))`?/giu,
    ),
  ].map((match) => String(match[1] || '').trim()).filter(Boolean)));
}

function declaredArtifactCaptureFailure(responseText, artifactLabels) {
  const declaredArtifacts = declaredPatchArtifactNames(responseText);
  const capturedLabels = Array.isArray(artifactLabels)
    ? artifactLabels.map((label) => String(label || '').trim()).filter(Boolean)
    : [];
  const searchableLabels = normalizeAttachmentSearchText(capturedLabels.join(' '));
  const missingArtifacts = declaredArtifacts.filter((artifactName) => {
    const matcher = buildAttachmentNameMatcher(artifactName);
    return !matcher || !matcher.test(searchableLabels);
  });
  if (missingArtifacts.length === 0) return '';
  const capturedSummary = capturedLabels.length > 0
    ? `Captured assistant attachments: ${capturedLabels.join(', ')}.`
    : 'No downloadable assistant attachments were captured.';
  return `Assistant response declared patch artifact ${missingArtifacts.join(', ')}, but it was not present among the downloadable assistant attachments. ${capturedSummary} The response was preserved, but the waited review is incomplete.`;
}

function declaredSingleArtifactSha256(responseText, artifactCount) {
  if (artifactCount !== 1) return '';
  const claims = [
    ...new Set(
      [...String(responseText || '').matchAll(/\bsha-?256\s*:?\s*([a-f0-9]{64})\b/giu)]
        .map((match) => String(match[1] || '').toLowerCase()),
    ),
  ];
  return claims.length === 1 ? claims[0] : '';
}

function buildThreadCaptureIdentity({
  assistantSnapshot = null,
  attachmentButtons = [],
  browserEndpoint,
  chatUrl,
  committedUserTurn,
  expectedContentSource,
  targetId,
}) {
  const exactBrowserEndpoint = String(browserEndpoint || '').trim();
  const exactChatUrl = extractConversationHref(chatUrl);
  const exactTargetId = String(targetId || '').trim();
  if (!exactBrowserEndpoint || !exactChatUrl || !exactTargetId) {
    throw new Error('Could not persist capture metadata without one exact browser, thread, and target identity.');
  }
  if (!committedUserTurn?.turnId || !Number.isInteger(committedUserTurn?.turnIndex)) {
    throw new Error('Could not persist capture metadata without one exact committed user turn.');
  }
  const exactExpectedContentSource = assistantSnapshot?.contentSource || expectedContentSource;
  if (exactExpectedContentSource !== undefined && exactExpectedContentSource !== 'deep-research-iframe') {
    throw new Error('Could not persist an unsupported expected assistant content source.');
  }
  if (
    assistantSnapshot &&
    expectedContentSource !== undefined &&
    assistantSnapshot.contentSource !== expectedContentSource
  ) {
    throw new Error('Could not persist a completed assistant response from the wrong content source.');
  }
  const assistantResponse = assistantSnapshot
    ? {
        assistantTurnId: sanitizedCaptureTurnId(assistantSnapshot.assistantTurnId),
        assistantTurnIndex: Number(assistantSnapshot.assistantTurnIndex),
        precedingUserMessageSignature: captureIdentityDigest(assistantSnapshot.precedingUserMessageSignature),
        precedingUserTurnId: sanitizedCaptureTurnId(assistantSnapshot.precedingUserTurnId),
        precedingUserTurnIndex: Number(assistantSnapshot.precedingUserTurnIndex),
        responseSha256: createHash('sha256')
          .update(capturedResponseFileText(assistantSnapshot.text), 'utf8')
          .digest('hex'),
        signature: captureIdentityDigest(assistantSnapshot.signature),
        ...(assistantSnapshot.contentSource === 'deep-research-iframe'
          ? {
              contentSource: 'deep-research-iframe',
              parentAnchor: {
                responseSha256: createHash('sha256')
                  .update(capturedResponseFileText(assistantSnapshot.deepResearchParentAnchor?.text), 'utf8')
                  .digest('hex'),
                signature: captureIdentityDigest(assistantSnapshot.deepResearchParentAnchor?.signature),
              },
            }
          : {}),
      }
    : null;
  if (
    assistantResponse &&
    (
      !assistantResponse.assistantTurnId ||
      !Number.isInteger(assistantResponse.assistantTurnIndex) ||
      !assistantResponse.precedingUserTurnId ||
      !Number.isInteger(assistantResponse.precedingUserTurnIndex) ||
      !String(assistantSnapshot.signature || '').trim() ||
      (assistantResponse.contentSource === 'deep-research-iframe' &&
        (!String(assistantSnapshot.deepResearchParentAnchor?.text || '').trim() ||
          !String(assistantSnapshot.deepResearchParentAnchor?.signature || '').trim()))
    )
  ) {
    throw new Error('Could not persist an exact identity for the waited assistant response.');
  }
  if (
    assistantResponse &&
    (
      assistantResponse.precedingUserTurnId !== sanitizedCaptureTurnId(committedUserTurn.turnId) ||
      assistantResponse.precedingUserTurnIndex !== committedUserTurn.turnIndex ||
      String(assistantSnapshot.precedingUserMessageSignature || '') !== String(committedUserTurn.signature || '')
    )
  ) {
    throw new Error('Waited assistant response did not belong to the exact committed user turn.');
  }

  const matchingAttachments = assistantResponse
    ? matchingCapturedAssistantArtifacts(assistantSnapshot, attachmentButtons)
    : [];
  const declaredContentSha256 = declaredSingleArtifactSha256(
    assistantSnapshot?.text,
    matchingAttachments.length,
  );
  const artifacts = matchingAttachments.map((attachment) => ({
    artifactIndexInAssistantTurn: Number(attachment.artifactIndexInAssistantTurn),
    assistantTurnId: sanitizedCaptureTurnId(attachment.assistantTurnId),
    assistantTurnIndex: Number(attachment.assistantTurnIndex),
    href: attachment.href == null ? null : captureIdentityDigest(attachment.href),
    label: sanitizedArtifactCaptureLabel(attachment),
    ...(declaredContentSha256 ? { contentSha256: declaredContentSha256 } : {}),
  }));
  if (artifacts.some(
    (artifact) =>
      !Number.isInteger(artifact.artifactIndexInAssistantTurn) ||
      artifact.artifactIndexInAssistantTurn < 0 ||
      !artifact.assistantTurnId ||
      !Number.isInteger(artifact.assistantTurnIndex),
  )) {
    throw new Error('Could not persist an exact identity for every waited assistant artifact.');
  }

  return {
    artifacts,
    assistantResponse,
    browserEndpoint: exactBrowserEndpoint,
    chatUrl: exactChatUrl,
    committedUserTurn: {
      signature: captureIdentityDigest(committedUserTurn.signature),
      turnId: sanitizedCaptureTurnId(committedUserTurn.turnId),
      turnIndex: Number(committedUserTurn.turnIndex),
    },
    ...(exactExpectedContentSource ? { expectedContentSource: exactExpectedContentSource } : {}),
    schemaVersion: 2,
    targetId: exactTargetId,
  };
}

function matchingCapturedAssistantArtifacts(assistantSnapshot, attachmentButtons) {
  const assistantTurnId = sanitizedCaptureTurnId(assistantSnapshot?.assistantTurnId);
  const assistantTurnIndex = assistantSnapshot?.assistantTurnIndex;
  if (!assistantTurnId || !Number.isInteger(assistantTurnIndex)) return [];
  return (Array.isArray(attachmentButtons) ? attachmentButtons : []).filter(
    (attachment) =>
      sanitizedCaptureTurnId(attachment?.assistantTurnId) === assistantTurnId &&
      attachment?.assistantTurnIndex === assistantTurnIndex &&
      isCapturedAssistantArtifact(attachment),
  );
}

function writeThreadCaptureIdentity(filePath, captureIdentity) {
  if (!filePath) return '';
  writePrivateFileAtomically(filePath, `${JSON.stringify(captureIdentity)}\n`);
  return filePath;
}

function writeCompletedResponseArtifacts(responseFilePath, responseText, evidence, captureIdentity = null, captureIdentityPath = '') {
  if (!responseFilePath && !captureIdentityPath) {
    return { captureMetadataPath: '', evidencePath: '', evidenceWarning: '', responseFilePath: '' };
  }
  const responseBytes = capturedResponseFileText(responseText);
  const responseSha256 = createHash('sha256').update(responseBytes, 'utf8').digest('hex');
  if (evidence && evidence.responseSha256 !== responseSha256) {
    throw new Error('Model verification digest did not match the captured response bytes');
  }

  if (captureIdentity && captureIdentity.assistantResponse?.responseSha256 !== responseSha256) {
    throw new Error('Capture metadata digest did not match the captured response bytes');
  }
  if (responseFilePath) {
    writePrivateFileAtomically(responseFilePath, responseBytes);
  }
  const captureMetadataPath = captureIdentity
    ? writeThreadCaptureIdentity(captureIdentityPath, captureIdentity)
    : '';
  let evidencePath = '';
  let evidenceWarning = '';
  if (evidence && responseFilePath) {
    evidencePath = `${responseFilePath}.model-verification.json`;
    try {
      writePrivateFileAtomically(evidencePath, `${JSON.stringify(evidence)}\n`);
    } catch (error) {
      let staleEvidenceCleanupWarning = '';
      try {
        const status = fs.lstatSync(evidencePath, { throwIfNoEntry: false });
        if (status?.isFile() || status?.isSymbolicLink()) {
          fs.rmSync(evidencePath, { force: true });
        }
      } catch (cleanupError) {
        staleEvidenceCleanupWarning = ` Stale evidence cleanup also failed: ${errorMessage(cleanupError)}`;
      }
      evidencePath = '';
      evidenceWarning = `Optional model verification was not persisted: ${errorMessage(error)}.${staleEvidenceCleanupWarning}`;
    }
  }
  return { captureMetadataPath, evidencePath, evidenceWarning, responseFilePath };
}

function removeModelVerificationEvidenceFile(responseFilePath) {
  if (!responseFilePath) return '';
  const evidencePath = `${responseFilePath}.model-verification.json`;
  fs.rmSync(evidencePath, { force: true });
  return evidencePath;
}

function selectAssistantResponseCandidate(
  state,
  baselineAssistantSignatures,
  promptCandidates,
  requireAfterLastUserMessage = false,
  requiredPrecedingUserMessageSignature = '',
  requiredPrecedingUserTurnId = '',
  requiredPrecedingUserTurnIndex = null,
) {
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
  const requiredUserTurnSignature = String(requiredPrecedingUserMessageSignature || '').trim();
  const requiredUserTurnId = String(requiredPrecedingUserTurnId || '').trim();
  const requiredUserTurnIndex = Number(requiredPrecedingUserTurnIndex);
  const hasExactUserTurnIdentity = requiredUserTurnId && Number.isInteger(requiredUserTurnIndex);
  const scopedSnapshots = hasExactUserTurnIdentity
    ? assistantSnapshots.filter(
        (snapshot) =>
          snapshot.precedingUserTurnId === requiredUserTurnId &&
          snapshot.precedingUserTurnIndex === requiredUserTurnIndex &&
          (!requiredUserTurnSignature ||
            snapshot.precedingUserMessageSignature === requiredUserTurnSignature),
      )
    : requiredUserTurnSignature
    ? assistantSnapshots.filter(
        (snapshot) => snapshot.precedingUserMessageSignature === requiredUserTurnSignature,
      )
    : requireAfterLastUserMessage
      ? assistantSnapshots.filter((snapshot) => snapshot.afterLastUserMessage === true)
      : assistantSnapshots;
  const freshSnapshots = scopedSnapshots.filter((snapshot) => !baselineSet.has(snapshot.signature));
  const ordered = requiredUserTurnSignature
    ? freshSnapshots
    : freshSnapshots.length > 0
      ? freshSnapshots
      : scopedSnapshots;
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

function nextResponseStabilityCount({ stableCount, candidateMatchesPrevious, candidateHasText, generationActive }) {
  // Only quiet polls count toward stability. Counting polls while generation is
  // active lets an interim assistant message (e.g. "I'll inspect the PR...")
  // accumulate enough stability to be captured the moment the busy indicator
  // flickers off between tool/connector phases, instead of the final reply.
  if (generationActive) {
    return 0;
  }
  if (!candidateMatchesPrevious) {
    return candidateHasText ? 1 : 0;
  }
  return stableCount + 1;
}

function shouldFinishAssistantResponseWait({
  candidate,
  expectedContentSource,
  generationActive,
  stableCount,
  stablePollsRequired,
  isDeepResearchMode: deepResearchMode,
  sawGenerationActive,
  responseMarker: requiredMarker,
}) {
  if (!candidate?.text || generationActive) {
    return false;
  }
  if (expectedContentSource && candidate.contentSource !== expectedContentSource) {
    return false;
  }

  // A completion marker is the only reliable end-of-turn signal for long
  // multi-message turns: interim status messages can be followed by minutes of
  // visually quiet tool/connector work, which no busy-indicator heuristic can
  // bridge. When a marker is required, never accept a candidate without it;
  // the timeout-partial path still returns the best snapshot at the deadline.
  if (requiredMarker && !String(candidate.text).includes(requiredMarker)) {
    return false;
  }

  const stabilitySatisfied = stableCount >= stablePollsRequired;
  if (!stabilitySatisfied) {
    return false;
  }

  if (!deepResearchMode) {
    return true;
  }

  return Boolean(sawGenerationActive);
}

function mergeResponseCaptureStates(pageState, deepResearchState, committedUserTurn = null) {
  if (!deepResearchState) {
    return pageState;
  }
  const committedAssistantAnchors = committedUserTurn
    ? (Array.isArray(pageState?.assistantSnapshots) ? pageState.assistantSnapshots : []).filter(
        (snapshot) =>
          snapshot?.precedingUserTurnId === committedUserTurn.turnId &&
          snapshot?.precedingUserTurnIndex === committedUserTurn.turnIndex &&
          snapshot?.precedingUserMessageSignature === committedUserTurn.signature,
      )
    : [];
  const committedAssistantAnchor = committedAssistantAnchors.length === 1
    ? committedAssistantAnchors[0]
    : null;
  return {
    ...pageState,
    assistantSnapshots: [
      ...(Array.isArray(pageState?.assistantSnapshots) ? pageState.assistantSnapshots : []),
      ...(Array.isArray(deepResearchState?.assistantSnapshots)
        ? deepResearchState.assistantSnapshots
            .map((snapshot) => sanitizeDeepResearchAssistantSnapshot(snapshot, committedAssistantAnchor))
            .filter(Boolean)
        : []),
    ],
    statusTexts: [
      ...(Array.isArray(pageState?.statusTexts) ? pageState.statusTexts : []),
      ...(Array.isArray(deepResearchState?.statusTexts) ? deepResearchState.statusTexts : []),
    ],
    statusBusy: Boolean(pageState?.statusBusy || deepResearchState?.statusBusy),
    stopVisible: Boolean(pageState?.stopVisible || deepResearchState?.stopVisible),
    deepResearchState,
  };
}

async function openNewTarget(desiredUrl, socketOwner) {
  const version = await fetchJson('/json/version');
  const browserWsUrl = version?.webSocketDebuggerUrl;
  if (!browserWsUrl) {
    throw new Error('Browser debugging endpoint did not expose a browser websocket URL');
  }
  const ownershipUrl = `${targetOwnershipUrlPrefix}${randomUUID()}`;
  let created = null;
  let creationError = null;
  try {
    created = await createBackgroundTarget(browserWsUrl, ownershipUrl, socketOwner);
  } catch (error) {
    if (!error?.reviewGptTargetOwnershipUncertain) throw error;
    creationError = error;
  }

  const createdTargetId = String(created?.targetId || '').trim();
  const recoveredTargetIds = new Set();
  const discoveryDeadline = Date.now() + targetOwnershipReconciliationTimeoutMs;
  let discoveryError = null;
  let lastListConfirmedNoMarker = false;
  while (Date.now() < discoveryDeadline) {
    try {
      const listed = await fetchJson(
        '/json/list',
        Math.max(1, discoveryDeadline - Date.now())
      );
      if (!Array.isArray(listed)) {
        throw new Error('Browser target list was not an array');
      }
      const markerTargets = listed.filter(
        (entry) => entry.type === 'page' && entry.url === ownershipUrl
      );
      for (const markerTarget of markerTargets) {
        const markerTargetId = String(markerTarget?.id || '').trim();
        if (markerTargetId) recoveredTargetIds.add(markerTargetId);
      }
      if (markerTargets.length > 1) {
        discoveryError = new Error('Browser exposed multiple targets for one ownership marker');
        break;
      }
      const target = createdTargetId
        ? listed.find(
          (entry) => entry.type === 'page' && entry.id === createdTargetId && entry.webSocketDebuggerUrl
        )
        : markerTargets.find((entry) => entry.webSocketDebuggerUrl);
      if (target) return target;
      lastListConfirmedNoMarker = markerTargets.length === 0;
      discoveryError = null;
    } catch (error) {
      lastListConfirmedNoMarker = false;
      discoveryError = error;
    }
    if (Date.now() < discoveryDeadline) await sleep(200);
  }

  if (createdTargetId) recoveredTargetIds.add(createdTargetId);
  let cleanupError = null;
  for (const targetId of recoveredTargetIds) {
    try {
      await closeBackgroundTarget(targetId, socketOwner);
    } catch (error) {
      cleanupError = cleanupError
        ? new Error(`${errorMessage(cleanupError)}; ${errorMessage(error)}`)
        : error;
    }
  }
  if (cleanupError) {
    throw addTargetCleanupContext(cleanupError, discoveryError || creationError);
  }
  if (creationError) {
    if (recoveredTargetIds.size > 0) {
      throw creationError.cause || creationError;
    }
    if (lastListConfirmedNoMarker && !discoveryError) throw creationError;
    throw createTargetOwnershipFailure(discoveryError || creationError);
  }
  if (discoveryError) throw discoveryError;
  throw new Error(`Created ChatGPT target did not expose a debuggable page for ${desiredUrl}`);
}

async function sendBrowserCommand(
  browserWsUrl,
  method,
  params = {},
  commandDeadline = Date.now() + browserTransportTimeoutMs,
  socketOwner,
) {
  const ws = socketOwner.create(browserWsUrl);
  const pending = new Map();
  let nextId = 0;
  const closed = new Promise((_, reject) => {
    ws.addEventListener('close', () => reject(new Error('Browser CDP socket closed unexpectedly')));
    ws.addEventListener('error', (event) => reject(event.error || new Error('Browser CDP socket error')));
  });
  void closed.catch(() => {});

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
      const commandError = new Error(message.error.message || 'Browser CDP command failed');
      commandError.reviewGptBrowserCommandResponseReceived = true;
      slot.reject(commandError);
      return;
    }
    slot.resolve(message.result || {});
  });

  try {
    await withTimeout(
      Promise.race([
        new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener(
            'error',
            (event) => reject(event.error || new Error('Browser CDP socket error')),
            { once: true }
          );
        }),
        closed,
      ]),
      Math.max(1, commandDeadline - Date.now()),
      'Timed out opening browser CDP socket'
    );
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    const payload = JSON.stringify({
      id,
      method,
      params,
    });
    let commandDeliveryStarted = false;
    try {
      if (typeof ws.readyState === 'number' && ws.readyState !== 1) {
        throw new Error('Browser CDP socket was not open for command delivery');
      }
      ws.send(payload);
      commandDeliveryStarted = true;
      return await withTimeout(
        Promise.race([response, closed]),
        Math.max(1, commandDeadline - Date.now()),
        `Timed out waiting for browser CDP command ${method}`
      );
    } catch (error) {
      if (
        commandDeliveryStarted &&
        error &&
        typeof error === 'object' &&
        !error.reviewGptBrowserCommandResponseReceived
      ) {
        error.reviewGptBrowserCommandDeliveryUncertain = true;
        error.reviewGptBrowserCommandMethod = method;
      }
      throw error;
    }
  } finally {
    try {
      socketOwner.close(ws);
    } catch {}
  }
}

function createTargetOwnershipFailure(error) {
  const failure = new Error(
    `Could not confirm whether browser target creation completed: ${errorMessage(error)}`
  );
  failure.reviewGptStage = 'target-create';
  failure.reviewGptTargetOwnershipUncertain = true;
  failure.cause = error;
  return failure;
}

async function createBackgroundTarget(browserWsUrl, ownershipUrl, socketOwner) {
  try {
    const created = await sendBrowserCommand(browserWsUrl, 'Target.createTarget', {
      url: ownershipUrl,
      background: true,
    }, Date.now() + browserTransportTimeoutMs, socketOwner);
    if (!created?.targetId) {
      throw createTargetOwnershipFailure(
        new Error('Browser acknowledged target creation without returning a target ID')
      );
    }
    return created;
  } catch (error) {
    if (error?.reviewGptTargetOwnershipUncertain) throw error;
    if (!error?.reviewGptBrowserCommandDeliveryUncertain) throw error;
    throw createTargetOwnershipFailure(error);
  }
}

function createTargetCleanupFailure(targetId, error) {
  const failure = new Error(
    `Could not confirm cleanup for browser target ${targetId}: ${errorMessage(error)}`
  );
  failure.reviewGptStage = 'target-cleanup';
  failure.reviewGptTargetCleanupFailure = true;
  failure.reviewGptTargetId = targetId;
  failure.cause = error;
  return failure;
}

function addTargetCleanupContext(cleanupError, operationError) {
  if (!operationError) return cleanupError;
  const failure = new Error(`${errorMessage(operationError)}; ${errorMessage(cleanupError)}`);
  failure.reviewGptStage = 'target-cleanup';
  failure.reviewGptTargetCleanupFailure = true;
  failure.reviewGptTargetId = cleanupError?.reviewGptTargetId;
  failure.operationCause = operationError;
  failure.cause = cleanupError;
  return failure;
}

async function closeBackgroundTarget(targetId, socketOwner) {
  const normalizedTargetId = String(targetId || '').trim();
  if (!normalizedTargetId) return;
  const cleanupDeadline = Date.now() + targetCleanupTimeoutMs;
  let closeAccepted = false;
  let lastError = null;
  while (Date.now() < cleanupDeadline) {
    if (!closeAccepted) {
      const attemptDeadline = Math.min(
        cleanupDeadline,
        Date.now() + targetCleanupAttemptTimeoutMs
      );
      try {
        const version = await fetchJson(
          '/json/version',
          Math.max(1, attemptDeadline - Date.now())
        );
        const browserWsUrl = version?.webSocketDebuggerUrl;
        if (!browserWsUrl) {
          throw new Error('Browser debugging endpoint did not expose a browser websocket URL');
        }
        const result = await sendBrowserCommand(
          browserWsUrl,
          'Target.closeTarget',
          { targetId: normalizedTargetId },
          attemptDeadline,
          socketOwner,
        );
        if (result?.success !== true) {
          throw new Error(`Browser did not accept closure of target ${normalizedTargetId}`);
        }
        closeAccepted = true;
      } catch (error) {
        lastError = error;
      }
    }

    if (Date.now() < cleanupDeadline) {
      try {
        const listed = await fetchJson(
          '/json/list',
          Math.max(
            1,
            Math.min(targetCleanupAttemptTimeoutMs, cleanupDeadline - Date.now())
          )
        );
        if (!Array.isArray(listed)) {
          throw new Error('Browser target list was not an array');
        }
        const stillPresent = listed.some(
          (entry) => String(entry?.id || '').trim() === normalizedTargetId
        );
        if (!stillPresent) return;
        lastError = new Error(
          `Browser target ${normalizedTargetId} remained present after close`
        );
      } catch (error) {
        lastError = new Error(`Target absence check failed: ${errorMessage(error)}`);
      }
    }

    if (Date.now() < cleanupDeadline) {
      await sleep(Math.min(100, cleanupDeadline - Date.now()));
    }
  }

  throw createTargetCleanupFailure(
    normalizedTargetId,
    lastError || new Error('Target absence was not confirmed')
  );
}

function installOwnedTargetSignalCleanup() {
  let cleanupStarted = false;
  const handlers = new Map();
  const exitCodes = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      const cleanup = ownedTargetSignalCleanup;
      ownedTargetSignalCleanup = null;
      void (async () => {
        if (cleanup) {
          try {
            await cleanup();
          } catch (error) {
            console.error(`Could not close the interrupted draft target: ${errorMessage(error)}`);
          }
        }
        await flushProcessOutput();
        process.exit(exitCodes[signal]);
      })();
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}

async function ensureTarget(desiredUrl, socketOwner) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await openNewTarget(desiredUrl, socketOwner);
    } catch (error) {
      if (
        error?.reviewGptTargetCleanupFailure ||
        error?.reviewGptTargetOwnershipUncertain
      ) {
        throw error;
      }
      lastError = error;
    }
    await sleep(300);
  }
  throw lastError || new Error(`Timed out creating a fresh ChatGPT target on port ${remotePort}`);
}

async function connectTargetWebSocket(desiredUrl, socketOwner) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const target = await ensureTarget(desiredUrl, socketOwner);
    let ws = null;
    try {
      ws = socketOwner.create(target.webSocketDebuggerUrl);
      await withTimeout(
        new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener(
            'error',
            (event) => reject(event.error || new Error('CDP socket error')),
            { once: true }
          );
          ws.addEventListener('close', () => reject(new Error('CDP socket closed unexpectedly')), { once: true });
        }),
        browserTransportTimeoutMs,
        'Timed out opening page CDP socket'
      );
      return { ws, target };
    } catch (error) {
      try {
        socketOwner.close(ws);
      } catch {}
      try {
        await closeBackgroundTarget(target?.id, socketOwner);
      } catch (cleanupError) {
        throw addTargetCleanupContext(cleanupError, error);
      }
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

async function ensureDraftThinkingSelected(target, evaluateDraftExpression, buildThinkingExpression) {
  const normalizedTarget = String(target || '').trim().toLowerCase();
  if (isCurrentSelectionTarget(normalizedTarget)) {
    return {
      ok: true,
      label: 'current',
      skipped: true,
    };
  }
  if (normalizedTarget === 'xhigh' || normalizedTarget === 'extended') {
    return {
      ok: false,
      reason: 'unsupported-thinking-target',
      details: {
        status: 'unsupported-thinking-target',
        message: `Thinking target ${normalizedTarget} is not a ChatGPT model or an available independent control. Use current for the Pro model.`,
      },
    };
  }
  const result = await evaluateDraftExpression(buildThinkingExpression(normalizedTarget));
  switch (result?.status) {
    case 'already-selected':
    case 'switched':
      return { ok: true, label: result?.label || normalizedTarget };
    case 'chip-not-found':
    case 'menu-not-found':
    case 'option-not-found':
      return { ok: false, reason: result.status, details: result };
    default:
      return { ok: false, reason: result?.status || 'selection-failed', details: result };
  }
}

function isRetryableSocketError(error) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('cdp socket closed unexpectedly') ||
    message.includes('cdp socket error') ||
    (message.includes('cdp socket') && message.includes('timed out')) ||
    message.includes('websocket') ||
    message.includes('target closed') ||
    message.includes('promise was collected')
  );
}

function hardRefreshDue(lastHardRefreshAt, now = Date.now()) {
  return (
    Number.isFinite(lastHardRefreshAt) &&
    Number.isFinite(now) &&
    now - lastHardRefreshAt >= HARD_REFRESH_INTERVAL_MS
  );
}

function authStatusIsUnauthenticated(authStatus) {
  return authStatus?.status === 401 || authStatus?.status === 403;
}

async function retryTransientUnauthenticatedSession({
  hardRefresh,
  onRetry,
  probeAuthenticatedSession,
}) {
  const initialAuthStatus = await probeAuthenticatedSession();
  if (!authStatusIsUnauthenticated(initialAuthStatus)) {
    return {
      authStatus: initialAuthStatus,
      hardRefreshed: false,
    };
  }

  onRetry?.(initialAuthStatus);
  await hardRefresh();
  return {
    authStatus: await probeAuthenticatedSession(),
    hardRefreshed: true,
  };
}

async function main() {
  const socketOwner = createWebSocketOwner();
  let currentStage = 'connect';
  // The parent buffers this process's output until it exits, so a stalled stage
  // used to be completely invisible: the log froze mid-run and the driver sat at
  // 0% CPU with no way to tell a hang from slow work. Stream the current stage
  // to a file the parent names up front so a stall can be read while it happens.
  const stageLogPath = process.env.REVIEW_GPT_DRAFT_STAGE_LOG || '';
  const recordStage = (note) => {
    if (!stageLogPath) return;
    try {
      appendFileSync(
        stageLogPath,
        `${new Date().toISOString()} ${currentStage}${note ? ` ${note}` : ''}\n`,
      );
    } catch {}
  };
  const stageHeartbeat = setInterval(() => recordStage('(waiting)'), 15000);
  stageHeartbeat.unref?.();
  recordStage('(start)');
  const tagStageError = (error) => {
    if (error && typeof error === 'object' && !error.reviewGptStage) {
      error.reviewGptStage = currentStage;
    }
    return error;
  };

  let initialConnection;
  try {
    initialConnection = await connectTargetWebSocket(chatgptUrl, socketOwner);
  } catch (error) {
    await flushProcessOutput();
    await socketOwner.closeAll();
    throw tagStageError(error);
  }
  let ws = initialConnection.ws;
  const { target } = initialConnection;
  const pageTargetId = String(target?.id || '');
  let captureTargetId = pageTargetId;
  let acceptedCaptureIdentity = null;
  let replacementRecoveryAttempted = false;
  let threadCaptureLibraryPromise = null;
  let ownedTargetId = pageTargetId;
  const closeOwnedTargetOnSignal = async () => {
    await closeBackgroundTarget(ownedTargetId, socketOwner);
  };
  ownedTargetSignalCleanup = closeOwnedTargetOnSignal;
  let operationError = null;
  let completedResponseCapture = null;
  let waitedAttachmentCleanupPending = false;
  let retainedIdleDraftTargetId = '';
  let acceptedSendProven = false;
  let releasePageFocusEmulation = async () => {};
  try {

  const pending = new Map();
  let nextId = 0;
  let closed;
  const bindPageSocket = (nextSocket) => {
    for (const slot of pending.values()) {
      slot.reject(new Error('CDP socket replaced during exact-target reconnect'));
    }
    pending.clear();
    ws = nextSocket;
    closed = new Promise((_, reject) => {
      nextSocket.addEventListener('close', () => reject(new Error('CDP socket closed unexpectedly')));
      nextSocket.addEventListener('error', (event) => reject(event.error || new Error('CDP socket error')));
    });
    void closed.catch(() => {});
    nextSocket.addEventListener('message', (event) => {
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
      if (!slot || slot.socket !== nextSocket) return;
      pending.delete(message.id);
      if (message.error) {
        slot.reject(new Error(message.error.message || 'CDP command failed'));
        return;
      }
      slot.resolve(message.result || {});
    });
  };
  bindPageSocket(ws);

  const cdp = async (method, params = {}) => {
    const commandSocket = ws;
    const commandClosed = closed;
    const id = ++nextId;
    const payload = JSON.stringify({ id, method, params });
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, socket: commandSocket });
    });
    commandSocket.send(payload);
    return withTimeout(
      Promise.race([response, commandClosed]),
      pageCommandTimeoutMs,
      `CDP socket command timed out: ${method}`
    );
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

  const loadThreadCaptureLibrary = async () => {
    threadCaptureLibraryPromise ||= import('../dist/chatgpt-thread-lib.mjs');
    return await threadCaptureLibraryPromise;
  };

  const connectCaptureTarget = async (captureTarget, exactChatUrl, deadline) => {
    const reconnectedSocket = socketOwner.create(captureTarget.webSocketDebuggerUrl);
    await withTimeout(
      new Promise((resolve, reject) => {
        reconnectedSocket.addEventListener('open', resolve, { once: true });
        reconnectedSocket.addEventListener(
          'error',
          (event) => reject(event.error || new Error('CDP socket error')),
          { once: true },
        );
        reconnectedSocket.addEventListener(
          'close',
          () => reject(new Error('CDP socket closed unexpectedly')),
          { once: true },
        );
      }),
      Math.max(1, Math.min(browserTransportTimeoutMs, deadline - Date.now())),
      'Timed out reconnecting to the exact accepted browser target',
    );
    bindPageSocket(reconnectedSocket);
    await cdp('Runtime.enable');
    const currentHref = await evaluate('location.href');
    if (extractConversationHref(currentHref) !== exactChatUrl) {
      throw new Error('Reconnected target no longer points at the exact accepted conversation.');
    }
    await keepPageRenderingWhileBackgrounded();
  };

  const reconnectExactAcceptedTarget = async (acceptedChatUrl, deadline) => {
    const exactChatUrl = extractConversationHref(acceptedChatUrl);
    if (!captureTargetId || !exactChatUrl) {
      throw new Error('Exact-target reconnect requires the accepted target ID and conversation URL.');
    }
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const targets = await fetchJson(
          '/json/list',
          Math.max(1, Math.min(browserTransportTimeoutMs, deadline - Date.now())),
        );
        const exactTarget = selectExactAcceptedTarget(targets, captureTargetId, exactChatUrl);
        if (exactTarget) {
          await connectCaptureTarget(exactTarget, exactChatUrl, deadline);
          return;
        }

        if (replacementRecoveryAttempted) {
          throw new Error(
            'The exact accepted browser target disappeared after one replacement target was already attempted.',
          );
        }
        if (!acceptedCaptureIdentity) {
          throw new Error('Replacement target recovery requires the accepted committed-turn identity.');
        }
        replacementRecoveryAttempted = true;

        const threadCaptureLibrary = await loadThreadCaptureLibrary();
        let acquiredLease = null;
        const recoveryPromise = threadCaptureLibrary.captureThreadTargetSnapshot(
          `http://127.0.0.1:${remotePort}`,
          exactChatUrl,
          acceptedCaptureIdentity,
          {
            onTargetLease: (lease) => {
              acquiredLease = lease;
            },
          },
        );
        const recovery = await withTimeout(
          recoveryPromise,
          Math.max(1, deadline - Date.now()),
          'Timed out validating one replacement target before the original response deadline',
          () => {
            if (acquiredLease?.rehydrated && acquiredLease.target?.id) {
              void closeBackgroundTarget(acquiredLease.target.id, socketOwner).catch(() => {});
              return;
            }
            void recoveryPromise.then(async (lateRecovery) => {
              if (lateRecovery?.targetLease?.rehydrated && lateRecovery.targetLease.target?.id) {
                await closeBackgroundTarget(lateRecovery.targetLease.target.id, socketOwner);
              }
            }).catch(() => {});
          },
        );
        const targetLease = recovery.targetLease;
        if (!targetLease.rehydrated) {
          replacementRecoveryAttempted = false;
          await connectCaptureTarget(targetLease.target, exactChatUrl, deadline);
          return;
        }

        const replacementTargetId = String(targetLease.target.id || '').trim();
        const replacementCaptureIdentity = {
          ...acceptedCaptureIdentity,
          targetId: replacementTargetId,
        };
        try {
          if (captureMetadataFile) {
            writeThreadCaptureIdentity(captureMetadataFile, replacementCaptureIdentity);
          }
        } catch (error) {
          await closeBackgroundTarget(replacementTargetId, socketOwner);
          throw error;
        }
        acceptedCaptureIdentity = replacementCaptureIdentity;
        captureTargetId = replacementTargetId;
        ownedTargetId = replacementTargetId;
        console.log('ReviewGPT rebound wait capture to one validated replacement target.');
        await connectCaptureTarget(targetLease.target, exactChatUrl, deadline);
        return;
      } catch (error) {
        lastError = error;
        if (replacementRecoveryAttempted) {
          throw error;
        }
      }
      if (Date.now() < deadline) {
        await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      }
    }
    throw lastError || new Error('Could not reconnect to the exact accepted target before the original response deadline.');
  };

  const buildClickDispatcher = (functionName = 'dispatchClickSequence') => {
    const clickTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const typesLiteral = JSON.stringify(clickTypes);
    return `function ${functionName}(target){
      if(!target || typeof target.dispatchEvent !== 'function') return false;
      const ownerView =
        (target.ownerDocument && target.ownerDocument.defaultView) ||
        (typeof window === 'object' ? window : null);
      if (!ownerView) return false;
      const rect = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
      const clientX = rect ? rect.left + rect.width / 2 : 0;
      const clientY = rect ? rect.top + rect.height / 2 : 0;
      const types = ${typesLiteral};
      for (const type of types) {
        const common = { bubbles: true, cancelable: true, view: ownerView, clientX, clientY };
        let event;
        if (type.startsWith('pointer') && 'PointerEvent' in ownerView) {
          event = new ownerView.PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' });
        } else {
          event = new ownerView.MouseEvent(type, common);
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
  const activateCurrentPageForNativeInput = async () => {
    try {
      await cdp('Page.bringToFront');
    } catch {}
    if (pageTargetId) {
      try {
        await cdp('Target.activateTarget', { targetId: pageTargetId });
      } catch {}
    }
  };
  const keepPageRenderingWhileBackgrounded = async () => {
    // Browsers throttle background-tab rendering, which can freeze the polled
    // DOM mid-stream (observed frozen for 40+ minutes). Emulate focus and pin
    // the page lifecycle to active so streamed content keeps committing to the
    // DOM we read, without ever stealing OS focus from the user.
    try {
      await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch {}
    try {
      await cdp('Page.setWebLifecycleState', { state: 'active' });
    } catch {}
  };
  releasePageFocusEmulation = async () => {
    // Draft-only and send-without-wait runs intentionally retain their owned
    // target. Give those pages back their real browser focus before detaching
    // so they can be backgrounded normally; a later capture re-enables focus
    // emulation while it actively polls the response.
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: false });
  };
  const clickNativePoint = async (point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return false;
    }
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
    });
    await sleep(50);
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    return true;
  };
  const promptMatchCandidates = buildPromptMatchCandidates(draftPrompt);
  const expectedAttachmentNames = buildExpectedAttachmentNames(filesToAttach);
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
      const scoreCandidate = (node) => {
        if (!node) return Number.NEGATIVE_INFINITY;
        const id = normalize(node.getAttribute?.('id'));
        const accept = String(node.getAttribute?.('accept') || '')
          .split(',')
          .map((value) => normalize(value))
          .filter(Boolean);
        const imageOnlyAccept =
          accept.length > 0 && accept.every((value) => value === 'image *' || value.startsWith('image/'));
        let score = 0;
        if (id === 'upload files') score += 1000;
        if (id === 'upload photos' || id === 'upload camera') score -= 1000;
        if (imageOnlyAccept) score -= 500;
        if (accept.length === 0) score += 200;
        if (node.multiple) score += 25;
        if (composerRoot && composerRoot.contains(node)) score += 50;
        if (visible(node)) score += 10;
        return score;
      };
      const candidates = dedupeNodes(inputCandidates)
        .map((node) => ({ node, score: scoreCandidate(node) }))
        .sort((left, right) => right.score - left.score);
      return candidates[0]?.node || null;
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
        const ariaLabel = normalize(node.getAttribute?.('aria-label'));
        // The attached-file tile renders its filename only in accessible names
        // on icon-only controls, so aria-label carries the evidence that a
        // named upload landed.
        const text = normalize([ariaLabel, node.innerText || node.textContent || ''].filter(Boolean).join(' '));
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

    if (base.includes('5.6') || base.includes('5-6') || base.includes('56')) {
      push('5.6', labelTokens);
      push('gpt-5.6', labelTokens);
      push('gpt5.6', labelTokens);
      push('gpt-5-6', labelTokens);
      push('gpt5-6', labelTokens);
      push('gpt56', labelTokens);
      push('chatgpt 5.6', labelTokens);
      testIdTokens.add('gpt-5-6');
      testIdTokens.add('gpt5-6');
      testIdTokens.add('gpt56');
      if (base.includes('sol')) {
        push('pro', labelTokens);
        testIdTokens.add('model-switcher-pro');
      }
    }

    if (base.includes('5.5') || base.includes('5-5') || base.includes('55')) {
      push('5.5', labelTokens);
      push('gpt-5.5', labelTokens);
      push('gpt5.5', labelTokens);
      push('gpt-5-5', labelTokens);
      push('gpt5-5', labelTokens);
      push('gpt55', labelTokens);
      push('chatgpt 5.5', labelTokens);
      if (base.includes('thinking')) {
        push('thinking', labelTokens);
        testIdTokens.add('model-switcher-gpt-5-5-thinking');
        testIdTokens.add('gpt-5-5-thinking');
        testIdTokens.add('gpt-5.5-thinking');
      }
      if (!base.includes('thinking') && !base.includes('pro')) {
        push('instant', labelTokens);
        testIdTokens.add('model-switcher-gpt-5-5');
        testIdTokens.add('model-switcher-gpt-5-3');
      }
      testIdTokens.add('gpt-5-5');
      testIdTokens.add('gpt-5-3');
      testIdTokens.add('gpt5-5');
      testIdTokens.add('gpt5-3');
      testIdTokens.add('gpt55');
      testIdTokens.add('gpt53');
    }

    if (base.includes('5.4') || base.includes('5-4') || base.includes('54')) {
      push('5.4', labelTokens);
      push('gpt-5.4', labelTokens);
      push('gpt5.4', labelTokens);
      push('gpt-5-4', labelTokens);
      push('gpt5-4', labelTokens);
      push('gpt54', labelTokens);
      push('chatgpt 5.4', labelTokens);
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
      if (base.includes('5.5') || base.includes('5-5') || base.includes('55')) {
        testIdTokens.add('gpt-5.5-pro');
        testIdTokens.add('gpt-5-5-pro');
        testIdTokens.add('gpt55pro');
      }
      if (base.includes('5.4') || base.includes('5-4') || base.includes('54')) {
        testIdTokens.add('gpt-5.4-pro');
        testIdTokens.add('gpt-5-4-pro');
        testIdTokens.add('gpt54pro');
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

  // ChatGPT's model picker no longer opens from synthesized pointer events: the
  // trigger accepts them, renders its menu container, and leaves the menu empty
  // because the options only mount for trusted input. This probe reports the
  // next point to press so the caller can drive the picker with real CDP mouse
  // input, mirroring how app-connector selection already works.
  const buildModelSelectionProbeExpression = (targetModel) => {
    const primaryLabelLiteral = JSON.stringify(targetModel);
    const buttonSelectorsLiteral = JSON.stringify(MODEL_BUTTON_SELECTORS);
    const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
    const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
    return `(() => {
      const normalizeModelPickerText = ${normalizeModelPickerText.toString()};
      const modelPickerTextHasWord = ${modelPickerTextHasWord.toString()};
      const modelPickerTargetAllowsExplicitSol = ${modelPickerTargetAllowsExplicitSol.toString()};
      const modelPickerExplicitVersions = ${modelPickerExplicitVersions.toString()};
      const modelPickerHasMatchingExplicitSol = ${modelPickerHasMatchingExplicitSol.toString()};
      const modelPickerOptionMatchesTarget = ${modelPickerOptionMatchesTarget.toString()};
      const modelPickerLabelMatchesTarget = ${modelPickerLabelMatchesTarget.toString()};
      const modelPickerOptionIsFinalTarget = ${modelPickerOptionIsFinalTarget.toString()};
      const modelPickerOptionCanTraverseTarget = ${modelPickerOptionCanTraverseTarget.toString()};
      const BUTTON_SELECTORS = ${buttonSelectorsLiteral};
      const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
      const MENU_ITEM_SELECTOR = ${menuItemLiteral};
      const PRIMARY_LABEL = ${primaryLabelLiteral};
      const normalizedTarget = normalizeModelPickerText(PRIMARY_LABEL);
      const desiredVersion = normalizedTarget.includes('5 6')
        ? '5-6'
        : normalizedTarget.includes('5 5')
          ? '5-5'
          : normalizedTarget.includes('5 4')
            ? '5-4'
            : normalizedTarget.includes('5 2')
              ? '5-2'
              : normalizedTarget.includes('5 1')
                ? '5-1'
                : normalizedTarget.includes('5 0')
                  ? '5-0'
                  : null;
      const wantsSol = modelPickerTextHasWord(normalizedTarget, 'sol');
      const wantsPro = !wantsSol && (normalizedTarget === 'pro' || normalizedTarget.includes(' pro') || normalizedTarget.endsWith(' pro'));
      const wantsThinking = normalizedTarget.includes('thinking');
      const wantsInstant = normalizedTarget.includes('instant') || (desiredVersion === '5-5' && !wantsPro && !wantsThinking);
      const target = { desiredVersion, wantsPro, wantsSol, wantsInstant, wantsThinking };

      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const pointFor = (node) => {
        if (!(node instanceof HTMLElement) || !visible(node)) return null;
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      };
      const labelFor = (node) => [
        node?.getAttribute?.('aria-label') || '',
        node?.textContent || '',
      ].join(' ').trim();
      const testIdFor = (node) => node?.getAttribute?.('data-testid') || '';
      const menuRoots = () =>
        Array.from(document.querySelectorAll(MENU_CONTAINER_SELECTOR)).filter(visible);
      const findButton = () => {
        for (const selector of BUTTON_SELECTORS) {
          const node = Array.from(document.querySelectorAll(selector)).find(visible);
          if (node) return node;
        }
        return null;
      };

      const button = findButton();
      const roots = menuRoots();
      if (roots.length > 0) {
        const items = roots.flatMap((root) =>
          Array.from(root.querySelectorAll(MENU_ITEM_SELECTOR)).filter(visible),
        );
        if (items.length > 0) {
          const finalItem = items.find((item) =>
            modelPickerOptionMatchesTarget(labelFor(item), testIdFor(item), target) &&
            modelPickerOptionIsFinalTarget(labelFor(item), testIdFor(item), target, false),
          );
          if (finalItem) {
            return { status: 'click-option', label: labelFor(finalItem) || PRIMARY_LABEL, point: pointFor(finalItem) };
          }
          const traverseItem = items.find((item) =>
            modelPickerOptionCanTraverseTarget(labelFor(item), testIdFor(item), target, true),
          );
          if (traverseItem) {
            return { status: 'click-submenu', label: labelFor(traverseItem), point: pointFor(traverseItem) };
          }
          return {
            status: 'option-not-found',
            availableOptions: items.map((item) => labelFor(item).slice(0, 40)).slice(0, 20),
          };
        }
      }

      if (!button) {
        return { status: 'button-missing' };
      }
      if (modelPickerLabelMatchesTarget(labelFor(button), target)) {
        return { status: 'already-selected', label: labelFor(button) };
      }
      return { status: 'click-button', label: labelFor(button), point: pointFor(button) };
    })()`;
  };

  const buildModelSelectionExpression = (targetModel, strategy = 'select') => {
    const matchers = buildModelMatchersLiteral(targetModel);
    const labelLiteral = JSON.stringify(matchers.labelTokens);
    const idLiteral = JSON.stringify(matchers.testIdTokens);
    const primaryLabelLiteral = JSON.stringify(targetModel);
    const strategyLiteral = JSON.stringify(strategy);
    const buttonSelectorsLiteral = JSON.stringify(MODEL_BUTTON_SELECTORS);
    const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
    const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
    const normalizeModelPickerTextLiteral = normalizeModelPickerText.toString();
    const modelPickerTextHasWordLiteral = modelPickerTextHasWord.toString();
    const modelPickerTargetAllowsExplicitSolLiteral = modelPickerTargetAllowsExplicitSol.toString();
    const modelPickerExplicitVersionsLiteral = modelPickerExplicitVersions.toString();
    const modelPickerHasMatchingExplicitSolLiteral = modelPickerHasMatchingExplicitSol.toString();
    const modelPickerOptionMatchesTargetLiteral = modelPickerOptionMatchesTarget.toString();
    const modelPickerLabelMatchesTargetLiteral = modelPickerLabelMatchesTarget.toString();
    const modelPickerOptionIsFinalTargetLiteral = modelPickerOptionIsFinalTarget.toString();
    const modelPickerOptionCanTraverseTargetLiteral = modelPickerOptionCanTraverseTarget.toString();
    const modelPickerSummarySelectionProofLiteral = modelPickerSummarySelectionProof.toString();
    const modelPickerOptionElementCanParticipateLiteral = modelPickerOptionElementCanParticipate.toString();
    const modelPickerOptionSelectionProofLiteral = modelPickerOptionSelectionProof.toString();
    const modelPickerControlLabelCanProveTargetLiteral = modelPickerControlLabelCanProveTarget.toString();
    const modelPickerControlSelectionProofLiteral = modelPickerControlSelectionProof.toString();
    const modelPickerSelectionStateMatchesLiteral = modelPickerSelectionStateMatches.toString();
    const modelPickerUnavailableReasonLiteral = modelPickerUnavailableReason.toString();

    return `(() => {
      ${buildClickDispatcher()}
      const normalizeModelPickerText = ${normalizeModelPickerTextLiteral};
      const modelPickerTextHasWord = ${modelPickerTextHasWordLiteral};
      const modelPickerTargetAllowsExplicitSol = ${modelPickerTargetAllowsExplicitSolLiteral};
      const modelPickerExplicitVersions = ${modelPickerExplicitVersionsLiteral};
      const modelPickerHasMatchingExplicitSol = ${modelPickerHasMatchingExplicitSolLiteral};
      const modelPickerOptionMatchesTarget = ${modelPickerOptionMatchesTargetLiteral};
      const modelPickerLabelMatchesTarget = ${modelPickerLabelMatchesTargetLiteral};
      const modelPickerOptionIsFinalTarget = ${modelPickerOptionIsFinalTargetLiteral};
      const modelPickerOptionCanTraverseTarget = ${modelPickerOptionCanTraverseTargetLiteral};
      const modelPickerSummarySelectionProof = ${modelPickerSummarySelectionProofLiteral};
      const modelPickerOptionElementCanParticipate = ${modelPickerOptionElementCanParticipateLiteral};
      const modelPickerSelectionStateMatches = ${modelPickerSelectionStateMatchesLiteral};
      const modelPickerOptionSelectionProof = ${modelPickerOptionSelectionProofLiteral};
      const modelPickerControlLabelCanProveTarget = ${modelPickerControlLabelCanProveTargetLiteral};
      const modelPickerControlSelectionProof = ${modelPickerControlSelectionProofLiteral};
      const modelPickerUnavailableReason = ${modelPickerUnavailableReasonLiteral};
      const BUTTON_SELECTORS = ${buttonSelectorsLiteral};
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
      const desiredVersion = normalizedTarget.includes('5 6')
        ? '5-6'
        : normalizedTarget.includes('5 5')
          ? '5-5'
          : normalizedTarget.includes('5 4')
            ? '5-4'
            : normalizedTarget.includes('5 2')
              ? '5-2'
              : normalizedTarget.includes('5 1')
                ? '5-1'
                : normalizedTarget.includes('5 0')
                  ? '5-0'
                  : null;
      const wantsSol = modelPickerTextHasWord(normalizedTarget, 'sol');
      const wantsPro = !wantsSol && (normalizedTarget === 'pro' || normalizedTarget.includes(' pro') || normalizedTarget.endsWith(' pro'));
      const wantsThinking = normalizedTarget.includes('thinking');
      const wantsInstant = normalizedTarget.includes('instant') || (desiredVersion === '5-5' && !wantsPro && !wantsThinking);
      const targetDescriptor = {
        desiredVersion,
        wantsPro,
        wantsSol,
        wantsInstant,
        wantsThinking,
      };

      const visible = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }
        for (let current = node; current instanceof HTMLElement; current = current.parentElement) {
          const style = window.getComputedStyle(current);
          if (
            current.hasAttribute('inert') ||
            current.inert === true ||
            String(current.getAttribute('aria-hidden') || '').toLowerCase() === 'true' ||
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number.parseFloat(style.opacity || '1') <= 0 ||
            (current === node && style.pointerEvents === 'none')
          ) {
            return false;
          }
        }
        return true;
      };
      const modelButtonLabel = (node) => (node?.getAttribute?.('aria-label') ?? node?.textContent ?? '').trim();
      const labelLooksLikeModelPicker = (label) => {
        const normalizedLabel = normalizeText(label);
        if (!normalizedLabel) return false;
        return (
          normalizedLabel.includes('chatgpt') ||
          normalizedLabel.includes('model') ||
          normalizedLabel.includes('gpt') ||
          normalizedLabel.includes('instant') ||
          normalizedLabel.includes('thinking') ||
          modelPickerTextHasWord(normalizedLabel, 'pro') ||
          normalizedLabel.includes('extended') ||
          normalizedLabel.includes('standard') ||
          normalizedLabel === 'advanced'
        );
      };
      const findModelButton = () => {
        let fallback = null;
        for (const selector of BUTTON_SELECTORS) {
          const candidates = Array.from(document.querySelectorAll(selector)).filter((node) => node instanceof HTMLElement);
          const visibleCandidates = candidates.filter(visible);
          const match = visibleCandidates.find((node) => labelLooksLikeModelPicker(modelButtonLabel(node)));
          if (match) {
            return match;
          }
          if (!fallback && visibleCandidates.length === 1) {
            fallback = visibleCandidates[0];
          }
        }
        return fallback;
      };
      let button = findModelButton();
      const refreshButton = () => {
        if (!(button instanceof HTMLElement) || !button.isConnected || !visible(button)) {
          button = findModelButton();
        }
        return button;
      };
      const getButtonLabel = () => modelButtonLabel(refreshButton());
      if (MODEL_STRATEGY === 'current') {
        const currentButton = refreshButton();
        if (!currentButton) {
          return { status: 'button-missing' };
        }
        return { status: 'already-selected', label: getButtonLabel() };
      }
      const getComposerChipLabel = () => {
        const chipSelectors = BUTTON_SELECTORS.filter((selector) => !selector.includes('model-switcher-dropdown-button'));
        for (const selector of chipSelectors) {
          const buttons = Array.from(document.querySelectorAll(selector));
          for (const candidate of buttons) {
            if (!visible(candidate)) continue;
            const label = modelButtonLabel(candidate);
            const normalizedLabel = normalizeText(label);
            if (!normalizedLabel) continue;
            if (
              labelLooksLikeModelPicker(label)
            ) {
              return label;
            }
          }
        }
        return '';
      };
      const selectionMatchesTarget = () => {
        const control = findMatchingSelectionControl();
        if (!control) return false;
        return modelPickerControlSelectionProof(
          {
            ariaDisabled: control.getAttribute('aria-disabled'),
            dataDisabled: control.hasAttribute('data-disabled'),
            dataState: control.getAttribute('data-state'),
            disabled: control.hasAttribute('disabled'),
            inert: control.hasAttribute('inert'),
            label: modelButtonLabel(control),
            unavailable: Boolean(selectionControlUnavailableDetails(control)),
            visible: visible(control),
          },
          targetDescriptor
        );
      };
      const currentSelectionLabel = () => getComposerChipLabel() || getButtonLabel();
      const collectFallbackOptionNodes = () =>
        Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]'));
      const collectOptionNodes = () => {
        const menus = Array.from(document.querySelectorAll(${menuContainerLiteral}));
        const menuOptions = menus.flatMap((menu) => Array.from(menu.querySelectorAll(${menuItemLiteral})));
        return Array.from(new Set([...menuOptions, ...collectFallbackOptionNodes()])).filter((node) =>
          modelPickerOptionElementCanParticipate({
            containsSlider: Boolean(node.querySelector?.('[role="slider"], input[type="range"]')),
            inputType: node.getAttribute?.('type'),
            insideSlider: Boolean(node.closest?.('[role="slider"], input[type="range"]')),
            role: node.getAttribute?.('role'),
          })
        );
      };

      let lastPointerClick = 0;
      const pointerClick = () => {
        const currentButton = refreshButton();
        if (currentButton && dispatchClickSequence(currentButton)) {
          lastPointerClick = performance.now();
        }
      };
      const activateOption = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const target =
          node.closest('button, [role="menuitem"], [role="menuitemradio"]') ??
          node;
        if (!(target instanceof HTMLElement)) {
          return false;
        }
        target.scrollIntoView({ block: 'center' });
        const dispatched = dispatchClickSequence(target);
        if (!dispatched && typeof target.click === 'function') {
          target.click();
          return true;
        }
        return dispatched;
      };

      const optionActivationTarget = (node) => {
        if (!(node instanceof HTMLElement)) {
          return null;
        }
        const target =
          node.closest('button, [role="menuitem"], [role="menuitemradio"]') ??
          node;
        return target instanceof HTMLElement ? target : null;
      };
      const hoverOption = (node) => {
        const target = optionActivationTarget(node);
        if (!(target instanceof HTMLElement)) {
          return false;
        }
        const rect = target.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        const ownerView =
          (target.ownerDocument && target.ownerDocument.defaultView) ||
          (typeof window === 'object' ? window : null);
        if (!ownerView) return false;
        for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove']) {
          const common = { bubbles: true, cancelable: true, view: ownerView, clientX, clientY };
          let event;
          if (type.startsWith('pointer') && 'PointerEvent' in ownerView) {
            event = new ownerView.PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' });
          } else {
            event = new ownerView.MouseEvent(type, common);
          }
          target.dispatchEvent(event);
        }
        return true;
      };
      const collectDescribedByText = (node) => {
        const ids = String(node?.getAttribute?.('aria-describedby') || '')
          .split(/\\s+/)
          .map((id) => id.trim())
          .filter(Boolean);
        return ids
          .map((id) => document.getElementById(id)?.textContent || '')
          .filter(Boolean)
          .join(' ');
      };
      const unavailableDetailsFromText = (text, source) => {
        const reason = modelPickerUnavailableReason(text);
        return reason ? { reason, source } : null;
      };
      const optionUnavailableDetails = (node, source = 'option') => {
        const target = optionActivationTarget(node);
        if (!target) {
          return null;
        }
        const textValues = [
          target.textContent,
          target.getAttribute('aria-label'),
          target.getAttribute('title'),
          target.getAttribute('data-tooltip'),
          target.getAttribute('data-state'),
          collectDescribedByText(target),
        ];
        for (const value of textValues) {
          const details = unavailableDetailsFromText(value, source);
          if (details) {
            return details;
          }
        }
        const disabled =
          target.hasAttribute('disabled') ||
          target.getAttribute('aria-disabled') === 'true' ||
          target.hasAttribute('data-disabled') ||
          target.getAttribute('data-state') === 'disabled' ||
          target.hasAttribute('inert');
        return disabled
          ? { reason: 'Requested model option is disabled in ChatGPT.', source: source + '-disabled' }
          : null;
      };
      const collectVisibleUnavailableMessages = () => {
        const selectors = [
          '[role="tooltip"]',
          '[role="alert"]',
          '[aria-live]',
          '[data-testid*="toast"]',
          '[data-testid*="snackbar"]',
          '[data-sonner-toast]',
          '[data-radix-popper-content-wrapper]',
        ];
        const nodes = Array.from(document.querySelectorAll(selectors.join(','))).filter(visible);
        const messages = [];
        for (const node of nodes) {
          const details = unavailableDetailsFromText(node.textContent, 'page-message');
          if (details && !messages.some((message) => message.reason === details.reason)) {
            messages.push(details);
          }
        }
        return messages;
      };
      const findMatchingSelectionControl = () => {
        const currentButton = refreshButton();
        if (currentButton && modelPickerControlLabelCanProveTarget(modelButtonLabel(currentButton), targetDescriptor)) {
          return currentButton;
        }
        for (const selector of BUTTON_SELECTORS) {
          for (const candidate of document.querySelectorAll(selector)) {
            if (
              candidate !== currentButton &&
              visible(candidate) &&
              modelPickerControlLabelCanProveTarget(modelButtonLabel(candidate), targetDescriptor)
            ) {
              return candidate;
            }
          }
        }
        return null;
      };
      const selectionControlUnavailableDetails = (control) =>
        optionUnavailableDetails(control, 'model-control') || collectVisibleUnavailableMessages()[0] || null;

      const initialSelectionControl = findMatchingSelectionControl();
      if (initialSelectionControl) {
        const unavailable = selectionControlUnavailableDetails(initialSelectionControl);
        if (unavailable) {
          return {
            status: 'model-unavailable',
            label: modelButtonLabel(initialSelectionControl) || PRIMARY_LABEL,
            details: unavailable,
          };
        }
        return {
          status: 'already-selected',
          label: modelButtonLabel(initialSelectionControl) || currentSelectionLabel(),
        };
      }
      const getOptionLabel = (node) => node?.textContent?.trim() ?? '';
      const optionIsSelected = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        return modelPickerSelectionStateMatches({
          ariaChecked: node.getAttribute('aria-checked'),
          ariaSelected: node.getAttribute('aria-selected'),
          ariaCurrent: node.getAttribute('aria-current'),
          dataSelected: node.getAttribute('data-selected'),
          dataState: node.getAttribute('data-state'),
          hasCheckIcon: Boolean(
            node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]')
          ),
        });
      };
      const optionOpensSubmenu = (node, testid = '') =>
        node?.getAttribute?.('aria-haspopup') === 'menu' ||
        Boolean(node?.querySelector?.('[aria-haspopup="menu"]')) ||
        String(testid || '').toLowerCase().includes('submenu');

      const scoreOption = (normalizedText, testid) => {
        if (!normalizedText && !testid) {
          return 0;
        }
        let score = 0;
        const normalizedTestId = (testid ?? '').toLowerCase();
        if (!modelPickerOptionMatchesTarget(normalizedText, normalizedTestId, targetDescriptor)) {
          return 0;
        }
        if (normalizedTestId) {
          if (desiredVersion) {
            const has56 =
              normalizedTestId.includes('5-6') ||
              normalizedTestId.includes('5.6') ||
              normalizedTestId.includes('gpt-5-6') ||
              normalizedTestId.includes('gpt-5.6') ||
              normalizedTestId.includes('gpt56');
            const has55 =
              normalizedTestId.includes('5-5') ||
              normalizedTestId.includes('5.5') ||
              normalizedTestId.includes('gpt-5-5') ||
              normalizedTestId.includes('gpt-5.5') ||
              normalizedTestId.includes('gpt55');
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
              normalizedTestId.includes('gpt54');
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
            const candidateVersion = has56 ? '5-6' : has55 ? '5-5' : has54 ? '5-4' : has52 ? '5-2' : has51 ? '5-1' : has50 ? '5-0' : null;
            const genericTierAlias =
              !wantsPro &&
              ((wantsThinking && modelPickerTextHasWord(normalizedText, 'thinking')) ||
                (wantsInstant && modelPickerTextHasWord(normalizedText, 'instant')));
            if (candidateVersion && candidateVersion !== desiredVersion && !genericTierAlias) {
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
        if (desiredVersion === '5-6' && wantsSol && labelMatchesTarget) {
          score += 480;
        }
        if ((desiredVersion === '5-5' || desiredVersion === '5-4') && wantsPro && labelMatchesTarget && modelPickerTextHasWord(normalizedText, 'pro')) {
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
        const options = collectOptionNodes();
        for (const option of options) {
          if (!visible(option)) {
            continue;
          }
          const text = option.textContent ?? '';
          const normalizedText = normalizeText(text);
          const testid = option.getAttribute('data-testid') ?? '';
          if (
            !modelPickerOptionIsFinalTarget(
              normalizedText,
              testid,
              targetDescriptor,
              optionOpensSubmenu(option, testid)
            )
          ) {
            continue;
          }
          const score = scoreOption(normalizedText, testid);
          if (score <= 0) {
            continue;
          }
          const label = getOptionLabel(option);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { node: option, label, score, testid, normalizedText };
          }
        }
        return bestMatch;
      };

      const findBestTraversalOption = () => {
        let bestMatch = null;
        const options = collectOptionNodes();
        for (const option of options) {
          if (!visible(option)) {
            continue;
          }
          const text = option.textContent ?? '';
          const normalizedText = normalizeText(text);
          const testid = option.getAttribute('data-testid') ?? '';
          const opensSubmenu = optionOpensSubmenu(option, testid);
          if (
            option.getAttribute('aria-expanded') === 'true' ||
            !modelPickerOptionCanTraverseTarget(
              normalizedText,
              testid,
              targetDescriptor,
              opensSubmenu
            )
          ) {
            continue;
          }
          const targetSpecific = modelPickerOptionMatchesTarget(
            normalizedText,
            testid,
            targetDescriptor
          );
          const isModelSummary =
            normalizedText === 'model' || normalizedText.startsWith('model ');
          const score = (targetSpecific ? 1000 : 0) + (isModelSummary ? 200 : 0);
          const label = getOptionLabel(option);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { node: option, label, score, testid };
          }
        }
        return bestMatch;
      };

      const findSelectedTargetOption = () => {
        const options = collectOptionNodes();
        for (const option of options) {
          if (!visible(option)) {
            continue;
          }
          const normalizedText = normalizeText(option.textContent ?? '');
          const testid = option.getAttribute('data-testid') ?? '';
          const opensSubmenu = optionOpensSubmenu(option, testid);
          const score = scoreOption(normalizedText, testid);
          if (score <= 0) {
            continue;
          }
          const unavailable = optionUnavailableDetails(option);
          const proof = modelPickerOptionSelectionProof(
            {
              label: getOptionLabel(option),
              opensSubmenu,
              selected: optionIsSelected(option),
              testId: testid,
              unavailable: Boolean(unavailable),
              visible: true,
            },
            targetDescriptor
          );
          if (proof) {
            return {
              node: option,
              label: getOptionLabel(option),
            };
          }
        }
        return null;
      };

      const PENDING_PROMISE_KEY = '__reviewGptDraftModelSelectionPromise';
      let pendingPromise;
      const clearPendingPromise = () => {
        try {
          if (window[PENDING_PROMISE_KEY] === pendingPromise) {
            delete window[PENDING_PROMISE_KEY];
          }
        } catch {}
      };

      pendingPromise = new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearPendingPromise();
          resolve(value);
        };
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
          const nodes = collectOptionNodes();
          const labels = nodes
            .map((node) => (node?.textContent ?? '').trim())
            .filter(Boolean)
            .filter((label, index, arr) => arr.indexOf(label) === index);
          return labels.slice(0, 12);
        };
        const ensureMenuOpen = () => {
          const currentButton = refreshButton();
          const menuOpen =
            currentButton?.getAttribute?.('aria-expanded') === 'true' ||
            Array.from(document.querySelectorAll('[role="menu"], [data-radix-collection-root]')).some(visible);
          if (currentButton && !menuOpen && performance.now() - lastPointerClick > REOPEN_INTERVAL_MS) {
            pointerClick();
          }
        };

        pointerClick();
        const openDelay = () => new Promise((r) => setTimeout(r, INITIAL_WAIT_MS));
        const scheduleAttempt = (delay) => {
          setTimeout(() => {
            attempt().catch((error) => {
              finish({
                status: 'selection-error',
                details: { message: String(error?.message || error || 'unknown') },
              });
            });
          }, delay);
        };
        setTimeout(() => {
          finish({
            status: 'selection-timeout',
            hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
          });
        }, MAX_WAIT_MS + 500);
        let initialized = false;
        const attempt = async () => {
          if (!initialized) {
            initialized = true;
            await openDelay();
          }
          if (!refreshButton()) {
            if (performance.now() - start > MAX_WAIT_MS) {
              finish({
                status: 'button-missing',
                hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
              });
              return;
            }
            scheduleAttempt(REOPEN_INTERVAL_MS / 2);
            return;
          }
          ensureMenuOpen();
          const matchingSelectionControl = findMatchingSelectionControl();
          if (matchingSelectionControl) {
            const unavailable = selectionControlUnavailableDetails(matchingSelectionControl);
            if (unavailable) {
              finish({
                status: 'model-unavailable',
                label: modelButtonLabel(matchingSelectionControl) || PRIMARY_LABEL,
                details: unavailable,
              });
              return;
            }
            finish({
              status: 'already-selected',
              label: modelButtonLabel(matchingSelectionControl) || currentSelectionLabel() || PRIMARY_LABEL,
            });
            return;
          }
          const selectedTarget = findSelectedTargetOption();
          if (selectedTarget) {
            finish({
              status: 'already-selected',
              label: selectedTarget.label || currentSelectionLabel() || PRIMARY_LABEL,
            });
            return;
          }
          const match = findBestOption();
          if (match) {
            const unavailableSelected = optionUnavailableDetails(match.node);
            const selectedProof = modelPickerOptionSelectionProof(
              {
                label: match.label,
                opensSubmenu: optionOpensSubmenu(match.node, match.testid),
                selected: optionIsSelected(match.node),
                testId: match.testid,
                unavailable: Boolean(unavailableSelected),
                visible: visible(match.node),
              },
              targetDescriptor
            );
            if (unavailableSelected && optionIsSelected(match.node)) {
              finish({
                status: 'model-unavailable',
                label: match.label || PRIMARY_LABEL,
                details: unavailableSelected,
              });
              return;
            }
            if (selectedProof) {
              finish({
                status: 'already-selected',
                label: match.label || currentSelectionLabel(),
              });
              return;
            }
            hoverOption(match.node);
            await new Promise((resolve) => setTimeout(resolve, 80));
            const unavailableBeforeClick = optionUnavailableDetails(match.node) || collectVisibleUnavailableMessages()[0] || null;
            if (unavailableBeforeClick) {
              finish({
                status: 'model-unavailable',
                label: match.label || PRIMARY_LABEL,
                details: unavailableBeforeClick,
              });
              return;
            }
            activateOption(match.node);
            await new Promise((resolve) => setTimeout(resolve, Math.max(120, INITIAL_WAIT_MS)));
            const unavailableAfterClick = optionUnavailableDetails(match.node) || collectVisibleUnavailableMessages()[0] || null;
            if (unavailableAfterClick) {
              finish({
                status: 'model-unavailable',
                label: match.label || PRIMARY_LABEL,
                details: unavailableAfterClick,
              });
              return;
            }
            if (selectionMatchesTarget()) {
              finish({
                status: 'switched',
                label: match.label || currentSelectionLabel(),
              });
              return;
            }
            const isSubmenu = (match.testid ?? '').toLowerCase().includes('submenu');
            if (isSubmenu) {
              scheduleAttempt(REOPEN_INTERVAL_MS / 2);
              return;
            }
            scheduleAttempt(Math.max(120, INITIAL_WAIT_MS));
            return;
          }
          const traversal = findBestTraversalOption();
          if (traversal) {
            hoverOption(traversal.node);
            await new Promise((resolve) => setTimeout(resolve, 80));
            const unavailable =
              optionUnavailableDetails(traversal.node) ||
              collectVisibleUnavailableMessages()[0] ||
              null;
            if (unavailable) {
              finish({
                status: 'model-unavailable',
                label: traversal.label || PRIMARY_LABEL,
                details: unavailable,
              });
              return;
            }
            activateOption(traversal.node);
            scheduleAttempt(Math.max(120, INITIAL_WAIT_MS));
            return;
          }
          if (performance.now() - start > MAX_WAIT_MS) {
            finish({
              status: 'option-not-found',
              hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
            });
            return;
          }
          scheduleAttempt(REOPEN_INTERVAL_MS / 2);
        };
        attempt().catch((error) => {
          finish({
            status: 'selection-error',
            details: { message: String(error?.message || error || 'unknown') },
          });
        });
      });
      try {
        window[PENDING_PROMISE_KEY] = pendingPromise;
      } catch {}
      return pendingPromise;
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
      const TARGET_ALIASES = TARGET_LEVEL === 'minimal'
        ? ['minimal', 'light']
        : TARGET_LEVEL === 'light'
          ? ['light', 'minimal']
          : [TARGET_LEVEL];

      const CHIP_SELECTORS = [
        '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
        'button.__composer-pill[aria-haspopup="menu"]',
        '.__composer-pill-composite button[aria-haspopup="menu"]',
      ];

      const INITIAL_WAIT_MS = 800;
      const MAX_WAIT_MS = 10000;
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const normalize = (value) => (value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
      const targetEffortOptionMatches = (text) => {
        const normalized = normalize(text);
        return TARGET_ALIASES.some((alias) => normalized === alias);
      };
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dispatchHoverSequence = (target) => {
        if (!(target instanceof HTMLElement)) return false;
        const rect = target.getBoundingClientRect();
        const clientX = Math.max(rect.left, rect.right - 8);
        const clientY = rect.top + rect.height / 2;
        const ownerView =
          (target.ownerDocument && target.ownerDocument.defaultView) ||
          (typeof window === 'object' ? window : null);
        if (!ownerView) return false;
        for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'pointermove', 'mousemove']) {
          const common = { bubbles: true, cancelable: true, view: ownerView, clientX, clientY };
          let event;
          if (type.startsWith('pointer') && 'PointerEvent' in ownerView) {
            event = new ownerView.PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' });
          } else {
            event = new ownerView.MouseEvent(type, common);
          }
          target.dispatchEvent(event);
        }
        return true;
      };

      const findThinkingChip = () => {
        for (const selector of CHIP_SELECTORS) {
          const buttons = document.querySelectorAll(selector);
          for (const btn of buttons) {
            if (btn.getAttribute?.('aria-haspopup') !== 'menu') continue;
            if (!visible(btn)) continue;
            const aria = normalize(btn.getAttribute?.('aria-label') ?? '');
            const text = normalize(btn.textContent ?? '');
            if (aria.includes('thinking') || text.includes('thinking')) {
              return btn;
            }
            if (
              aria.includes('standard') ||
              text.includes('standard') ||
              aria.includes('heavy') ||
              text.includes('heavy') ||
              aria.includes('light') ||
              text.includes('light')
            ) {
              return btn;
            }
          }
        }
        return null;
      };

      const clickChip = () => {
        dispatchClickSequence(chip);
        if (typeof chip.click === 'function') {
          chip.click();
        }
      };

      const chip = findThinkingChip();
      if (!chip) {
        return { status: 'chip-not-found' };
      }

      clickChip();

      const PENDING_PROMISE_KEY = '__reviewGptDraftThinkingSelectionPromise';
      let pendingPromise;
      const clearPendingPromise = () => {
        try {
          if (window[PENDING_PROMISE_KEY] === pendingPromise) {
            delete window[PENDING_PROMISE_KEY];
          }
        } catch {}
      };

      pendingPromise = new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearPendingPromise();
          resolve(value);
        };
        const start = performance.now();
        let lastEffortActionClick = 0;

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
            if (text.includes('standard') && (text.includes('extended') || text.includes('heavy') || text.includes('light'))) {
              return menu;
            }
          }
          return null;
        };

        const findTargetOption = (menu) => {
          const items = menu.querySelectorAll(MENU_ITEM_SELECTOR);
          for (const item of items) {
            if (visible(item) && targetEffortOptionMatches(item.textContent ?? '')) {
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
        const findEffortAction = () => {
          const rows = Array.from(document.querySelectorAll('[data-model-picker-thinking-effort-row="true"]'))
            .filter((row) => row instanceof HTMLElement);
          if (rows.length === 0) {
            return null;
          }
          const currentRow =
            rows.find((row) => optionIsSelected(row.querySelector('[data-model-picker-thinking-effort-menu-item="true"], [role="menuitemradio"]'))) ||
            rows.find((row) => {
              const chipText = normalize(chip.textContent ?? '');
              const rowText = normalize(row.textContent ?? '');
              return chipText && rowText.includes(chipText.split(' ')[0] || chipText);
            }) ||
            rows[0];
          const action = currentRow.querySelector(
            '[data-model-picker-thinking-effort-action="true"], [data-testid$="-thinking-effort"]'
          );
          if (!(action instanceof HTMLElement)) {
            return null;
          }
          return { row: currentRow, action };
        };
        const openEffortMenu = async () => {
          let target = findEffortAction();
          if (!target) {
            clickChip();
            await delay(500);
            target = findEffortAction();
          }
          if (!target) {
            return false;
          }
          target.row.scrollIntoView({ block: 'nearest' });
          dispatchHoverSequence(target.row);
          await delay(100);
          dispatchHoverSequence(target.action);
          await delay(100);
          dispatchClickSequence(target.action);
          if (typeof target.action.click === 'function') {
            target.action.click();
          }
          lastEffortActionClick = performance.now();
          await delay(400);
          return true;
        };

        const scheduleAttempt = (ms) => {
          setTimeout(() => {
            attempt().catch((error) => {
              finish({
                status: 'selection-error',
                details: { message: String(error?.message || error || 'unknown') },
              });
            });
          }, ms);
        };

        const attempt = async () => {
          const visibleTargetOption = findTargetOption(document);
          if (visibleTargetOption) {
            const alreadySelected =
              optionIsSelected(visibleTargetOption) ||
              optionIsSelected(visibleTargetOption.querySelector?.('[aria-checked="true"], [data-state="checked"], [data-state="selected"]'));
            const label = visibleTargetOption.textContent?.trim?.() || null;
            dispatchClickSequence(visibleTargetOption);
            finish({ status: alreadySelected ? 'already-selected' : 'switched', label });
            return;
          }

          const menu = findMenu();
          if (!menu) {
            if (performance.now() - lastEffortActionClick > 1500) {
              await openEffortMenu();
            }
            if (performance.now() - start > MAX_WAIT_MS) {
              finish({ status: 'menu-not-found' });
              return;
            }
            scheduleAttempt(100);
            return;
          }

          const targetOption = findTargetOption(menu);
          if (!targetOption) {
            finish({ status: 'option-not-found' });
            return;
          }

          const alreadySelected =
            optionIsSelected(targetOption) ||
            optionIsSelected(targetOption.querySelector?.('[aria-checked="true"], [data-state="checked"], [data-state="selected"]'));
          const label = targetOption.textContent?.trim?.() || null;
          dispatchClickSequence(targetOption);
          finish({ status: alreadySelected ? 'already-selected' : 'switched', label });
        };

        scheduleAttempt(INITIAL_WAIT_MS);
      });
      try {
        window[PENDING_PROMISE_KEY] = pendingPromise;
      } catch {}
      return pendingPromise;
    })()`;
  };

  const buildAppConnectorSelectionProbeExpression = (target) => {
    const targetLiteral = JSON.stringify(target);
    const normalizeAppConnectorTextLiteral = normalizeAppConnectorText.toString();
    const appConnectorTargetAliasesLiteral = appConnectorTargetAliases.toString();
    const appConnectorLabelMatchesTargetLiteral = appConnectorLabelMatchesTarget.toString();
    return `(() => {
      const normalizeAppConnectorText = ${normalizeAppConnectorTextLiteral};
      const appConnectorTargetAliases = ${appConnectorTargetAliasesLiteral};
      const appConnectorLabelMatchesTarget = ${appConnectorLabelMatchesTargetLiteral};
      const TARGET = ${targetLiteral};
      const ADD_BUTTON_SELECTORS = [
        'button[data-testid="composer-plus-btn"]',
        'button[data-testid*="composer-plus"]',
        'button[data-testid*="attachments"]',
        'button[data-testid*="attachment"]',
        'button[aria-label*="Add"]',
        'button[aria-label*="add"]',
        'button[aria-label*="Attach"]',
        'button[aria-label*="attach"]',
        '[data-testid="composer-footer-actions"] button',
        'form button',
      ];
      const MENU_CONTAINER_SELECTOR = [
        '[role="menu"]',
        '[role="dialog"]',
        '[role="listbox"]',
        '[cmdk-root]',
        '[data-cmdk-root]',
        '[data-radix-collection-root]',
        '[data-radix-popper-content-wrapper]',
      ].join(', ');
      const MENU_ITEM_SELECTOR =
        'button, a, [role="menuitem"], [role="menuitemradio"], [role="option"], [cmdk-item], [data-cmdk-item], [data-radix-collection-item], [data-testid]';
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const labelFor = (node) => [
        node?.getAttribute?.('aria-label') || '',
        node?.textContent || '',
        node?.getAttribute?.('data-testid') || '',
      ].join(' ').trim();
      const normalizedLabelFor = (node) => normalizeAppConnectorText(labelFor(node));
      const findComposerRoot = () => {
        const composerInput =
          document.querySelector('#prompt-textarea') ||
          document.querySelector('textarea[name="prompt-textarea"]') ||
          document.querySelector('[data-testid*="composer"] [contenteditable="true"]') ||
          document.querySelector('form [contenteditable="true"]') ||
          document.querySelector('textarea:not([disabled])');
        return (
          composerInput?.closest?.('[data-testid*="composer"], form') ||
          document.querySelector('[data-testid*="composer"]') ||
          null
        );
      };
      const isComposerSelectionCandidate = (node, composerRoot) => {
        if (!(node instanceof HTMLElement) || !visible(node) || !composerRoot?.contains?.(node)) return false;
        if (node.closest(MENU_CONTAINER_SELECTOR)) return false;
        if (node.matches('textarea, input, [contenteditable="true"]')) return false;
        if (node.closest('[contenteditable="true"]')) return false;
        const normalized = normalizedLabelFor(node);
        if (!normalized) return false;
        if (normalized.includes('composer plus')) return false;
        if (normalized.includes('add files') || normalized.includes('add photos')) return false;
        if (normalized.includes('send prompt') || normalized.includes('send message')) return false;
        if (normalized.includes('start dictation') || normalized.includes('microphone')) return false;
        if (normalized.includes('model') || normalized.includes('gpt') || normalized.includes('pro extended')) return false;
        return true;
      };
      const pointFor = (node) => {
        if (!(node instanceof HTMLElement) || !visible(node)) return null;
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const scoreAddButton = (node) => {
        if (!(node instanceof HTMLElement) || !visible(node)) return 0;
        const normalized = normalizedLabelFor(node);
        if (!normalized) return 0;
        let score = 0;
        if (normalized.includes('composer plus')) score += 260;
        if (normalized.includes('add photos') || normalized.includes('add files')) score += 240;
        if (normalized.includes('add') && normalized.includes('file')) score += 200;
        if (normalized.includes('attach') || normalized.includes('attachment')) score += 180;
        if (normalized === '+' || normalized.includes(' plus ')) score += 120;
        if (normalized.includes('send') || normalized.includes('voice') || normalized.includes('dictate')) score -= 220;
        if (normalized.includes('model') || normalized.includes('gpt') || normalized.includes('thinking')) score -= 180;
        return Math.max(score, 0);
      };
      const findAddButton = () => {
        let best = null;
        for (const selector of ADD_BUTTON_SELECTORS) {
          const candidates = Array.from(document.querySelectorAll(selector));
          for (const candidate of candidates) {
            const score = scoreAddButton(candidate);
            if (score > 0 && (!best || score > best.score)) {
              best = { node: candidate, score };
            }
          }
        }
        return best?.node || null;
      };
      const menuRoots = () => Array.from(document.querySelectorAll(MENU_CONTAINER_SELECTOR)).filter(visible);
      const collectMenuItems = () => {
        const items = [];
        for (const root of menuRoots()) {
          for (const item of Array.from(root.querySelectorAll(MENU_ITEM_SELECTOR))) {
            if (item instanceof HTMLElement && visible(item)) {
              items.push(item);
            }
          }
        }
        return items;
      };
      const findSelectedConnector = () => {
        const composerRoot = findComposerRoot();
        const candidates = composerRoot
          ? Array.from(composerRoot.querySelectorAll('button, [role="button"], [aria-label], [aria-haspopup="menu"], [data-testid]'))
          : [];
        for (const candidate of candidates) {
          if (!isComposerSelectionCandidate(candidate, composerRoot)) continue;
          if (appConnectorLabelMatchesTarget(labelFor(candidate), TARGET)) {
            return candidate;
          }
        }
        return null;
      };
      const findTargetItem = () => {
        for (const item of collectMenuItems()) {
          if (appConnectorLabelMatchesTarget(labelFor(item), TARGET)) {
            return item;
          }
        }
        return null;
      };
      const findMoreItem = () => {
        for (const item of collectMenuItems()) {
          const normalized = normalizedLabelFor(item);
          if (normalized === 'more' || normalized.startsWith('more ') || normalized.includes(' more ')) {
            return item;
          }
        }
        return null;
      };
      const collectAvailableOptions = () =>
        collectMenuItems()
          .map((node) => (node?.textContent || node?.getAttribute?.('aria-label') || '').trim())
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index)
          .slice(0, 16);

      const selected = findSelectedConnector();
      if (selected) {
        return { status: 'already-selected', label: labelFor(selected) || TARGET };
      }
      const targetItem = findTargetItem();
      if (targetItem) {
        return { status: 'click-target', label: labelFor(targetItem) || TARGET, point: pointFor(targetItem) };
      }
      const moreItem = findMoreItem();
      if (moreItem) {
        return { status: 'click-more', label: labelFor(moreItem) || 'More', point: pointFor(moreItem) };
      }
      const addButton = findAddButton();
      if (addButton) {
        return { status: 'click-add', label: labelFor(addButton) || 'Add files and more', point: pointFor(addButton) };
      }
      return {
        status: menuRoots().length > 0 ? 'option-not-found' : 'menu-not-found',
        hint: { availableOptions: collectAvailableOptions() },
      };
    })()`;
  };

  const buildAppConnectorMentionVerificationExpression = (target) => {
    const targetLiteral = JSON.stringify(target);
    const normalizeAppConnectorTextLiteral = normalizeAppConnectorText.toString();
    const appConnectorTargetAliasesLiteral = appConnectorTargetAliases.toString();
    return `(() => {
      const normalizeAppConnectorText = ${normalizeAppConnectorTextLiteral};
      const appConnectorTargetAliases = ${appConnectorTargetAliasesLiteral};
      const TARGET = ${targetLiteral};
      const inputSelectors = [
        '#prompt-textarea',
        'textarea[name="prompt-textarea"]',
        '[data-testid*="composer"] [contenteditable="true"]',
        'form [contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea:not([disabled])',
      ];
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const readText = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          return node.value || '';
        }
        return node.innerText || node.textContent || '';
      };
      const input =
        inputSelectors
          .map((selector) => document.querySelector(selector))
          .find((node) => node instanceof HTMLElement && visible(node)) ||
        inputSelectors
          .map((selector) => document.querySelector(selector))
          .find(Boolean) ||
        null;
      const composerText = readText(input).trim();
      const normalizedText = normalizeAppConnectorText(composerText);
      const targetAliases = appConnectorTargetAliases(TARGET).map((alias) => normalizeAppConnectorText(alias));
      const connectorPill =
        input instanceof HTMLElement
          ? Array.from(input.querySelectorAll('[data-inline-selection-pill], [data-id^="connector:"], [data-symbol="ecosystemMention"]'))
              .find((node) => {
                if (!(node instanceof HTMLElement)) return false;
                const pillText = readText(node).trim();
                const normalizedPillText = normalizeAppConnectorText(pillText);
                const dataId = String(node.getAttribute('data-id') || '');
                const dataSymbol = String(node.getAttribute('data-symbol') || '');
                return (
                  targetAliases.includes(normalizedPillText) &&
                  (dataId.startsWith('connector:') || dataSymbol === 'ecosystemMention')
                );
              }) || null
          : null;
      const selected = Boolean(connectorPill);
      return {
        selected,
        label: selected ? readText(connectorPill).trim() : '',
        composerText: composerText.slice(0, 200),
        normalizedText,
        hasConnectorPill: Boolean(connectorPill),
      };
    })()`;
  };

  const buildAppConnectorMentionSuggestionProbeExpression = (target) => {
    const targetLiteral = JSON.stringify(target);
    const normalizeAppConnectorTextLiteral = normalizeAppConnectorText.toString();
    const appConnectorTargetAliasesLiteral = appConnectorTargetAliases.toString();
    return `(() => {
      const normalizeAppConnectorText = ${normalizeAppConnectorTextLiteral};
      const appConnectorTargetAliases = ${appConnectorTargetAliasesLiteral};
      const TARGET = ${targetLiteral};
      const targetAliases = appConnectorTargetAliases(TARGET).map((alias) => normalizeAppConnectorText(alias));
      const OVERLAY_SELECTOR = [
        '.popover',
        '[role="dialog"]',
        '[role="listbox"]',
        '[cmdk-root]',
        '[data-cmdk-root]',
        '[data-radix-collection-root]',
        '[data-radix-popper-content-wrapper]',
      ].join(', ');
      const ITEM_SELECTOR =
        '.__menu-item, [role="option"], [cmdk-item], [data-cmdk-item], [role="menuitem"], [role="menuitemradio"], button, a';
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const textFor = (node) => (node?.innerText || node?.textContent || node?.getAttribute?.('aria-label') || '').trim();
      const pointFor = (node) => {
        if (!(node instanceof HTMLElement) || !visible(node)) return null;
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const pluginGroupLabelFor = (node) => {
        const group = node?.closest?.('[role="group"]');
        if (!group) return '';
        const label =
          group.querySelector?.('.__menu-label') ||
          group.querySelector?.('[data-menu-label]') ||
          group.firstElementChild;
        return normalizeAppConnectorText(label?.textContent || '');
      };
      const candidates = [];
      for (const node of Array.from(document.querySelectorAll(ITEM_SELECTOR))) {
        if (!(node instanceof HTMLElement) || !visible(node)) continue;
        if (!node.closest(OVERLAY_SELECTOR)) continue;
        const item = node.closest('.__menu-item') || node;
        if (!(item instanceof HTMLElement) || !visible(item)) continue;
        const normalizedText = normalizeAppConnectorText(textFor(item));
        if (!targetAliases.includes(normalizedText)) continue;
        const groupLabel = pluginGroupLabelFor(item);
        const score =
          groupLabel.includes('plugin') || groupLabel.includes('app') || groupLabel.includes('connector')
            ? 100
            : 10;
        candidates.push({ item, score, label: textFor(item), groupLabel });
      }
      candidates.sort((left, right) => right.score - left.score);
      const candidate = candidates[0];
      if (!candidate) {
        return { status: 'suggestion-not-found' };
      }
      return {
        status: 'click-target',
        label: candidate.label || TARGET,
        groupLabel: candidate.groupLabel || '',
        point: pointFor(candidate.item),
      };
    })()`;
  };

  const focusAndClearComposerForMention = async () => evaluate(`(() => {
    try {
      const inputSelectors = [
        '#prompt-textarea',
        'textarea[name="prompt-textarea"]',
        '[data-testid*="composer"] [contenteditable="true"]',
        'form [contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea:not([disabled])',
      ];
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const input =
        inputSelectors
          .map((selector) => document.querySelector(selector))
          .find((node) => node instanceof HTMLElement && visible(node)) ||
        inputSelectors
          .map((selector) => document.querySelector(selector))
          .find(Boolean) ||
        null;
      if (!input) {
        return { ok: false, reason: 'composer-input-not-found' };
      }
      input.focus();
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        const prototype = input instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(input, '');
        } else {
          input.value = '';
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, mode: 'input' };
      }

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const deleted = document.execCommand('delete');
      if (!deleted && (input.innerText || input.textContent)) {
        input.textContent = '';
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
      return { ok: true, mode: 'contenteditable' };
    } catch (error) {
      return {
        ok: false,
        reason: 'exception',
        message: String((error && error.message) || error || 'unknown'),
      };
    }
  })()`);

  const typeNativeText = async (text) => {
    for (const character of Array.from(String(text || ''))) {
      await cdp('Input.dispatchKeyEvent', {
        type: 'char',
        text: character,
        unmodifiedText: character,
      });
      await sleep(35);
    }
  };

  const pressNativeEnter = async () => {
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...ENTER_KEY_EVENT,
    });
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...ENTER_KEY_EVENT,
    });
  };

  const selectDraftAppConnectorByMention = async (target) => {
    const mention = appConnectorMentionText(target);
    if (!mention) {
      return { status: 'mention-unavailable', details: { message: 'No app connector mention text.' } };
    }

    await activateCurrentPageForNativeInput();
    const before = await evaluate(buildAppConnectorMentionVerificationExpression(target));
    if (before?.selected) {
      return {
        status: 'already-selected',
        label: before.label || target,
        preserveComposerPrefix: true,
      };
    }

    const focused = await focusAndClearComposerForMention();
    if (!focused?.ok) {
      return {
        status: 'selection-error',
        details: focused || { message: 'Composer input was not available for app connector mention.' },
      };
    }

    await typeNativeText(mention);
    await sleep(500);

    const suggestionDeadline = Date.now() + 2500;
    let lastSuggestion = null;
    let targetSuggestion = null;
    while (Date.now() < suggestionDeadline) {
      lastSuggestion = await evaluate(buildAppConnectorMentionSuggestionProbeExpression(target));
      if (lastSuggestion?.status === 'click-target' && lastSuggestion.point) {
        targetSuggestion = lastSuggestion;
        break;
      }
      await sleep(150);
    }

    await pressNativeEnter();
    await sleep(900);

    const after = await evaluate(buildAppConnectorMentionVerificationExpression(target));
    if (after?.selected) {
      return {
        status: 'switched',
        label: after.label || target,
        preserveComposerPrefix: true,
      };
    }

    if (targetSuggestion?.point) {
      await clickNativePoint(targetSuggestion.point);
      await sleep(900);
      const clicked = await evaluate(buildAppConnectorMentionVerificationExpression(target));
      if (clicked?.selected) {
        return {
          status: 'switched',
          label: clicked.label || targetSuggestion.label || target,
          preserveComposerPrefix: true,
        };
      }
    }

    await focusAndClearComposerForMention();
    return {
      status: 'mention-not-confirmed',
      details: after || { message: 'App connector mention did not resolve to a selected connector.' },
    };
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
      default:
        break;
    }

    // The in-page path could not complete the switch. Retry by driving the
    // picker with real mouse input before reporting a failure, because a menu
    // that stays empty under synthesized events still populates for trusted
    // input.
    const nativeResult = await driveDraftModelSelectionNatively(modelTargetRaw);
    switch (nativeResult?.status) {
      case 'already-selected':
      case 'switched':
        return { ok: true, label: nativeResult?.label || modelTargetRaw };
      default:
        break;
    }

    const failure = nativeResult?.status ? nativeResult : result;
    switch (failure?.status) {
      case 'model-unavailable':
        return { ok: false, reason: 'model-unavailable', details: failure?.details || failure };
      case 'option-not-found':
        return { ok: false, reason: 'option-not-found', details: failure };
      default:
        return { ok: false, reason: failure?.status || 'selection-failed', details: failure };
    }
  };

  const driveDraftModelSelectionNatively = async (target) => {
    await activateCurrentPageForNativeInput();
    const deadline = Date.now() + 20000;
    let lastProbe = null;
    let clickedTargetLabel = '';

    while (Date.now() < deadline) {
      lastProbe = await evaluate(buildModelSelectionProbeExpression(target));
      switch (lastProbe?.status) {
        case 'already-selected':
          return {
            status: clickedTargetLabel ? 'switched' : 'already-selected',
            label: clickedTargetLabel || lastProbe.label || target,
          };
        case 'click-button':
        case 'click-submenu':
        case 'click-option':
          if (!lastProbe.point) {
            return {
              status: 'selection-error',
              details: { message: `Missing click point for ${lastProbe.status}` },
            };
          }
          if (lastProbe.status === 'click-option') {
            clickedTargetLabel = lastProbe.label || target;
          }
          await clickNativePoint(lastProbe.point);
          await sleep(lastProbe.status === 'click-button' ? 400 : 600);
          break;
        case 'option-not-found':
        case 'button-missing':
        default:
          await sleep(250);
          break;
      }
    }

    return {
      status: lastProbe?.status || 'selection-timeout',
      details: lastProbe || { message: 'Timed out selecting model.' },
    };
  };

  const driveDraftAppConnectorSelection = async (target) => {
    const mentionResult = await selectDraftAppConnectorByMention(target);
    if (mentionResult?.status === 'switched' || mentionResult?.status === 'already-selected') {
      return mentionResult;
    }

    await activateCurrentPageForNativeInput();
    const deadline = Date.now() + 15000;
    let lastProbe = null;
    let clickedTargetLabel = '';

    while (Date.now() < deadline) {
      lastProbe = await evaluate(buildAppConnectorSelectionProbeExpression(target));
      switch (lastProbe?.status) {
        case 'already-selected':
          return {
            status: clickedTargetLabel ? 'switched' : 'already-selected',
            label: clickedTargetLabel || lastProbe.label || target,
          };
        case 'click-add':
        case 'click-more':
        case 'click-target':
          if (!lastProbe.point) {
            return {
              status: 'selection-error',
              details: { message: `Missing click point for ${lastProbe.status}` },
            };
          }
          if (lastProbe.status === 'click-target') {
            clickedTargetLabel = lastProbe.label || target;
          }
          await clickNativePoint(lastProbe.point);
          await sleep(lastProbe.status === 'click-target' ? 500 : 250);
          break;
        case 'option-not-found':
        case 'menu-not-found':
        default:
          await sleep(250);
          break;
      }
    }

    return {
      status: lastProbe?.status || 'selection-timeout',
      details: lastProbe || { message: 'Timed out selecting app connector.' },
    };
  };

  const ensureDraftAppConnectorSelected = async () => {
    if (isCurrentSelectionTarget(appConnectorTarget)) {
      return {
        ok: true,
        label: 'current',
        skipped: true,
      };
    }
    const result = await driveDraftAppConnectorSelection(appConnectorTarget);
    switch (result?.status) {
      case 'already-selected':
      case 'switched':
        return {
          ok: true,
          label: result?.label || appConnectorTarget,
          preserveComposerPrefix: Boolean(result?.preserveComposerPrefix),
        };
      case 'selection-timeout':
      case 'selection-error':
      case 'menu-not-found':
      case 'option-not-found':
        return { ok: false, reason: result.status, details: result.details || result };
      default:
        return { ok: false, reason: result?.status || 'selection-failed', details: result };
    }
  };

  const setDraftComposerPrompt = async (prompt, options = {}) => {
    const promptLiteral = JSON.stringify(String(prompt));
    const appendLiteral = JSON.stringify(Boolean(options.append));
    return evaluate(`(() => {
      try {
        const APPEND_TO_EXISTING = ${appendLiteral};
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
        const appendText = (existing, next) => {
          const current = String(existing || '');
          if (!APPEND_TO_EXISTING || current.trim().length === 0) return next;
          return /\\s$/.test(current) ? current + next : current + ' ' + next;
        };
        const textarea = pickBySelectors(textareaSelectors);
        if (textarea && String(textarea.tagName || '').toUpperCase() === 'TEXTAREA') {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(textarea, APPEND_TO_EXISTING ? appendText(textarea.value || '', value) : value);
          } else {
            textarea.value = APPEND_TO_EXISTING ? appendText(textarea.value || '', value) : value;
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
        if (APPEND_TO_EXISTING) {
          range.collapse(false);
        }
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const existingText = editor.innerText || editor.textContent || '';
        const insertValue = APPEND_TO_EXISTING && String(existingText || '').trim().length > 0
          ? (/\\s$/.test(existingText) ? value : ' ' + value)
          : value;
        const replaced = document.execCommand('insertText', false, insertValue);
        if (!replaced) {
          editor.textContent = appendText(existingText, value);
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

  const appendDraftComposerPromptNatively = async (prompt) => {
    const focused = await evaluate(`(() => {
      try {
        const inputSelectors = [
          '#prompt-textarea',
          'textarea[name="prompt-textarea"]',
          '[data-testid*="composer"] [contenteditable="true"]',
          'form [contenteditable="true"]',
          '[contenteditable="true"][role="textbox"]',
          'textarea:not([disabled])',
        ];
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const readText = (node) => {
          if (!node) return '';
          if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value || '';
          return node.innerText || node.textContent || '';
        };
        const input =
          inputSelectors
            .map((selector) => document.querySelector(selector))
            .find((node) => node instanceof HTMLElement && visible(node)) ||
          inputSelectors
            .map((selector) => document.querySelector(selector))
            .find(Boolean) ||
          null;
        if (!input) {
          return { ok: false, reason: 'composer-input-not-found' };
        }
        input.focus();
        if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
          const length = input.value.length;
          input.setSelectionRange(length, length);
          return { ok: true, mode: 'input', existingText: readText(input).slice(-80) };
        }
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return { ok: true, mode: 'contenteditable', existingText: readText(input).slice(-80) };
      } catch (error) {
        return {
          ok: false,
          reason: 'exception',
          message: String((error && error.message) || error || 'unknown'),
        };
      }
    })()`);
    if (!focused?.ok) return focused || { ok: false, reason: 'composer-input-not-found' };

    const existingText = String(focused.existingText || '');
    const separator = existingText.trim().length > 0 && !/\s$/.test(existingText) ? ' ' : '';
    await cdp('Input.insertText', { text: `${separator}${String(prompt || '')}` });
    await sleep(150);
    return {
      ok: true,
      mode: `${focused.mode || 'composer'}-native-insert`,
      length: String(prompt || '').length,
    };
  };

  const readAutoSendState = async () => {
    const assistantTurnSelectorLiteral = JSON.stringify(CHATGPT_ASSISTANT_TURN_SELECTOR);
    const userTurnSelectorLiteral = JSON.stringify(CHATGPT_USER_TURN_SELECTOR);
    const stopSelectorsLiteral = JSON.stringify(CHATGPT_STOP_SELECTORS);
    const userTurnAttachmentSelectorLiteral = JSON.stringify(CHATGPT_USER_TURN_ATTACHMENT_SELECTOR);
    const canonicalizeChatGptTurnNodesSource = canonicalizeChatGptTurnNodes.toString();
    const collectChatGptTurnAttachmentTextsSource = collectChatGptTurnAttachmentTexts.toString();
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
      const assistantTurnSelector = ${assistantTurnSelectorLiteral};
      const userTurnSelector = ${userTurnSelectorLiteral};
      const stopSelectors = ${stopSelectorsLiteral};
      const userTurnAttachmentSelector = ${userTurnAttachmentSelectorLiteral};
      const canonicalizeChatGptTurnNodes = ${canonicalizeChatGptTurnNodesSource};
      const collectChatGptTurnAttachmentTexts = ${collectChatGptTurnAttachmentTextsSource};
      const normalize = (value) => (value || '').toLowerCase();
      const signatureize = (value) =>
        normalize(value)
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
      const turnIdentity = (node, role, index, signature) => {
        for (const attribute of ['data-message-id', 'data-turn-id', 'data-testid', 'id']) {
          const value = String(node?.getAttribute?.(attribute) || '').trim();
          if (value) return attribute + ':' + value;
        }
        return role + ':index:' + index + ':signature:' + signature;
      };
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
      const userTurnGroups = canonicalizeChatGptTurnNodes(
        Array.from(document.querySelectorAll(userTurnSelector)),
      );
      const userTurnNodes = userTurnGroups.map((group) => group.node);
      const userTurnSignatures = userTurnNodes
        .map((node) => signatureize(node?.innerText || node?.textContent || '').slice(0, 320))
        .filter(Boolean);
      const recentUserTurnSignatures = userTurnSignatures.slice(-12);
      const recentUserTurns = userTurnGroups.slice(-12).map((group, recentIndex) => {
        const node = group.node;
        const turnIndex = Math.max(0, userTurnGroups.length - 12) + recentIndex;
        const signature = signatureize(node?.innerText || node?.textContent || '').slice(0, 320);
        const attachmentTexts = collectChatGptTurnAttachmentTexts(
          group.aliases,
          location.href,
          userTurnAttachmentSelector,
        );
        return {
          attachmentTexts,
          signature,
          turnId: turnIdentity(node, 'user', turnIndex, signature),
          turnIndex,
        };
      });
      const lastUserTurnSignature = recentUserTurnSignatures[recentUserTurnSignatures.length - 1] || '';
      const turnsCount = canonicalizeChatGptTurnNodes(
        Array.from(document.querySelectorAll(turnSelector)),
      ).length;
      const stopVisible = stopSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((node) => visible(node))
      );
      const assistantVisible = Array.from(document.querySelectorAll(assistantTurnSelector)).some((node) => visible(node));
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
        recentUserTurns,
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
      userTurnIds: Array.isArray(state?.recentUserTurns)
        ? state.recentUserTurns.map((turn) => turn?.turnId).filter(Boolean)
        : [],
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

  const hardRefreshInitialPageForAuthRetry = async () => {
    const refreshMarker = `review-gpt-auth-refresh-${randomUUID()}`;
    const refreshMarkerLiteral = JSON.stringify(refreshMarker);
    await evaluate(`window.__reviewGptAuthRefreshMarker = ${refreshMarkerLiteral}`);
    await cdp('Page.reload', { ignoreCache: true });

    const refreshDeadline = Date.now() + Math.max(
      8_000,
      Math.min(30_000, configuredDraftTimeoutMs),
    );
    let lastError = null;
    let lastState = null;
    while (Date.now() < refreshDeadline) {
      try {
        const state = await evaluate(`(() => ({
          href: typeof location === 'object' && location.href ? location.href : '',
          readyState: document.readyState || '',
          refreshMarker: window.__reviewGptAuthRefreshMarker || '',
        }))()`);
        lastState = state;
        const currentUrl = safeUrl(state?.href);
        const originMatches = !desiredTargetOrigin || currentUrl?.origin === desiredTargetOrigin;
        if (
          state?.refreshMarker !== refreshMarker &&
          String(state?.readyState || '').toLowerCase() === 'complete' &&
          originMatches
        ) {
          await keepPageRenderingWhileBackgrounded();
          return;
        }
      } catch (error) {
        lastError = error;
        const message = errorMessage(error).toLowerCase();
        const reloadStillInProgress =
          message.includes('execution context was destroyed') ||
          message.includes('cannot find context') ||
          message.includes('cannot find default execution context') ||
          message.includes('inspected target navigated');
        if (!reloadStillInProgress) throw error;
      }
      await sleep(Math.min(200, Math.max(1, refreshDeadline - Date.now())));
    }

    const targetMatch = Boolean(
      lastState &&
      safeUrl(lastState.href)?.origin === desiredTargetOrigin,
    );
    throw new Error(
      `ChatGPT authentication hard refresh did not finish before the draft timeout (readyState=${String(lastState?.readyState || 'unknown')}, targetMatch=${targetMatch})${
        lastError ? `: ${errorMessage(lastError)}` : '.'
      }`,
    );
  };

  const readResponseCaptureState = async (exactChatUrl = '') => {
    const exactUrl = safeUrl(exactChatUrl);
    return evaluate(
      buildChatGptCaptureStateExpression({
        desiredChatId: exactUrl ? extractChatId(exactUrl.pathname).toLowerCase() : desiredTargetChatId,
        desiredOrigin: exactUrl?.origin || desiredTargetOrigin,
      })
    );
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

  const hardRefreshExactAcceptedTarget = async (acceptedChatUrl, responseDeadline) => {
    const exactChatUrl = extractConversationHref(acceptedChatUrl);
    if (!exactChatUrl) {
      throw new Error('Hard refresh requires the exact accepted conversation URL.');
    }
    const refreshDeadline = Math.min(
      responseDeadline,
      Date.now() + Math.max(15_000, pageCommandTimeoutMs),
    );
    try {
      await cdp('Page.reload', { ignoreCache: true });
    } catch (error) {
      if (!isRetryableSocketError(error)) throw error;
      await reconnectExactAcceptedTarget(exactChatUrl, refreshDeadline);
    }

    let lastError = null;
    while (Date.now() < refreshDeadline) {
      try {
        const state = await readResponseCaptureState(exactChatUrl);
        if (
          state?.targetMatch === true &&
          String(state?.readyState || '').toLowerCase() === 'complete'
        ) {
          await keepPageRenderingWhileBackgrounded();
          return;
        }
      } catch (error) {
        lastError = error;
        if (isRetryableSocketError(error)) {
          await reconnectExactAcceptedTarget(exactChatUrl, refreshDeadline);
        }
      }
      await sleep(Math.min(250, Math.max(1, refreshDeadline - Date.now())));
    }
    throw new Error(
      `Hard refresh did not restore the exact accepted ChatGPT thread before the response deadline${
        lastError ? `: ${errorMessage(lastError)}` : '.'
      }`,
    );
  };

  const waitForAssistantResponse = async (baselineSnapshot, committedUserTurn, acceptedChatUrl) => {
    const baselineAssistantSignatures = Array.isArray(baselineSnapshot?.assistantTurnSignatures)
      ? baselineSnapshot.assistantTurnSignatures
      : [];
    const committedTurnSignature = String(committedUserTurn?.signature || '').trim();
    const committedTurnId = String(committedUserTurn?.turnId || '').trim();
    const committedTurnIndex = Number(committedUserTurn?.turnIndex);
    const exactAcceptedChatUrl = extractConversationHref(acceptedChatUrl);
    const responseWaitStartedAt = Date.now();
    const deadline = responseWaitStartedAt + Math.max(15_000, responseTimeoutMs);
    // Stability now counts consecutive quiet polls only (see
    // nextResponseStabilityCount), so the standard window is wider to ride out
    // brief busy-indicator gaps between an interim message and continued work.
    const stablePollsRequired = isDeepResearchMode ? 4 : 12;
    const requiresNewTurnModelAttestation = modelConfirmationRequired({
      isDeepResearchMode,
      shouldSend,
      shouldWaitForResponse,
      targetModel: modelTargetRaw,
    });
    if (!committedTurnId || !Number.isInteger(committedTurnIndex)) {
      return {
        status: 'target-identity-failed',
        failureText: 'Could not bind response capture to one exact committed user turn.',
        responseText: '',
        href: '',
      };
    }
    if (requiresNewTurnModelAttestation && !committedTurnSignature) {
      return {
        status: 'model-confirmation-failed',
        modelConfirmationFailure: `Could not bind the assistant response to the committed user turn for requested model ${modelTargetRaw}.`,
        responseText: '',
        href: '',
      };
    }
    if (!exactAcceptedChatUrl) {
      return {
        status: 'target-identity-failed',
        failureText: 'Could not bind response capture to one exact accepted ChatGPT thread.',
        responseText: '',
        href: '',
      };
    }
    let lastState = null;
    let bestSnapshot = null;
    let stableSignature = '';
    let stableText = '';
    let stableCount = 0;
    let sawGenerationActive = false;
    let generationStartedAt = 0;
    let lastHardRefreshAt = responseWaitStartedAt;

    // Re-assert before the wait: a navigation since session setup can reset
    // the renderer's lifecycle/focus emulation state.
    await keepPageRenderingWhileBackgrounded();

    while (Date.now() < deadline) {
      if (hardRefreshDue(lastHardRefreshAt)) {
        recordStage('(hard-refresh)');
        console.log('Assistant wait hard-refreshing the exact ChatGPT thread after 10 minutes.');
        await hardRefreshExactAcceptedTarget(exactAcceptedChatUrl, deadline);
        lastHardRefreshAt = Date.now();
        stableSignature = '';
        stableText = '';
        stableCount = 0;
        continue;
      }
      let pageState;
      let deepResearchState;
      try {
        pageState = await readResponseCaptureState(exactAcceptedChatUrl);
        if (pageState?.targetMatch !== true) {
          await reconnectExactAcceptedTarget(exactAcceptedChatUrl, deadline);
          continue;
        }
        deepResearchState = isDeepResearchMode ? await readDeepResearchResponseCaptureState() : null;
      } catch (error) {
        if (!isRetryableSocketError(error)) throw error;
        await reconnectExactAcceptedTarget(exactAcceptedChatUrl, deadline);
        continue;
      }
      const state = mergeResponseCaptureStates(pageState, deepResearchState, committedUserTurn);
      lastState = state;
      const candidate = selectAssistantResponseCandidate(
        state,
        baselineAssistantSignatures,
        promptMatchCandidates,
        requiresNewTurnModelAttestation,
        committedTurnSignature,
        committedTurnId,
        committedTurnIndex,
      ).snapshot;
      if (candidate?.text) {
        bestSnapshot = candidate;
      }

      const generationActive = Boolean(state?.stopVisible || state?.statusBusy);
      if (generationActive) {
        sawGenerationActive = true;
        generationStartedAt ||= Date.now();
      }
      const assistantFailureText = responseStateAssistantFailureText(state);
      if (assistantFailureText && !generationActive) {
        return {
          status: 'generation-failed',
          failureText: assistantFailureText,
          responseText: candidate?.text || '',
          href: state?.href || '',
          rateLimited: responseStateIndicatesChatGptRateLimit(state),
        };
      }

      const candidateMatchesPrevious =
        candidate?.signature === stableSignature && candidate?.text === stableText;
      if (!candidateMatchesPrevious) {
        stableSignature = candidate?.signature || '';
        stableText = candidate?.text || '';
      }
      stableCount = nextResponseStabilityCount({
        stableCount,
        candidateMatchesPrevious,
        candidateHasText: Boolean(candidate?.text),
        generationActive,
      });
      if (
        shouldFinishAssistantResponseWait({
          candidate,
          expectedContentSource: isDeepResearchMode ? 'deep-research-iframe' : undefined,
          generationActive,
          stableCount,
          stablePollsRequired,
          isDeepResearchMode,
          sawGenerationActive,
          responseMarker,
        })
      ) {
        const modelAttestation = modelAttestationForSnapshot(
          modelTargetRaw,
          candidate,
          true,
          committedTurnSignature,
          generationStartedAt ? Date.now() - generationStartedAt : 0,
        );
        if (modelAttestation.failure) {
          return {
            status: 'model-confirmation-failed',
            modelConfirmationFailure: modelAttestation.failure,
            responseText: candidate.text,
            href: state?.href || '',
          };
        }
        const responseDurationFailure = markedResponseDurationFailure({
          targetModel: modelTargetRaw,
          responseMarker,
          responseElapsedMs: Date.now() - responseWaitStartedAt,
          minimumResponseMs: minimumMarkedResponseMs,
          hasConcreteModelEvidence: Boolean(modelAttestation.evidence),
        });
        if (responseDurationFailure) {
          return {
            status: 'response-too-fast',
            responseDurationFailure,
            responseText: candidate.text,
            href: state?.href || '',
          };
        }
        return {
          status: 'completed',
          assistantSnapshot: candidate,
          attachmentButtons: Array.isArray(state?.attachmentButtons) ? state.attachmentButtons : [],
          responseText: candidate.text,
          href: state?.href || '',
          modelVerification: modelAttestation.evidence,
        };
      }

      // A capture snapshot traverses a large live ChatGPT DOM. While the model
      // is still generating, a one-minute cadence avoids continuously
      // re-rendering and rescanning that UI without delaying server-side work.
      // Once generation becomes quiet, retain the short cadence so stability
      // and completion checks still settle promptly.
      await sleep(Math.min(generationActive ? 60_000 : 500, Math.max(1, deadline - Date.now())));
    }

    if (bestSnapshot?.text) {
      // Report the missing completion marker before running the model
      // attestation. A snapshot captured at the deadline is an unfinished turn
      // -- often just the streamed reasoning summary -- and unfinished text has
      // no MODEL_CONFIRMATION line yet. Attesting first turns every ordinary
      // wait timeout into "did not include MODEL_CONFIRMATION", which sends the
      // operator after the prompt or the model selection when the real cause is
      // that the response never completed.
      if (timeoutSnapshotMissingResponseMarker(responseMarker, bestSnapshot.text)) {
        return {
          status: 'timeout-missing-marker',
          responseText: bestSnapshot.text,
          href: lastState?.href || '',
          partial: true,
          rateLimited: responseStateIndicatesChatGptRateLimit(lastState),
        };
      }
      const modelAttestation = modelAttestationForSnapshot(
        modelTargetRaw,
        bestSnapshot,
        false,
        committedTurnSignature,
        generationStartedAt ? Date.now() - generationStartedAt : 0,
      );
      if (modelAttestation.failure) {
        return {
          status: 'model-confirmation-failed',
          modelConfirmationFailure: modelAttestation.failure,
          responseText: bestSnapshot.text,
          href: lastState?.href || '',
          partial: true,
        };
      }
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

  const waitForAutoSendReadiness = async (requireComposerText) => {
    const deadline = Date.now() + Math.max(8_000, timeoutMs);
    let lastState = null;
    let lastButtonAttempt = null;
    while (Date.now() < deadline) {
      const state = await readAutoSendState();
      lastState = state;
      if (state?.uploading) {
        lastButtonAttempt = { status: 'send-wait-uploading', state };
        await sleep(200);
        continue;
      }

      if (requireComposerText && promptMatchCandidates.length > 0 && !promptSignatureMatches(state?.composerSignature, promptMatchCandidates)) {
        return {
          status: 'composer-refill-needed',
          state,
        };
      }

      const buttonAttempt = await attemptClickSendButton();
      lastButtonAttempt = buttonAttempt || { status: 'send-attempt-unknown' };
      if (buttonAttempt?.status === 'send-button-disabled') {
        await sleep(200);
        continue;
      }

      return {
        status: 'ready',
        state,
        buttonAttempt: lastButtonAttempt,
      };
    }

    return {
      status: 'timeout',
      state: lastState,
      buttonAttempt: lastButtonAttempt,
    };
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

  const buildDeepResearchStartButtonInspectionSource = (click = false) => `
    (() => {
      try {
        ${buildClickDispatcher('dispatchDeepResearchStartClick')}
        const shouldClick = ${click ? 'true' : 'false'};
        const visible = (node) => {
          if (!node || typeof node.getBoundingClientRect !== 'function') return false;
          const rect = node.getBoundingClientRect();
          const style = (node.ownerDocument?.defaultView || window).getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const normalize = (value) => String(value || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
        const scoreCandidate = (snapshot) => {
          const label = normalize(snapshot?.label);
          if (!label || snapshot?.disabled) return 0;
          let score = 0;
          if (label === 'start') score += 280;
          if (label.startsWith('start ')) score += 260;
          if (label.includes(' start ')) score += 180;
          if (snapshot?.hasCancelSibling) score += 120;
          if (snapshot?.hasEditSibling) score += 60;
          if (snapshot?.withinPlanCard) score += 80;
          if (snapshot?.isButtonElement) score += 20;
          return score;
        };
        const searchRoots = [document];
        for (const frame of Array.from(document.querySelectorAll('iframe'))) {
          try {
            const frameDoc = frame.contentDocument;
            if (frameDoc?.documentElement) {
              searchRoots.push(frameDoc);
            }
          } catch {}
        }
        const candidates = [];
        for (const root of searchRoots) {
          for (const node of Array.from(root.querySelectorAll('button, [role="button"]'))) {
            if (!visible(node)) continue;
            const label = String(
              node.getAttribute('aria-label') ||
              node.getAttribute('title') ||
              node.innerText ||
              node.textContent ||
              ''
            ).trim();
            const normalizedLabel = normalize(label);
            if (!normalizedLabel.includes('start')) continue;
            const style = (node.ownerDocument?.defaultView || window).getComputedStyle(node);
            const ariaDisabled = normalize(node.getAttribute('aria-disabled'));
            const dataDisabled = normalize(node.getAttribute('data-disabled'));
            const disabled =
              Boolean(node.disabled) ||
              node.hasAttribute('disabled') ||
              ariaDisabled === 'true' ||
              dataDisabled === 'true' ||
              style.pointerEvents === 'none';
            let hasCancelSibling = false;
            let hasEditSibling = false;
            let withinPlanCard = false;
            let current = node.parentElement;
            let depth = 0;
            while (current && depth < 6) {
              const buttonLabels = Array.from(current.querySelectorAll('button, [role="button"]'))
                .filter((other) => other !== node && visible(other))
                .map((other) =>
                  normalize(
                    other.getAttribute('aria-label') ||
                    other.getAttribute('title') ||
                    other.innerText ||
                    other.textContent ||
                    ''
                  )
                )
                .filter(Boolean);
              if (buttonLabels.some((value) => value === 'cancel' || value.startsWith('cancel '))) {
                hasCancelSibling = true;
              }
              if (buttonLabels.some((value) => value === 'edit' || value.startsWith('edit '))) {
                hasEditSibling = true;
              }
              if (hasCancelSibling && hasEditSibling) {
                withinPlanCard = true;
                break;
              }
              current = current.parentElement;
              depth += 1;
            }
            const snapshot = {
              label,
              disabled,
              hasCancelSibling,
              hasEditSibling,
              withinPlanCard,
              isButtonElement: node.tagName === 'BUTTON',
            };
            const score = scoreCandidate(snapshot);
            if (score <= 0) continue;
            candidates.push({ node, score, snapshot });
          }
        }
        candidates.sort((left, right) => right.score - left.score);
        const winner = candidates[0];
        if (!winner) {
          return { status: 'deep-research-start-button-not-found' };
        }
        if (!shouldClick) {
          return {
            status: 'ready',
            label: winner.snapshot.label,
            score: winner.score,
          };
        }
        const clicked = dispatchDeepResearchStartClick(winner.node);
        if (!clicked && typeof winner.node.click === 'function') {
          winner.node.click();
        }
        return {
          status: 'clicked',
          label: winner.snapshot.label,
          score: winner.score,
        };
      } catch (error) {
        return {
          status: 'deep-research-start-button-error',
          message: String((error && error.message) || error || 'unknown'),
        };
      }
    })()
  `;

  const evaluateInTargetWebSocket = async (webSocketUrl, expression) => {
    if (!webSocketUrl) return null;
    const targetWs = socketOwner.create(webSocketUrl);
    try {
      await withTimeout(
        new Promise((resolve, reject) => {
          targetWs.addEventListener('open', resolve, { once: true });
          targetWs.addEventListener(
            'error',
            (event) => reject(event.error || new Error('CDP socket error')),
            { once: true }
          );
          targetWs.addEventListener('close', () => reject(new Error('CDP socket closed unexpectedly')), { once: true });
        }),
        browserTransportTimeoutMs,
        'Timed out opening nested target CDP socket'
      );
      const targetPending = new Map();
      let targetNextId = 0;
      const targetClosed = new Promise((_, reject) => {
        targetWs.addEventListener('close', () => reject(new Error('CDP socket closed unexpectedly')));
        targetWs.addEventListener('error', (event) => reject(event.error || new Error('CDP socket error')));
      });
      void targetClosed.catch(() => {});
      targetWs.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (typeof message.id !== 'number') {
          return;
        }
        const slot = targetPending.get(message.id);
        if (!slot) return;
        targetPending.delete(message.id);
        if (message.error) {
          slot.reject(new Error(message.error.message || 'CDP command failed'));
          return;
        }
        slot.resolve(message.result || {});
      });
      const targetCdp = async (method, params = {}) => {
        const id = ++targetNextId;
        const response = new Promise((resolve, reject) => {
          targetPending.set(id, { resolve, reject });
        });
        targetWs.send(JSON.stringify({ id, method, params }));
        return withTimeout(
          Promise.race([response, targetClosed]),
          pageCommandTimeoutMs,
          `Nested CDP socket command timed out: ${method}`
        );
      };
      await targetCdp('Runtime.enable');
      const result = await targetCdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result.result?.value;
    } finally {
      try {
        socketOwner.close(targetWs);
      } catch {}
    }
  };

  const pickDeepResearchIframeTarget = async () => {
    if (!captureTargetId) return null;
    const targets = await fetchJson('/json/list');
    return selectUniqueDeepResearchIframeTarget(targets, captureTargetId);
  };

  const readDeepResearchResponseCaptureState = async () => {
    if (!isDeepResearchMode) {
      return null;
    }
    const iframeTarget = await pickDeepResearchIframeTarget();
    if (!iframeTarget?.webSocketDebuggerUrl) {
      return null;
    }
    return evaluateInTargetWebSocket(iframeTarget.webSocketDebuggerUrl, buildDeepResearchResponseInspectionSource()).catch(
      () => null
    );
  };

  const resolveDeepResearchIframeHotspot = async () => {
    return evaluate(`(() => {
      const visible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const normalize = (value) => String(value || '').toLowerCase();
      const frames = Array.from(document.querySelectorAll('iframe')).filter((frame) => {
        const title = normalize(frame.getAttribute('title'));
        const src = normalize(frame.getAttribute('src'));
        return (
          title.includes('deep-research') ||
          title.includes('deep research') ||
          src.includes('deep_research') ||
          src.includes('deep-research')
        );
      });
      const target = frames.find((frame) => visible(frame)) || frames[0] || null;
      if (!target) {
        return { status: 'deep-research-iframe-not-found' };
      }
      const rect = target.getBoundingClientRect();
      return {
        status: 'ready',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    })()`);
  };

  const inspectDeepResearchStartButton = async (click = false) => {
    const expression = buildDeepResearchStartButtonInspectionSource(click);
    const iframeTarget = await pickDeepResearchIframeTarget();
    if (iframeTarget?.webSocketDebuggerUrl) {
      const iframeResult = await evaluateInTargetWebSocket(iframeTarget.webSocketDebuggerUrl, expression).catch((error) => ({
        status: 'deep-research-start-button-error',
        message: errorMessage(error),
      }));
      if (iframeResult?.status && iframeResult.status !== 'deep-research-start-button-not-found') {
        return {
          ...iframeResult,
          via: 'iframe-target',
        };
      }
    }
    return { status: 'deep-research-start-button-not-found' };
  };

  const clickDeepResearchStartHotspot = async () => {
    const target = await resolveDeepResearchIframeHotspot();
    if (target?.status !== 'ready') {
      return target || { status: 'deep-research-iframe-not-found' };
    }
    const clickPoint = buildDeepResearchStartClickPoint(target);
    if (!clickPoint) {
      return {
        status: 'deep-research-hotspot-invalid',
        target,
      };
    }
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: clickPoint.x,
      y: clickPoint.y,
      button: 'none',
    });
    await cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: clickPoint.x,
      y: clickPoint.y,
      button: 'left',
      clickCount: 1,
    });
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: clickPoint.x,
      y: clickPoint.y,
      button: 'left',
      clickCount: 1,
    });
    return {
      status: 'clicked',
      x: clickPoint.x,
      y: clickPoint.y,
    };
  };

  const readDeepResearchKickoffState = async () => {
    const buttonState = await inspectDeepResearchStartButton(false);
    if (buttonState?.status === 'ready') {
      return {
        status: 'start-button-visible',
        buttonState,
      };
    }
    const responseState = await readResponseCaptureState();
    if (responseState?.stopVisible || responseState?.statusBusy) {
      return {
        status: 'generation-active',
        responseState,
      };
    }
    const iframeTarget = await pickDeepResearchIframeTarget();
    if (iframeTarget?.webSocketDebuggerUrl) {
      return {
        status: 'start-iframe-visible',
        iframeTarget,
      };
    }
    return {
      status: 'start-control-missing',
      responseState,
    };
  };

  const advanceDeepResearchPlan = async () => {
    if (!isDeepResearchMode) {
      return { status: 'skipped' };
    }
    const attempts = [];
    const graceStartedAt = Date.now();
    while (Date.now() - graceStartedAt < DEEP_RESEARCH_AUTO_START_GRACE_MS) {
      const kickoffState = await readDeepResearchKickoffState();
      if (kickoffState?.status === 'generation-active') {
        return {
          status: 'started-automatically',
          attempts,
          kickoffState,
        };
      }
      await sleep(DEEP_RESEARCH_AUTO_START_POLL_MS);
    }

    const kickoffStateAfterGrace = await readDeepResearchKickoffState();
    if (
      !shouldAttemptDeepResearchStartFallback({
        kickoffState: kickoffStateAfterGrace,
        elapsedMs: Date.now() - graceStartedAt,
      })
    ) {
      return {
        status: kickoffStateAfterGrace?.status === 'generation-active' ? 'started-automatically' : 'auto-start-timeout',
        attempts,
        kickoffState: kickoffStateAfterGrace,
      };
    }

    for (let index = 0; index < DEEP_RESEARCH_START_ATTEMPTS; index += 1) {
      const buttonAttempt = await inspectDeepResearchStartButton(true);
      const attempt = {
        buttonAttempt,
      };
      attempts.push(attempt);
      const clicked = buttonAttempt?.status === 'clicked';
      for (let poll = 0; poll < 6; poll += 1) {
        const kickoffState = await readDeepResearchKickoffState();
        attempt.kickoffState = kickoffState;
        if (kickoffState?.status === 'generation-active') {
          return {
            status: 'started',
            attempts,
          };
        }
        if (clicked && kickoffState?.status === 'start-control-missing') {
          return {
            status: 'started',
            attempts,
          };
        }
        if (!clicked && kickoffState?.status === 'start-control-missing') {
          return {
            status: 'not-needed',
            attempts,
          };
        }
        if (poll < 5) {
          await sleep(500);
        }
      }
      if (index < DEEP_RESEARCH_START_ATTEMPTS - 1) {
        await sleep(DEEP_RESEARCH_START_RETRY_DELAY_MS);
      }
    }
    return {
      status: attempts.some((attempt) => attempt?.buttonAttempt?.status === 'clicked') ? 'clicked' : 'not-clicked',
      attempts,
    };
  };

  const verifyAutoSendCommitted = async (baselineSnapshot, maxWaitMs) => {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const state = await readAutoSendState();
      const commitState = evaluateAutoSendCommitState({
        baselineSnapshot,
        promptCandidates: promptMatchCandidates,
        state,
      });
      if (commitState.committed) {
        return {
          status: 'committed',
          committedUserTurn: commitState.committedUserTurn,
          newUserTurnSignature: commitState.newUserTurnSignature,
          state,
        };
      }
      await sleep(150);
    }
    const timedOutState = await readAutoSendState();
    const timedOutCommitState = evaluateAutoSendCommitState({
      baselineSnapshot,
      promptCandidates: promptMatchCandidates,
      state: timedOutState,
    });
    if (timedOutCommitState.committed) {
      return {
        status: 'committed',
        committedUserTurn: timedOutCommitState.committedUserTurn,
        newUserTurnSignature: timedOutCommitState.newUserTurnSignature,
        state: timedOutState,
      };
    }
    return {
      status: 'commit-timeout',
      state: timedOutState,
    };
  };

  const verifyCommittedUserTurnAttachments = async (commitResult, maxWaitMs) => {
    if (!shouldAttachFiles) {
      return {
        status: 'confirmed',
        committedUserTurn: commitResult?.committedUserTurn || null,
      };
    }
    const committedTurnId = String(commitResult?.committedUserTurn?.turnId || '');
    if (!committedTurnId) {
      return {
        status: 'identity-missing',
        verification: committedTurnAttachmentVerification(null, expectedAttachmentNames),
      };
    }

    const deadline = Date.now() + Math.max(1, maxWaitMs);
    let lastVerification = committedTurnAttachmentVerification(
      commitResult.committedUserTurn,
      expectedAttachmentNames,
    );
    while (Date.now() < deadline) {
      const state = await readAutoSendState();
      const matches = (Array.isArray(state?.recentUserTurns) ? state.recentUserTurns : [])
        .filter((turn) => turn?.turnId === committedTurnId);
      if (matches.length > 1) {
        return {
          status: 'ambiguous-turn',
          verification: lastVerification,
        };
      }
      const committedUserTurn = matches[0] || commitResult.committedUserTurn;
      lastVerification = committedTurnAttachmentVerification(
        committedUserTurn,
        expectedAttachmentNames,
      );
      if (lastVerification.confirmed) {
        return {
          status: 'confirmed',
          committedUserTurn,
          verification: lastVerification,
        };
      }
      await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
    }
    return {
      status: 'missing',
      verification: lastVerification,
    };
  };

  const retainAcceptedSendTarget = () => {
    acceptedSendProven = true;
    // Once the exact committed turn is visible, process retry may not resend
    // it. The failure path below relinquishes cleanup for recovery, while a
    // successful waited capture still closes this run-owned target.
    if (ownedTargetSignalCleanup === closeOwnedTargetOnSignal) {
      ownedTargetSignalCleanup = null;
    }
  };

  const persistAcceptedSendIdentity = (commitResult, conversationHref) => {
    const exactConversationHref = extractConversationHref(conversationHref, desiredTargetOrigin);
    if (!exactConversationHref) {
      throw new Error('Auto-send committed, but ReviewGPT could not prove one exact accepted conversation URL. Do not auto-resend.');
    }
    acceptedCaptureIdentity = buildThreadCaptureIdentity({
      browserEndpoint: `http://127.0.0.1:${remotePort}`,
      chatUrl: exactConversationHref,
      committedUserTurn: commitResult.committedUserTurn,
      ...(isDeepResearchMode ? { expectedContentSource: 'deep-research-iframe' } : {}),
      targetId: captureTargetId,
    });
    if (captureMetadataFile) {
      writeThreadCaptureIdentity(captureMetadataFile, acceptedCaptureIdentity);
      console.log('ReviewGPT exact target and committed-turn identity persisted for wake recovery.');
    }
    return exactConversationHref;
  };

  const waitForConversationStateAfterSend = async (committedState, maxWaitMs) => {
    let lastState = committedState || null;
    let stableConversationHref = extractConversationHref(committedState?.href, desiredTargetOrigin);
    let stableConversationCount = stableConversationHref ? 1 : 0;
    let stableConversationState = stableConversationHref
      ? {
          ...(committedState || {}),
          href: stableConversationHref,
          inConversation: true,
          targetMatch: true,
        }
      : committedState || null;

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const autoState = await readAutoSendState();
      const responseState = await readResponseCaptureState();
      const candidates = [responseState, autoState];
      let observedConversationHref = '';
      let observedConversationState = null;

      for (const state of candidates) {
        if (!state) {
          continue;
        }

        if (state.href) {
          lastState = state;
        }

        const conversationHref = extractConversationHref(state.href, desiredTargetOrigin);
        if (!conversationHref) {
          continue;
        }

        if (
          observedConversationHref &&
          conversationHref !== observedConversationHref
        ) {
          observedConversationHref = '';
          observedConversationState = null;
          break;
        }
        observedConversationHref = conversationHref;
        observedConversationState = state;
      }

      if (observedConversationHref === stableConversationHref) {
        stableConversationCount += 1;
      } else if (observedConversationHref) {
        stableConversationHref = observedConversationHref;
        stableConversationCount = 1;
      } else {
        stableConversationHref = '';
        stableConversationCount = 0;
      }

      if (observedConversationHref && observedConversationState) {
        stableConversationState = {
          ...observedConversationState,
          href: observedConversationHref,
          inConversation: true,
          targetMatch: true,
        };
      }

      if (stableConversationHref && stableConversationCount >= 2) {
        return {
          status: 'ready',
          href: stableConversationHref,
          state: stableConversationState,
        };
      }

      await sleep(200);
    }

    return {
      status: stableConversationHref ? 'timeout-with-conversation' : 'timeout-no-conversation',
      href: stableConversationHref,
      state: stableConversationState || lastState,
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
    const sendDeadline = Date.now() + Math.max(8_000, timeoutMs);
    let lastAttempt = { status: 'send-not-attempted' };
    while (Date.now() < sendDeadline) {
      const readiness = await waitForAutoSendReadiness(draftPrompt.length > 0);
      if (readiness?.status === 'timeout') {
        lastAttempt = readiness.buttonAttempt || { status: 'send-readiness-timeout', state: readiness.state };
        break;
      }
      if (readiness?.status === 'composer-refill-needed') {
        const refillResult = await setDraftComposerPrompt(draftPrompt);
        lastAttempt = {
          status: 'composer-refilled-before-send',
          stateBeforeSend: readiness.state,
          refillResult,
        };
        await sleep(150);
        continue;
      }

      const clickAttempt = readiness?.buttonAttempt || await attemptClickSendButton();
      lastAttempt = clickAttempt || { status: 'send-attempt-unknown' };
      if (clickAttempt?.status === 'clicked') {
        const commitResult = await verifyAutoSendCommitted(baselineSnapshot, Math.min(15_000, timeoutMs));
        if (commitResult?.status === 'committed') {
          retainAcceptedSendTarget();
          const acceptedConversation = await resolveAcceptedConversationAfterSend({
            commitResult,
            desiredTargetOrigin,
            maxWaitMs: Math.min(15_000, timeoutMs),
            waitForConversationStateAfterSend,
          });
          const exactConversationHref = persistAcceptedSendIdentity(
            commitResult,
            acceptedConversation.conversationHref,
          );
          const attachmentVerification = await verifyCommittedUserTurnAttachments(
            commitResult,
            Math.min(15_000, timeoutMs),
          );
          if (attachmentVerification.status !== 'confirmed') {
            const failure = new Error(
              `Submitted user turn did not retain every expected attachment (${formatAttachmentVerificationSummary({
                attachedCount: attachmentVerification.verification?.matchedNames?.length || 0,
                expectedCount: expectedAttachmentNames.length,
                missingNames: expectedAttachmentNames.filter(
                  (name) => !attachmentVerification.verification?.matchedNames?.includes(name),
                ),
              })}). The generated ZIP was retained; inspect the accepted thread and do not auto-resend.`,
            );
            failure.reviewGptPostSendAttachmentFailure = true;
            throw failure;
          }
          const deepResearchKickoff = await advanceDeepResearchPlan();
          return {
            status: 'sent',
            method: 'button',
            label: clickAttempt.label,
            state: acceptedConversation.conversationStateResult?.state || commitResult.state,
            conversationHref: exactConversationHref,
            committedUserTurn: attachmentVerification.committedUserTurn,
            committedUserTurnSignature: commitResult.newUserTurnSignature || null,
            deepResearchKickoff,
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
              retainAcceptedSendTarget();
              const acceptedConversation = await resolveAcceptedConversationAfterSend({
                commitResult,
                desiredTargetOrigin,
                maxWaitMs: Math.min(15_000, timeoutMs),
                waitForConversationStateAfterSend,
              });
              const exactConversationHref = persistAcceptedSendIdentity(
                commitResult,
                acceptedConversation.conversationHref,
              );
              const attachmentVerification = await verifyCommittedUserTurnAttachments(
                commitResult,
                Math.min(15_000, timeoutMs),
              );
              if (attachmentVerification.status !== 'confirmed') {
                const failure = new Error(
                  'Submitted user turn did not retain every expected attachment. The generated ZIP was retained; inspect the accepted thread and do not auto-resend.',
                );
                failure.reviewGptPostSendAttachmentFailure = true;
                throw failure;
              }
              const deepResearchKickoff = await advanceDeepResearchPlan();
              return {
                status: 'sent',
                method: 'enter',
                state: acceptedConversation.conversationStateResult?.state || commitResult.state,
                conversationHref: exactConversationHref,
                committedUserTurn: attachmentVerification.committedUserTurn,
                committedUserTurnSignature: commitResult.newUserTurnSignature || null,
                deepResearchKickoff,
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
  const navigation = await cdp('Page.navigate', { url: chatgptUrl });
  if (navigation?.errorText) {
    throw new Error(`ChatGPT target navigation failed: ${navigation.errorText}`);
  }
  await cdp('Runtime.enable');
  await cdp('DOM.enable');
  await keepPageRenderingWhileBackgrounded();
  currentStage = 'auth-probe';
  recordStage();
  const authCheck = await retryTransientUnauthenticatedSession({
    hardRefresh: hardRefreshInitialPageForAuthRetry,
    onRetry: () => {
      console.warn(
        'Initial ChatGPT authentication probe was unauthorized; hard-refreshing once to check for transient startup state.',
      );
    },
    probeAuthenticatedSession,
  });
  if (authStatusIsUnauthenticated(authCheck.authStatus)) {
    throw new Error('ChatGPT session is not authenticated in the managed browser profile. Sign in and retry.');
  }

  currentStage = 'initial-ready';
  recordStage();
  const initialReady = await waitForDraftComposerReady(false);
  if (initialReady?.status !== 'ready') {
    throw new Error(
      `Composer was not ready for draft staging (composer=${Boolean(initialReady?.state?.composerReady)}, fileInput=${Boolean(initialReady?.state?.fileInputReady)}, targetMatch=${Boolean(initialReady?.state?.targetMatch)}).`
    );
  }

  let modelSelection;
  currentStage = 'model-selection';
  recordStage();
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
    // ChatGPT no longer exposes a composer model picker: that control now
    // selects reasoning effort, and the model itself is fixed by the account.
    // Selection therefore cannot be driven or proven from the page, so a failed
    // switch is reported and the configured target is assumed rather than
    // failing the run. The thread still records which model answered.
    console.warn(
      `Draft model not switchable in this UI; assuming ${modelTargetRaw}: ${JSON.stringify(
        modelSelection?.details || modelSelection,
      )}`,
    );
  }

  let thinkingSelection;
  currentStage = 'thinking-selection';
  recordStage();
  try {
    thinkingSelection = await ensureDraftThinkingSelected(
      thinkingTarget,
      evaluate,
      buildThinkingTimeExpression
    );
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

  let appConnectorSelection;
  currentStage = 'app-connector-selection';
  recordStage();
  try {
    appConnectorSelection = await ensureDraftAppConnectorSelected();
  } catch (error) {
    if (isRetryableSocketError(error)) throw error;
    appConnectorSelection = {
      ok: false,
      reason: 'selection-error',
      details: { message: errorMessage(error) },
    };
  }
  if (appConnectorSelection?.ok) {
    if (appConnectorSelection.skipped) {
      console.log(`App connector kept: ${appConnectorSelection.label}`);
    } else {
      console.log(`App connector selected: ${appConnectorSelection.label}`);
    }
  } else {
    console.warn(`App connector selection warning (${appConnectorTarget}): ${JSON.stringify(appConnectorSelection?.details || appConnectorSelection)}`);
  }
  if (shouldSend && !appConnectorSelection?.ok && !isCurrentSelectionTarget(appConnectorTarget)) {
    throw new Error(`App connector selection failed before auto-send (${appConnectorTarget}): ${JSON.stringify(appConnectorSelection?.details || appConnectorSelection)}`);
  }

  if (shouldAttachFiles) {
    currentStage = 'attachments';
    recordStage();
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
      for (let index = 0; index < filesToAttach.length; index += 1) {
        if (index > 0) {
          const stagedComposerReady = await waitForDraftComposerReady(true);
          if (stagedComposerReady?.status !== 'ready') {
            throw new Error(
              `Composer attachment input was not ready between staged uploads (composer=${Boolean(stagedComposerReady?.state?.composerReady)}, fileInput=${Boolean(stagedComposerReady?.state?.fileInputReady)}, targetMatch=${Boolean(stagedComposerReady?.state?.targetMatch)}).`
            );
          }
        }

        const uploadObjectId = await resolveDraftFileInputObjectId();
        if (!uploadObjectId) {
          throw new Error('Could not resolve composer file input object for draft upload');
        }

        await cdp('DOM.setFileInputFiles', {
          objectId: uploadObjectId,
          files: [filesToAttach[index]],
        });
      }

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
      `Draft attachments confirmed (${formatAttachmentVerificationSummary(verification.summary)}).`
    );
  }

  if (draftPrompt.length > 0) {
    currentStage = 'prompt-prefill';
    recordStage();
    const promptSetResult = appConnectorSelection?.preserveComposerPrefix
      ? await appendDraftComposerPromptNatively(draftPrompt)
      : await setDraftComposerPrompt(draftPrompt);
    if (promptSetResult?.ok) {
      console.log(`Draft prompt prefilled in composer (${promptSetResult.length} chars, mode=${promptSetResult.mode}).`);
    } else {
      console.warn(`Draft prompt prefill warning: ${JSON.stringify(promptSetResult || { ok: false })}`);
    }
  }

  console.log(
    shouldAttachFiles
      ? 'Draft prepared in ChatGPT tab: prompt and attachments staged.'
      : 'Draft prepared in ChatGPT tab: prompt staged (no attachments requested).'
  );

  if (!shouldSend) {
    if (shouldAttachFiles) {
      // A staged draft has not been sent, and the composer tile appears while
      // the browser is still reading the file off disk. Removing it here
      // cancels the upload and leaves a draft with no attachment, so
      // draft-only runs retain the generated artifacts.
      console.log('Retained generated local attachment artifact(s) for the unsent draft.');
    }
    retainedIdleDraftTargetId = ownedTargetId;
    ownedTargetId = '';
    if (ownedTargetSignalCleanup === closeOwnedTargetOnSignal) {
      ownedTargetSignalCleanup = null;
    }
  }

  if (shouldSend) {
    currentStage = 'send';
    recordStage();
    const sendResult = await autoSendDraftMessage();
    if (sendResult?.status === 'sent') {
      console.log(`Draft auto-send triggered${sendResult.label ? ` (${sendResult.label})` : ''}.`);
      if (sendResult?.deepResearchKickoff?.status === 'clicked') {
        console.log('Deep Research plan kickoff nudged after auto-send.');
      }
      const reportedConversationHref =
        sendResult?.conversationHref ||
        extractConversationHref(sendResult?.state?.href, desiredTargetOrigin);
      if (reportedConversationHref) {
        console.log(`ChatGPT conversation URL: ${reportedConversationHref}`);
      }
      if (shouldWaitForResponse) {
        waitedAttachmentCleanupPending = true;
        if (isDeepResearchMode) {
          console.log(
            `Deep Research wait in progress: staying attached until the report completes or the wait timeout is hit (${responseTimeoutMs}ms).`
          );
        } else {
          console.log(`Assistant wait in progress: staying attached until the response completes or the wait timeout is hit (${responseTimeoutMs}ms).`);
        }
        currentStage = 'wait-response';
        recordStage();
        const responseResult = await waitForAssistantResponse(
          sendResult.responseBaseline,
          sendResult.committedUserTurn,
          reportedConversationHref,
        );
        assertMarkedResponseDurationTrusted(responseResult, responseFile);
        if (responseResult?.status === 'completed') {
          const completedCaptureIdentity = buildThreadCaptureIdentity({
            assistantSnapshot: responseResult.assistantSnapshot,
            attachmentButtons: responseResult.attachmentButtons,
            browserEndpoint: `http://127.0.0.1:${remotePort}`,
            chatUrl: reportedConversationHref,
            committedUserTurn: sendResult.committedUserTurn,
            ...(isDeepResearchMode ? { expectedContentSource: 'deep-research-iframe' } : {}),
            targetId: captureTargetId,
          });
          const artifacts = writeCompletedResponseArtifacts(
            responseFile,
            responseResult.responseText,
            responseResult.modelVerification,
            completedCaptureIdentity,
            captureMetadataFile,
          );
          const artifactCaptureFailure = declaredArtifactCaptureFailure(
            responseResult.responseText,
            matchingCapturedAssistantArtifacts(
              responseResult.assistantSnapshot,
              responseResult.attachmentButtons,
            ).map(artifactCaptureLabel),
          );
          if (artifactCaptureFailure) {
            throw new Error(artifactCaptureFailure);
          }
          completedResponseCapture = {
            artifacts,
            href: responseResult.href,
            modelVerification: responseResult.modelVerification,
            responseText: responseResult.responseText,
          };
        } else if (responseResult?.status === 'timeout-partial') {
          emitCapturedResponse(responseResult.responseText, responseResult.href, true);
          if (responseFile) {
            writeCapturedResponseFile(responseFile, responseResult.responseText);
          }
        } else if (responseResult?.status === 'timeout-missing-marker') {
          if (responseFile) {
            writeCapturedResponseFile(responseFile, responseResult.responseText);
          }
          throw new Error(missingResponseMarkerMessage(responseMarker, responseResult));
        } else if (responseResult?.status === 'generation-failed') {
          if (responseFile && responseResult.responseText) {
            writeCapturedResponseFile(responseFile, responseResult.responseText);
          }
          const cooldown = responseResult.rateLimited ? ' ChatGPT also exposed a rate/usage-limit signal; cool down before retrying.' : '';
          throw new Error(`ChatGPT generation failed: ${responseResult.failureText}.${cooldown}`);
        } else if (responseResult?.status === 'model-confirmation-failed') {
          if (responseFile) {
            writeCapturedResponseFile(responseFile, responseResult.responseText);
          }
          throw new Error(responseResult.modelConfirmationFailure || 'Assistant response did not confirm the requested model.');
        } else if (responseResult?.status === 'target-identity-failed') {
          throw new Error(responseResult.failureText || 'Assistant response capture lost its exact target identity.');
        } else {
          throw new Error(`Assistant response capture failed: ${JSON.stringify(responseResult || { status: 'unknown' })}`);
        }
      } else {
        cleanupConfirmedDraftAttachments('the send');
      }
      if (!shouldWaitForResponse) {
        ownedTargetId = '';
        if (ownedTargetSignalCleanup === closeOwnedTargetOnSignal) {
          ownedTargetSignalCleanup = null;
        }
      }
    } else {
      throw new Error(`Auto-send failed: ${JSON.stringify(sendResult?.lastAttempt || sendResult || { status: 'unknown' })}`);
    }
  }
  } catch (error) {
    operationError = tagStageError(error);
  }

  if (acceptedSendProven && operationError && !completedResponseCapture) {
    // A committed send must remain available for exact-target wake recovery.
    // Release every socket below, but retain the accepted tab and never resend.
    ownedTargetId = '';
  }

  if (waitedAttachmentCleanupPending) {
    cleanupConfirmedDraftAttachments('the response capture');
  }

  let focusReleaseError = null;
  try {
    await releasePageFocusEmulation();
  } catch (error) {
    focusReleaseError = error;
  }

  if (retainedIdleDraftTargetId && idleDraftTimeoutMs > 0) {
    try {
      registerIdleDraftCleanup({
        port: remotePort,
        targetId: retainedIdleDraftTargetId,
        timeoutMs: idleDraftTimeoutMs,
      });
      console.log(`Idle draft cleanup scheduled after ${idleDraftTimeoutMs}ms.`);
    } catch (error) {
      console.warn(`Could not schedule idle draft cleanup: ${errorMessage(error)}`);
    }
  }

  let cleanupError = null;
  if (ownedTargetId) {
    try {
      await closeBackgroundTarget(ownedTargetId, socketOwner);
    } catch (error) {
      cleanupError = addTargetCleanupContext(error, operationError);
    } finally {
      if (ownedTargetSignalCleanup === closeOwnedTargetOnSignal) {
        ownedTargetSignalCleanup = null;
      }
    }
  }
  try {
    socketOwner.close(ws);
  } catch {}
  if (focusReleaseError && !ownedTargetId) {
    console.warn(
      `Retained ChatGPT target could not release focus emulation: ${errorMessage(focusReleaseError)}`
    );
  }
  if (completedResponseCapture && !operationError) {
    if (cleanupError) {
      console.warn(
        `Completed assistant response preserved despite unconfirmed cleanup for browser target ${ownedTargetId}: ${errorMessage(cleanupError)}`
      );
    }
    if (completedResponseCapture.artifacts.evidenceWarning) {
      console.warn(completedResponseCapture.artifacts.evidenceWarning);
    }
    emitCapturedResponse(
      completedResponseCapture.responseText,
      completedResponseCapture.href,
      false,
    );
    if (completedResponseCapture.artifacts.responseFilePath) {
      console.log(`Assistant response written to ${completedResponseCapture.artifacts.responseFilePath}`);
      if (completedResponseCapture.artifacts.evidencePath) {
        console.log('Assistant model verification written beside the response file.');
      }
    }
    if (completedResponseCapture.artifacts.captureMetadataPath) {
      console.log('Exact assistant response and artifact identity written beside the response capture.');
    }
    if (
      completedResponseCapture.modelVerification &&
      (!completedResponseCapture.artifacts.responseFilePath ||
        completedResponseCapture.artifacts.evidencePath)
    ) {
      console.log(
        `REVIEW_GPT_MODEL_VERIFICATION ${JSON.stringify(completedResponseCapture.modelVerification)}`
      );
    }
    await flushProcessOutput();
    await socketOwner.closeAll();
    return;
  }
  await flushProcessOutput();
  await socketOwner.closeAll();
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
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
        error?.reviewGptTargetCleanupFailure ||
        error?.reviewGptTargetOwnershipUncertain ||
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
  if (!Number.isSafeInteger(minimumMarkedResponseMs) || minimumMarkedResponseMs <= 0) {
    throw new Error('Invalid ORACLE_DRAFT_MINIMUM_MARKED_RESPONSE_MS: expected a positive integer.');
  }
  if (shouldAttachFiles) {
    for (const filePath of filesToAttach) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Draft attachment missing: ${filePath}`);
      }
    }
  }
}

function prepareRuntimeConfig() {
  if (shouldWaitForResponse && responseFile) {
    removeModelVerificationEvidenceFile(responseFile);
  }
  validateRuntimeConfig();
}

if (require.main === module) {
  prepareRuntimeConfig();
  const removeSignalCleanup = installOwnedTargetSignalCleanup();
  mainWithRetry().then(
    async () => {
      removeSignalCleanup();
      await flushProcessOutput();
      process.exit(0);
    },
    async (error) => {
      removeSignalCleanup();
      console.error(`Draft staging failed: ${error instanceof Error ? error.message : String(error)}`);
      await flushProcessOutput();
      process.exit(1);
    },
  );
}

module.exports = {
  buildAttachmentNameMatcher,
  buildExpectedAttachmentNames,
  buildDeepResearchStartClickPoint,
  buildThreadCaptureIdentity,
  declaredArtifactCaptureFailure,
  declaredSingleArtifactSha256,
  committedTurnAttachmentVerification,
  createWebSocketOwner,
  formatAttachmentVerificationSummary,
  authStatusIsUnauthenticated,
  hardRefreshDue,
  isRetryableSocketError,
  appConnectorLabelMatchesTarget,
  appConnectorMentionText,
  formatModelSelectionFailureMessage,
  modelPickerLabelMatchesTarget,
  modelPickerControlLabelCanProveTarget,
  modelPickerControlSelectionProof,
  modelPickerOptionCanTraverseTarget,
  modelPickerOptionElementCanParticipate,
  modelPickerOptionMatchesTarget,
  modelPickerOptionIsFinalTarget,
  modelPickerOptionSelectionProof,
  modelPickerSummarySelectionProof,
  modelPickerSelectionStateMatches,
  modelPickerTextHasWord,
  modelPickerUnavailableReason,
  normalizeAttachmentName,
  normalizeAttachmentSearchText,
  normalizeComparableText,
  normalizeAppConnectorText,
  normalizeModelPickerText,
  normalizeResponseText,
  removeConfirmedAttachmentFiles,
  removeModelVerificationEvidenceFile,
  retryTransientUnauthenticatedSession,
  resolveAcceptedConversationAfterSend,
  extractConversationHref,
  sanitizeDeepResearchResponseText,
  buildPromptMatchCandidates,
  isLikelyPromptEcho,
  evaluateAutoSendCommitState,
  mergeResponseCaptureStates,
  assertMarkedResponseDurationTrusted,
  markedResponseDurationFailure,
  modelAttestationForSnapshot,
  appendModelConfirmationPrompt,
  extractModelConfirmationValue,
  ensureDraftThinkingSelected,
  modelConfirmationFailure,
  timeoutSnapshotMissingResponseMarker,
  modelConfirmationRequired,
  scoreDeepResearchStartButtonCandidate,
  responseStatusTextIndicatesBusy,
  responseStatusTextsIndicateBusy,
  responseStateAssistantFailureText,
  responseStateIndicatesChatGptRateLimit,
  selectAssistantResponseCandidate,
  selectExactAcceptedTarget,
  selectUniqueDeepResearchIframeTarget,
  promptSignatureMatches,
  nextResponseStabilityCount,
  shouldFinishAssistantResponseWait,
  shouldAttemptDeepResearchStartFallback,
  summarizeAttachmentVerification,
  writeCompletedResponseArtifacts,
};
