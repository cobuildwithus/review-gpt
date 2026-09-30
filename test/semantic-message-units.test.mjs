import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const shared = require('../src/chatgpt-dom-snapshot-shared.js');
const driver = require('../src/prepare-chatgpt-draft.js');
const snapshotLib = await import('../dist/chatgpt-thread-snapshot-lib.mjs');
const source = readFileSync(new URL('../src/prepare-chatgpt-draft.js', import.meta.url), 'utf8');
const start = source.indexOf('  const readAutoSendState =');
const end = source.indexOf('  const readAutoSendBaseline =', start);

class Element {
  constructor(tag, attrs = {}, text = '', children = []) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.text = text; this.children = children;
    this.classList = { contains: () => false };
    for (const child of children) child.parentElement = this;
  }
  get textContent() { return [this.text, ...this.children.map(child => child.textContent)].filter(Boolean).join('\n'); }
  get innerText() { return this.textContent; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  getBoundingClientRect() { return { width: 100, height: 20 }; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  contains(node) { return node === this || this.descendants().includes(node); }
  compareDocumentPosition(node) {
    let root = this; while (root.parentElement) root = root.parentElement;
    return root.descendants().indexOf(node) > root.descendants().indexOf(this) ? 4 : 2;
  }
  matches(selector) {
    const has = selector.match(/^(.*):has\((.*)\)$/);
    if (has) {
      const direct = has[2].startsWith('>');
      const children = direct ? this.children : this.descendants();
      return this.matches(has[1]) && children.some(child => child.matches(has[2].replace(/^>\s*/, '')));
    }
    if (selector === '.markdown') return String(this.attrs.class || '').split(/\s+/).includes('markdown');
    if (selector.includes(' ') && !selector.includes('[')) return false;
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    const attributes = [...selector.matchAll(/\[([\w-]+)(?:([*$^]?=)"([^"]*)")?\]/g)];
    if (!tag && attributes.length === 0) return false;
    return attributes.every(([, name, operator, value]) => {
      const actual = this.getAttribute(name);
      if (!operator) return actual !== null;
      if (actual === null) return false;
      return operator === '$=' ? actual.endsWith(value) : operator === '*=' ? actual.includes(value) : operator === '^=' ? actual.startsWith(value) : actual === value;
    });
  }
  querySelectorAll(selector) { return this.descendants().filter(node => selector.split(',').some(part => node.matches(part.trim()))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { return selector.split(',').some(part => this.matches(part.trim())) ? this : this.parentElement?.closest(selector) ?? null; }
}
function fixture({ userId = 'request-one', attachment = true, text = 'Synthetic exact response. REVIEW_COMPLETE', role = 'assistant' } = {}) {
  const user = new Element('div', { 'data-chatgpt-search-unit-key': 'synthetic:0:user', 'data-chatgpt-search-message-ids': userId }, '', [
    ...(attachment ? [new Element('button', { 'aria-label': 'fixture.zip' })] : []),
    new Element('div', { 'data-user-message-bubble': 'true' }, 'Review the attached synthetic candidate carefully.'),
  ]);
  const assistant = new Element('div', { 'data-chatgpt-search-unit-key': `synthetic:1:${role}`, 'data-chatgpt-search-message-ids': 'reply-one reply-two' }, '', [
    new Element('h4', { 'data-conversation-role': role }, 'Response:'),
    new Element('div', { class: 'markdown' }, text), new Element('button', { 'aria-label': 'Copy' }),
  ]);
  const root = new Element('main', {}, '', [user, assistant]);
  const document = { body: root, readyState: 'complete', title: 'Synthetic', querySelector: s => s === 'main' ? root : root.querySelector(s), querySelectorAll: s => root.querySelectorAll(s) };
  const context = { document, URL, HTMLElement: Element, HTMLTextAreaElement: class {}, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, location: { href: 'https://chatgpt.com/c/synthetic' }, window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } };
  return { root, user, assistant, context };
}
function capture(f) { return vm.runInNewContext(shared.buildChatGptCaptureStateExpression(), f.context); }
async function sendState(f) {
  const read = vm.runInNewContext(source.slice(start, end) + '\nreadAutoSendState', {
    ...shared, desiredTargetOriginLiteral: JSON.stringify('https://chatgpt.com'), desiredTargetChatIdLiteral: JSON.stringify(''),
    evaluate: async expression => vm.runInNewContext(expression, f.context),
  });
  return await read();
}

test('semantic message units are shared by send proof and export with attachment siblings and stable identities', async () => {
  const f = fixture(), state = await sendState(f), snapshot = capture(f);
  assert.equal(state.recentUserTurns.length, 1);
  assert.equal(snapshot.userSnapshots.length, 1);
  assert.equal(snapshot.assistantSnapshots.length, 1);
  const turn = state.recentUserTurns[0];
  assert.equal(turn.turnId, 'data-chatgpt-search-message-ids:request-one');
  assert.equal(snapshot.userSnapshots[0].turnId, turn.turnId);
  assert.equal(snapshot.assistantSnapshots[0].precedingUserTurnId, turn.turnId);
  assert.equal(snapshot.assistantSnapshots[0].assistantTurnId, 'data-chatgpt-search-message-ids:reply-one reply-two');
  assert.equal(driver.committedTurnAttachmentVerification(turn, ['fixture.zip']).confirmed, true);
  assert.equal(driver.evaluateAutoSendCommitState({ baselineSnapshot: { turnCount: 0, userTurnIds: [] }, promptCandidates: driver.buildPromptMatchCandidates('Review the attached synthetic candidate carefully.'), state }).committed, true);
});

test('missing attachment or a different request cannot borrow proof from an adjacent message', async () => {
  const f = fixture({ attachment: false });
  f.assistant.children.push(new Element('button', { 'aria-label': 'fixture.zip' }));
  const state = await sendState(f);
  assert.equal(state.recentUserTurns.length, 1);
  assert.equal(driver.committedTurnAttachmentVerification(state.recentUserTurns[0], ['fixture.zip']).confirmed, false);
  assert.equal(driver.evaluateAutoSendCommitState({ baselineSnapshot: { turnCount: 0, userTurnIds: [] }, promptCandidates: driver.buildPromptMatchCandidates('An unrelated request must never match this candidate.'), state }).committed, false);
});

test('semantic recovery rejects changed user identity, changed response content, and unknown roles', () => {
  const initial = capture(fixture());
  assert.equal(initial.assistantSnapshots.length, 1);
  const identity = driver.buildThreadCaptureIdentity({ browserEndpoint: 'http://127.0.0.1:9222', chatUrl: 'https://chatgpt.com/c/synthetic', targetId: 'owned', committedUserTurn: initial.userSnapshots[0], assistantSnapshot: initial.assistantSnapshots[0], attachmentButtons: [] });
  assert.throws(() => snapshotLib.scopeThreadSnapshotToCaptureIdentity(capture(fixture({ userId: 'different-request' })), identity), /identity resolved to 0 turns/);
  assert.throws(() => snapshotLib.scopeThreadSnapshotToCaptureIdentity(capture(fixture({ text: 'Changed response. REVIEW_COMPLETE' })), identity), /identity resolved to 0 turns/);
  assert.equal(capture(fixture({ role: 'tool' })).assistantSnapshots.length, 0);
});

test('capability scanning excludes semantic message quotes but still rejects a real external footer', () => {
  const notice = 'Capabilities reduced until 9:00 PM. Responses may have lower quality.';
  const f = fixture({ text: notice });
  const collect = () => vm.runInNewContext(`(${shared.collectChatGptCapabilityLimitText.toString()})()`, f.context);
  assert.equal(collect(), '');
  const footer = new Element('footer', {}, notice);
  footer.parentElement = f.root;
  f.root.children.push(footer);
  assert.equal(collect(), notice);
  assert.throws(() => shared.assertChatGptCapabilitiesAvailable({ capabilityLimitText: collect() }), { code: 'REVIEW_GPT_RATE_LIMITED' });
});


test('capability scanning retains a product footer beside semantic assistant content', () => {
  const notice = 'Capabilities reduced until 9:00 PM. Responses may have lower quality.';
  const f = fixture({ text: notice });
  const collect = () => vm.runInNewContext(`(${shared.collectChatGptCapabilityLimitText.toString()})()`, f.context);
  assert.equal(collect(), '', 'quoted assistant text remains excluded');
  const footer = new Element('footer', {}, notice);
  footer.parentElement = f.assistant;
  f.assistant.children.push(footer);
  assert.equal(collect(), notice);
  assert.throws(() => shared.assertChatGptCapabilitiesAvailable(capture(f)), { code: 'REVIEW_GPT_RATE_LIMITED' });
  footer.parentElement = f.user;
  f.assistant.children.pop();
  f.user.children.push(footer);
  assert.equal(collect(), '', 'semantic user content cannot masquerade as product UI');
});


const threadSource = readFileSync(new URL('../dist/chatgpt-thread-lib.mjs', import.meta.url), 'utf8');
const downloadOwners = vm.runInNewContext(`(() => {
  ${threadSource.slice(threadSource.indexOf('async function findAttachmentClickTargetWithSelector('), threadSource.indexOf('async function waitForDownloadedFile('))}
  return { findAttachmentClickTargetWithSelector, clickAttachmentWithSelector };
})()`.replace('export async function', 'async function'), { ...shared, sleep: async () => {} });

test('malformed hrefs preserve exact artifact labels across capture, export and download', async () => {
  const readContent = vm.runInNewContext(threadSource.slice(threadSource.indexOf('async function readThreadContentState('), threadSource.indexOf('function parseContentDispositionFilename(')) + '\nreadThreadContentState', shared);
  for (const [leaf, expected] of [['100%.patch', '100%.patch'], ['%ZZ.patch', '%ZZ.patch'], ['%E0%A4.patch', '%E0%A4.patch'], ['two%20words.patch', 'two words.patch'], ['100%25.patch', '100%.patch'], ['%252E.patch', '%2E.patch']]) {
    const f = fixture();
    const ordinary = new Element('a', {}, 'Synthetic reference');
    ordinary.href = 'https://example.invalid/' + leaf.replace('.patch', '');
    ordinary.parentElement = f.assistant;
    f.assistant.children.push(ordinary);
    const client = { evaluate: async expression => vm.runInNewContext(expression, f.context), send: async () => assert.fail('DOM activation must not fall back to native click') };
    assert.equal((await readContent(client)).attachmentButtonCount, 1, 'ordinary links are not artifacts');
    const artifactNode = new Element('a', { download: '' });
    artifactNode.href = 'sandbox:/mnt/data/' + leaf;
    let clicks = 0;
    artifactNode.click = () => { clicks++; };
    artifactNode.scrollIntoView = () => {};
    artifactNode.parentElement = f.assistant;
    f.assistant.children.push(artifactNode);
    assert.equal((await readContent(client)).attachmentButtonCount, 2);
    const snapshot = snapshotLib.normalizeThreadSnapshot(capture(f));
    const identity = driver.buildThreadCaptureIdentity({ browserEndpoint: 'http://127.0.0.1:9222', chatUrl: 'https://chatgpt.com/c/synthetic', targetId: 'owned', committedUserTurn: snapshot.userSnapshots[0], assistantSnapshot: snapshot.assistantSnapshots[0], attachmentButtons: snapshot.attachmentButtons });
    const artifact = snapshotLib.scopeThreadSnapshotToCaptureIdentity(snapshot, identity).attachmentButtons[0];
    assert.equal(snapshotLib.deriveAttachmentLabel(artifact), expected);
    assert.equal(identity.artifacts.length, 1);
    assert.equal((await downloadOwners.findAttachmentClickTargetWithSelector(client, expected, artifact)).found, true);
    assert.equal((await downloadOwners.clickAttachmentWithSelector(client, expected, 1, artifact)).found, true);
    assert.equal(clicks, 1);
    assert.equal((await downloadOwners.findAttachmentClickTargetWithSelector(client, expected, { ...artifact, href: artifact.href + '-changed' })).found, false);
  }
});

for (const layout of ['semantic', 'hybrid', 'legacy']) {
  test(`capture and pending recovery preserve exact download lookup and activation (${layout})`, async () => {
    const f = fixture();
    if (layout === 'hybrid') f.assistant.attrs['data-testid'] = 'conversation-turn-assistant';
    if (layout === 'legacy') {
      delete f.assistant.attrs['data-chatgpt-search-message-ids'];
      f.assistant.attrs['data-message-author-role'] = 'assistant';
      f.assistant.attrs['data-message-id'] = 'legacy-reply';
    }
    const button = new Element('button', { download: '', 'aria-label': 'fixture.patch' });
    let activations = 0;
    button.parentElement = f.assistant;
    button.scrollIntoView = () => {};
    button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 20 });
    button.click = () => { activations++; };
    f.assistant.children.push(button);
    const snapshot = snapshotLib.normalizeThreadSnapshot(capture(f));
    const pending = driver.buildThreadCaptureIdentity({ browserEndpoint: 'http://127.0.0.1:9222', chatUrl: 'https://chatgpt.com/c/synthetic', targetId: 'owned-target', committedUserTurn: snapshot.userSnapshots[0] });
    const { completeDownloadCaptureIdentity } = await import('../dist/chatgpt-thread-lib.mjs');
    const completed = completeDownloadCaptureIdentity(pending, snapshot);
    assert.equal(completed.artifacts.length, 1);
    const artifact = snapshotLib.scopeThreadSnapshotToCaptureIdentity(snapshot, completed).attachmentButtons[0];
    const label = 'fixture.patch';
    const client = { evaluate: async expression => vm.runInNewContext(expression, f.context), send: async () => assert.fail('DOM activation must not fall back to native click') };
    assert.equal((await downloadOwners.findAttachmentClickTargetWithSelector(client, label, artifact)).found, true);
    assert.equal((await downloadOwners.clickAttachmentWithSelector(client, label, 1, artifact)).found, true);
    assert.equal(activations, 1);
    for (const changed of [
      { ...artifact, assistantTurnId: 'data-message-id:different' },
      { ...artifact, assistantTurnIndex: 1 },
      { ...artifact, href: 'sandbox:/mnt/data/different.patch' },
      { ...artifact, artifactIndexInAssistantTurn: 1 },
    ]) {
      assert.equal((await downloadOwners.findAttachmentClickTargetWithSelector(client, label, changed)).found, false);
      assert.equal((await downloadOwners.clickAttachmentWithSelector(client, label, -1, changed)).found, false);
      assert.equal(activations, 1);
    }
  });
}


test('exact captured UUIDs survive legacy-to-semantic message attributes without weakening signatures', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const replyId = '22222222-2222-4222-8222-222222222222';
  const otherId = '33333333-3333-4333-8333-333333333333';
  const f = fixture({ userId });
  f.assistant.attrs['data-chatgpt-search-message-ids'] = replyId;
  for (const [node, role, id] of [[f.user, 'user', userId], [f.assistant, 'assistant', replyId]]) {
    node.attrs['data-message-author-role'] = role;
    node.attrs['data-message-id'] = id;
  }
  const legacy = capture(f);
  const input = { browserEndpoint: 'http://127.0.0.1:9222', chatUrl: 'https://chatgpt.com/c/synthetic', targetId: 'owned', committedUserTurn: legacy.userSnapshots[0], attachmentButtons: [] };
  const pending = driver.buildThreadCaptureIdentity(input);
  const completed = driver.buildThreadCaptureIdentity({ ...input, assistantSnapshot: legacy.assistantSnapshots[0] });
  for (const node of [f.user, f.assistant]) {
    delete node.attrs['data-message-id'];
    delete node.attrs['data-message-author-role'];
  }
  f.assistant.attrs['data-chatgpt-search-message-ids'] = `${replyId} ${replyId}`;
  const current = capture(f);
  assert.equal(current.userSnapshots[0].signature, legacy.userSnapshots[0].signature);
  for (const identity of [pending, completed]) {
    assert.equal(snapshotLib.scopeThreadSnapshotToCaptureIdentity(current, identity).assistantSnapshots.length, 1);
  }
  const checkPending = snapshot => snapshotLib.scopeThreadSnapshotToCaptureIdentity(snapshot, pending);
  assert.throws(() => checkPending({ ...current, userSnapshots: [current.userSnapshots[0], current.userSnapshots[0]] }), /resolved to 2 turns/);
  for (const changedId of [otherId, `${userId} ${otherId}`]) {
    f.user.attrs['data-chatgpt-search-message-ids'] = changedId;
    assert.throws(() => checkPending(capture(f)), /resolved to 0 turns/);
  }
  f.user.attrs['data-chatgpt-search-message-ids'] = userId;
  f.user.children.at(-1).text = 'A different synthetic request must not recover the original.';
  assert.throws(() => checkPending(capture(f)), /resolved to 0 turns/);
  f.user.children.at(-1).text = 'Review the attached synthetic candidate carefully.';
  f.assistant.attrs['data-chatgpt-search-unit-key'] = 'synthetic:1:tool';
  assert.equal(checkPending(capture(f)).assistantSnapshots.length, 0);
  f.assistant.attrs['data-chatgpt-search-unit-key'] = 'synthetic:1:assistant';
  f.assistant.attrs['data-chatgpt-search-message-ids'] = `${replyId} ${otherId}`;
  assert.throws(() => snapshotLib.scopeThreadSnapshotToCaptureIdentity(capture(f), completed), /resolved to 0 turns/);
  const unrelatedNamespace = { ...current, userSnapshots: [{ ...current.userSnapshots[0], turnId: `data-turn-key:${userId}` }] };
  assert.throws(() => checkPending(unrelatedNamespace), /resolved to 0 turns/);
});


test('legacy ZIP attachment chrome recovery keeps the exact stored fingerprint', () => {
  function withZip({ filename = 'fixture.zip', kind = 'File', cards = 1, prompt = 'Review the attached synthetic candidate carefully.' } = {}) {
    const f = fixture({ userId: '11111111-1111-4111-8111-111111111111', attachment: false });
    const card = new Element('div', {}, '', Array.from({ length: cards }, () => new Element('div', {}, '', [
      new Element('button', { 'aria-label': filename }),
      new Element('span', { title: filename }, filename), new Element('span', {}, kind),
    ])));
    const bubble = f.user.children[0];
    bubble.text = prompt;
    const request = new Element('div', {}, '', [bubble]);
    card.parentElement = f.user; request.parentElement = f.user;
    f.user.children = [card, request];
    return f;
  }
  const previous = capture(withZip({ kind: 'Zip Archive' }));
  const pending = driver.buildThreadCaptureIdentity({ browserEndpoint: 'http://127.0.0.1:9222', chatUrl: 'https://chatgpt.com/c/synthetic', targetId: 'owned', committedUserTurn: previous.userSnapshots[0] });
  const current = capture(withZip());
  assert.notEqual(current.userSnapshots[0].signature, previous.userSnapshots[0].signature);
  assert.equal(snapshotLib.scopeThreadSnapshotToCaptureIdentity(current, pending).assistantSnapshots.length, 1);
  const completed = driver.buildThreadCaptureIdentity({ ...pending, committedUserTurn: previous.userSnapshots[0], assistantSnapshot: previous.assistantSnapshots[0], attachmentButtons: [] });
  assert.equal(snapshotLib.scopeThreadSnapshotToCaptureIdentity(current, completed).assistantSnapshots.length, 1);
  for (const options of [{ filename: 'different.zip' }, { filename: 'fixture.txt' }, { kind: 'Document' }, { cards: 2 }, { prompt: 'Different request must not pass its predecessor fingerprint.' }]) {
    assert.throws(() => snapshotLib.scopeThreadSnapshotToCaptureIdentity(capture(withZip(options)), pending), /resolved to 0 turns/);
  }
  const spoof = fixture({ userId: '11111111-1111-4111-8111-111111111111', attachment: false });
  spoof.user.children[0].text = 'fixture.zip File Review the attached synthetic candidate carefully.';
  assert.throws(() => snapshotLib.scopeThreadSnapshotToCaptureIdentity(capture(spoof), pending), /resolved to 0 turns/);
});
