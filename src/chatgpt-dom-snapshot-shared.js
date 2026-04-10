const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  'article[data-message-author-role="assistant"]',
  'div[data-message-author-role="assistant"]',
  'section[data-message-author-role="assistant"]',
  'article[data-turn="assistant"]',
  'div[data-turn="assistant"]',
  'section[data-turn="assistant"]',
  'article[data-testid*="conversation-turn-assistant"]',
  'div[data-testid*="conversation-turn-assistant"]',
  'section[data-testid*="conversation-turn-assistant"]',
].join(', ');

const CHATGPT_USER_TURN_SELECTOR = [
  'article[data-message-author-role="user"]',
  'div[data-message-author-role="user"]',
  'section[data-message-author-role="user"]',
  'article[data-turn="user"]',
  'div[data-turn="user"]',
  'section[data-turn="user"]',
  'article[data-testid*="conversation-turn-user"]',
  'div[data-testid*="conversation-turn-user"]',
  'section[data-testid*="conversation-turn-user"]',
].join(', ');

const CHATGPT_COPY_SELECTORS = [
  'button[aria-label*="Copy"]',
  'button[aria-label*="copy"]',
  'button[data-testid*="copy"]',
  'button[title*="Copy"]',
  'button[title*="copy"]',
];

const CHATGPT_STOP_SELECTORS = [
  '[data-testid="stop-button"]',
  'button[aria-label*="Stop"]',
  'button[aria-label*="stop"]',
];

const CHATGPT_STATUS_SELECTORS = [
  '[role="status"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
  '[data-testid*="status"]',
  '[data-testid*="progress"]',
  '[data-testid*="research"]',
];

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function threadStatusTextIndicatesBusy(value) {
  const normalizedText = normalizeComparableText(value);
  if (!normalizedText) {
    return false;
  }

  if (
    /\b(complete|completed|finished|done|ready|available|success|succeeded)\b/.test(normalizedText) &&
    !/\b(in progress|underway|running|starting|processing|loading|researching|searching|gathering|analyzing|analysing|browsing|writing|reading|thinking|working|drafting|generating|synthesizing)\b/.test(normalizedText)
  ) {
    return false;
  }

  if (/\b(in progress|underway|running|starting|working|pending|queued)\b/.test(normalizedText)) {
    return true;
  }

  return /\b(researching|searching|gathering|analyzing|analysing|browsing|writing|reading|processing|loading|thinking|drafting|generating|synthesizing)\b/.test(
    normalizedText,
  );
}

