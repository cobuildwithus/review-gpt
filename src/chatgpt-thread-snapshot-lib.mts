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

export type ThreadAssistantDownloadButton = ThreadAttachmentButton & {
  artifactIndex: number;
  hrefLabel: string;
  label: string;
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
const PATCH_ATTACHMENT_FILE_PATTERN = /\.(patch|diff|patched)\b/iu;
const PATCH_ARCHIVE_FILE_PATTERN = /\.zip\b/iu;
const DOWNLOAD_ACTION_TEXT_PATTERN = /\bdownload\b/iu;
const PATCH_DOWNLOAD_CONTROL_TEXT_PATTERN = /\bdownload(?: the)? (?:patch|diff)\b/iu;
const SANDBOX_ATTACHMENT_PREFIX = 'sandbox:/mnt/data/';
const MARKDOWN_DOWNLOAD_LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/gu;

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

type TranscriptDownloadLink = {
  href: string;
  hrefLabel: string;
  label: string;
};

function finalAssistantTextForLatestUser(snapshot: ThreadSnapshot): string {
  return normalizeAttachmentValue(assistantSnapshotsForLatestUser(snapshot).at(-1)?.text);
}

function normalizeComparableAttachmentText(value: string): string {
  return normalizeAttachmentValue(value)
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function transcriptTextCandidates(snapshot: ThreadSnapshot): string[] {
  const candidates = assistantSnapshotsForLatestUser(snapshot)
    .map((assistantSnapshot) => normalizeAttachmentValue(assistantSnapshot.text))
    .filter((value, index, items) => value.length > 0 && items.indexOf(value) === index);
  const bodyText = normalizeAttachmentValue(snapshot.bodyText);
  if (bodyText.length === 0) {
    return candidates;
  }

  const lastAssistantText = finalAssistantTextForLatestUser(snapshot);
  if (lastAssistantText.length === 0) {
    return [...candidates, bodyText];
  }

  const bodyMatchIndex = bodyText.lastIndexOf(lastAssistantText);
  if (bodyMatchIndex < 0) {
    return [...candidates, bodyText];
  }

  const scopedStart = Math.max(0, bodyMatchIndex - 8_000);
  const scopedBodyText = bodyText.slice(scopedStart, bodyMatchIndex + lastAssistantText.length);
  if (scopedBodyText.length === 0) {
    return candidates;
  }

  return [...candidates, scopedBodyText];
}

function extractTranscriptDownloadLinks(snapshot: ThreadSnapshot): TranscriptDownloadLink[] {
  const texts = transcriptTextCandidates(snapshot);
  const links: TranscriptDownloadLink[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) {
      continue;
    }

    MARKDOWN_DOWNLOAD_LINK_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(MARKDOWN_DOWNLOAD_LINK_PATTERN)) {
      const label = normalizeAttachmentValue(match[1]);
      const href = normalizeAttachmentValue(match[2]);
      const hrefLabel = deriveAttachmentHrefLabel(href);
      if (href.length === 0) {
        continue;
      }
      if (
        !hasAssistantDownloadableHref(href) &&
        !DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(href) &&
        !DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(hrefLabel)
      ) {
        continue;
      }

      const key = `${label}\n${href}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      links.push({
        href,
        hrefLabel,
        label,
      });
    }
  }

  return links;
}

function hydrateAttachmentButtonsWithTranscriptLinks(
  snapshot: ThreadSnapshot,
  attachments: ThreadAttachmentButton[],
): ThreadAttachmentButton[] {
  const transcriptLinks = extractTranscriptDownloadLinks(snapshot);
  if (transcriptLinks.length === 0) {
    return attachments;
  }

  const singleTranscriptLink = transcriptLinks.length === 1 ? transcriptLinks[0] : null;

  return attachments.map((attachment) => {
    if (normalizeAttachmentValue(attachment.href).length > 0) {
      return attachment;
    }
    if (!attachment.insideAssistantMessage) {
      return attachment;
    }

    const attachmentText = normalizeComparableAttachmentText(attachment.text);
    const matchedLink = [...transcriptLinks]
      .reverse()
      .find((link) => normalizeComparableAttachmentText(link.label) === attachmentText)
      ?? (
        singleTranscriptLink &&
        attachments.filter((candidate) => Boolean(candidate.insideAssistantMessage)).length === 1
          ? singleTranscriptLink
          : null
      );

    if (!matchedLink) {
      return attachment;
    }

    return {
      ...attachment,
      href: matchedLink.href,
    };
  });
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
    DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(text) ||
    DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(href) ||
    DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(hrefLabel)
  );
}

export function hasAssistantDownloadableHref(href: string | null | undefined): boolean {
  const normalizedHref = normalizeAttachmentValue(href);
  if (normalizedHref.length === 0) {
    return false;
  }

  if (normalizedHref.startsWith(SANDBOX_ATTACHMENT_PREFIX)) {
    return true;
  }

  try {
    const url = new URL(normalizedHref, 'https://chatgpt.com');
    return url.protocol === 'blob:' || url.protocol === 'data:';
  } catch {
    return false;
  }
}

export function isAssistantDownloadControl(item: ThreadAttachmentButton): boolean {
  if (isChatConversationHref(item.href)) {
    return false;
  }

  if (Boolean(item.download) || hasAssistantDownloadableHref(item.href)) {
    return true;
  }

  if (!item.behaviorButton) {
    return false;
  }

  const text = normalizeAttachmentValue(item.text);
  const href = normalizeAttachmentValue(item.href);
  const hrefLabel = deriveAttachmentHrefLabel(href);
  return (
    DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(text) ||
    DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(href) ||
    DOWNLOADABLE_ATTACHMENT_FILE_PATTERN.test(hrefLabel) ||
    DOWNLOAD_ACTION_TEXT_PATTERN.test(text)
  );
}

export function extractAssistantDownloadButtons(
  snapshot: Pick<ThreadSnapshot, 'attachmentButtons'> | Partial<ThreadSnapshot> | null | undefined,
): ThreadAssistantDownloadButton[] {
  const normalized = normalizeThreadSnapshot(snapshot);
  const latestUserAttachments = hydrateAttachmentButtonsWithTranscriptLinks(
    normalized,
    attachmentButtonsForLatestUser(normalized),
  );
  const hasAssistantOwnershipMetadata = normalized.attachmentButtons.some(
    (attachment) =>
      typeof attachment.insideAssistantMessage === 'boolean' || typeof attachment.insideFinalAssistantMessage === 'boolean',
  );
  const assistantOwnedAttachments = latestUserAttachments.filter((attachment) => Boolean(attachment.insideAssistantMessage));
  const finalAssistantAttachments = assistantOwnedAttachments.filter((attachment) => attachment.insideFinalAssistantMessage);
  const attachments = hasAssistantOwnershipMetadata
    ? finalAssistantAttachments.length > 0
      ? finalAssistantAttachments.filter((attachment) => Boolean(attachment.behaviorButton) || isAssistantDownloadControl(attachment))
      : assistantOwnedAttachments.filter((attachment) => isAssistantDownloadControl(attachment))
    : latestUserAttachments.filter((attachment) => isAssistantDownloadControl(attachment));

  return attachments.map((attachment, artifactIndex) => ({
    ...attachment,
    artifactIndex,
    hrefLabel: deriveAttachmentHrefLabel(attachment.href),
    label: deriveAttachmentLabel(attachment),
  }));
}

export function isPatchArtifactAttachment(item: ThreadAttachmentButton): boolean {
  const label = deriveAttachmentLabel(item);
  const href = normalizeAttachmentValue(item.href);
  const text = normalizeAttachmentValue(item.text);
  const hasAssistantOwnershipMetadata =
    typeof item.insideAssistantMessage === 'boolean' || typeof item.insideFinalAssistantMessage === 'boolean';
  const assistantArtifact = Boolean(item.insideAssistantMessage) || Boolean(item.insideFinalAssistantMessage);

  if (label.length === 0) {
    return false;
  }

  if (!hasAssistantOwnershipMetadata) {
    return PATCH_ATTACHMENT_FILE_PATTERN.test(label) || PATCH_ATTACHMENT_FILE_PATTERN.test(href);
  }

  return (
    assistantArtifact &&
    (
      PATCH_ATTACHMENT_FILE_PATTERN.test(label) ||
      PATCH_ATTACHMENT_FILE_PATTERN.test(href) ||
      PATCH_DOWNLOAD_CONTROL_TEXT_PATTERN.test(text) ||
      PATCH_ARCHIVE_FILE_PATTERN.test(label) ||
      PATCH_ARCHIVE_FILE_PATTERN.test(href)
    )
  );
}

export function extractAssistantArtifactButtons(
  snapshot: Pick<ThreadSnapshot, 'attachmentButtons'> | Partial<ThreadSnapshot> | null | undefined,
): ThreadAttachmentButton[] {
  const normalized = normalizeThreadSnapshot(snapshot);
  const latestUserAttachments = hydrateAttachmentButtonsWithTranscriptLinks(
    normalized,
    attachmentButtonsForLatestUser(normalized),
  );
  const hasAssistantOwnershipMetadata = normalized.attachmentButtons.some(
    (attachment) =>
      typeof attachment.insideAssistantMessage === 'boolean' || typeof attachment.insideFinalAssistantMessage === 'boolean',
  );
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
  return extractAssistantDownloadButtons(snapshot).length > 0;
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

  return true;
}

export function assistantSnapshotLooksIncomplete(snapshot: Partial<ThreadSnapshot> | null | undefined): boolean {
  return false;
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

  return extractAssistantArtifactButtons(normalized).some((attachment) => isPatchArtifactAttachment(attachment));
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
