export type ThreadAttachmentButton = {
  href: string | null;
  tag: string;
  text: string;
};

export type ThreadAssistantSnapshot = {
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

export function snapshotIndicatesBusy(snapshot: Pick<ThreadSnapshot, 'statusBusy' | 'stopVisible'>): boolean {
  return Boolean(snapshot.stopVisible || snapshot.statusBusy);
}

export function hasThreadPayload(snapshot: ThreadSnapshot): boolean {
  if (snapshot.patchMarkers.beginPatch || snapshot.patchMarkers.diffGit || snapshot.patchMarkers.addFile || snapshot.patchMarkers.updateFile || snapshot.patchMarkers.deleteFile) {
    return true;
  }

  if (snapshot.assistantSnapshots.length > 0) {
    return true;
  }

  return snapshot.attachmentButtons.some((attachment) => {
    const label = attachment.text.trim();
    return label.length > 0 && !/^Add files and more$/iu.test(label);
  });
}

export function buildCaptureThreadSnapshotExpression(): string {
  return `(() => {
    const bodyText = document.body?.innerText ?? '';
    const filePattern = /\\.(patch|diff|zip|txt|json|md)\\b/i;
    const keywordPattern = /patch|diff|archive|zip|file/i;
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
    const assistantNodes = Array.from(document.querySelectorAll(assistantTurnSelector));
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
        hasCopyButton,
        signature,
        text: text.slice(0, 20000),
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
    const statusBusy = statusTexts.some((text) => statusTextIndicatesBusy(text));
    const stopVisible = stopSelectors.some((selector) => Array.from(document.querySelectorAll(selector)).some((node) => visible(node)));
    const attachments = Array.from(document.querySelectorAll('button, a'))
      .map((element) => ({
        tag: element.tagName,
        text: (element.innerText || element.getAttribute('aria-label') || '').trim(),
        href: element.href || null,
      }))
      .filter((item) => filePattern.test(item.text) || filePattern.test(item.href || '') || keywordPattern.test(item.text));
    const codeBlocks = Array.from(document.querySelectorAll('pre'))
      .map((element) => element.innerText)
      .filter(Boolean);

    return {
      assistantSnapshots: assistantSnapshots.slice(-12),
      href: location.href,
      title: document.title,
      patchMarkers: {
        beginPatch: bodyText.includes('*** Begin Patch'),
        diffGit: bodyText.includes('diff --git'),
        addFile: bodyText.includes('*** Add File:'),
        updateFile: bodyText.includes('*** Update File:'),
        deleteFile: bodyText.includes('*** Delete File:'),
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
