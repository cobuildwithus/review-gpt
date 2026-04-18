const fs = require('fs');
const path = require('path');

const RESPONSE_MARKER_BEGIN = '----- REVIEW_GPT_RESPONSE_BEGIN -----';
const RESPONSE_MARKER_END = '----- REVIEW_GPT_RESPONSE_END -----';

function normalizeResponseText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
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
  const attachmentUiAddedCount = Math.max(0, attachmentUiCount - baselineAttachmentUiCount);
  const effectiveAttachedCount = Math.max(attachedCount, attachmentUiAddedCount);
  const uploading = Boolean(currentState?.uploading);
  const namesVisible = normalizedExpectedNames.every((name) =>
    currentAttachmentText.includes(name) || currentComposerText.includes(name)
  );
  const attachmentUiSignature = String(currentState?.attachmentUiSignature || '').trim();
  const baselineAttachmentUiSignature = String(baselineState?.attachmentUiSignature || '').trim();
  const attachmentUiChanged =
    attachmentUiSignature.length > 0 && attachmentUiSignature !== baselineAttachmentUiSignature;
  const attachmentUiProgressed = uploading || attachmentUiCount > baselineAttachmentUiCount || attachmentUiChanged;
  const attachedEnough = effectiveAttachedCount >= normalizedExpectedCount;
  const ready = Boolean(
    !uploading &&
      (
        namesVisible ||
        (attachedEnough &&
          (attachmentUiCount > baselineAttachmentUiCount || attachmentUiChanged))
      )
  );

  return {
    expectedCount: normalizedExpectedCount,
    attachedCount,
    effectiveAttachedCount,
    attachmentUiCount,
    baselineAttachmentUiCount,
    uploading,
    namesVisible,
    attachmentUiChanged,
    attachmentUiProgressed,
    attachedEnough,
    ready,
    fileInputReady: Boolean(currentState?.fileInputReady),
    readyStateComplete: String(currentState?.readyState || '').toLowerCase() === 'complete',
    confirmed: ready,
    inputOnly: attachedEnough && !attachmentUiProgressed && !namesVisible,
  };
}

function formatAttachmentVerificationSummary(summary) {
  const expectedCount = Math.max(0, Number(summary?.expectedCount || 0));
  const rawAttachedCount = summary?.effectiveAttachedCount ?? summary?.attachedCount ?? 0;
  const attachedCount = Math.max(0, Number(rawAttachedCount));
  const attachmentUiCount = Math.max(0, Number(summary?.attachmentUiCount || 0));
  const baselineAttachmentUiCount = Math.max(0, Number(summary?.baselineAttachmentUiCount || 0));
  return [
    `attached=${attachedCount}/${expectedCount}`,
    `ui=${attachmentUiCount} (baseline=${baselineAttachmentUiCount})`,
    `uploading=${Boolean(summary?.uploading)}`,
    `ready=${Boolean(summary?.ready)}`,
    `namesVisible=${Boolean(summary?.namesVisible)}`,
    `uiChanged=${Boolean(summary?.attachmentUiChanged)}`,
  ].join(', ');
}

module.exports = {
  buildExpectedAttachmentNames,
  emitCapturedResponse,
  formatAttachmentVerificationSummary,
  normalizeAttachmentName,
  summarizeAttachmentVerification,
  writeCapturedResponseFile,
};
