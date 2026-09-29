/**
 * Split-flap (departure-board) text animation for the status surface.
 * Ported from God's Eye View (MIT) — src/splitFlap.js.
 *
 * When a label changes — "LOADING LIVE DATA" → "LOAD COMPLETE" — the changed
 * characters flip over mechanically, left to right, like a Solari board.
 *
 * CSS CONTRACT (integrator): the styles below are referenced by this module.
 * Add them to the app stylesheet (class names prefixed `ci-flap-`):
 *   .ci-flap-text — in-flow span holding the real, live Text node.
 *   .ci-flap-cells — aria-hidden decorative sibling holding .ci-flap-cell spans.
 *   .ci-flap-cell — one span per column; incoming glyph via ::before? no:
 *     per-cell glyphs are `::before` content from `data-flap-prev`
 *     (outgoing) and `::after` content from `data-flap-next` (incoming).
 *   The flip: `.ci-flap-cell.is-flapping::before` runs keyframes
 *     `ci-flap-out` (rotate away) with delay var(--ci-flap-delay);
 *     `.ci-flap-cell.is-flapping::after` runs keyframes `ci-flap-in`.
 *   The host sets --ci-flap-dur (one char flip time) per change.
 *   `.ci-flap-sizing` transitions the host's width over var(--ci-flap-total).
 *   Reduced-motion: collapse durations to near-zero rather than removing
 *   the animation (see reducedMotion handling below).
 *
 * FOUR INVARIANTS (do not "fix"):
 * 1. DOM TEXT IS THE TRUTH. One long-lived Text node inside .ci-flap-text is
 *    the ONLY text operation (`node.data = next`). Cells are decorative and
 *    carry no text (glyphs are CSS generated content).
 * 2. NO ANIMATION LOOP; exactly ONE timer per change. Motion is CSS only.
 * 3. ONLY WHAT WAS VISIBLE FLAPS AWAY. An interrupted cascade derives each
 *    column's outgoing glyph from what is on screen at that instant.
 * 4. COLUMNS NEVER RENUMBER MID-CASCADE. One column per index of the longer
 *    string; vacating columns flap to blank and hold their width.
 */

/** One-line kill switch. Flip to false and everything becomes an instant swap. */
export const SPLIT_FLAP_ENABLED = true;
/** Time one character spends flipping. */
export const FLAP_CHAR_MS = 190;
/** Nominal gap between consecutive characters starting their flip. */
export const FLAP_STAGGER_MS = 26;
/** Hard ceiling for a whole cascade; long labels compress their stagger. */
export const FLAP_MAX_TOTAL_MS = 620;
/** Slack after the last character lands before the cells are stripped. */
const FLAP_SETTLE_SLACK_MS = 60;
/** Fraction of a char flip at which the incoming glyph takes over the eye. */
const FLAP_TURN_RATIO = 0.5;

const HOST_CLASS = 'ci-flap-host';
const ACTIVE_CLASS = 'ci-flap-active';
const TEXT_CLASS = 'ci-flap-text';
const CELLS_CLASS = 'ci-flap-cells';
const CELL_CLASS = 'ci-flap-cell';
const FLAPPING_CLASS = 'is-flapping';
const SIZING_CLASS = 'ci-flap-sizing';
const BLANK = ' ';

