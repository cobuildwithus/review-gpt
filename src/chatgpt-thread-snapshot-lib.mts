export type ThreadAttachmentButton = {
  afterLastUserMessage?: boolean;
  behaviorButton?: boolean;
  download?: boolean;
  href: string | null;
  insideAssistantMessage?: boolean;
  insideFinalAssistantMessage?: boolean;
  tag: string;
  text: string;
};

export type ThreadAssistantSnapshot = {
  afterLastUserMessage?: boolean;
  hasCopyButton: boolean;
  signature: string;
  text: string;
};

export type ThreadSnapshot = {
  assistantSnapshots: ThreadAssistantSnapshot[];
  attachmentButtons: ThreadAttachmentButton[];
  bodyText: string;
  codeBlocks: string[];
  href: string;
  patchMarkers: {
    addFile: boolean;
    beginPatch: boolean;
    deleteFile: boolean;
    diffGit: boolean;
    updateFile: boolean;
  };
  statusBusy: boolean;
  statusTexts: string[];
  stopVisible: boolean;
  title: string;
};

export type ExportedThreadSnapshot = ThreadSnapshot & {
  capturedAt: string;
  chatUrl: string;
};

const EMPTY_PATCH_MARKERS: ThreadSnapshot['patchMarkers'] = {
  addFile: false,
  beginPatch: false,
  deleteFile: false,
  diffGit: false,
  updateFile: false,
};

export function normalizeThreadSnapshot(snapshot: Partial<ThreadSnapshot> | null | undefined): ThreadSnapshot {
  return {
    assistantSnapshots: Array.isArray(snapshot?.assistantSnapshots) ? snapshot.assistantSnapshots : [],
    attachmentButtons: Array.isArray(snapshot?.attachmentButtons) ? snapshot.attachmentButtons : [],
    bodyText: typeof snapshot?.bodyText === 'string' ? snapshot.bodyText : '',
    codeBlocks: Array.isArray(snapshot?.codeBlocks) ? snapshot.codeBlocks : [],
    href: typeof snapshot?.href === 'string' ? snapshot.href : '',
    patchMarkers: {
      ...EMPTY_PATCH_MARKERS,
      ...(snapshot?.patchMarkers ?? {}),
    },
    statusBusy: Boolean(snapshot?.statusBusy),
    statusTexts: Array.isArray(snapshot?.statusTexts) ? snapshot.statusTexts : [],
    stopVisible: Boolean(snapshot?.stopVisible),
    title: typeof snapshot?.title === 'string' ? snapshot.title : '',
  };
}

const DOWNLOADABLE_ATTACHMENT_FILE_PATTERN = /\.(patch|diff|zip|txt|json|md|patched)\b/iu;
const THREAD_ATTACHMENT_KEYWORD_PATTERN = /\b(?:archive|zip|file|files|download|attachment|snapshot)\b/iu;
const PATCH_ATTACHMENT_FILE_PATTERN = /\.(patch|diff|patched)\b/iu;
const PATCH_ARCHIVE_FILE_PATTERN = /\.zip\b/iu;
const PATCH_BUTTON_TEXT_PATTERN = /\b(?:patch|diff)\b/iu;
const ASSISTANT_ARTIFACT_BUTTON_TEXT_PATTERN = /\b(?:patch|diff|zip|snapshot|files?)\b/iu;
const ARTIFACT_REFERENCE_TEXT_PATTERN = /\b(?:patch|diff|zip|download|attachment|artifact|file|files)\b/iu;
const TERMINAL_ASSISTANT_PUNCTUATION_PATTERN = /[.!?:)\]"'`…]$/u;

function scopeItemsToLatestUser<T extends { afterLastUserMessage?: boolean }>(items: T[]): T[] {
  if (!items.some((item) => typeof item.afterLastUserMessage === 'boolean')) {
    return items;
  }
  return items.filter((item) => item.afterLastUserMessage === true);
}

function assistantSnapshotsForLatestUser(snapshot: ThreadSnapshot): ThreadAssistantSnapshot[] {
  return scopeItemsToLatestUser(snapshot.assistantSnapshots);
}

function attachmentButtonsForLatestUser(snapshot: ThreadSnapshot): ThreadAttachmentButton[] {
  return scopeItemsToLatestUser(snapshot.attachmentButtons);
}

function snapshotTextContainsPatchMarkers(text: string): boolean {
  return (
    text.includes('*** Begin Patch') ||
    text.includes('diff --git') ||
    text.includes('*** Add File:') ||
    text.includes('*** Update File:') ||
    text.includes('*** Delete File:')
  );
}