function buildChatGptCaptureStateExpression({
  desiredChatId = '',
  desiredOrigin = '',
} = {}) {
  const desiredChatIdLiteral = JSON.stringify(String(desiredChatId || '').trim().toLowerCase());
  const desiredOriginLiteral = JSON.stringify(String(desiredOrigin || '').trim());
  const assistantTurnSelectorLiteral = JSON.stringify(CHATGPT_ASSISTANT_TURN_SELECTOR);
  const userTurnSelectorLiteral = JSON.stringify(CHATGPT_USER_TURN_SELECTOR);
  const copySelectorsLiteral = JSON.stringify(CHATGPT_COPY_SELECTORS);
  const stopSelectorsLiteral = JSON.stringify(CHATGPT_STOP_SELECTORS);
  const statusSelectorsLiteral = JSON.stringify(CHATGPT_STATUS_SELECTORS);
  const normalizeComparableTextSource = normalizeComparableText.toString();
  const threadStatusTextIndicatesBusySource = threadStatusTextIndicatesBusy.toString();

  return `(() => {
    const root = document.querySelector('main') ?? document.body;
    const bodyText = root?.innerText ?? '';
    const filePattern = /\\.(patch|diff|zip|txt|json|md|patched)\\b/i;
    const keywordPattern = /\\b(?:patch|diff|archive|zip|file|download|attachment)\\b/i;
    const assistantTurnSelector = ${assistantTurnSelectorLiteral};
    const userTurnSelector = ${userTurnSelectorLiteral};
    const copySelectors = ${copySelectorsLiteral};
    const stopSelectors = ${stopSelectorsLiteral};
    const statusSelectors = ${statusSelectorsLiteral};
    const desiredOrigin = ${desiredOriginLiteral};
    const desiredChatId = ${desiredChatIdLiteral};
    const normalizeComparableText = ${normalizeComparableTextSource};
    const threadStatusTextIndicatesBusy = ${threadStatusTextIndicatesBusySource};
    const visible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const assistantSnapshots = [];
    const deriveHrefLabel = (href) => {
      if (!href) return '';
      try {
        return decodeURIComponent(new URL(href, location.href).pathname.split('/').filter(Boolean).at(-1) || '');
      } catch {
        return decodeURIComponent(String(href).split('/').filter(Boolean).at(-1) || '');
      }
    };
    const isConversationHref = (href) => {
      if (!href) return false;
      try {
        return /^\\/c\\/[^/]+$/u.test(new URL(href, location.href).pathname);
      } catch {
        return /^\\/?c\\/[^/]+$/u.test(String(href));
      }
    };
    const assistantNodes = Array.from(root.querySelectorAll(assistantTurnSelector));
    const userNodes = Array.from(root.querySelectorAll(userTurnSelector));
    const lastUserNode = userNodes.at(-1) || null;
    const isAfterLastUserNode = (node) => {
      if (!lastUserNode) return true;
      if (!node || node === lastUserNode || typeof lastUserNode.compareDocumentPosition !== 'function') return false;
      return Boolean(lastUserNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const assistantNodesAfterLastUser = assistantNodes.filter((node) => isAfterLastUserNode(node));
    const assistantNodesAfterLastUserSet = new Set(assistantNodesAfterLastUser);
    const finalAssistantNode = assistantNodesAfterLastUser.at(-1) || (!lastUserNode ? assistantNodes.at(-1) || null : null);
    for (const node of assistantNodes) {
      const text = String(node?.innerText || node?.textContent || '').trim();
      const signature = normalizeComparableText(text).slice(0, 320);
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
        afterLastUserMessage: assistantNodesAfterLastUserSet.has(node),
        hasCopyButton,
        signature,
        text: text.slice(0, 20000),
      });
    }
    const statusTexts = [];
    const seenStatusTexts = new Set();
    for (const selector of statusSelectors) {
      for (const node of Array.from(root.querySelectorAll(selector))) {
        if (!visible(node)) continue;
        const rawText = String(node.innerText || node.textContent || '').trim();
        const normalized = normalizeComparableText(rawText);
        if (!normalized || seenStatusTexts.has(normalized)) continue;
        seenStatusTexts.add(normalized);
        statusTexts.push(rawText.slice(0, 500));
      }
    }
    const statusBusy = statusTexts.some((text) => threadStatusTextIndicatesBusy(text));
    const stopVisible = stopSelectors.some((selector) => Array.from(root.querySelectorAll(selector)).some((node) => visible(node)));
    const patchTextSource =
      assistantNodesAfterLastUser.length > 0 || lastUserNode
        ? assistantNodesAfterLastUser
            .map((node) => String(node?.innerText || node?.textContent || '').trim())
            .filter(Boolean)
            .join('\\n\\n')
        : bodyText;
    const attachments = Array.from(root.querySelectorAll('button, a'))
      .map((element) => {
        const assistantContainer = element.closest(assistantTurnSelector);
        return {
          tag: element.tagName,
          text: (element.innerText || element.getAttribute('aria-label') || '').trim(),
          href: element.href || null,
          download: element.hasAttribute('download'),
          behaviorButton: element.classList?.contains('behavior-btn') ?? false,
          insideAssistantMessage: Boolean(assistantContainer),
          insideFinalAssistantMessage: Boolean(finalAssistantNode && finalAssistantNode.contains(element)),
          afterLastUserMessage: assistantContainer
            ? assistantNodesAfterLastUserSet.has(assistantContainer)
            : isAfterLastUserNode(element),
        };
      })
      .filter((item) => {
        const hrefLabel = deriveHrefLabel(item.href);
        if (isConversationHref(item.href)) return false;
        if (item.download || item.behaviorButton) return true;
        return (
          filePattern.test(item.text) ||
          filePattern.test(item.href || '') ||
          filePattern.test(hrefLabel) ||
          keywordPattern.test(item.text)
        );
      });
    const codeBlocks = Array.from(root.querySelectorAll('pre'))
      .map((element) => element.innerText)
      .filter(Boolean);
    const readyState = document.readyState || '';
    const href = typeof location === 'object' && location.href ? location.href : '';
    const inConversation = /\\/c\\//.test(href);
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
      assistantSnapshots: assistantSnapshots.slice(-12),
      attachmentButtons: attachments,
      bodyText,
      codeBlocks,
      href,
      inConversation,
      patchMarkers: {
        beginPatch: patchTextSource.includes('*** Begin Patch'),
        diffGit: patchTextSource.includes('diff --git'),
        addFile: patchTextSource.includes('*** Add File:'),
        updateFile: patchTextSource.includes('*** Update File:'),
        deleteFile: patchTextSource.includes('*** Delete File:'),
      },
      readyState,
      statusTexts: statusTexts.slice(0, 8),
      statusBusy,
      stopVisible,
      targetMatch,
      title: document.title,
    };
  })()`;
}

module.exports = {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COPY_SELECTORS,
  CHATGPT_STATUS_SELECTORS,
  CHATGPT_STOP_SELECTORS,
  CHATGPT_USER_TURN_SELECTOR,
  buildChatGptCaptureStateExpression,
  threadStatusTextIndicatesBusy,
};
