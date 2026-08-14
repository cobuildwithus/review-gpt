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
  '[role="alert"]',
  '[role="status"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
  '[data-testid*="error"]',
  '[data-testid*="status"]',
  '[data-testid*="progress"]',
  '[data-testid*="research"]',
  '[data-testid*="toast"]',
];

const CHATGPT_ASSISTANT_FAILURE_BUTTON_TEXTS = new Set([
  'stopped thinking',
  'thinking failed',
]);

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

function chatGptTextIndicatesRateLimit(value) {
  const normalizedText = normalizeComparableText(value);
  if (!normalizedText) {
    return false;
  }

  return /\b(too many requests|limit reached|reached your limit|you have reached|try again after|rate limit|rate limited|usage limit|message cap|cap reached)\b/.test(
    normalizedText,
  );
}

function extractModelConfirmationText(node, getComputedStyleValue) {
  const excludedTags = new Set(['BLOCKQUOTE', 'CODE', 'PRE']);
  const blockTags = new Set([
    'ARTICLE',
    'DIV',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'LI',
    'OL',
    'P',
    'SECTION',
    'TABLE',
    'TBODY',
    'TD',
    'TH',
    'THEAD',
    'TR',
    'UL',
  ]);
  const chunks = [];
  const appendBreak = () => {
    const lastChunk = chunks.at(-1) || '';
    if (!lastChunk.endsWith('\n')) chunks.push('\n');
  };
  const displayCreatesBoundary = (display) => {
    const normalized = String(display || '').toLowerCase();
    return (
      normalized === 'block' ||
      normalized === 'flex' ||
      normalized === 'grid' ||
      normalized === 'list-item' ||
      normalized === 'table' ||
      normalized.startsWith('table-')
    );
  };
  const visit = (current) => {
    if (!current) return;
    if (current.nodeType === 3) {
      chunks.push(String(current.nodeValue || ''));
      return;
    }

    const tagName = String(current.tagName || '').toUpperCase();
    let computedStyle = null;
    try {
      computedStyle = typeof getComputedStyleValue === 'function'
        ? getComputedStyleValue(current)
        : null;
    } catch {}
    const hidden = Boolean(
      current.hidden ||
      String(current.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true' ||
      computedStyle?.display === 'none' ||
      computedStyle?.visibility === 'hidden'
    );
    if (hidden) return;
    const computedDisplay = String(computedStyle?.display || '').trim();
    const createsBoundary = computedDisplay
      ? displayCreatesBoundary(computedDisplay)
      : blockTags.has(tagName) || tagName === 'BLOCKQUOTE' || tagName === 'PRE';
    if (excludedTags.has(tagName)) {
      if (createsBoundary) appendBreak();
      return;
    }
    if (tagName === 'BR') {
      appendBreak();
      return;
    }

    const isBlock = createsBoundary;
    if (isBlock) appendBreak();
    for (const child of Array.from(current.childNodes || [])) visit(child);
    if (isBlock) appendBreak();
  };

  visit(node);
  return chunks
    .join('')
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/\n{2,}/gu, '\n')
    .trim();
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
  const assistantFailureButtonTextsLiteral = JSON.stringify(Array.from(CHATGPT_ASSISTANT_FAILURE_BUTTON_TEXTS));
  const normalizeComparableTextSource = normalizeComparableText.toString();
  const threadStatusTextIndicatesBusySource = threadStatusTextIndicatesBusy.toString();
  const extractModelConfirmationTextSource = extractModelConfirmationText.toString();

  return `(() => {
    const root = document.querySelector('main') ?? document.body;
    const bodyText = root?.innerText ?? '';
    const assistantTurnSelector = ${assistantTurnSelectorLiteral};
    const userTurnSelector = ${userTurnSelectorLiteral};
    const copySelectors = ${copySelectorsLiteral};
    const stopSelectors = ${stopSelectorsLiteral};
    const statusSelectors = ${statusSelectorsLiteral};
    const assistantFailureButtonTexts = new Set(${assistantFailureButtonTextsLiteral});
    const desiredOrigin = ${desiredOriginLiteral};
    const desiredChatId = ${desiredChatIdLiteral};
    const normalizeComparableText = ${normalizeComparableTextSource};
    const threadStatusTextIndicatesBusy = ${threadStatusTextIndicatesBusySource};
    const extractModelConfirmationText = ${extractModelConfirmationTextSource};
    const visible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const assistantSnapshots = [];
    const turnIdentity = (node, role, index, signature) => {
      const attributes = ['data-message-id', 'data-turn-id', 'data-testid', 'id'];
      for (const attribute of attributes) {
        const value = String(node?.getAttribute?.(attribute) || '').trim();
        if (value) return attribute + ':' + value;
      }
      return role + ':index:' + index + ':signature:' + signature;
    };
    const deriveHrefLabel = (href) => {
      if (!href) return '';
      try {
        return decodeURIComponent(new URL(href, location.href).pathname.split('/').filter(Boolean).at(-1) || '');
      } catch {
        return decodeURIComponent(String(href).split('/').filter(Boolean).at(-1) || '');
      }
    };
    const hasDownloadableHref = (href) => {
      if (!href) return false;
      const normalizedHref = String(href).trim();
      if (!normalizedHref) return false;
      if (normalizedHref.startsWith('sandbox:/mnt/data/')) return true;
      try {
        const url = new URL(normalizedHref, location.href);
        return url.protocol === 'blob:' || url.protocol === 'data:';
      } catch {
        return false;
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
    const userSnapshots = userNodes.map((node, turnIndex) => {
      const signature = normalizeComparableText(node?.innerText || node?.textContent || '').slice(0, 320);
      return {
        signature,
        turnId: turnIdentity(node, 'user', turnIndex, signature),
        turnIndex,
      };
    });
    const lastUserNode = userNodes.at(-1) || null;
    const isAfterLastUserNode = (node) => {
      if (!lastUserNode) return true;
      if (!node || node === lastUserNode || typeof lastUserNode.compareDocumentPosition !== 'function') return false;
      return Boolean(lastUserNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const assistantNodesAfterLastUser = assistantNodes.filter((node) => isAfterLastUserNode(node));
    const assistantNodesAfterLastUserSet = new Set(assistantNodesAfterLastUser);
    const finalAssistantNode = assistantNodesAfterLastUser.at(-1) || (!lastUserNode ? assistantNodes.at(-1) || null : null);
    for (const [assistantTurnIndex, node] of assistantNodes.entries()) {
      const text = String(node?.innerText || node?.textContent || '').trim();
      const signature = normalizeComparableText(text).slice(0, 320);
      if (!text || !signature) continue;
      const precedingUserNode = userNodes
        .filter((userNode) => (
          userNode &&
          userNode !== node &&
          typeof userNode.compareDocumentPosition === 'function' &&
          Boolean(userNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
        ))
        .at(-1) || null;
      const precedingUserMessageSignature = normalizeComparableText(
        precedingUserNode?.innerText || precedingUserNode?.textContent || '',
      ).slice(0, 320);
      const precedingUserTurnIndex = precedingUserNode ? userNodes.indexOf(precedingUserNode) : -1;
      const precedingUserTurnId = precedingUserNode
        ? turnIdentity(precedingUserNode, 'user', precedingUserTurnIndex, precedingUserMessageSignature)
        : '';
      const assistantTurnId = turnIdentity(node, 'assistant', assistantTurnIndex, signature);
      const modelSlug = String(node.getAttribute?.('data-message-model-slug') || '').trim();
      const modelConfirmationText = extractModelConfirmationText(
        node,
        (element) => window.getComputedStyle(element),
      );
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
        assistantTurnId,
        assistantTurnIndex,
        hasCopyButton,
        modelConfirmationText,
        modelSlug,
        precedingUserMessageSignature,
        precedingUserTurnId,
        precedingUserTurnIndex,
        signature,
        text,
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
    const assistantFailureTexts = [];
    const seenAssistantFailureTexts = new Set();
    for (const node of assistantNodesAfterLastUser) {
      for (const button of Array.from(node.querySelectorAll?.('button') ?? [])) {
        if (!visible(button)) continue;
        const rawText = String(button.innerText || button.textContent || '').trim();
        const normalized = normalizeComparableText(rawText);
        if (!assistantFailureButtonTexts.has(normalized) || seenAssistantFailureTexts.has(normalized)) continue;
        seenAssistantFailureTexts.add(normalized);
        assistantFailureTexts.push(rawText.slice(0, 500));
      }
    }
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
        const assistantTurnIndex = assistantContainer ? assistantNodes.indexOf(assistantContainer) : -1;
        const assistantText = String(
          assistantContainer?.innerText || assistantContainer?.textContent || '',
        ).trim();
        const assistantSignature = normalizeComparableText(assistantText).slice(0, 320);
        const assistantTurnId = assistantContainer
          ? turnIdentity(assistantContainer, 'assistant', assistantTurnIndex, assistantSignature)
          : '';
        const assistantControls = assistantContainer
          ? Array.from(assistantContainer.querySelectorAll('button, a')).filter((control) => {
              if (isConversationHref(control.href || null)) return false;
              return control.hasAttribute('download') || control.classList?.contains('behavior-btn') || hasDownloadableHref(control.href || null);
            })
          : [];
        return {
          tag: element.tagName,
          text: (element.innerText || element.getAttribute('aria-label') || '').trim(),
          href: element.href || null,
          download: element.hasAttribute('download'),
          behaviorButton: element.classList?.contains('behavior-btn') ?? false,
          assistantTurnId,
          assistantTurnIndex,
          artifactIndexInAssistantTurn: assistantContainer ? assistantControls.indexOf(element) : -1,
          insideAssistantMessage: Boolean(assistantContainer),
          insideFinalAssistantMessage: Boolean(finalAssistantNode && finalAssistantNode.contains(element)),
          afterLastUserMessage: assistantContainer
            ? assistantNodesAfterLastUserSet.has(assistantContainer)
            : isAfterLastUserNode(element),
        };
      })
      .filter((item) => {
        if (isConversationHref(item.href)) return false;
        return item.download || item.behaviorButton || hasDownloadableHref(item.href);
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
      assistantFailureTexts,
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
      userSnapshots: userSnapshots.slice(-12),
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
  chatGptTextIndicatesRateLimit,
  extractModelConfirmationText,
  threadStatusTextIndicatesBusy,
};