/** In-flight cascade state, keyed by element so nothing is stored on the node. */
const flapStates = new WeakMap();
/** Teardown for an in-flight width ease (listeners, not timers). */
const widthEases = new WeakMap();

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nowMs() {
  return typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function defaultReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Diff two strings into per-character flap cells with staggered delays.
 * Pure — no DOM, no clock. Stagger rebases on the first changed column.
 *
 * @param {string} fromText - Glyphs currently on screen.
 * @param {string} toText - Text to settle on.
 * @param {object} [options]
 * @returns {{cells, durationMs, staggerMs, changedCount, firstChanged, lastChanged}}
 */
export function planTextFlip(fromText, toText, options = {}) {
  const charMs = positiveNumber(options.charMs, FLAP_CHAR_MS);
  const baseStagger = positiveNumber(options.staggerMs, FLAP_STAGGER_MS);
  const maxTotalMs = positiveNumber(options.maxTotalMs, FLAP_MAX_TOTAL_MS);

  const fromChars = Array.from(String(fromText ?? ''));
  const toChars = Array.from(String(toText ?? ''));
  const width = Math.max(fromChars.length, toChars.length);

  let firstChanged = -1;
  let lastChanged = -1;
  for (let index = 0; index < width; index += 1) {
    if ((fromChars[index] ?? '') !== (toChars[index] ?? '')) {
      if (firstChanged < 0) firstChanged = index;
      lastChanged = index;
    }
  }

  if (firstChanged < 0) {
    return {
      cells: [],
      durationMs: 0,
      staggerMs: 0,
      changedCount: 0,
      firstChanged: -1,
      lastChanged: -1,
    };
  }

  const span = lastChanged - firstChanged + 1;
  const room = Math.max(0, maxTotalMs - charMs);
  const staggerMs = span > 1 ? Math.min(baseStagger, room / (span - 1)) : 0;

  const cells = [];
  let changedCount = 0;
  for (let index = 0; index < width; index += 1) {
    const from = fromChars[index] ?? '';
    const to = toChars[index] ?? '';
    const changed = from !== to;
    if (changed) changedCount += 1;
    cells.push({
      index,
      from,
      to,
      changed,
      // Shrinking: flap the old glyph to a blank, hold the column (invariant 4).
      vacating: changed && to === '' && from !== '',
      delayMs: changed ? Math.round((index - firstChanged) * staggerMs) : 0,
    });
  }

  return {
    cells,
    durationMs: Math.round((lastChanged - firstChanged) * staggerMs + charMs),
    staggerMs,
    changedCount,
    firstChanged,
    lastChanged,
  };
}

/**
 * Plan a flip for an element: diffs the element's CURRENT text against the new
 * text and returns the cascade plan (or a no-op plan when unchanged).
 *
 * @param {HTMLElement} el - Label element.
 * @param {string} newText - Text to settle on.
 * @param {object} [options] - charMs / staggerMs / maxTotalMs.
 * @returns {object} Plan from planTextFlip, plus `noChange` when identical.
 */
export function planSplitFlap(el, newText, options = {}) {
  const next = String(newText ?? '');
  const from = el ? (el.textContent ?? '') : '';
  if (from === next) {
    return { ...planTextFlip('', '', options), noChange: true };
  }
  return { ...planTextFlip(from, next, options), noChange: false };
}

function displayedGlyph(cell, turned) {
  if (!cell.changed) return cell.to;
  return (turned ? cell.to : cell.from) || BLANK;
}

/**
 * The glyphs a cascade is actually SHOWING at `elapsedMs` — one character per
 * column, blanks for vacating columns. Pure; used for honest interrupts.
 */
export function visibleGlyphs(plan, elapsedMs, options = {}) {
  const charMs = positiveNumber(options.charMs, FLAP_CHAR_MS);
  const turnRatio = Number.isFinite(Number(options.turnRatio))
    ? Number(options.turnRatio)
    : FLAP_TURN_RATIO;
  const elapsed = Number.isFinite(Number(elapsedMs))
    ? Math.max(0, Number(elapsedMs))
    : 0;
  const turn = charMs * turnRatio;
  let out = '';
  for (const cell of plan?.cells || []) {
    out += displayedGlyph(cell, elapsed >= cell.delayMs + turn);
  }
  return out;
}

function isVisible(element) {
  if (!element?.isConnected) return false;
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true,
    });
  }
  if (typeof element.getClientRects !== 'function') return false;
  if (element.getClientRects().length === 0) return false;
  const view = element.ownerDocument?.defaultView;
  if (typeof view?.getComputedStyle !== 'function') return true;
  for (
    let node = element;
    node && node.nodeType === 1;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
  }
  return true;
}

function measureWidth(element) {
  return typeof element.getBoundingClientRect === 'function'
    ? element.getBoundingClientRect().width
    : 0;
}

/** The label's permanent shell: one Text node + one decorative cells span. */
function ensureHost(element) {
  const text = element.firstElementChild;
  const cells = text?.nextElementSibling;
  if (
    text?.classList?.contains(TEXT_CLASS) &&
    text.firstChild?.nodeType === 3 &&
    cells?.classList?.contains(CELLS_CLASS) &&
    !cells.nextElementSibling
  ) {
    return { text, cells };
  }

  const doc = element.ownerDocument || globalThis.document;
  const carried = element.textContent ?? '';
  const nextText = doc.createElement('span');
  nextText.className = TEXT_CLASS;
  nextText.append(doc.createTextNode(carried));
  const nextCells = doc.createElement('span');
  nextCells.className = CELLS_CLASS;
  nextCells.setAttribute('aria-hidden', 'true');
  element.classList.add(HOST_CLASS);
  element.replaceChildren(nextText, nextCells);
  return { text: nextText, cells: nextCells };
}

function clearSizing(element) {
  element.classList?.remove(SIZING_CLASS);
  element.style?.removeProperty('width');
  element.style?.removeProperty('--ci-flap-total');
}

function cancelWidthEase(element) {
  const teardown = widthEases.get(element);
  if (!teardown) return;
  widthEases.delete(element);
  teardown();
}

function easeWidth(element, fromWidth, toWidth, durationMs) {
  cancelWidthEase(element);
  if (!(fromWidth > 0.5) || Math.abs(toWidth - fromWidth) <= 0.5) {
    clearSizing(element);
    return false;
  }
  element.style.setProperty('--ci-flap-total', `${durationMs}ms`);
  element.style.width = `${fromWidth}px`;
  element.classList.add(SIZING_CLASS);
  void element.offsetWidth; // flush the start value so the transition runs
  element.style.width = `${toWidth}px`;

  const finish = (event) => {
    if (event && (event.target !== element || event.propertyName !== 'width'))
      return;
    cancelWidthEase(element);
    clearSizing(element);
  };
  const teardown = () => {
    element.removeEventListener('transitionend', finish);
    element.removeEventListener('transitioncancel', finish);
  };
  element.addEventListener('transitionend', finish);
  element.addEventListener('transitioncancel', finish);
  widthEases.set(element, teardown);
  return true;
}

