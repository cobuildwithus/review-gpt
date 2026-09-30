import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildThreadCaptureIdentity, modelAttestationForSnapshot, selectAssistantResponseCandidate } = require('../src/prepare-chatgpt-draft.js');
const source = readFileSync(new URL('../src/prepare-chatgpt-draft.js', import.meta.url), 'utf8');
const start = source.indexOf('  const waitForAssistantResponse = async (baselineSnapshot, committedUserTurn, acceptedChatUrl) => {');
const end = source.indexOf('    let lastState = null;', start);
assert.ok(start >= 0 && end > start);

// Execute the actual waiter identity preparation and guards before browser I/O.
async function preparedIdentity(signature, { required = true, turnId = 'user-1', turnIndex = 0 } = {}) {
  return vm.runInNewContext(`${source.slice(start, end)}\nreturn { signature: committedTurnSignature }; }; waitForAssistantResponse({}, committed, 'https://chatgpt.com/c/synthetic');`, {
    committed: { signature, turnId, turnIndex },
    extractConversationHref: (value) => value,
    responseTimeoutMs: 30_000,
    isDeepResearchMode: false,
    shouldSend: true,
    shouldWaitForResponse: true,
    modelTargetRaw: 'gpt-6-pro',
    modelVerificationRequired: () => required,
  });
}
function snapshot(signature, overrides = {}) {
  return { signature: 'synthetic assistant answer', text: 'No findings\nREVIEW_COMPLETE', precedingUserMessageSignature: signature, precedingUserTurnId: 'user-1', afterLastUserMessage: true, modelSlug: 'gpt-6-pro', ...overrides };
}
function select(value, required, turnId = 'user-1', requireAfter = true) {
  return selectAssistantResponseCandidate({ assistantSnapshots: [value] }, [], [], requireAfter, required, turnId, 0).snapshot;
}

for (const [name, signature] of [
  ['truncated trailing space', `${'x'.repeat(319)} `],
  ['leading space', ' exact signature'],
  ['boundary tab and newline', '\texact signature\n'],
]) {
  test(`preserves ${name} through waiter, selector, attestation, and receipt`, async () => {
    const prepared = await preparedIdentity(signature);
    assert.equal(prepared.signature, signature);
    const value = snapshot(signature);
    assert.equal(select(value, prepared.signature)?.text, value.text);
    assert.equal(modelAttestationForSnapshot('gpt-6-pro', value, true, prepared.signature).failure, '');
    const identity = buildThreadCaptureIdentity({ browserEndpoint: 'http://127.0.0.1:9222', chatUrl: 'https://chatgpt.com/c/synthetic', targetId: 'synthetic-target', committedUserTurn: { signature, turnId: 'user-1', turnIndex: 0 } });
    assert.equal(identity.committedUserTurn.signature, `sha256:${createHash('sha256').update(signature).digest('hex')}`);
  });
}
for (const [name, actual] of [
  ['removed trailing whitespace', 'exact signature'],
  ['changed trailing whitespace', 'exact signature\t'],
  ['changed content', 'other signature '],
]) {
  test(`rejects ${name} even with the same turn ID`, () => {
    const value = snapshot(actual);
    assert.equal(select(value, 'exact signature '), null);
    assert.match(modelAttestationForSnapshot('gpt-6-pro', value, true, 'exact signature ').failure, /not bound/);
  });
}
test('exact signatures do not permit a different user turn or model', () => {
  assert.equal(select(snapshot('exact ', { precedingUserTurnId: 'other-user' }), 'exact '), null);
  assert.match(modelAttestationForSnapshot('gpt-6-pro', snapshot('exact ', { modelSlug: 'gpt-6-mini' }), true, 'exact ').failure, /expected gpt-6-pro/);
});
test('blank signatures retain exact-ID and after-last-user fallback boundaries', () => {
  for (const blank of ['', ' \t\n']) {
    assert.ok(select(snapshot('existing'), blank));
    assert.equal(select(snapshot('existing', { precedingUserTurnId: 'other-user' }), blank), null);
    assert.ok(select(snapshot('existing'), blank, ''));
    assert.equal(select(snapshot('existing', { afterLastUserMessage: false }), blank, ''), null);
    assert.equal(modelAttestationForSnapshot('gpt-6-pro', snapshot('existing'), true, blank).failure, '');
    assert.match(modelAttestationForSnapshot('gpt-6-pro', snapshot('existing', { afterLastUserMessage: false }), true, blank).failure, /new assistant turn/);
  }
});
test('waiter keeps required blank-signature and missing-identity guards', async () => {
  for (const blank of ['', ' \t\n']) assert.equal((await preparedIdentity(blank)).status, 'model-verification-failed');
  assert.equal((await preparedIdentity('exact ', { turnId: '' })).status, 'target-identity-failed');
  assert.equal((await preparedIdentity('exact ', { turnIndex: 'invalid' })).status, 'target-identity-failed');
  assert.equal((await preparedIdentity(' ', { required: false })).signature, ' ');
});
