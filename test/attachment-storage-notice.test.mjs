import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildChatOnlyAttachmentNoticeDismissalExpression } = require('../src/prepare-chatgpt-draft.js');

function fixture({ text, labels, extraInput = false, disabledClose = false, hidden = false } = {}) {
  const clicks = [];
  const buttons = (labels ?? ['Manage storage', 'Close dialog']).map((label) => ({
    textContent: label,
    disabled: label === 'Close dialog' && disabledClose,
    getBoundingClientRect: () => ({ width: 30, height: 20 }),
    getAttribute: () => null,
    hasAttribute: () => false,
    click: () => clicks.push(label),
  }));
  const dialog = {
    innerText: text ?? 'File added to chat only\n\nYou don’t have enough storage space left to save this file. Remove files to create space.\n\nreview.zip\n34 MB\nManage storage\nClose dialog',
    getBoundingClientRect: () => ({ width: hidden ? 0 : 300, height: 200 }),
    querySelectorAll: () => buttons,
    querySelector: () => extraInput ? {} : null,
  };
  return { clicks, dialog };
}

function run(dialogs, names = ['review.zip']) {
  return vm.runInNewContext(buildChatOnlyAttachmentNoticeDismissalExpression(names), {
    document: { querySelectorAll: () => dialogs },
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }) },
  });
}

test('dismisses only the exact informational notice for the verified ZIP attachment', () => {
  const f = fixture();
  assert.equal(run([f.dialog]).status, 'dismissed');
  assert.deepEqual(f.clicks, ['Close dialog']);
});

test('leaves a draft without a visible attachment notice unchanged', () => {
  const f = fixture({ hidden: true });
  assert.equal(run([f.dialog]).status, 'absent');
  assert.deepEqual(f.clicks, []);
});

test('recognizes a late informational notice on a later readiness check', () => {
  const f = fixture();
  assert.equal(run([]).status, 'absent');
  assert.deepEqual(f.clicks, []);
  assert.equal(run([f.dialog]).status, 'dismissed');
  assert.deepEqual(f.clicks, ['Close dialog']);
});

for (const [name, options, names] of [
  ['upload failure', { text: 'File upload failed. Storage limit reached. Manage storage Close dialog' }],
  ['changed success notice', { text: 'File added to chat only Upload could not be completed. review.zip 34 MB Manage storage Close dialog' }],
  ['different attachment', {}, ['other.zip']],
  ['unverified attachment', {}, []],
  ['multiple requested attachments', {}, ['review.zip', 'companion.zip']],
  ['non-ZIP attachment', {}, ['review.pdf']],
  ['additional decision control', { labels: ['Manage storage', 'Close dialog', 'Delete files'] }],
  ['editable decision', { extraInput: true }],
  ['disabled dismissal', { disabledClose: true }],
]) {
  test(`fails closed for ${name}`, () => {
    const f = fixture(options);
    assert.equal(run([f.dialog], names).status, 'blocked');
    assert.deepEqual(f.clicks, []);
  });
}

test('fails closed when another dialog is also visible', () => {
  const first = fixture();
  const second = fixture();
  assert.equal(run([first.dialog, second.dialog]).status, 'blocked');
  assert.deepEqual([...first.clicks, ...second.clicks], []);
});

// Execute the production closure bodies together, replacing only browser I/O.
// In particular, never let this regression test submit a real message.
function readinessHarness({ notice = fixture(), verificationOk = true } = {}) {
  const source = readFileSync(new URL('../src/prepare-chatgpt-draft.js', import.meta.url), 'utf8');
  const extract = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
  };
  const dismiss = extract('  const dismissVerifiedAttachmentNotice = async () => {', '  const buildModelMatchersLiteral =');
  const readiness = extract('  const waitForAutoSendReadiness = async (requireComposerText) => {', '  const attemptEnterSend =');
  const baseline = { attachmentCount: 0 };
  const events = [];
  let dialogs = [];
  let attempts = 0;
  const context = {
    verifiedAttachmentContext: { baselineState: baseline, expectedNames: ['review.zip'], expectedCount: 1 },
    buildChatOnlyAttachmentNoticeDismissalExpression,
    evaluate: async (expression) => {
      const result = vm.runInNewContext(expression, {
        document: { querySelectorAll: () => dialogs },
        window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }) },
      });
      if (result.status === 'dismissed') {
        events.push('close');
        dialogs = [];
      }
      return result;
    },
    verifyDraftAttachments: async (actualBaseline, names, count) => {
      assert.equal(actualBaseline, baseline);
      assert.deepEqual(names, ['review.zip']);
      assert.equal(count, 1);
      events.push('verify-original-baseline');
      return { ok: verificationOk };
    },
    formatAttachmentVerificationSummary: () => 'not confirmed',
    readAutoSendState: async () => ({ uploading: false, composerSignature: 'unchanged prompt' }),
    promptMatchCandidates: ['unchanged prompt'],
    promptSignatureMatches: (actual, expected) => expected.includes(actual),
    attemptClickSendButton: async () => {
      if (++attempts === 1) {
        // The notice arrives after the first notice probe, as in the real UI.
        dialogs = [notice.dialog];
        events.push('blocked-send');
        return { status: 'send-button-disabled' };
      }
      assert.equal(dialogs.length, 0);
      events.push('intercepted-send');
      return { status: 'clicked' };
    },
    sleep: async () => {},
    timeoutMs: 1000,
    console: { log: () => {} },
  };
  const wait = vm.runInNewContext(`(() => { ${dismiss}\n${readiness}\nreturn waitForAutoSendReadiness; })()`, context);
  return { wait, events, notice };
}

test('actual readiness loop dismisses a late notice and rechecks the original upload before intercepted Send', async () => {
  const h = readinessHarness();
  assert.equal((await h.wait(true)).status, 'ready');
  assert.deepEqual(h.events, ['blocked-send', 'close', 'verify-original-baseline', 'intercepted-send']);
  assert.deepEqual(h.notice.clicks, ['Close dialog']);
});

test('actual readiness loop never sends after attachment re-verification fails', async () => {
  const h = readinessHarness({ verificationOk: false });
  await assert.rejects(h.wait(true), /attachments not confirmed after notice dismissal/);
  assert.deepEqual(h.events, ['blocked-send', 'close', 'verify-original-baseline']);
});

test('actual readiness loop fails closed on a late decision dialog without dismissing or sending', async () => {
  const h = readinessHarness({ notice: fixture({ labels: ['Manage storage', 'Delete files'] }) });
  await assert.rejects(h.wait(true), /requires manual attention/);
  assert.deepEqual(h.events, ['blocked-send']);
  assert.deepEqual(h.notice.clicks, []);
});