export function normalizeAttachmentValue(value: unknown): string {
  return String(value ?? '').trim();
}

export function deriveAttachmentHrefLabel(href: string | null | undefined): string {
  const normalizedHref = normalizeAttachmentValue(href);
  if (normalizedHref.length === 0) {
    return '';
  }

  try {
    const pathname = new URL(normalizedHref, 'https://chatgpt.com').pathname;
    return decodeURIComponent(pathname.split('/').filter(Boolean).at(-1) ?? '');
  } catch {
    return decodeURIComponent(normalizedHref.split('/').filter(Boolean).at(-1) ?? '');
  }
}

export function deriveAttachmentLabel(item: Pick<ThreadAttachmentButton, 'href' | 'text'> | string): string {
  const text = normalizeAttachmentValue(typeof item === 'string' ? item : item.text);
  const hrefLabel = deriveAttachmentHrefLabel(typeof item === 'string' ? '' : item.href);

  if (hrefLabel.length > 0 && PATCH_ATTACHMENT_FILE_PATTERN.test(hrefLabel) && !PATCH_ATTACHMENT_FILE_PATTERN.test(text)) {
    return hrefLabel;
  }

  if (text.length > 0) {
    return text;
  }

  return hrefLabel;
}

export function isChatConversationHref(href: string | null | undefined): boolean {
  const normalizedHref = normalizeAttachmentValue(href);
  if (normalizedHref.length === 0) {
    return false;
  }

  try {
    const url = new URL(normalizedHref, 'https://chatgpt.com');
    return /^\/c\/[^/]+$/u.test(url.pathname);
  } catch {
    return /^\/?c\/[^/]+$/u.test(normalizedHref);
  }
}

export function isThreadAttachmentCandidate(item: ThreadAttachmentButton): boolean {
  const text = normalizeAttachmentValue(item.text);
  const href = normalizeAttachmentValue(item.href);
  const hrefLabel = deriveAttachmentHrefLabel(href);

  if (isChatConversationHref(href)) {
    return false;
  }

  return (
    Boolean(item.download) ||
    (Boolean(item.behaviorButton) &&
      Boolean(item.insideAssistantMessage) &&
      (PATCH_BUTTON_TEXT_PATTERN.test(text) || ASSISTANT_ARTIFACT_BUTTON_TEXT_PATTERN.test(text))) ||
    DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(text) ||
    DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(href) ||
    DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(hrefLabel) ||
    THREAD_ATTACHMENT_KEYWORD_PATTERN.test(text)
  );
}

export function isPatchArtifactAttachment(item: ThreadAttachmentButton): boolean {
  const label = deriveAttachmentLabel(item);
  const href = normalizeAttachmentValue(item.href);
  const assistantDownloadControl = Boolean(item.download) && Boolean(item.insideAssistantMessage);
  const assistantArtifact = Boolean(item.insideAssistantMessage) || Boolean(item.insideFinalAssistantMessage);

  if (label.length === 0 && !assistantDownloadControl) {
    return false;
  }

  return (
    PATCH_ATTACHMENT_FILE_PATTERN.test(label) ||
    PATCH_ATTACHMENT_FILE_PATTERN.test(href) ||
    ((PATCH_ARCHIVE_FILE_PATTERN.test(label) || PATCH_ARCHIVE_FILE_PATTERN.test(href)) && assistantArtifact) ||
    assistantDownloadControl ||
    (Boolean(item.behaviorButton) && assistantArtifact && ASSISTANT_ARTIFACT_BUTTON_TEXT_PATTERN.test(label))
  );
}

export function extractAssistantArtifactButtons(
  snapshot: Pick<ThreadSnapshot, 'attachmentButtons'> | Partial<ThreadSnapshot> | null | undefined,
): ThreadAttachmentButton[] {
  const normalized = normalizeThreadSnapshot(snapshot);
  const latestUserAttachments = attachmentButtonsForLatestUser(normalized);
  const attachments = latestUserAttachments.filter(
    (attachment) => Boolean(attachment.insideAssistantMessage) && isThreadAttachmentCandidate(attachment),
  );
  const finalAssistantAttachments = attachments.filter((attachment) => attachment.insideFinalAssistantMessage);
  if (finalAssistantAttachments.length > 0) {
    return finalAssistantAttachments;
  }
  if (attachments.length > 0) {
    return attachments;
  }

  const hasAssistantOwnershipMetadata = latestUserAttachments.some(
    (attachment) =>
      typeof attachment.insideAssistantMessage === 'boolean' || typeof attachment.insideFinalAssistantMessage === 'boolean',
  );
  if (!hasAssistantOwnershipMetadata) {
    return latestUserAttachments.filter(
      (attachment) => isThreadAttachmentCandidate(attachment) && isPatchArtifactAttachment(attachment),
    );
  }

  return [];
}

