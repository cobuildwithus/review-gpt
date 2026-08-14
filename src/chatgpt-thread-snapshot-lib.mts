import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildChatGptCaptureStateExpression,
  normalizeComparableText,
  sanitizeDeepResearchResponseText,
  threadStatusTextIndicatesBusy,
} = require('./chatgpt-dom-snapshot-shared.js') as typeof import('./chatgpt-dom-snapshot-shared.js');

export { threadStatusTextIndicatesBusy };

export type ThreadAttachmentButton = {
  afterLastUserMessage?: boolean;
  artifactIndexInAssistantTurn?: number;
  assistantTurnId?: string;
  assistantTurnIndex?: number;
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
  assistantTurnId?: string;
  assistantTurnIndex?: number;
  contentSource?: 'deep-research-iframe';
  deepResearchParentAnchor?: {
    signature: string;
    text: string;
  };
  hasCopyButton: boolean;
  modelConfirmationText?: string;
  modelSlug?: string;
  precedingUserMessageSignature?: string;
  precedingUserTurnId?: string;
  precedingUserTurnIndex?: number;
  signature: string;
  text: string;
};

export type ThreadCaptureIdentity = {
  artifacts: Array<{
    artifactIndexInAssistantTurn: number;
    assistantTurnId: string;
    assistantTurnIndex: number;
    href: string | null;
    label: string;
  }>;
  assistantResponse: {
    assistantTurnId: string;
    assistantTurnIndex: number;
    precedingUserMessageSignature: string;
    precedingUserTurnId: string;
    precedingUserTurnIndex: number;
    responseSha256: string;
    signature: string;
    contentSource?: 'deep-research-iframe';
    parentAnchor?: {
      responseSha256: string;
      signature: string;
    };
  } | null;
  browserEndpoint: string;
  chatUrl: string;
  committedUserTurn: {
    signature: string;
    turnId: string;
    turnIndex: number;
  };
  expectedContentSource?: 'deep-research-iframe';
  schemaVersion: 1 | 2;
  targetId: string;
};

export type ThreadSnapshot = {
  assistantFailureTexts: string[];
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
  userSnapshots: Array<{
    signature: string;
    turnId: string;
    turnIndex: number;
  }>;
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
    assistantFailureTexts: Array.isArray(snapshot?.assistantFailureTexts) ? snapshot.assistantFailureTexts : [],
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
    userSnapshots: Array.isArray(snapshot?.userSnapshots) ? snapshot.userSnapshots : [],
  };
}

function patchMarkersForText(text: string): ThreadSnapshot['patchMarkers'] {
  return {
    addFile: text.includes('*** Add File:'),
    beginPatch: text.includes('*** Begin Patch'),
    deleteFile: text.includes('*** Delete File:'),
    diffGit: text.includes('diff --git'),
    updateFile: text.includes('*** Update File:'),
  };
}

function capturedResponseSha256(responseText: string): string {
  const responseBytes = `${String(responseText || '')
    .replace(/\r\n/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()}\n`;
  return createHash('sha256').update(responseBytes, 'utf8').digest('hex');
}

const CAPTURE_DIGEST_PREFIX = 'sha256:';

export function captureIdentityDigest(value: unknown): string {
  const normalized = String(value ?? '');
  return isCaptureIdentityDigest(normalized)
    ? normalized
    : `${CAPTURE_DIGEST_PREFIX}${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

export function isCaptureIdentityDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function matchesStoredCaptureValue(liveValue: unknown, storedValue: unknown): boolean {
  const stored = String(storedValue ?? '');
  return isCaptureIdentityDigest(stored)
    ? captureIdentityDigest(liveValue) === stored
    : String(liveValue ?? '') === stored;
}

function sanitizedCaptureTurnId(value: unknown): string {
  const raw = String(value ?? '');
  const marker = ':signature:';
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) return raw;
  let hash = 0x811c9dc5;
  for (const character of raw.slice(markerIndex + marker.length)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${raw.slice(0, markerIndex)}:hash32:${hash.toString(16).padStart(8, '0')}`;
}

