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

const statusStart = source.indexOf('function regularChatSurfaceStatus(');
const statusEnd = source.indexOf('\nasync function ', statusStart);
const probeStart = source.indexOf('  const buildRegularChatSurfaceProbeExpression =');
const probeEnd = source.indexOf('  const ensureRegularChatSurface =', probeStart);
const buildProbe = vm.runInNewContext(
  source.slice(statusStart, statusEnd) + '\n' + source.slice(probeStart, probeEnd) + '\nbuildRegularChatSurfaceProbeExpression',
);

// Minimal DOM semantics for the actual page probe, with no application classes.
class SurfaceElement {
  constructor(tag, text = '', attributes = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.textContent = text;
    this.innerText = text;
    this.attributes = attributes;
    this.children = children;
    for (const child of children) child.parentElement = this;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return { left: 0, top: 20, width: 80, height: 30 }; }
  scrollIntoView() {}
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector === '[role="radio"]') return this.getAttribute('role') === 'radio';
    if (selector === 'button[aria-pressed]') return this.tagName === 'BUTTON' && this.getAttribute('aria-pressed') !== null;
    if (selector === '#prompt-textarea') return this.getAttribute('id') === 'prompt-textarea';
    if (selector === '[data-testid^="work-usage-"]') return this.getAttribute('data-testid')?.startsWith('work-usage-');
    if (selector === '[data-testid*="work-usage"]') return this.getAttribute('data-testid')?.includes('work-usage');
    return false;
  }
  closest(selector) {
    return selector.split(',').some(part => this.matches(part.trim())) ? this : this.parentElement?.closest(selector) ?? null;
  }
}

function surfaceProbe({ mode = 'chat', radio = false, breadcrumb = false, usage = false, unknownControl = false } = {}) {
  const selectedAttribute = radio ? 'aria-checked' : 'aria-pressed';
  const control = label => new SurfaceElement('button', label, {
    ...(radio ? { role: 'radio' } : {}),
    [selectedAttribute]: String(mode === label.toLowerCase()),
  }, [new SurfaceElement('span', label)]);
  const roots = [new SurfaceElement('textarea', '', { id: 'prompt-textarea' })];
  if (!unknownControl) roots.push(control('Chat'), control('Work'));
  if (unknownControl) roots.push(new SurfaceElement('button', 'Other', { 'aria-pressed': 'true' }));
  if (breadcrumb) roots.push(new SurfaceElement('span', 'Work'));
  if (usage) roots.push(new SurfaceElement('div', '', { 'data-testid': 'work-usage-summary' }));
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const nodes = roots.flatMap(flatten);
  return vm.runInNewContext(buildProbe(), {
    HTMLElement: SurfaceElement,
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    location: { pathname: '/' },
    document: {
      querySelectorAll: selector => selector === 'body *' ? nodes : nodes.filter(node => selector.split(',').some(part => node.matches(part.trim()))),
    },
  });
}

test('actual surface probe recognizes pressed Chat buttons without mistaking their Work label for a breadcrumb', () => {
  const probe = surfaceProbe();
  assert.equal(probe.status, 'chat-selected');
  assert.ok(probe.chatPoint);
});

test('actual surface probe preserves radio controls and rejects pressed Work buttons', () => {
  assert.equal(surfaceProbe({ radio: true }).status, 'chat-selected');
  assert.equal(surfaceProbe({ mode: 'work' }).status, 'work');
  assert.equal(surfaceProbe({ mode: 'work', radio: true }).status, 'work');
});

test('actual surface probe retains independent Work breadcrumb and usage evidence even with pressed Chat', () => {
  assert.equal(surfaceProbe({ breadcrumb: true }).status, 'work');
  assert.equal(surfaceProbe({ usage: true }).status, 'work');
});

test('actual surface probe does not approve unselected or unknown new-chat controls', () => {
  assert.equal(surfaceProbe({ mode: 'neither' }).status, 'unknown');
  const probe = surfaceProbe({ unknownControl: true });
  assert.equal(probe.status, 'unknown');
  assert.equal(probe.chatPoint, null);
});
