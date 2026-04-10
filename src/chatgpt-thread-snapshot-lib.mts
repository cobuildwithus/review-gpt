import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildChatGptCaptureStateExpression,
  threadStatusTextIndicatesBusy,
} = require('./chatgpt-dom-snapshot-shared.js') as typeof import('./chatgpt-dom-snapshot-shared.js');

export { threadStatusTextIndicatesBusy };

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

  if (normalized.stopVisible && !snapshotHasAssistantArtifacts(normalized) && !snapshotHasPatchArtifacts(normalized)) {
    return 'stop-visible';
  }

  if (assistantSnapshotLooksIncomplete(normalized)) {
    return 'assistant-settling';
  }

  return 'idle';
}

export function snapshotIndicatesBusy(snapshot: SnapshotBusyInput | null | undefined): boolean {
  const normalized = normalizeThreadSnapshot(snapshot);

  if (normalized.statusBusy) {
    return true;
  }

  if (normalized.stopVisible && !snapshotHasAssistantArtifacts(normalized) && !snapshotHasPatchArtifacts(normalized)) {
    return true;
  }

  if (assistantSnapshotLooksIncomplete(normalized)) {
    return true;
  }

  return false;
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
  return buildChatGptCaptureStateExpression();
}
