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

const CHATGPT_USER_TURN_ATTACHMENT_SELECTOR = [
  '[data-testid*="attachment"]',
  '[data-testid*="file"]',
  '[data-testid*="upload"]',
  'a[download]',
  'a[href]',
  'button[aria-label]',
  '[role="group"][aria-label]',
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

// Code-block chrome (language badges and copy controls) can disappear after
// rehydration. Derive those blocks from their code node, while retaining all
// surrounding response text and exact code content in the capture identity.
function readChatGptTurnText(node) {
  const raw = () => String(node?.innerText || node?.textContent || '').trim();
  if (!node?.querySelector?.('pre code') || !node.childNodes) return raw();
  const read = (element) => {
    if (element.nodeType === 3) return element.textContent || '';
    const tag = String(element.tagName || '').toUpperCase();
    if (tag === 'BR') return '\n';
    if (tag === 'PRE') {
      const code = element.querySelector?.('code');
      if (code) return '\n' + String(code.textContent || '') + '\n';
    }
    const text = Array.from(element.childNodes || []).map(read).join('');
    return /^(P|DIV|SECTION|ARTICLE|LI|TR|H[1-6]|BLOCKQUOTE)$/.test(tag)
      ? '\n' + text + '\n'
      : text;
  };
  return normalizeResponseText(read(node));
}

function canonicalizeChatGptTurnNodes(nodes) {
  const orderedNodes = Array.from(nodes || []).filter(Boolean);
  const groups = [];
  const contains = (outer, inner) => {
    if (!outer || !inner) return false;
    if (outer === inner) return true;
    try {
      return typeof outer.contains === 'function' && outer.contains(inner);
    } catch {
      return false;
    }
  };
  const identityRank = (node) => {
    const attributes = ['data-message-id', 'data-turn-id', 'data-testid', 'id'];
    const attributeIndex = attributes.findIndex((attribute) =>
      Boolean(String(node?.getAttribute?.(attribute) || '').trim()),
    );
    return attributeIndex < 0 ? 0 : attributes.length - attributeIndex;
  };
  const preferredNode = (current, candidate) => {
    const currentRank = identityRank(current);
    const candidateRank = identityRank(candidate);
    if (candidateRank !== currentRank) return candidateRank > currentRank ? candidate : current;
    if (contains(current, candidate) && !contains(candidate, current)) return candidate;
    return current;
  };

  for (const node of orderedNodes) {
    const matchingGroupIndexes = [];
    for (const [groupIndex, group] of groups.entries()) {
      if (group.aliases.some((alias) => contains(alias, node) || contains(node, alias))) {
        matchingGroupIndexes.push(groupIndex);
      }
    }
    if (matchingGroupIndexes.length === 0) {
      groups.push({ aliases: [node], node });
      continue;
    }

    const primaryGroup = groups[matchingGroupIndexes[0]];
    primaryGroup.aliases.push(node);
    for (const groupIndex of matchingGroupIndexes.slice(1).reverse()) {
      primaryGroup.aliases.push(...groups[groupIndex].aliases);
      groups.splice(groupIndex, 1);
    }
    primaryGroup.node = primaryGroup.aliases.reduce(preferredNode);
  }

  return groups;
}

function collectChatGptTurnAttachmentTexts(nodes, baseHref, selector) {
  const attachmentTexts = [];
  const seenAttachmentTexts = new Set();
  for (const node of Array.from(nodes || []).filter(Boolean)) {
    const attachmentNodes = Array.from(node.querySelectorAll?.(selector) || []);
    for (const element of attachmentNodes) {
      const href = String(element.href || element.getAttribute?.('href') || '');
      let hrefLabel = '';
      if (href) {
        try {
          hrefLabel = decodeURIComponent(new URL(href, baseHref).pathname.split('/').filter(Boolean).at(-1) || '');
        } catch {}
      }
      const attachmentText = [
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.innerText || element.textContent,
        hrefLabel,
      ].filter(Boolean).join(' ');
      if (!attachmentText || seenAttachmentTexts.has(attachmentText)) continue;
      seenAttachmentTexts.add(attachmentText);
      attachmentTexts.push(attachmentText);
    }
  }
  return attachmentTexts;
}

function normalizeResponseText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collapseAdjacentDuplicateLines(value) {
  const normalized = normalizeResponseText(value);
  if (!normalized) return '';
  const deduped = [];
  for (const rawLine of normalized.split('\n')) {
    const line = String(rawLine || '');
    const trimmed = line.trim();
    const previous = deduped.length > 0 ? deduped[deduped.length - 1] : '';
    const previousTrimmed = String(previous || '').trim();
    const isDuplicate =
      trimmed.length >= 8 &&
      previousTrimmed.length >= 8 &&
      normalizeComparableText(trimmed) === normalizeComparableText(previousTrimmed);
    if (!isDuplicate) deduped.push(line);
  }
  return normalizeResponseText(deduped.join('\n'));
}

function sanitizeDeepResearchResponseText(value) {
  const normalized = normalizeResponseText(value);
  if (!normalized) return '';

  const lines = normalized.split('\n');
  let index = 0;
  let digitLineCount = 0;
  let sawCitationLeadIn = false;
  while (index < lines.length) {
    const line = String(lines[index] || '').trim();
    if (!line) {
      index += 1;
      continue;
    }
    if (/^\d{1,3}$/.test(line)) {
      digitLineCount += 1;
      index += 1;
      continue;
    }
    if (/^(?:\d+\s+)?citations?(?:\s+\d+)?$/i.test(line)) {
      sawCitationLeadIn = true;
      index += 1;
      continue;
    }
    break;
  }

  if (digitLineCount < 5 && !sawCitationLeadIn) {
    return collapseAdjacentDuplicateLines(normalized);
  }
  const cleaned = lines.slice(index).join('\n').trim();
  return collapseAdjacentDuplicateLines(cleaned || normalized);
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

function buildDeepResearchResponseInspectionSource() {
  return `
    (() => {
      const normalize = (value) => String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
      const signatureize = (value) => normalize(value).slice(0, 320);
      const searchRoots = [document];
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        try {
          const frameDoc = frame.contentDocument;
          if (frameDoc?.documentElement) {
            searchRoots.push(frameDoc);
          }
        } catch {}
      }
      const rootSnapshots = searchRoots
        .map((root) => {
          const text = String(root.body?.innerText || '').trim();
          const buttons = Array.from(root.querySelectorAll('button, [role="button"]'))
            .map((node) => String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim())
            .filter(Boolean);
          return {
            text,
            normalizedText: normalize(text),
            buttons,
          };
        })
        .filter((snapshot) => snapshot.text);
      const reportSnapshot =
        rootSnapshots
          .filter((snapshot) =>
            snapshot.normalizedText.includes('research completed') ||
            snapshot.normalizedText.includes('executive summary') ||
            snapshot.normalizedText.includes('scope and methodology')
          )
          .sort((left, right) => right.text.length - left.text.length)[0] ||
        rootSnapshots.sort((left, right) => right.text.length - left.text.length)[0] ||
        null;
      const combinedText = rootSnapshots.map((snapshot) => snapshot.text).join('\\n\\n');
      const normalizedCombinedText = normalize(combinedText);
      const buttonLabels = rootSnapshots.flatMap((snapshot) => snapshot.buttons);
      const stopResearchVisible = buttonLabels.some((label) => normalize(label).startsWith('stop research'));
      const completed = normalizedCombinedText.includes('research completed');
      const busy =
        stopResearchVisible ||
        (
          /\\b(researching|looking for|searching|gathering|analyzing|analysing|browsing|reading|processing|writing)\\b/.test(normalizedCombinedText) &&
          !completed
        );
      const reportText = reportSnapshot?.text || '';
      const assistantSnapshots = reportText
        ? [{
            signature: signatureize(reportText),
            text: reportText,
            hasCopyButton: completed,
          }]
        : [];
      return {
        assistantSnapshots,
        statusTexts: combinedText ? [combinedText.slice(0, 2000)] : [],
        statusBusy: busy,
        stopVisible: stopResearchVisible,
      };
    })()
  `;
}

// Read only visible product UI, never quoted prompts or assistant content.
function collectChatGptCapabilityLimitText() {
  // ChatGPT also puts this footer inside the assistant turn, beside its rendered message.
  const excluded = '[data-message-author-role], [data-turn="user"], [data-testid*="conversation-turn-user"], .markdown, [contenteditable="true"], textarea, pre, code, blockquote';
  const nodes = document.body?.querySelectorAll('div, span, p, footer, [role="alert"], [role="status"]') || [];
  for (const node of nodes) {
    if (node.closest?.(excluded) || node.querySelector?.(excluded)) continue;
    const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 500 || !/^capabilities reduced until\s+/i.test(text)) continue;
    const rect = node.getBoundingClientRect?.();
    const style = window.getComputedStyle(node);
    if (!rect || rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') continue;
    return text;
  }
  return '';
}

function assertChatGptCapabilitiesAvailable(state) {
  const notice = String(state?.capabilityLimitText || '').trim();
  if (!notice) return;
  const error = new Error(
    `REVIEW_GPT_RATE_LIMITED: ${notice} This browser cannot provide a trusted review. Retry a fresh full review on another configured browser lane; keep the requested model and do not reuse this conversation across lanes.`,
  );
  error.code = 'REVIEW_GPT_RATE_LIMITED';
  throw error;
}

function chatGptTextIndicatesRateLimit(value) {
  const normalizedText = normalizeComparableText(value);
  if (!normalizedText) {
    return false;
  }

  return /\b(too many requests|limit reached|reached your limit|you have reached|try again after|rate limit|rate limited|usage limit|message cap|cap reached|capabilities reduced until)\b/.test(
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
  const assistantFailureButtonTextsLiteral = JSON.stringify(Array.from(CHATGPT_ASSISTANT_FAILURE_BUTTON_TEXTS));
  const normalizeComparableTextSource = normalizeComparableText.toString();
  const canonicalizeChatGptTurnNodesSource = canonicalizeChatGptTurnNodes.toString();
  const readChatGptTurnTextSource = readChatGptTurnText.toString();
  const normalizeResponseTextSource = normalizeResponseText.toString();
  const threadStatusTextIndicatesBusySource = threadStatusTextIndicatesBusy.toString();

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
    const canonicalizeChatGptTurnNodes = ${canonicalizeChatGptTurnNodesSource};
    const normalizeResponseText = ${normalizeResponseTextSource};
    const readChatGptTurnText = ${readChatGptTurnTextSource};
    const threadStatusTextIndicatesBusy = ${threadStatusTextIndicatesBusySource};
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
    const assistantTurnGroups = canonicalizeChatGptTurnNodes(
      Array.from(root.querySelectorAll(assistantTurnSelector)),
    );
    const assistantNodes = assistantTurnGroups.map((group) => group.node);
    const assistantTurnGroupFor = (node) =>
      assistantTurnGroups.find((group) => group.aliases.includes(node)) || null;
    const userNodes = canonicalizeChatGptTurnNodes(
      Array.from(root.querySelectorAll(userTurnSelector)),
    ).map((group) => group.node);
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
      const text = readChatGptTurnText(node);
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
      let hasCopyButton = false;
      const assistantAliases = assistantTurnGroupFor(node)?.aliases || [node];
      for (const assistantAlias of assistantAliases) {
        for (const selector of copySelectors) {
          const copyNode = assistantAlias.querySelector?.(selector) || null;
          if (copyNode) {
            hasCopyButton = true;
            break;
          }
        }
        if (hasCopyButton) break;
      }
      assistantSnapshots.push({
        afterLastUserMessage: assistantNodesAfterLastUserSet.has(node),
        assistantTurnId,
        assistantTurnIndex,
        hasCopyButton,
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
      const assistantAliases = assistantTurnGroupFor(node)?.aliases || [node];
      for (const assistantAlias of assistantAliases) {
        for (const button of Array.from(assistantAlias.querySelectorAll?.('button') ?? [])) {
          if (!visible(button)) continue;
          const rawText = String(button.innerText || button.textContent || '').trim();
          const normalized = normalizeComparableText(rawText);
          if (!assistantFailureButtonTexts.has(normalized) || seenAssistantFailureTexts.has(normalized)) continue;
          seenAssistantFailureTexts.add(normalized);
          assistantFailureTexts.push(rawText.slice(0, 500));
        }
      }
    }
    const patchTextSource =
      assistantNodesAfterLastUser.length > 0 || lastUserNode
        ? assistantNodesAfterLastUser
            .map((node) => readChatGptTurnText(node))
            .filter(Boolean)
            .join('\\n\\n')
        : bodyText;
    const attachments = Array.from(root.querySelectorAll('button, a'))
      .map((element) => {
        const rawAssistantContainer = element.closest(assistantTurnSelector);
        const assistantTurnGroup = assistantTurnGroupFor(rawAssistantContainer);
        const assistantContainer = assistantTurnGroup?.node || rawAssistantContainer;
        const assistantTurnIndex = assistantContainer ? assistantNodes.indexOf(assistantContainer) : -1;
        const assistantText = readChatGptTurnText(assistantContainer);
        const assistantSignature = normalizeComparableText(assistantText).slice(0, 320);
        const assistantTurnId = assistantContainer
          ? turnIdentity(assistantContainer, 'assistant', assistantTurnIndex, assistantSignature)
          : '';
        const assistantControls = assistantContainer
          ? Array.from(new Set(
              (assistantTurnGroup?.aliases || [assistantContainer])
                .flatMap((assistantAlias) => Array.from(assistantAlias.querySelectorAll('button, a'))),
            )).filter((control) => {
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
          insideFinalAssistantMessage: Boolean(
            finalAssistantNode &&
            (assistantTurnGroupFor(finalAssistantNode)?.aliases || [finalAssistantNode])
              .some((assistantAlias) => assistantAlias.contains(element)),
          ),
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
      capabilityLimitText: (${collectChatGptCapabilityLimitText.toString()})(),
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
  collectChatGptCapabilityLimitText,
  assertChatGptCapabilitiesAvailable,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COPY_SELECTORS,
  CHATGPT_STATUS_SELECTORS,
  CHATGPT_STOP_SELECTORS,
  CHATGPT_USER_TURN_ATTACHMENT_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  buildChatGptCaptureStateExpression,
  buildDeepResearchResponseInspectionSource,
  canonicalizeChatGptTurnNodes,
  collectChatGptTurnAttachmentTexts,
  chatGptTextIndicatesRateLimit,
  normalizeComparableText,
  normalizeResponseText,
  readChatGptTurnText,
  sanitizeDeepResearchResponseText,
  threadStatusTextIndicatesBusy,
};