function matchesStoredTurnId(liveValue: unknown, storedValue: unknown): boolean {
  return String(liveValue ?? '') === String(storedValue ?? '') ||
    sanitizedCaptureTurnId(liveValue) === String(storedValue ?? '');
}

function matchesCapturedAssistant(
  snapshot: ThreadAssistantSnapshot,
  capture: NonNullable<ThreadCaptureIdentity['assistantResponse']>,
): boolean {
  return (
    matchesStoredTurnId(snapshot.assistantTurnId, capture.assistantTurnId) &&
    snapshot.assistantTurnIndex === capture.assistantTurnIndex &&
    matchesStoredCaptureValue(snapshot.precedingUserMessageSignature, capture.precedingUserMessageSignature) &&
    matchesStoredTurnId(snapshot.precedingUserTurnId, capture.precedingUserTurnId) &&
    snapshot.precedingUserTurnIndex === capture.precedingUserTurnIndex &&
    matchesStoredCaptureValue(snapshot.signature, capture.signature) &&
    capturedResponseSha256(snapshot.text) === capture.responseSha256
  );
}

function matchesDeepResearchParentAnchor(
  snapshot: ThreadAssistantSnapshot,
  capture: NonNullable<ThreadCaptureIdentity['assistantResponse']>,
): boolean {
  const parentAnchor = capture.parentAnchor;
  return Boolean(
    parentAnchor &&
    matchesStoredTurnId(snapshot.assistantTurnId, capture.assistantTurnId) &&
    snapshot.assistantTurnIndex === capture.assistantTurnIndex &&
    matchesStoredCaptureValue(snapshot.precedingUserMessageSignature, capture.precedingUserMessageSignature) &&
    matchesStoredTurnId(snapshot.precedingUserTurnId, capture.precedingUserTurnId) &&
    snapshot.precedingUserTurnIndex === capture.precedingUserTurnIndex &&
    matchesStoredCaptureValue(snapshot.signature, parentAnchor.signature) &&
    capturedResponseSha256(snapshot.text) === parentAnchor.responseSha256
  );
}

export function mergeDeepResearchReportSnapshot(
  pageSnapshot: Partial<ThreadSnapshot> | null | undefined,
  deepResearchSnapshot: Partial<ThreadSnapshot> | null | undefined,
  capture: ThreadCaptureIdentity,
): ThreadSnapshot {
  const normalizedPage = normalizeThreadSnapshot(pageSnapshot);
  const assistantResponse = capture.assistantResponse;
  const expectsDeepResearch =
    capture.expectedContentSource === 'deep-research-iframe' ||
    assistantResponse?.contentSource === 'deep-research-iframe';
  if (!expectsDeepResearch) {
    return normalizedPage;
  }

  const parentAnchors = assistantResponse
    ? normalizedPage.assistantSnapshots.filter((candidate) =>
        matchesDeepResearchParentAnchor(candidate, assistantResponse),
      )
    : scopeThreadSnapshotToCaptureIdentity(normalizedPage, capture).assistantSnapshots;
  const normalizedDeepResearch = normalizeThreadSnapshot(deepResearchSnapshot);
  const reportSnapshots = normalizedDeepResearch.assistantSnapshots
    .map((snapshot) => {
      const text = sanitizeDeepResearchResponseText(snapshot.text);
      if (!text) return null;
      return {
        ...snapshot,
        text,
        signature: normalizeComparableText(text).slice(0, 320),
      };
    })
    .filter((snapshot): snapshot is ThreadAssistantSnapshot => snapshot !== null);

  if (!assistantResponse && reportSnapshots.length === 0) {
    return {
      ...scopeThreadSnapshotToCaptureIdentity(normalizedPage, capture),
      attachmentButtons: [],
      statusBusy: normalizedPage.statusBusy || normalizedDeepResearch.statusBusy,
      statusTexts: [...normalizedPage.statusTexts, ...normalizedDeepResearch.statusTexts],
      stopVisible: normalizedPage.stopVisible || normalizedDeepResearch.stopVisible,
    };
  }
  if (parentAnchors.length !== 1) {
    throw new Error(
      `Captured Deep Research parent assistant anchor resolved to ${parentAnchors.length} turns; refusing ambiguous thread export.`,
    );
  }

  if (reportSnapshots.length !== 1) {
    throw new Error(
      `Captured Deep Research iframe report resolved to ${reportSnapshots.length} responses; refusing ambiguous thread export.`,
    );
  }

  const parentAnchor = parentAnchors[0]!;
  const reportSnapshot = reportSnapshots[0]!;
  const pendingReportBusy = !assistantResponse && !reportSnapshot.hasCopyButton;
  const reportComplete =
    reportSnapshot.hasCopyButton &&
    !normalizedPage.statusBusy &&
    !normalizedPage.stopVisible &&
    !normalizedDeepResearch.statusBusy &&
    !normalizedDeepResearch.stopVisible;
  return {
    ...normalizedPage,
    attachmentButtons: reportComplete ? normalizedPage.attachmentButtons : [],
    assistantSnapshots: [{
      ...reportSnapshot,
      afterLastUserMessage: parentAnchor.afterLastUserMessage,
      assistantTurnId: parentAnchor.assistantTurnId,
      assistantTurnIndex: parentAnchor.assistantTurnIndex,
      precedingUserMessageSignature: parentAnchor.precedingUserMessageSignature,
      precedingUserTurnId: parentAnchor.precedingUserTurnId,
      precedingUserTurnIndex: parentAnchor.precedingUserTurnIndex,
      contentSource: 'deep-research-iframe',
      deepResearchParentAnchor: {
        signature: parentAnchor.signature,
        text: parentAnchor.text,
      },
    }],
    bodyText: reportSnapshot.text,
    statusBusy: normalizedPage.statusBusy || normalizedDeepResearch.statusBusy || pendingReportBusy,
    statusTexts: [...normalizedPage.statusTexts, ...normalizedDeepResearch.statusTexts],
    stopVisible: normalizedPage.stopVisible || normalizedDeepResearch.stopVisible,
  };
}

