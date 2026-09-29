/**
 * Cyber sonar — rotating acquisition sweep.
 *
 * Ported from bilawalsidhu/gods-eye-view (MIT, © 2026 Bilawal Sidhu — see
 * THIRD-PARTY-NOTICES.md): src/cyberSonar.js (timing, dim factors, the
 * base-alpha ownership pattern) and the screen-space sweep-arm idea from
 * src/cyberSonarGpu.js. CI runs it purely in DOM + CPU: a conic-gradient
 * wedge rotates on the absolute clock while contact alphas are modulated in
 * a throttled rAF loop.
 *
 * OPT-IN: off by default. The loop runs ONLY while enabled; disabling
 * restores every contact's original alpha and cancels the loop. Dimming
 * touches alpha ONLY — severity colors are never rewritten.
 */
import * as Cesium from 'cesium';

/** One full sweep, pinned to the absolute clock. */
export const CYBER_SONAR_PERIOD_MS = 5200;
/** Angular width of the acquisition sector. */
export const CYBER_SONAR_SWEEP_DEG = 24;
/** Soft edge of the sector, degrees. */
export const CYBER_SONAR_FEATHER_DEG = 10;
/** Default dim for contacts outside the sector (tunable). */
export const CYBER_SONAR_DIM_FACTOR = 0.84;
/** Fixed floor for label alphas — typography never disappears between passes. */
export const CYBER_SONAR_LABEL_DIM_FACTOR = 0.92;
/** Contact-projection refresh cadence; the rAF loop skips frames between paints. */
export const CYBER_SONAR_RENDER_INTERVAL_MS = 80;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

let _viewer = null;
let _container = null;
let _getBillboards = null;
let _enabled = false;
let _dimFactor = CYBER_SONAR_DIM_FACTOR;
let _rafId = 0;
let _lastPaintMs = -Infinity;
let _root = null;
let _arm = null;
let _styleEl = null;

/** Canonical visual records: token -> { propName: record }. Stable across ticks. */
let _visualCache = new WeakMap();
/** Base-alpha ownership: token -> { propName: { base, applied, factor } }. */
let _dimStates = new WeakMap();
/** Canonical visuals currently holding our dim (for restore on disable). */
const _touched = new Set();

const _scratch2 = typeof Cesium !== 'undefined' ? new Cesium.Cartesian2() : null;

/**
 * Clockwise sweep heading in degrees, 0 = top of the viewport.
 * Pinned to the absolute clock: identical for every caller at the same instant.
 * @param {number} [nowMs] - Defaults to performance.now().
 * @returns {number}
 */
export function cyberSonarAngleDeg(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : performance.now();
  const phase = ((now % CYBER_SONAR_PERIOD_MS) + CYBER_SONAR_PERIOD_MS) % CYBER_SONAR_PERIOD_MS;
  return (phase / CYBER_SONAR_PERIOD_MS) * 360;
}

/**
 * Brightness multiplier for one screen-projected contact. Pure.
 * Invalid projections fail open (1) so a render edge case never hides a contact.
 * @param {number} x - Screen x, px.
 * @param {number} y - Screen y, px.
 * @param {number} cx - Viewport center x.
 * @param {number} cy - Viewport center y.
 * @param {number} radius - Sweep radius, px.
 * @param {number} angleDeg - Current sweep heading.
 * @param {number} dimFactor - Outside-sector dim floor.
 * @returns {number}
 */
export function cyberSonarIntensityAt(x, y, cx, cy, radius, angleDeg, dimFactor) {
  if (![x, y, cx, cy, radius, angleDeg, dimFactor].every(Number.isFinite) || radius <= 0)
    return 1;
  const dx = x - cx;
  const dy = y - cy;
  const d2 = dx * dx + dy * dy;
  const r2 = radius * radius;
  if (d2 > r2) return dimFactor;
  if (d2 < r2 * 0.000625) return 1;
  const pointAngle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const delta = (((pointAngle - angleDeg) % 360) + 360) % 360;
  if (delta > CYBER_SONAR_SWEEP_DEG) return dimFactor;
  const feather = Math.min(CYBER_SONAR_FEATHER_DEG, CYBER_SONAR_SWEEP_DEG * 0.42);
  const coverage =
    delta <= CYBER_SONAR_SWEEP_DEG - feather
      ? 1
      : clamp01((CYBER_SONAR_SWEEP_DEG - delta) / feather);
  return dimFactor + (1 - dimFactor) * coverage;
}

