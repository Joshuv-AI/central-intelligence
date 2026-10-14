// mobilePanelDock: pure state applier — flips body classes and toggle labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMobileDockState,
  MOBILE_DOCK_QUERY,
  DOCKED_CLASS,
  OPEN_CLASS,
} from './mobilePanelDock.js';

function fakeBody() {
  const classes = new Set();
  return {
    classList: {
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) { classes.delete(c); return false; }
          classes.add(c); return true;
        }
        if (force) classes.add(c); else classes.delete(c);
        return force;
      },
      contains: (c) => classes.has(c),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
    },
    _classes: classes,
  };
}

function fakeToggle() {
  const attrs = {};
  const label = { textContent: 'PANELS' };
  return {
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k],
    querySelector: () => label,
    _attrs: attrs,
    _label: label,
  };
}

test('opening docks-off state: OPEN on, DOCKED off, toggle says CLOSE', () => {
  const body = fakeBody();
  const toggle = fakeToggle();
  applyMobileDockState({ body, toggle, open: true });
  assert.equal(body.classList.contains(OPEN_CLASS), true);
  assert.equal(body.classList.contains(DOCKED_CLASS), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Close panels');
  assert.equal(toggle._label.textContent, 'CLOSE');
});

test('closing restores DOCKED, toggle says PANELS', () => {
  const body = fakeBody();
  const toggle = fakeToggle();
  applyMobileDockState({ body, toggle, open: true });
  applyMobileDockState({ body, toggle, open: false });
  assert.equal(body.classList.contains(OPEN_CLASS), false);
  assert.equal(body.classList.contains(DOCKED_CLASS), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Open panels');
  assert.equal(toggle._label.textContent, 'PANELS');
});

test('works without a toggle element (headless)', () => {
  const body = fakeBody();
  applyMobileDockState({ body, toggle: null, open: true });
  assert.equal(body.classList.contains(OPEN_CLASS), true);
});

test('query targets the mobile breakpoint', () => {
  assert.equal(MOBILE_DOCK_QUERY, '(max-width: 720px)');
});
