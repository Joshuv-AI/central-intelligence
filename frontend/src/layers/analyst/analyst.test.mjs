/**
 * J4-09/J4-10 · analyst layer — a11y shell install, keyboard traversal,
 * measure gating, summary announcement. DOM is faked; Cesium is stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalystLayer, installAnalystA11y, announce } from './index.js';

function fakeDoc() {
  const els = [];
  const listeners = {};
  const mkEl = (tag) => {
    const el = {
      tag, children: [], attrs: {}, listeners: {}, className: '', id: '',
      textContent: '', value: '', disabled: false, hidden: false,
      setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; },
      getAttribute(k) { return this.attrs[k] ?? null; },
      hasAttribute(k) { return k in this.attrs; },
      append(...c) { this.children.push(...c); return this; },
      appendChild(c) { this.children.push(c); return c; },
      prepend(c) { this.children.unshift(c); return this; },
      remove() { this._removed = true; },
      addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      focus() { doc._focused = this; },
      click() {},
      matches() { return false; },
    };
    els.push(el);
    return el;
  };
  const body = mkEl('body');
  const doc = {
    _els: els, _focused: null, body,
    get activeElement() { return this._focused || body; },
    createElement: (tag) => mkEl(tag),
    getElementById: (id) => els.find((e) => e.id === id) || null,
    querySelector: (sel) => {
      if (sel === '#dock-search-btn') return els.find((e) => e.id === 'dock-search-btn') || null;
      if (sel === '#data-toggles .data-toggle-btn') return els.find((e) => e.className.includes('data-toggle-btn')) || null;
      return null;
    },
    addEventListener(t, f) { (listeners[t] ??= []).push(f); },
    removeEventListener() {},
    _listeners: listeners,
    _fireKey(key, altKey = true) {
      const event = { key, altKey, ctrlKey: false, metaKey: false, target: { matches: () => false }, preventDefault() { this._pd = true; } };
      for (const f of listeners.keydown || []) f(event);
      return event;
    },
  };
  return doc;
}

const stubCesium = {
  CustomDataSource: class { constructor() { this.entities = { removeAll() {} }; } },
  ScreenSpaceEventHandler: class { setInputAction() {} destroy() {} },
  ScreenSpaceEventType: { LEFT_CLICK: 0, LEFT_DOUBLE_CLICK: 1 },
  Cartesian3: { fromDegrees: () => ({}) },
  Cartographic: { fromCartesian: () => ({ latitude: 0, longitude: 0 }) },
  PolygonHierarchy: class {},
  Color: { YELLOW: { withAlpha: () => ({}) }, BLACK: {} },
};

test('installAnalystA11y: skip links + live region, idempotent', () => {
  const doc = fakeDoc();
  const destroy = installAnalystA11y(doc);
  assert.ok(doc.getElementById('analyst-a11y-root'), 'root installed');
  assert.ok(doc.getElementById('analyst-live-region'), 'live region installed');
  const skips = doc._els.filter((e) => e.className === 'analyst-skip-link');
  assert.ok(skips.length >= 2, 'skip links installed');
  assert.equal(skips[0].getAttribute('aria-live'), null);
  installAnalystA11y(doc); // second call is a no-op
  assert.equal(doc._els.filter((e) => e.id === 'analyst-a11y-root').length, 1);
  assert.equal(typeof destroy, 'function');
});

test('Alt+2 focuses the layers panel toggle', () => {
  const doc = fakeDoc();
  installAnalystA11y(doc);
  const btn = doc.createElement('button');
  btn.className = 'data-toggle-btn';
  const event = doc._fireKey('2');
  assert.equal(event._pd, true, 'handled');
  assert.equal(doc._focused, btn);
});

test('Alt+1 with no dock button does not throw', () => {
  const doc = fakeDoc();
  installAnalystA11y(doc);
  const event = doc._fireKey('1');
  assert.equal(event._pd, undefined, 'not handled, no button');
});

test('analyst layer exposes the six quick-action chips', () => {
  const doc = fakeDoc();
  const layer = createAnalystLayer({ doc, cesium: stubCesium, fetchImpl: async () => ({ ok: false }) });
  assert.equal(layer.id, 'analyst-tools');
  const chips = layer.getRowControls().chips.map((c) => c.label);
  for (const want of ['COMPARE', 'MEASURE', 'AREA', 'EXPORT JSON', 'EXPORT TXT', 'READ SUMMARY'])
    assert.ok(chips.includes(want), `chip ${want}`);
});

test('measure start is gated to B2+ with the honest hint', async () => {
  const doc = fakeDoc();
  const layer = createAnalystLayer({ doc, cesium: stubCesium, fetchImpl: async () => ({ ok: false }) });
  // Globe band (B0): starting measure must refuse with the gated hint.
  const viewer = {
    camera: { positionCartographic: { height: 20_000_000 } },
    scene: { canvas: {}, globe: { ellipsoid: {} } },
    dataSources: { add() {}, remove() {} },
  };
  await layer.init(viewer);
  const chips = layer.getRowControls().chips;
  const measure = chips.find((c) => c.label === 'MEASURE');
  measure.onClick();
  const { mode } = layer._analyst();
  assert.equal(mode, 'gated-hint');
  assert.match(layer.getRowControls().info, /Zoom in to at least regional view/);
  layer._endMeasureMode();
  assert.equal(layer._analyst().mode, null);
});