function clearFlapTimer(element) {
  const state = flapStates.get(element);
  if (!state) return;
  clearTimeout(state.timer);
  flapStates.delete(element);
}

/** Resting state: real text visible, decorative cells emptied, no motion. */
function rest(element, host) {
  element.classList.remove(ACTIVE_CLASS);
  host.cells.replaceChildren();
  element.style?.removeProperty('--ci-flap-dur');
  element.removeAttribute?.('aria-label');
}

/** Strip the cells once the cascade lands, then take up any width slack. */
function settle(element, expected, easeMs) {
  flapStates.delete(element);
  // A newer label won the race — leave its cells alone.
  if (element.textContent !== expected) return;
  const host = ensureHost(element);
  const cascadeWidth = measureWidth(element);
  cancelWidthEase(element);
  clearSizing(element);
  rest(element, host);
  const naturalWidth = measureWidth(element);
  easeWidth(element, cascadeWidth, naturalWidth, easeMs);
}

/**
 * Set a label, flipping changed characters into place. Safe to call on every
 * tick — an unchanged write is a no-op. Respects reduced-motion: pass
 * `reducedMotion: true`, or omit and it checks matchMedia (same preference
 * `ui/boot.js` `reducedMotion()` reads).
 *
 * @param {HTMLElement|null} element - Label element.
 * @param {string} newText - Text to settle on.
 * @param {object} [options]
 * @param {boolean} [options.reducedMotion] - Force instant swap when true.
 * @param {boolean} [options.immediate] - Skip animation this change.
 * @returns {boolean} True when a flap animation was started.
 */
export function applySplitFlap(element, newText, options = {}) {
  if (!element) return false;
  const next = String(newText ?? '');
  // Upgrade to the permanent shell first, on a tick where text is not
  // changing; afterwards every change is one characterData mutation.
  const host = ensureHost(element);
  const settled = element.textContent ?? '';
  if (settled === next) return false;

  // What the viewer can SEE right now (invariant 3): mid-cascade, columns
  // whose stagger has not elapsed are still showing the old glyphs.
  const state = flapStates.get(element);
  const displayed = state
    ? visibleGlyphs(state.plan, nowMs() - state.startedAt, {
        charMs: state.charMs,
      })
    : settled;
  clearFlapTimer(element);

  const beforeWidth = measureWidth(element);

  const reduced =
    'reducedMotion' in options ? !!options.reducedMotion : defaultReducedMotion();
  const animate =
    SPLIT_FLAP_ENABLED &&
    options.immediate !== true &&
    !reduced &&
    isVisible(element);

  const plan = animate ? planTextFlip(displayed, next, options) : null;

  // THE ONLY TEXT OPERATION. One characterData mutation, no reparenting
  // (invariant 1).
  host.text.firstChild.data = next;

  if (!plan?.changedCount) {
    cancelWidthEase(element);
    clearSizing(element);
    rest(element, host);
    return false;
  }

  const doc = element.ownerDocument || globalThis.document;
  const charMs = positiveNumber(options.charMs, FLAP_CHAR_MS);

  const cellNodes = [];
  for (const cell of plan.cells) {
    const node = doc.createElement('span');
    node.className = CELL_CLASS;
    // Every column carries an in-flow incoming face, holding its width and
    // index for the whole cascade (invariant 4).
    node.dataset.flapNext = cell.to || BLANK;
    if (cell.changed) {
      node.classList.add(FLAPPING_CLASS);
      node.dataset.flapPrev = cell.from || BLANK;
      node.style.setProperty('--ci-flap-delay', `${cell.delayMs}ms`);
    }
    cellNodes.push(node);
  }

  element.removeAttribute('aria-label');
  cancelWidthEase(element);
  clearSizing(element);
  host.cells.replaceChildren(...cellNodes);
  element.classList.add(ACTIVE_CLASS);
  element.style.setProperty('--ci-flap-dur', `${charMs}ms`);

  // Width, phase one: growing labels reserve new columns now; shrinking
  // labels ease down in settle(), after the flaps land.
  easeWidth(element, beforeWidth, measureWidth(element), plan.durationMs);

  // The one and only timer this change schedules (invariant 2).
  flapStates.set(element, {
    plan,
    charMs,
    startedAt: nowMs(),
    timer: setTimeout(
      () => settle(element, next, plan.durationMs),
      plan.durationMs + FLAP_SETTLE_SLACK_MS,
    ),
  });
  return true;
}

/** Stop decoration without replacing the label's permanent accessible text. */
export function disposeSplitFlap(element) {
  if (!element) return;
  clearFlapTimer(element);
  cancelWidthEase(element);
  clearSizing(element);
  const cells = element.querySelector?.('.ci-flap-cells');
  if (cells) rest(element, { cells });
}
