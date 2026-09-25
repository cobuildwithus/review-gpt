import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readChatGptTurnText, normalizeComparableText } = require('../src/chatgpt-dom-snapshot-shared.js');
const { extractTransientConversationHref, extractConversationHref, resolveAcceptedConversationAfterSend } = require('../src/prepare-chatgpt-draft.js');
const snapshotLib = await import('../dist/chatgpt-thread-snapshot-lib.mjs');
const threadLib = await import('../dist/chatgpt-thread-lib.mjs');

function element(tagName, children) {
  const childNodes = children.map(child => typeof child === 'string' ? { nodeType: 3, textContent: child } : child);
  return {
    tagName, childNodes, nodeType: 1,
    get textContent() { return childNodes.map(child => child.textContent).join(''); },
    querySelector(selector) {
      if (selector === 'pre code') return this.querySelector('PRE')?.querySelector('CODE') ?? null;
      for (const child of childNodes) {
        if (child.tagName === selector.toUpperCase()) return child;
        const match = child.querySelector?.(selector);
        if (match) return match;
      }
      return null;
    },
  };
}
function response(code, badge = 'javascript') {
  return element('ARTICLE', [element('P', ['Example:']), element('PRE', [element('SPAN', [badge]), element('CODE', [code])]), element('P', ['REVIEW_COMPLETE'])]);
}
const capture = {
  schemaVersion: 1, browserEndpoint: 'http://127.0.0.1:9222',
  chatUrl: 'https://chatgpt.com/c/synthetic', targetId: 'owned-target',
  artifacts: [], assistantResponse: null,
  committedUserTurn: { turnId: 'data-message-id:request', turnIndex: 0, signature: 'synthetic request' },
};
function snapshot(text) {
  return snapshotLib.normalizeThreadSnapshot({
    userSnapshots: [capture.committedUserTurn],
    assistantSnapshots: [{ text, signature: normalizeComparableText(text).slice(0, 320),
      assistantTurnId: 'data-message-id:reply', assistantTurnIndex: 0,
      precedingUserTurnId: capture.committedUserTurn.turnId, precedingUserTurnIndex: 0,
      precedingUserMessageSignature: capture.committedUserTurn.signature,
      hasCopyButton: true, afterLastUserMessage: true,
    }],
  });
}

test('code chrome changes preserve exact capture but edited code and prose still reject', () => {
  const original = snapshot(readChatGptTurnText(response('const example = 42;')));
  const completed = snapshotLib.completeThreadCaptureIdentity(capture, original);
  const hiddenBadge = snapshot(readChatGptTurnText(response('const example = 42;', '')));
  assert.equal(original.assistantSnapshots[0].text, hiddenBadge.assistantSnapshots[0].text);
  snapshotLib.scopeThreadSnapshotToCaptureIdentity(hiddenBadge, completed);
  for (const changed of [readChatGptTurnText(response('const example = 43;')), original.assistantSnapshots[0].text + '\nDifferent instruction.']) {
    assert.throws(() => snapshotLib.scopeThreadSnapshotToCaptureIdentity(snapshot(changed), completed), /identity resolved to 0 turns/);
  }
  const legacy = snapshotLib.completeThreadCaptureIdentity(capture, snapshot('Example:\njavascript\nconst example = 42;\nREVIEW_COMPLETE'));
  assert.throws(() => snapshotLib.scopeThreadSnapshotToCaptureIdentity(hiddenBadge, legacy), /identity resolved to 0 turns/, 'legacy hashes never gain a permissive fallback');
});

test('transient accepted URL is retained separately and never called canonical', async () => {
  const transient = 'https://chatgpt.com/c/WEB:11111111-2222-3333-4444-555555555555';
  assert.equal(extractConversationHref(transient), '');
  assert.equal(extractTransientConversationHref(transient.replace('WEB:', 'WEB%3A')), transient);
  assert.equal(extractTransientConversationHref('https://chatgpt.com/c/WEB:untrusted'), '');
  const result = await resolveAcceptedConversationAfterSend({
    commitResult: { state: { href: 'https://chatgpt.com/' } },
    desiredTargetOrigin: 'https://chatgpt.com', maxWaitMs: 1,
    waitForConversationStateAfterSend: async () => ({ href: '', state: { href: transient } }),
  });
  assert.equal(result.conversationHref, '');
  assert.equal(result.transientConversationHref, transient);
});

test('transient recovery requires original target and matching canonical location', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const pending = { ...capture, chatUrl: 'https://chatgpt.com/c/WEB:11111111-2222-3333-4444-555555555555' };
  let targets = [{ id: 'other-target', type: 'page', url: capture.chatUrl, webSocketDebuggerUrl: 'ws://example/other' }];
  globalThis.fetch = async () => new Response(JSON.stringify(targets));
  await assert.rejects(threadLib.resolveCapturedConversation(capture.browserEndpoint, pending.chatUrl, pending), /original browser target/);
  targets = [{ ...targets[0], id: capture.targetId, url: pending.chatUrl }];
  await assert.rejects(threadLib.resolveCapturedConversation(capture.browserEndpoint, pending.chatUrl, pending), /has not obtained a canonical URL/);
  targets[0].url = capture.chatUrl;
  const resolved = await threadLib.resolveCapturedConversation(capture.browserEndpoint, pending.chatUrl, pending);
  assert.equal(resolved.chatUrl, capture.chatUrl);
  assert.equal(pending.chatUrl.includes('WEB:'), true, 'original receipt remains unchanged');
  assert.equal(resolved.committedUserTurn, pending.committedUserTurn);
  await assert.rejects(threadLib.resolveCapturedConversation(capture.browserEndpoint, 'https://chatgpt.com/c/other', pending), /does not match/);
});

test('pending download completion rejects active responses and retains exact artifact identity', () => {
  const complete = snapshot('A synthetic artifact is ready.');
  complete.attachmentButtons = [{ tag: 'BUTTON', text: 'fixture.patch', href: null, behaviorButton: true,
    artifactIndexInAssistantTurn: 0, assistantTurnId: 'data-message-id:reply', assistantTurnIndex: 0,
    afterLastUserMessage: true, insideAssistantMessage: true, insideFinalAssistantMessage: true }];
  assert.throws(() => threadLib.completeDownloadCaptureIdentity(capture, { ...complete, stopVisible: true }), /not complete/);
  assert.throws(() => threadLib.completeDownloadCaptureIdentity(capture, snapshot('No file.')), /no captured artifacts/);
  const result = threadLib.completeDownloadCaptureIdentity(capture, complete);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.assistantResponse.assistantTurnId, 'data-message-id:reply');
  assert.equal(capture.assistantResponse, null);
  assert.throws(() => threadLib.completeDownloadCaptureIdentity(capture, { ...complete, userSnapshots: [] }), /identity resolved to 0 turns/);
});