export function scopeThreadSnapshotToCaptureIdentity(
  snapshot: Partial<ThreadSnapshot> | null | undefined,
  capture: ThreadCaptureIdentity | undefined,
): ThreadSnapshot {
  const normalized = normalizeThreadSnapshot(snapshot);
  const assistantResponse = capture?.assistantResponse;
  if (!assistantResponse) {
    if (!capture) return normalized;
    const committedUserMatches = normalized.userSnapshots.filter(
      (candidate) =>
        matchesStoredTurnId(candidate.turnId, capture.committedUserTurn.turnId) &&
        candidate.turnIndex === capture.committedUserTurn.turnIndex &&
        matchesStoredCaptureValue(candidate.signature, capture.committedUserTurn.signature),
    );
    if (committedUserMatches.length !== 1) {
      throw new Error(
        `Captured committed user-turn identity resolved to ${committedUserMatches.length} turns; refusing ambiguous wake.`,
      );
    }
    if (normalized.userSnapshots.some((candidate) => candidate.turnIndex > capture.committedUserTurn.turnIndex)) {
      throw new Error('Captured committed user turn is no longer the latest request; refusing to wait on a different turn.');
    }
    const pendingAssistantMatches = normalized.assistantSnapshots.filter(
      (candidate) =>
        matchesStoredTurnId(candidate.precedingUserTurnId, capture.committedUserTurn.turnId) &&
        candidate.precedingUserTurnIndex === capture.committedUserTurn.turnIndex &&
        matchesStoredCaptureValue(candidate.precedingUserMessageSignature, capture.committedUserTurn.signature),
    );
    if (pendingAssistantMatches.length > 1) {
      throw new Error(
        `Captured committed user turn resolved to ${pendingAssistantMatches.length} assistant responses; refusing ambiguous wake.`,
      );
    }
    const pendingAssistant = pendingAssistantMatches[0];
    const pendingText = pendingAssistant?.text ?? '';
    const pendingAttachments = pendingAssistant
      ? normalized.attachmentButtons.filter(
          (attachment) =>
            matchesStoredTurnId(attachment.assistantTurnId, pendingAssistant.assistantTurnId) &&
            attachment.assistantTurnIndex === pendingAssistant.assistantTurnIndex &&
            (isThreadAttachmentCandidate(attachment) || isAssistantDownloadControl(attachment)),
        )
      : [];
    return {
      ...normalized,
      assistantSnapshots: pendingAssistant ? [{ ...pendingAssistant, afterLastUserMessage: true }] : [],
      attachmentButtons: pendingAttachments.map((attachment) => ({ ...attachment, afterLastUserMessage: true })),
      bodyText: pendingText,
      codeBlocks: [],
      patchMarkers: patchMarkersForText(pendingText),
      userSnapshots: committedUserMatches,
    };
  }

  const assistantMatches = normalized.assistantSnapshots.filter((candidate) =>
    matchesCapturedAssistant(candidate, assistantResponse),
  );
  if (assistantMatches.length !== 1) {
    throw new Error(
      `Captured assistant response identity resolved to ${assistantMatches.length} turns; refusing ambiguous thread export.`,
    );
  }

  const assistantArtifactCandidates = normalized.attachmentButtons.filter(
    (attachment) =>
      matchesStoredTurnId(attachment.assistantTurnId, assistantResponse.assistantTurnId) &&
      attachment.assistantTurnIndex === assistantResponse.assistantTurnIndex,
  );
  const capturedArtifacts: ThreadAttachmentButton[] = [];
  for (const expectedArtifact of capture.artifacts) {
    const matches = assistantArtifactCandidates.filter(
      (attachment) =>
        attachment.artifactIndexInAssistantTurn === expectedArtifact.artifactIndexInAssistantTurn &&
        matchesStoredTurnId(attachment.assistantTurnId, expectedArtifact.assistantTurnId) &&
        attachment.assistantTurnIndex === expectedArtifact.assistantTurnIndex &&
        matchesStoredCaptureValue(attachment.href, expectedArtifact.href) &&
        matchesStoredCaptureValue(deriveAttachmentLabel(attachment), expectedArtifact.label),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Captured assistant artifact identity resolved to ${matches.length} controls; refusing ambiguous thread export.`,
      );
    }
    capturedArtifacts.push(matches[0]!);
  }

  return {
    ...normalized,
    assistantFailureTexts: [],
    assistantSnapshots: assistantMatches,
    attachmentButtons: capturedArtifacts,
    bodyText: assistantMatches[0]!.text,
    codeBlocks: [],
    patchMarkers: patchMarkersForText(assistantMatches[0]!.text),
    statusBusy: false,
    statusTexts: [],
    stopVisible: false,
    userSnapshots: [{ ...capture.committedUserTurn }],
  };
}

export function completeThreadCaptureIdentity(
  capture: ThreadCaptureIdentity,
  snapshot: Partial<ThreadSnapshot> | null | undefined,
): ThreadCaptureIdentity {
  if (capture.assistantResponse) {
    scopeThreadSnapshotToCaptureIdentity(snapshot, capture);
    return capture;
  }
  const scoped = scopeThreadSnapshotToCaptureIdentity(snapshot, capture);
  if (scoped.assistantSnapshots.length !== 1) {
    throw new Error(
      `Captured committed user turn resolved to ${scoped.assistantSnapshots.length} completed assistant responses; refusing ambiguous capture.`,
    );
  }
  const assistant = scoped.assistantSnapshots[0]!;
  if (
    !assistant.assistantTurnId ||
    !Number.isInteger(assistant.assistantTurnIndex) ||
    assistant.assistantTurnIndex! < 0 ||
    !assistant.precedingUserTurnId ||
    !Number.isInteger(assistant.precedingUserTurnIndex) ||
    assistant.precedingUserTurnIndex! < 0 ||
    typeof assistant.precedingUserMessageSignature !== 'string' ||
    !assistant.signature ||
    (assistant.contentSource === 'deep-research-iframe' &&
      (!assistant.deepResearchParentAnchor?.text || !assistant.deepResearchParentAnchor.signature))
  ) {
    throw new Error('Completed assistant response is missing its exact capture identity.');
  }
  return parseThreadCaptureIdentity({
    ...capture,
    schemaVersion: 2,
    committedUserTurn: {
      ...capture.committedUserTurn,
      signature: captureIdentityDigest(capture.committedUserTurn.signature),
      turnId: sanitizedCaptureTurnId(capture.committedUserTurn.turnId),
    },
    artifacts: scoped.attachmentButtons.map((attachment) => ({
      artifactIndexInAssistantTurn: attachment.artifactIndexInAssistantTurn,
      assistantTurnId: sanitizedCaptureTurnId(assistant.assistantTurnId),
      assistantTurnIndex: assistant.assistantTurnIndex,
      href: attachment.href == null ? null : captureIdentityDigest(attachment.href),
      label: captureIdentityDigest(deriveAttachmentLabel(attachment)),
    })),
    assistantResponse: {
      assistantTurnId: sanitizedCaptureTurnId(assistant.assistantTurnId),
      assistantTurnIndex: assistant.assistantTurnIndex,
      precedingUserMessageSignature: captureIdentityDigest(assistant.precedingUserMessageSignature),
      precedingUserTurnId: sanitizedCaptureTurnId(assistant.precedingUserTurnId),
      precedingUserTurnIndex: assistant.precedingUserTurnIndex,
      responseSha256: capturedResponseSha256(assistant.text),
      signature: captureIdentityDigest(assistant.signature),
      ...(assistant.contentSource === 'deep-research-iframe'
        ? {
            contentSource: 'deep-research-iframe',
            parentAnchor: {
              responseSha256: capturedResponseSha256(assistant.deepResearchParentAnchor?.text ?? ''),
              signature: captureIdentityDigest(assistant.deepResearchParentAnchor?.signature),
            },
          }
        : {}),
    },
  });
}

export function parseThreadCaptureIdentity(value: unknown): ThreadCaptureIdentity {
  const candidate = value as Partial<ThreadCaptureIdentity> | null;
  if (
    !candidate ||
    (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) ||
    typeof candidate.browserEndpoint !== 'string' ||
    !candidate.browserEndpoint ||
    typeof candidate.chatUrl !== 'string' ||
    !candidate.chatUrl ||
    typeof candidate.targetId !== 'string' ||
    !candidate.targetId ||
    !candidate.committedUserTurn ||
    typeof candidate.committedUserTurn.turnId !== 'string' ||
    !candidate.committedUserTurn.turnId ||
    !Number.isInteger(candidate.committedUserTurn.turnIndex) ||
    candidate.committedUserTurn.turnIndex < 0 ||
    typeof candidate.committedUserTurn.signature !== 'string' ||
    !Array.isArray(candidate.artifacts)
  ) {
    throw new Error('Capture metadata is missing its exact browser, thread, target, or committed-turn identity.');
  }

  if (
    candidate.schemaVersion === 2 &&
    (!isCaptureIdentityDigest(candidate.committedUserTurn.signature) ||
      candidate.committedUserTurn.turnId.includes(':signature:'))
  ) {
    throw new Error('Capture metadata contains an unhashed committed-turn content identity.');
  }

  if (
    candidate.expectedContentSource !== undefined &&
    (candidate.schemaVersion !== 2 || candidate.expectedContentSource !== 'deep-research-iframe')
  ) {
    throw new Error('Capture metadata contains an unsupported expected assistant content source.');
  }

  if (candidate.assistantResponse !== null) {
    const response = candidate.assistantResponse;
    if (
      !response ||
      typeof response.assistantTurnId !== 'string' ||
      !response.assistantTurnId ||
      !Number.isInteger(response.assistantTurnIndex) ||
      response.assistantTurnIndex < 0 ||
      typeof response.precedingUserMessageSignature !== 'string' ||
      typeof response.precedingUserTurnId !== 'string' ||
      !response.precedingUserTurnId ||
      !Number.isInteger(response.precedingUserTurnIndex) ||
      response.precedingUserTurnIndex < 0 ||
      typeof response.responseSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(response.responseSha256) ||
      typeof response.signature !== 'string' ||
      !response.signature
    ) {
      throw new Error('Capture metadata contains an incomplete assistant-response identity.');
    }
    const hasDeepResearchSource = response.contentSource === 'deep-research-iframe';
    if (
      (response.contentSource !== undefined && !hasDeepResearchSource) ||
      (hasDeepResearchSource &&
        (candidate.schemaVersion !== 2 ||
          !response.parentAnchor ||
          !/^[a-f0-9]{64}$/u.test(response.parentAnchor.responseSha256) ||
          !isCaptureIdentityDigest(response.parentAnchor.signature))) ||
      (!hasDeepResearchSource && response.parentAnchor !== undefined)
    ) {
      throw new Error('Capture metadata contains an incomplete Deep Research parent-anchor identity.');
    }
    if (candidate.expectedContentSource === 'deep-research-iframe' && !hasDeepResearchSource) {
      throw new Error('Capture metadata completed a Deep Research request from the wrong content source.');
    }
    if (
      response.precedingUserTurnId !== candidate.committedUserTurn.turnId ||
      response.precedingUserTurnIndex !== candidate.committedUserTurn.turnIndex ||
      response.precedingUserMessageSignature !== candidate.committedUserTurn.signature
    ) {
      throw new Error('Capture metadata assistant response does not belong to its exact committed user turn.');
    }
  } else if (candidate.artifacts.length > 0) {
    throw new Error('Capture metadata cannot contain assistant artifacts before an assistant response is captured.');
  }

  const artifactIdentities = new Set<string>();
  for (const artifact of candidate.artifacts) {
    if (
      !artifact ||
      !Number.isInteger(artifact.artifactIndexInAssistantTurn) ||
      artifact.artifactIndexInAssistantTurn < 0 ||
      typeof artifact.assistantTurnId !== 'string' ||
      !artifact.assistantTurnId ||
      !Number.isInteger(artifact.assistantTurnIndex) ||
      artifact.assistantTurnIndex < 0 ||
      !(artifact.href === null || typeof artifact.href === 'string') ||
      typeof artifact.label !== 'string'
    ) {
      throw new Error('Capture metadata contains an incomplete assistant-artifact identity.');
    }
    if (
      artifact.assistantTurnId !== candidate.assistantResponse?.assistantTurnId ||
      artifact.assistantTurnIndex !== candidate.assistantResponse.assistantTurnIndex
    ) {
      throw new Error('Capture metadata assistant artifact does not belong to its exact assistant response.');
    }
    const artifactIdentity = `${artifact.assistantTurnId}\n${artifact.assistantTurnIndex}\n${artifact.artifactIndexInAssistantTurn}`;
    if (artifactIdentities.has(artifactIdentity)) {
      throw new Error('Capture metadata contains a duplicate assistant-artifact identity.');
    }
    artifactIdentities.add(artifactIdentity);
  }

  if (
    candidate.schemaVersion === 2 &&
    (
      (candidate.assistantResponse &&
        (!isCaptureIdentityDigest(candidate.assistantResponse.precedingUserMessageSignature) ||
          !isCaptureIdentityDigest(candidate.assistantResponse.signature) ||
          (candidate.assistantResponse.contentSource === 'deep-research-iframe' &&
            !isCaptureIdentityDigest(candidate.assistantResponse.parentAnchor?.signature)) ||
          candidate.assistantResponse.assistantTurnId.includes(':signature:') ||
          candidate.assistantResponse.precedingUserTurnId.includes(':signature:'))) ||
      candidate.artifacts.some(
        (artifact) =>
          (artifact.href !== null && !isCaptureIdentityDigest(artifact.href)) ||
          !isCaptureIdentityDigest(artifact.label) ||
          artifact.assistantTurnId.includes(':signature:'),
      )
    )
  ) {
    throw new Error('Capture metadata contains an unhashed assistant content or artifact identity.');
  }

  return candidate as ThreadCaptureIdentity;
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

function lastAssistantSnapshot(snapshot: ThreadSnapshot): ThreadAssistantSnapshot | undefined {
  return assistantSnapshotsForLatestUser(snapshot).at(-1);
}

function lastAssistantText(snapshot: ThreadSnapshot): string {
  return String(lastAssistantSnapshot(snapshot)?.text ?? '')
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

  return assistantSnapshotsForLatestUser(normalized).some(
    (assistantSnapshot) => assistantSnapshot.hasCopyButton === true,
  );
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
