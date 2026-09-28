import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const driverPath = process.env.REVIEW_GPT_DRIVER_TEST_PATH || new URL('../src/prepare-chatgpt-draft.js', import.meta.url).pathname;
const { createPageCdpCommandChannel } = require(driverPath);
const source = readFileSync(driverPath, 'utf8');

function channelFixture() {
  const listeners = new Map();
  const requests = [];
  const socket = {
    addEventListener(type, fn) {
      const handlers = listeners.get(type) || [];
      handlers.push(fn);
      listeners.set(type, handlers);
    },
    send(payload) { requests.push(JSON.parse(payload)); },
  };
  const channel = createPageCdpCommandChannel(socket, { commandTimeoutMs: 30, closeSocket() {} });
  return {
    channel,
    reply() {
      const { id } = requests.at(-1);
      for (const fn of listeners.get('message') || []) fn({ data: JSON.stringify({ id, result: { inserted: true } }) });
    },
  };
}

test('a healthy insertion can finish past the short command deadline without changing later command deadlines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel, reply } = channelFixture();
  const insertion = channel.command('Runtime.evaluate', {}, 180);
  t.mock.timers.tick(78);
  assert.equal(channel.pendingCount(), 1);
  reply();
  assert.deepEqual(await insertion, { inserted: true });
  assert.equal(channel.pendingCount(), 0);
  const ordinary = assert.rejects(channel.command('Page.reload'), /timed out: Page.reload/);
  t.mock.timers.tick(30);
  await ordinary;
  assert.equal(channel.pendingCount(), 0);
});

test('a stalled insertion still expires at its explicit bounded phase budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel } = channelFixture();
  const timeout = assert.rejects(channel.command('Runtime.evaluate', {}, 180), /timed out: Runtime.evaluate/);
  t.mock.timers.tick(179);
  assert.equal(channel.pendingCount(), 1);
  t.mock.timers.tick(1);
  await timeout;
  assert.equal(channel.pendingCount(), 0);
});

test('invalid per-call budgets retain the default deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const budget of [NaN, Infinity, 0, -1]) {
    const { channel } = channelFixture();
    const timeout = assert.rejects(channel.command('Runtime.evaluate', {}, budget), /timed out/);
    t.mock.timers.tick(30);
    await timeout;
    assert.equal(channel.pendingCount(), 0);
  }
});

test('the actual prompt insertion passes the configured draft budget without changing its synchronous text operation', async () => {
  const start = source.indexOf('  const setDraftComposerPrompt =');
  const end = source.indexOf('  const appendDraftComposerPromptNatively =', start);
  const calls = [];
  const insert = vm.runInNewContext(source.slice(start, end) + '\nsetDraftComposerPrompt', {
    configuredDraftTimeoutMs: 180,
    evaluate: async (expression, timeoutMs) => {
      calls.push({ expression, timeoutMs });
      return { ok: true };
    },
  });
  await insert('Synthetic multiline\ncontext\twith spaces.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 180);
  assert.match(calls[0].expression, /document\.execCommand\('insertText'/);
  assert.match(calls[0].expression, /Synthetic multiline\\ncontext\\twith spaces\./);
});

test('the actual evaluate helper forwards an explicit budget and otherwise keeps the ordinary deadline', async () => {
  const start = source.indexOf('  const evaluate = async (expression');
  const end = source.indexOf('  const evaluateHandle =', start);
  const calls = [];
  const evaluate = vm.runInNewContext(source.slice(start, end) + '\nevaluate', {
    pageCommandTimeoutMs: 30,
    cdp: async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      return { result: { value: 'unchanged result' } };
    },
  });
  assert.equal(await evaluate('synthetic expression', 180), 'unchanged result');
  assert.equal(await evaluate('ordinary expression'), 'unchanged result');
  assert.deepEqual(calls.map(call => call.timeoutMs), [180, 30]);
  assert.ok(calls.every(call => call.method === 'Runtime.evaluate' && call.params.awaitPromise === true));
});