/**
 * Map a contact intensity to its label intensity: labels keep the brighter
 * fixed floor but stay synchronized with the sweep.
 * @param {number} contactFactor
 * @param {number} dimFactor
 * @returns {number}
 */
export function cyberSonarLabelIntensity(contactFactor, dimFactor) {
  const range = 1 - dimFactor;
  const normalized = range <= 0.0001 ? 1 : clamp01((contactFactor - dimFactor) / range);
  return CYBER_SONAR_LABEL_DIM_FACTOR + (1 - CYBER_SONAR_LABEL_DIM_FACTOR) * normalized;
}

function cloneColor(c) {
  if (!c || !Number.isFinite(c.alpha)) return null;
  if (typeof c.clone === 'function') return c.clone();
  return { red: c.red ?? 1, green: c.green ?? 1, blue: c.blue ?? 1, alpha: c.alpha ?? 1 };
}

function channelsEqual(a, b) {
  return (
    !!a && !!b &&
    a.red === b.red && a.green === b.green && a.blue === b.blue && a.alpha === b.alpha
  );
}

/**
 * Apply (or remove) the sector dim on one color-holding visual, WITHOUT owning
 * its base style: the base alpha is snapshotted on first touch, multiplied per
 * paint, and restored on disable. An owner's mid-sweep restyle is adopted as
 * the new base; an owner restyle between last paint and teardown wins outright.
 * Alpha only — RGB (severity colors) is never touched.
 */
function setVisualAlpha(visual, factor, active, time) {
  const { token, prop, read, write } = visual;
  let slots = _dimStates.get(token);
  const state = slots?.[prop];
  const current = read(time);
  const owns =
    !!(state && state.applied && channelsEqual(current, state.applied));
  if (!active) {
    if (owns) write(cloneColor(state.base));
    if (slots) delete slots[prop];
    _touched.delete(visual);
    return;
  }
  const nextFactor = clamp01(factor);
  if (owns && Math.abs(nextFactor - state.factor) <= 0.002) return; // no visible change
  let s = state;
  if (!owns) {
    const base = cloneColor(current) || { red: 1, green: 1, blue: 1, alpha: 1 };
    if (!s) {
      s = { base, factor: NaN, applied: null };
      if (!slots) {
        slots = Object.create(null);
        _dimStates.set(token, slots);
      }
      slots[prop] = s;
    } else {
      s.base = base; // owner restyled mid-sweep: adopt the new base
    }
    _touched.add(visual);
  }
  const next = cloneColor(s.base);
  next.alpha = s.base.alpha * nextFactor;
  write(next);
  s.applied = next; // Cesium copies on set; channels stay identical for the owns-check
  s.factor = nextFactor;
}

function canonicalVisual(token, prop, read, write) {
  let slots = _visualCache.get(token);
  if (!slots) {
    slots = Object.create(null);
    _visualCache.set(token, slots);
  }
  if (!slots[prop]) slots[prop] = { token, prop, read, write };
  return slots[prop];
}

function readEntityColor(colorProp, time) {
  if (!colorProp) return null;
  if (typeof colorProp.getValue === 'function') {
    try {
      return colorProp.getValue(time);
    } catch {
      return null;
    }
  }
  return colorProp; // already a Color
}

function resolveCartesian3(pos, time) {
  let p = pos;
  if (p && typeof p.getValue === 'function') {
    try {
      p = p.getValue(time);
    } catch {
      return null;
    }
  }
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? p : null;
}

function normalizePosition(pos) {
  if (!pos) return null;
  if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) return pos;
  const lat = Number(pos.latitude ?? pos.lat);
  const lon = Number(pos.longitude ?? pos.lon ?? pos.lng);
  if (Number.isFinite(lat) && Number.isFinite(lon))
    return Cesium.Cartesian3.fromDegrees(lon, lat, Number(pos.height ?? pos.alt ?? 0) || 0);
  if (Array.isArray(pos) && Number.isFinite(pos[0]) && Number.isFinite(pos[1]))
    return Cesium.Cartesian3.fromDegrees(pos[0], pos[1], 0);
  return null;
}

/**
 * Normalize one getBillboards() entry to { position, visuals }. Accepts:
 * Cesium.Billboard, Cesium.Entity (billboard and/or label), or a plain
 * { position, color, labelColor } record. Entries should be STABLE across
 * calls so base alphas track correctly.
 */
