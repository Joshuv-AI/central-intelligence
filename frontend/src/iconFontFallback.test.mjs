// iconFontFallback: the fallback class engages exactly when the icon font is
// unavailable (width-based detection), and the forced test hook toggles it directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armIconFontFallback, setIconFontFallbackForced, iconFontRenders } from './iconFontFallback.js';

// Fake DOM: createElement returns spans whose measured width depends on the
// font-family style and the simulated font availability.
function fakeDoc({ fontOk, events = true } = {}) {
  const classes = new Set();
  const listeners = {};
  let currentFontOk = fontOk;
  const spans = [];
  function makeSpan() {
    const span = {
      _family: '',
      textContent: '',
      setAttribute: (k, v) => { if (k === 'style') span._style = v; },
      getBoundingClientRect: () => {
        const usesIcon = /Material Symbols Outlined/.test(span._style || '');
        // Icon font available -> renders the glyph (narrow); missing -> falls
        // back to monospace like the reference span (wide).
        return { width: usesIcon && currentFontOk ? 60 : 620 };
      },
      remove: () => {},
    };
    spans.push(span);
    return span;
  }
  const doc = {
    documentElement: { classList: {
      toggle: (c, force) => { if (force) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    } },
    body: { appendChild: () => {} },
    createElement: () => makeSpan(),
    fonts: {
      addEventListener: (name, fn) => { if (events) listeners[name] = fn; },
      __listeners: listeners,
    },
    __classes: classes,
    __setFontOk: (v) => { currentFontOk = v; },
  };
  return doc;
}

test('iconFontRenders is true when widths differ (font loaded)', () => {
  assert.equal(iconFontRenders(fakeDoc({ fontOk: true })), true);
});

test('iconFontRenders is false when widths match (font missing)', () => {
  assert.equal(iconFontRenders(fakeDoc({ fontOk: false })), false);
});

test('fallback class engages when the icon font is missing', async () => {
  const doc = fakeDoc({ fontOk: false, events: false });
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => { fn(); return 0; }; // run retries inline
  try {
    armIconFontFallback(doc);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.equal(doc.__classes.has('no-icon-font'), true);
});

test('no fallback class when the icon font renders', () => {
  const doc = fakeDoc({ fontOk: true, events: false });
  armIconFontFallback(doc);
  assert.equal(doc.__classes.has('no-icon-font'), false);
});

test('late font load lifts the fallback via loadingdone', () => {
  const doc = fakeDoc({ fontOk: false });
  armIconFontFallback(doc);
  assert.equal(doc.__classes.has('no-icon-font'), true);
  doc.__setFontOk(true);
  doc.fonts.__listeners.loadingdone();
  assert.equal(doc.__classes.has('no-icon-font'), false);
});

test('forced hook toggles the class directly', () => {
  const doc = fakeDoc({ fontOk: true, events: false });
  setIconFontFallbackForced(doc, true);
  assert.equal(doc.__classes.has('no-icon-font'), true);
  setIconFontFallbackForced(doc, false);
  assert.equal(doc.__classes.has('no-icon-font'), false);
});
