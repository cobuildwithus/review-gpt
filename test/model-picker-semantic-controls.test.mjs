import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const owner = new URL('../src/prepare-chatgpt-draft.js', import.meta.url);
const source = readFileSync(owner, 'utf8');
const start = source.indexOf('  const buildModelSelectionProbeExpression =');
const end = source.indexOf('  const buildModelSelectionExpression =', start);
const buildProbe = vm.runInNewContext(source + '\n' + source.slice(start, end) + '\nbuildModelSelectionProbeExpression', {
  require: createRequire(owner), module: { exports: {} }, process, console, Buffer, URL,
  setTimeout, clearTimeout, setInterval, clearInterval,
});

class Element {
  constructor(tag, text, attributes = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.textContent = text;
    this.attributes = attributes;
    this.children = children;
    for (const child of children) child.parentElement = this;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  getBoundingClientRect() { return { left: 10, top: 20, width: this.hidden ? 0 : 80, height: 30 }; }
  scrollIntoView() {}
  matches(selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (selector.includes('.')) return false;
    return [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) => value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value);
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.descendants()]);
    return descendants.filter(node => selector.split(',').some(part => node.matches(part.trim())));
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function probe({ menuLabel, legacy = false, triggerLabel = 'Select ChatGPT model', disabledSummary = false } = {}) {
  const trigger = new Element('button', 'Thinking effortPro', { 'aria-label': triggerLabel, 'aria-haspopup': 'menu' });
  if (legacy) trigger.attributes['data-testid'] = 'model-switcher-dropdown-button';
  const summary = menuLabel === undefined ? null : new Element('div', menuLabel, {
    role: 'menuitem', 'aria-label': 'Select model', ...(disabledSummary ? { disabled: '' } : {}),
  });
  const menu = summary ? new Element('div', '', { role: 'menu' }, [summary]) : null;
  const nodes = [trigger, ...(menu ? [menu, summary] : [])];
  return vm.runInNewContext(buildProbe('gpt-6-pro'), {
    HTMLElement: Element,
    window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    document: { querySelectorAll(selector) {
      return nodes.filter(node => selector.split(',').some(part => {
        const ancestry = part.trim().split(/\s+(?=[^\]]*(?:\[|$))/);
        if (ancestry.length === 1) return node.matches(ancestry[0]);
        const childSelector = ancestry.pop();
        return node.matches(childSelector) && node.parentElement?.matches(ancestry.join(' '));
      }));
    } },
  });
}

test('semantic model trigger opens the picker without accepting bare Pro effort as GPT-6 Pro proof', () => {
  assert.equal(probe().status, 'click-button');
});

test('semantic visible menu summary proves explicit GPT-6 Pro', () => {
  assert.equal(probe({ menuLabel: '6Pro' }).status, 'already-selected');
});

test('unknown and wrong model summaries never prove GPT-6 Pro', () => {
  for (const menuLabel of ['Unknown', '5.6 Pro', '6 Thinking', 'Pro']) {
    assert.notEqual(probe({ menuLabel }).status, 'already-selected', menuLabel);
  }
  assert.notEqual(probe({ menuLabel: '6Pro', disabledSummary: true }).status, 'already-selected');
});

test('legacy model trigger remains supported and unrelated buttons are ignored', () => {
  assert.equal(probe({ legacy: true }).status, 'click-button');
  assert.equal(probe({ triggerLabel: 'Unrelated action' }).status, 'button-missing');
});