function normalizeEntry(entry, time) {
  if (!entry) return null;
  if (entry instanceof Cesium.Billboard) {
    const bb = entry;
    return {
      position: resolveCartesian3(bb.position, time),
      visuals: [
        canonicalVisual(bb, 'color', () => bb.color, (c) => { bb.color = c; }),
      ],
      labelFlags: [false],
    };
  }
  if (entry instanceof Cesium.Entity) {
    const visuals = [];
    const labelFlags = [];
    if (entry.billboard) {
      visuals.push(
        canonicalVisual(
          entry, 'billboard.color',
          (t) => readEntityColor(entry.billboard.color, t),
          (c) => { entry.billboard.color = c; },
        ),
      );
      labelFlags.push(false);
    }
    if (entry.label) {
      visuals.push(
        canonicalVisual(
          entry, 'label.fillColor',
          (t) => readEntityColor(entry.label.fillColor, t),
          (c) => { entry.label.fillColor = c; },
        ),
      );
      labelFlags.push(true);
    }
    if (!visuals.length) return null;
    return { position: resolveCartesian3(entry.position, time), visuals, labelFlags };
  }
  const position = normalizePosition(entry.position);
  const visuals = [];
  const labelFlags = [];
  if (entry.color) {
    const e = entry;
    visuals.push(canonicalVisual(e, 'color', () => e.color, (c) => { e.color = c; }));
    labelFlags.push(false);
  }
  if (entry.labelColor) {
    const e = entry;
    visuals.push(canonicalVisual(e, 'labelColor', () => e.labelColor, (c) => { e.labelColor = c; }));
    labelFlags.push(true);
  }
  if (!visuals.length || !position) return null;
  return { position, visuals, labelFlags };
}

function paint(now) {
  if (!_viewer || !_container) return;
  const time = _viewer.clock?.currentTime;
  const w = _container.clientWidth;
  const h = _container.clientHeight;
  if (!(w > 0) || !(h > 0)) return;
  let entries = [];
  try {
    entries = _getBillboards?.() || [];
  } catch {
    return;
  }
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w * 0.4, h * 0.52);
  const angle = cyberSonarAngleDeg(now);
  const scene = _viewer.scene;
  for (const entry of entries) {
    let rec;
    try {
      rec = normalizeEntry(entry, time);
    } catch {
      continue;
    }
    if (!rec || !rec.position || !rec.visuals.length) continue;
    let screen = null;
    try {
      screen = scene.cartesianToCanvasCoordinates(rec.position, _scratch2) || null;
    } catch {
      screen = null;
    }
    const contactFactor = screen
      ? cyberSonarIntensityAt(screen.x, screen.y, cx, cy, radius, angle, _dimFactor)
      : 1; // fail open
    for (let i = 0; i < rec.visuals.length; i++) {
      const v = rec.visuals[i];
      const eff = rec.labelFlags[i]
        ? cyberSonarLabelIntensity(contactFactor, _dimFactor)
        : contactFactor;
      try {
        setVisualAlpha(v, eff, true, time);
      } catch {
        /* one bad visual must not stall the sweep */
      }
    }
  }
}

function tick() {
  if (!_enabled) return;
  const now = performance.now();
  if (now - _lastPaintMs >= CYBER_SONAR_RENDER_INTERVAL_MS) {
    _lastPaintMs = now;
    paint(now);
  }
  _rafId = requestAnimationFrame(tick);
}

function ensureDom() {
  if (_root || !_container || typeof document === 'undefined') return;
  _styleEl = document.createElement('style');
  _styleEl.id = 'ci-cyber-sonar-style';
  _styleEl.textContent = `
.ci-cyber-sonar{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2;display:none}
.ci-cyber-sonar.on{display:block}
.ci-cyber-sonar-arm{position:absolute;inset:-60%;background:conic-gradient(from 0deg at 50% 50%,rgba(140,240,255,.55) 0deg,rgba(56,224,255,.30) 1.5deg,rgba(56,224,255,0) 24deg,transparent 24deg 360deg);animation:ci-cyber-sonar-sweep ${CYBER_SONAR_PERIOD_MS}ms linear infinite}
.ci-cyber-sonar-rings{position:absolute;inset:0;display:none;background:repeating-radial-gradient(circle at 50% 50%,rgba(56,224,255,.12) 0 1px,transparent 1px 90px)}
.ci-cyber-sonar.show-rings .ci-cyber-sonar-rings{display:block}
@keyframes ci-cyber-sonar-sweep{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ci-cyber-sonar-arm{animation:none}}`;
  document.head.appendChild(_styleEl);
  _root = document.createElement('div');
  _root.className = 'ci-cyber-sonar';
  _root.setAttribute('aria-hidden', 'true');
  _arm = document.createElement('div');
  _arm.className = 'ci-cyber-sonar-arm';
  const rings = document.createElement('div');
  rings.className = 'ci-cyber-sonar-rings';
  _root.appendChild(_arm);
  _root.appendChild(rings);
  _container.appendChild(_root);
}

