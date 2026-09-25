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
    new Element('div', {}, text), new Element('button', { 'aria-label': 'Copy' }),
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