export function extractAssistantArtifactLabels(
  snapshot: Pick<ThreadSnapshot, 'attachmentButtons'> | Partial<ThreadSnapshot> | null | undefined,
): string[] {
  return [
    ...new Set(
      extractAssistantArtifactButtons(snapshot)
        .map((attachment) => deriveAttachmentLabel(attachment))
        .filter((label) => label.length > 0),
    ),
  ];
}

export function snapshotHasAssistantArtifacts(snapshot: Partial<ThreadSnapshot> | null | undefined): boolean {
  return extractAssistantArtifactButtons(snapshot).length > 0;
}

export function threadStatusTextIndicatesBusy(value: string): boolean {
  const normalizedText = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalizedText) {
    return false;
  }

  if (
    /\b(complete|completed|finished|done|ready|available|success|succeeded)\b/iu.test(normalizedText) &&
    !/\b(in progress|underway|running|starting|processing|loading|researching|searching|gathering|analyzing|analysing|browsing|writing|reading|thinking|working|drafting|generating|synthesizing)\b/iu.test(normalizedText)
  ) {
    return false;
  }

  if (/\b(in progress|underway|running|starting|working|pending|queued)\b/iu.test(normalizedText)) {
    return true;
  }

  return /\b(researching|searching|gathering|analyzing|analysing|browsing|writing|reading|processing|loading|thinking|drafting|generating|synthesizing)\b/iu.test(
    normalizedText,
  );
}

export function threadStatusTextIndicatesComplete(value: string): boolean {
  const normalizedText = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (!normalizedText) {
    return false;
  }

  return (
    /\b(complete|completed|finished|done|ready|available|success|succeeded)\b/iu.test(normalizedText) &&
    !threadStatusTextIndicatesBusy(normalizedText)
  );
}

