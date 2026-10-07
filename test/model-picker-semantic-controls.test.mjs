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
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector.split(',').some(part => node.matches(part.trim()))) return node;
    }
    return null;
  }
  focus() { this.focused = true; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}

function runProbe(nodes) {
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

// Mirrors the 2026-10-07 picker: a simple view with the model-list toggle and
// the Power slider, plus an inert model list whose checked row is the model.
function powerPicker({ checked = 'GPT-6', current = 4, listView = false, open = true } = {}) {
  const trigger = new Element('button', 'Thinking effortPro', { 'aria-label': 'Select ChatGPT model', 'aria-haspopup': 'menu' });
  if (!open) return { nodes: [trigger] };
  const toggle = new Element('div', 'Pro', { role: 'menuitem', 'aria-label': 'Select model', 'data-model-picker-view-toggle': 'true' });
  const slider = new Element('span', '', { role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '4', 'aria-valuenow': String(current), 'aria-hidden': 'true' });
  const power = new Element('div', '', { role: 'menuitem', 'aria-label': 'Power', 'data-reasoning-slider': 'true' }, [slider]);
  const simple = new Element('div', '', listView ? { inert: '' } : {}, [toggle, power]);
  const rows = ['GPT-6', 'GPT-5.6 Sol', 'GPT-5.5Leaving on October 14'].map(label =>
    new Element('div', label, { role: 'menuitemradio', 'aria-checked': String(label === checked) }));
  const list = new Element('div', '', listView ? {} : { inert: '' }, rows);
  const menu = new Element('div', '', { role: 'menu' }, [simple, list]);
  return { nodes: [trigger, menu, ...menu.descendants()], power };
}

function probe({ menuLabel, legacy = false, triggerLabel = 'Select ChatGPT model', triggerText = 'Thinking effortPro', disabledSummary = false } = {}) {
  const trigger = new Element('button', triggerText, { 'aria-label': triggerLabel, 'aria-haspopup': 'menu' });
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
  for (const triggerLabel of ['Select ChatGPT model', 'Select model']) {
    assert.equal(probe({ triggerLabel, triggerText: 'Pro', legacy: true }).status, 'click-button');
    assert.equal(probe({ triggerLabel, triggerText: '6Pro', legacy: true }).status, 'already-selected');
  }
  assert.equal(probe({ triggerText: 'Pro' }).status, 'click-button');
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

test('power picker proves GPT-6 Pro from the checked model row and the maximum Power slider', () => {
  assert.equal(runProbe(powerPicker({ open: false }).nodes).status, 'click-button');
  assert.deepEqual({ ...runProbe(powerPicker().nodes) }, { status: 'already-selected', label: 'GPT-6 Pro', menuOpen: true });
});

test('power picker raises effort from the focused Power row', () => {
  const picker = powerPicker({ current: 1 });
  const result = runProbe(picker.nodes);
  assert.equal(result.status, 'raise-power');
  assert.equal(result.steps, 3);
  assert.equal(picker.power.focused, true);
});

test('power picker opens the model list and picks GPT-6 when another model is checked', () => {
  const simple = runProbe(powerPicker({ checked: 'GPT-5.6 Sol' }).nodes);
  assert.equal(simple.status, 'click-submenu');
  assert.match(simple.label, /Select model/u);
  const list = runProbe(powerPicker({ checked: 'GPT-5.6 Sol', listView: true }).nodes);
  assert.equal(list.status, 'click-option');
  assert.equal(list.label, 'GPT-6');
});

test('power picker never proves GPT-6 Pro while its Power row is inert', () => {
  assert.notEqual(runProbe(powerPicker({ listView: true }).nodes).status, 'already-selected');
});
