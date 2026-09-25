import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/prepare-chatgpt-draft.js', import.meta.url), 'utf8');
const start = source.indexOf('  const ensureRegularChatSurface = async');
const end = source.indexOf('  const promptMatchCandidates =', start);
const body = source.slice(start, end) + '\nensureRegularChatSurface';

function fixture(probes, chatPoint = { x: 1, y: 1 }) {
  const state = { now: 0, reads: 0, clicks: 0 };
  const ensure = vm.runInNewContext(body, {
    isDeepResearchMode: false,
    Date: { now: () => state.now },
    evaluate: async () => ({ status: probes[Math.min(state.reads++, probes.length - 1)], chatPoint }),
    buildRegularChatSurfaceProbeExpression: () => '',
    keepPageRenderingWhileBackgrounded: async () => {},
    clickNativePoint: async () => { state.clicks++; },
    sleep: async ms => { state.now += ms; },
  });
  return { ensure, state };
}

test('one authorized Work to Chat click waits through a still-Work render', async () => {
  const { ensure, state } = fixture(['work', 'work', 'chat-selected']);
  const result = await ensure({ allowSwitch: true });
  assert.equal(result.status, 'chat');
  assert.equal(result.switched, true);
  assert.deepEqual(state, { now: 400, reads: 3, clicks: 1 });
});

test('a permanently Work surface times out without another click or staging approval', async () => {
  const { ensure, state } = fixture(['work']);
  await assert.rejects(ensure({ allowSwitch: true }), /could not confirm the regular Chat surface/);
  assert.equal(state.now, 12000);
  assert.equal(state.clicks, 1);
});

test('Work remains forbidden when switching is disallowed or the Chat control is absent', async () => {
  for (const [allowSwitch, point] of [[false, { x: 1, y: 1 }], [true, null]]) {
    const { ensure, state } = fixture(['work'], point);
    await assert.rejects(ensure({ allowSwitch }), /refuses to stage or send a normal review in ChatGPT Work/);
    assert.equal(state.clicks, 0);
  }
});