/** Pin the CSS arm to the same absolute clock the contact math uses. */
function pinArmToClock() {
  if (!_arm) return;
  const phase = ((performance.now() % CYBER_SONAR_PERIOD_MS) + CYBER_SONAR_PERIOD_MS) % CYBER_SONAR_PERIOD_MS;
  _arm.style.animationDelay = `${-phase}ms`;
}

/**
 * Initialize cyber sonar. Idempotent. Builds no DOM and starts no loop until
 * enabled — OFF is the cheapest state.
 * @param {Object} options
 * @param {Cesium.Viewer} options.viewer - The CI viewer (container + scene).
 * @param {() => Array} options.getBillboards - Returns the registered contacts:
 *   Cesium.Billboard | Cesium.Entity (billboard/label) | plain
 *   { position, color, labelColor }. Entries should be stable across calls.
 * @returns {boolean} Whether initialization succeeded.
 */
export function initCyberSonar({ viewer, getBillboards } = {}) {
  if (_viewer) return true;
  if (!viewer?.container?.appendChild || typeof getBillboards !== 'function') return false;
  _viewer = viewer;
  _container = viewer.container;
  _getBillboards = getBillboards;
  return true;
}

/**
 * Enable or disable the sweep. Enabling pins the arm to the absolute clock and
 * starts the (throttled) loop; disabling restores every contact's original
 * alpha, hides the arm, and cancels the loop.
 * @param {boolean} enabled
 * @returns {boolean} The new enabled state.
 */
export function setCyberSonarEnabled(enabled) {
  const next = Boolean(enabled) && !!_viewer;
  if (next === _enabled && next) return _enabled;
  _enabled = next;
  if (next) {
    ensureDom();
    _root?.classList.add('on');
    pinArmToClock();
    _lastPaintMs = -Infinity;
    cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(_rafId);
    _rafId = 0;
    _root?.classList.remove('on');
    // Restore every touched visual to its owner base alpha.
    const time = _viewer?.clock?.currentTime;
    for (const v of [..._touched]) {
      try {
        setVisualAlpha(v, 1, false, time);
      } catch {
        /* restore must not throw */
      }
    }
    _touched.clear();
  }
  return _enabled;
}

/** @returns {boolean} Whether the sweep is currently enabled. */
export function isCyberSonarEnabled() {
  return _enabled;
}

/**
 * Tune the outside-sector dim factor (icons/dots). Labels keep their 0.92 floor.
 * @param {number} f - Alpha multiplier in [0, 1].
 * @returns {number} The applied factor.
 */
export function setCyberSonarDimFactor(f) {
  const v = Number(f);
  if (Number.isFinite(v)) _dimFactor = clamp01(v);
  return _dimFactor;
}

/** @returns {number} The current dim factor. */
export function getCyberSonarDimFactor() {
  return _dimFactor;
}

/**
 * Toggle the optional range-rings overlay (CSS repeating-radial-gradient).
 * @param {boolean} show
 * @returns {void}
 */
export function setCyberSonarRings(show) {
  if (!_root) return;
  _root.classList.toggle('show-rings', Boolean(show));
}

/**
 * Tear down: disable (restores alphas), remove DOM + injected CSS, drop state.
 * @returns {void}
 */
export function destroyCyberSonar() {
  setCyberSonarEnabled(false);
  _root?.remove();
  _root = null;
  _arm = null;
  _styleEl?.remove();
  _styleEl = null;
  _viewer = null;
  _container = null;
  _getBillboards = null;
  _visualCache = new WeakMap();
  _dimStates = new WeakMap();
  _touched.clear();
  _lastPaintMs = -Infinity;
}