function lastAssistantText(snapshot: ThreadSnapshot): string {
  return String(assistantSnapshotsForLatestUser(snapshot).at(-1)?.text ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function assistantSnapshotLooksTerminal(snapshot: Partial<ThreadSnapshot> | null | undefined): boolean {
  const normalized = normalizeThreadSnapshot(snapshot);

  if (snapshotHasAssistantArtifacts(normalized) || snapshotHasPatchArtifacts(normalized)) {
    return true;
  }

  const lastText = lastAssistantText(normalized);
  if (lastText.length === 0) {
    return false;
  }

  if (normalized.statusTexts.some((statusText) => threadStatusTextIndicatesComplete(statusText))) {
    return true;
  }

  if (ARTIFACT_REFERENCE_TEXT_PATTERN.test(lastText)) {
    return false;
  }

  return TERMINAL_ASSISTANT_PUNCTUATION_PATTERN.test(lastText);
}

export function assistantSnapshotLooksIncomplete(snapshot: Partial<ThreadSnapshot> | null | undefined): boolean {
  const normalized = normalizeThreadSnapshot(snapshot);
  return lastAssistantText(normalized).length > 0 && !assistantSnapshotLooksTerminal(normalized);
}

export function snapshotHasPatchArtifacts(snapshot: Partial<ThreadSnapshot> | null | undefined): boolean {
  const normalized = normalizeThreadSnapshot(snapshot);
  const scopedAssistantSnapshots = assistantSnapshotsForLatestUser(normalized);

  if (
    scopedAssistantSnapshots.some((assistantSnapshot) => snapshotTextContainsPatchMarkers(assistantSnapshot.text)) ||
    (
      !normalized.assistantSnapshots.some((assistantSnapshot) => typeof assistantSnapshot.afterLastUserMessage === 'boolean') &&
      (normalized.patchMarkers.beginPatch || normalized.patchMarkers.diffGit || normalized.patchMarkers.addFile || normalized.patchMarkers.updateFile || normalized.patchMarkers.deleteFile)
    )
  ) {
    return true;
  }

  return attachmentButtonsForLatestUser(normalized).some((attachment) => isPatchArtifactAttachment(attachment));
}

type SnapshotBusyInput = Partial<Pick<ThreadSnapshot, 'assistantSnapshots' | 'attachmentButtons' | 'patchMarkers' | 'statusBusy' | 'stopVisible'>>;

export function snapshotBusyReason(
  snapshot: SnapshotBusyInput | null | undefined,
): 'assistant-settling' | 'idle' | 'status-busy' | 'stop-visible' {
  const normalized = normalizeThreadSnapshot(snapshot);

  if (normalized.statusBusy) {
    return 'status-busy';
  }

  if (assistantSnapshotLooksIncomplete(normalized)) {
    return 'assistant-settling';
  }

  if (normalized.stopVisible && !snapshotHasAssistantArtifacts(normalized) && !snapshotHasPatchArtifacts(normalized)) {
    return 'stop-visible';
  }

  return 'idle';
}

export function snapshotIndicatesBusy(snapshot: Pick<ThreadSnapshot, 'statusBusy' | 'stopVisible'> | null | undefined): boolean {
  const normalized = normalizeThreadSnapshot(snapshot);

  if (normalized.statusBusy) {
    return true;
  }

  if (assistantSnapshotLooksIncomplete(normalized)) {
    return true;
  }

  return normalized.stopVisible && !snapshotHasPatchArtifacts(normalized);
}

export function hasThreadPayload(snapshot: Partial<ThreadSnapshot> | null | undefined): boolean {
  const normalized = normalizeThreadSnapshot(snapshot);

  if (normalized.patchMarkers.beginPatch || normalized.patchMarkers.diffGit || normalized.patchMarkers.addFile || normalized.patchMarkers.updateFile || normalized.patchMarkers.deleteFile) {
    return true;
  }

  if (normalized.assistantSnapshots.length > 0) {
    return true;
  }

  return normalized.attachmentButtons.some((attachment) => isThreadAttachmentCandidate(attachment));
}

export function buildCaptureThreadSnapshotExpression(): string {
  return `(() => {
    const root = document.querySelector('main') ?? document.body;
    const bodyText = root?.innerText ?? '';
    const filePattern = /\\.(patch|diff|zip|txt|json|md|patched)\\b/i;
    const keywordPattern = /\\b(?:patch|diff|archive|zip|file|download|attachment)\\b/i;
    const assistantTurnSelector =
      'article[data-message-author-role="assistant"], div[data-message-author-role="assistant"], section[data-message-author-role="assistant"], ' +
      'article[data-turn="assistant"], div[data-turn="assistant"], section[data-turn="assistant"], ' +
      'article[data-testid*="conversation-turn-assistant"], div[data-testid*="conversation-turn-assistant"], section[data-testid*="conversation-turn-assistant"]';
    const userTurnSelector =
      'article[data-message-author-role="user"], div[data-message-author-role="user"], section[data-message-author-role="user"], ' +
      'article[data-turn="user"], div[data-turn="user"], section[data-turn="user"], ' +
      'article[data-testid*="conversation-turn-user"], div[data-testid*="conversation-turn-user"], section[data-testid*="conversation-turn-user"]';
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
      .replace(/\\s+/g, ' ')
      .trim();
    const statusTextIndicatesBusy = (value) => {
      const normalizedText = normalize(value);
      if (!normalizedText) return false;
      if (
        /\\b(complete|completed|finished|done|ready|available|success|succeeded)\\b/.test(normalizedText) &&
        !/\\b(in progress|underway|running|starting|processing|loading|researching|searching|gathering|analyzing|analysing|browsing|writing|reading|thinking|working|drafting|generating|synthesizing)\\b/.test(normalizedText)
      ) {
        return false;
      }
      if (/\\b(in progress|underway|running|starting|working|pending|queued)\\b/.test(normalizedText)) {
        return true;
      }
      return /\\b(researching|searching|gathering|analyzing|analysing|browsing|writing|reading|processing|loading|thinking|drafting|generating|synthesizing)\\b/.test(normalizedText);
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
      const signature = normalize(text).slice(0, 320);
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
        const normalized = normalize(rawText);
        if (!normalized || seenStatusTexts.has(normalized)) continue;
        seenStatusTexts.add(normalized);
        statusTexts.push(rawText.slice(0, 500));
      }
    }
    const statusBusy = statusTexts.some((text) => statusTextIndicatesBusy(text));
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

    return {
      assistantSnapshots: assistantSnapshots.slice(-12),
      href: location.href,
      title: document.title,
      patchMarkers: {
        beginPatch: patchTextSource.includes('*** Begin Patch'),
        diffGit: patchTextSource.includes('diff --git'),
        addFile: patchTextSource.includes('*** Add File:'),
        updateFile: patchTextSource.includes('*** Update File:'),
        deleteFile: patchTextSource.includes('*** Delete File:'),
      },
      attachmentButtons: attachments,
      codeBlocks,
      bodyText,
      statusTexts: statusTexts.slice(0, 8),
      statusBusy,
      stopVisible,
    };
  })()`;
}
