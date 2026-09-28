import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { readChatGptTurnText, normalizeComparableText } = require('../src/chatgpt-dom-snapshot-shared.js');
const driver = require('../src/prepare-chatgpt-draft.js');
const { extractTransientConversationHref, extractConversationHref, resolveAcceptedConversationAfterSend } = driver;
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

test('code chrome normalization preserves table cell boundaries in exact response identity', () => {
  const table = (first, second, tag) => element('ARTICLE', [
    response('const example = 42;'),
    element('TABLE', [element('TR', [element(tag, [first]), element(tag, [second])])]),
  ]);
  for (const tag of ['TD', 'TH']) {
    const originalText = readChatGptTurnText(table('1', '23', tag));
    const changedText = readChatGptTurnText(table('12', '3', tag));
    assert.notEqual(originalText, changedText, tag);
    const completed = snapshotLib.completeThreadCaptureIdentity(capture, snapshot(originalText));
    assert.throws(() => snapshotLib.scopeThreadSnapshotToCaptureIdentity(snapshot(changedText), completed), /identity resolved to 0 turns/);
    snapshotLib.scopeThreadSnapshotToCaptureIdentity(snapshot(originalText), completed);
  }
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


const driverSource = readFileSync(new URL('../src/prepare-chatgpt-draft.js', import.meta.url), 'utf8');
const verificationSource = driverSource.slice(
  driverSource.indexOf('  const verifyCommittedUserTurnAttachments ='),
  driverSource.indexOf('  const waitForConversationStateAfterSend ='),
);
const autoSendSource = driverSource.slice(
  driverSource.indexOf('  const autoSendDraftMessage ='),
  driverSource.indexOf("  await cdp('Page.enable');", driverSource.indexOf('  const autoSendDraftMessage =')),
);
function acceptedSendFixture({ chatUrl = capture.chatUrl, attached = true, readState } = {}) {
  const turn = { ...capture.committedUserTurn, attachmentTexts: attached ? ['fixture.zip'] : [] };
  const commit = { status: 'committed', committedUserTurn: turn, state: { href: chatUrl }, newUserTurnSignature: turn.signature };
  const events = [];
  let receipt = null;
  const context = vm.createContext({
    ...driver, shouldAttachFiles: true, expectedAttachmentNames: ['fixture.zip'],
    draftPrompt: turn.signature, timeoutMs: 20, desiredTargetOrigin: 'https://chatgpt.com',
    remotePort: '9222', captureTargetId: capture.targetId, captureMetadataFile: 'synthetic-capture.json',
    isDeepResearchMode: false, acceptedSendProven: false, acceptedCaptureIdentity: null,
    ownedTargetSignalCleanup: null, closeOwnedTargetOnSignal: () => {}, console: { log: () => {} },
    waitForAutoSendContextReady: async () => ({ status: 'ready' }),
    readAutoSendBaseline: async () => ({}), readResponseCaptureBaseline: async () => ({}),
    waitForAutoSendReadiness: async () => ({ status: 'ready' }),
    attemptClickSendButton: async () => { events.push('send'); return { status: 'clicked' }; },
    verifyAutoSendCommitted: async () => commit,
    waitForConversationStateAfterSend: async () => ({ status: 'ready', href: chatUrl }),
    resolveAcceptedConversationAfterSend: async () => ({
      conversationHref: extractConversationHref(chatUrl), transientConversationHref: extractTransientConversationHref(chatUrl),
      conversationStateResult: { state: { href: chatUrl } },
    }),
    readAutoSendState: async () => { events.push('read'); return await readState?.(turn) ?? { recentUserTurns: [turn] }; },
    sleep: async () => {}, advanceDeepResearchPlan: async () => null,
    writeThreadCaptureIdentity: (_file, value) => { events.push('receipt'); receipt = value; },
  });
  context.ownedTargetSignalCleanup = context.closeOwnedTargetOnSignal;
  vm.runInContext(verificationSource + autoSendSource, context);
  return { events, context, turn, commit, receipt: () => receipt,
    send: () => vm.runInContext('autoSendDraftMessage()', context),
    verify: () => { context.commit = commit; return vm.runInContext('verifyCommittedUserTurnAttachments(commit, 5)', context); },
  };
}

test('accepted send persists already-proven attachments without a redundant failing browser read', async () => {
  const f = acceptedSendFixture({ readState: async () => { throw new Error('Synthetic disconnected CDP'); } });
  assert.equal((await f.send()).status, 'sent');
  assert.deepEqual(f.events, ['send', 'receipt']);
  assert.equal(f.receipt().targetId, capture.targetId);
  assert.equal(f.context.acceptedSendProven, true);
  assert.equal(f.context.ownedTargetSignalCleanup, null);
});

test('incomplete committed attachments poll only the exact turn and reject missing or ambiguous proof', async () => {
  const hydrated = acceptedSendFixture({ attached: false, readState: async turn => ({ recentUserTurns: [{ ...turn, attachmentTexts: ['fixture.zip'] }] }) });
  assert.equal((await hydrated.verify()).status, 'confirmed');
  assert.deepEqual(hydrated.events, ['read']);
  const wrong = acceptedSendFixture({ attached: false, readState: async turn => ({ recentUserTurns: [{ ...turn, turnId: 'other-request', attachmentTexts: ['fixture.zip'] }] }) });
  assert.equal((await wrong.verify()).status, 'missing');
  assert.equal(wrong.receipt(), null);
  const ambiguous = acceptedSendFixture({ attached: false, readState: async turn => ({ recentUserTurns: [turn, turn] }) });
  assert.equal((await ambiguous.verify()).status, 'ambiguous-turn');
  assert.equal(ambiguous.receipt(), null);
  const failed = acceptedSendFixture({ attached: false, readState: async () => { throw new Error('Synthetic read failure'); } });
  await assert.rejects(failed.verify(), /Synthetic read failure/);
  assert.equal(failed.receipt(), null);
});

test('raw and encoded transient sends persist pending receipts then promote only through the original target', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const separator of [':', '%3A']) {
    const chatUrl = 'https://chatgpt.com/c/WEB' + separator + '11111111-2222-3333-4444-555555555555';
    const f = acceptedSendFixture({ chatUrl });
    await assert.rejects(f.send(), /Exact target and turn metadata was retained/);
    assert.deepEqual(f.events, ['send', 'receipt']);
    const pending = snapshotLib.parseThreadCaptureIdentity(f.receipt());
    assert.equal(pending.assistantResponse, null);
    assert.equal(pending.browserEndpoint, capture.browserEndpoint);
    assert.equal(pending.targetId, capture.targetId);
    assert.equal(pending.chatUrl, extractTransientConversationHref(chatUrl));
    globalThis.fetch = async () => new Response(JSON.stringify([{ id: capture.targetId, type: 'page', url: capture.chatUrl, webSocketDebuggerUrl: 'ws://example/owned' }]));
    const canonical = await threadLib.resolveCapturedConversation(capture.browserEndpoint, chatUrl, pending);
    assert.equal((await threadLib.resolveCapturedConversation(capture.browserEndpoint, pending.chatUrl, pending)).chatUrl, capture.chatUrl);
    for (const different of [chatUrl.replace('chatgpt.com', 'example.com'), chatUrl.replace('11111111-', '99999999-'), 'https://chatgpt.com/c/WEB%ZZ']) {
      await assert.rejects(threadLib.resolveCapturedConversation(capture.browserEndpoint, different, pending), /does not match/);
    }
    const completed = snapshotLib.completeThreadCaptureIdentity(canonical, snapshot('A complete synthetic response.'));
    assert.equal(completed.chatUrl, capture.chatUrl);
    assert.equal(completed.assistantResponse.assistantTurnId, 'data-message-id:reply');
    assert.equal(pending.assistantResponse, null);
    assert.throws(() => snapshotLib.completeThreadCaptureIdentity(canonical, { ...snapshot('Complete.'), userSnapshots: [] }), /identity resolved to 0 turns/);
    globalThis.fetch = async () => new Response(JSON.stringify([{ id: 'foreign-target', type: 'page', url: capture.chatUrl, webSocketDebuggerUrl: 'ws://example/foreign' }]));
    await assert.rejects(threadLib.resolveCapturedConversation(capture.browserEndpoint, chatUrl, pending), /original browser target/);
    globalThis.fetch = async () => new Response(JSON.stringify([{ id: capture.targetId, type: 'page', url: 'https://example.com/c/synthetic', webSocketDebuggerUrl: 'ws://example/owned' }]));
    await assert.rejects(threadLib.resolveCapturedConversation(capture.browserEndpoint, chatUrl, pending), /has not obtained a canonical URL/);
    for (const missing of [{ targetId: '' }, { browserEndpoint: '' }, { committedUserTurn: null }]) {
      assert.throws(() => driver.buildThreadCaptureIdentity({ ...capture, chatUrl, ...missing }), /Could not persist/);
    }
    assert.throws(() => driver.buildThreadCaptureIdentity({ ...capture, chatUrl, assistantSnapshot: snapshot('Complete.').assistantSnapshots[0] }), /exact browser, thread, and target/);
  }
  assert.throws(() => driver.buildThreadCaptureIdentity({ ...capture, chatUrl: 'https://chatgpt.com/c/WEB:invalid' }), /exact browser, thread, and target/);
});
