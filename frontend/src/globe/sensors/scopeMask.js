/**
 * Scope mask — NVG/FLIR "looking through a scope" viewport treatment.
 *
 * Ported from bilawalsidhu/gods-eye-view (MIT, © 2026 Bilawal Sidhu — see
 * THIRD-PARTY-NOTICES.md): src/scopeMask.js. CI adaptation: this module never
 * imports the viewer — it accepts a `getCameraHeight` callback plus an
 * explicit `updateScopeMaskAltitude()` invalidation, so no import cycle is
 * possible.
 *
 * Implementation: one absolutely-positioned canvas parented into the globe
 * container, BELOW any detection/overlay surfaces (z-index 1), with
 * pointer-events: none. The mask is a radial gradient — fully transparent
 * inside the keyhole circle, feathering to near-opaque page black outside.
 *
 * Perf contract (verbatim from the GEV source):
 *   repaint ONLY on resize, tuning change, DPR change, or quantized alpha
 *   step. NO rAF loop. Use ResizeObserver + explicit invalidation.
 *
 * Altitude-adaptive edge terminus: the outside fill is 0.94 (alpha) at/above
 * 10 Mm so faint stars survive in the corners at globe scale, ramping
 * (smoothstepped) to solid black by 7 Mm. The ramp's repaint cost is bounded
 * by the QUANTIZED alpha step, not by how far the camera travels.
 */

/** Matches the page background the emergent scope faded into. */
const SCOPE_OUTSIDE_COLOR = { r: 5, g: 5, b: 8 };

/** Default edge feather as a fraction of the keyhole radius. */
export const SCOPE_FEATHER_RATIO_DEFAULT = 0.11;
/** Terminus opacity at/above SCOPE_TERMINUS_FAR_M. */
export const SCOPE_OUTSIDE_ALPHA = 0.94;
/** Terminus opacity at/below SCOPE_TERMINUS_NEAR_M — full black, no bleed. */
export const SCOPE_TERMINUS_ALPHA_NEAR = 1;
/** Camera height at/above which the terminus stays at SCOPE_OUTSIDE_ALPHA. */
export const SCOPE_TERMINUS_FAR_M = 10_000_000;
/** Camera height at/below which the terminus is fully opaque. */
export const SCOPE_TERMINUS_NEAR_M = 7_000_000;
/** Repaint granularity: 0.005 steps give ~12 repaints across the whole band. */
export const SCOPE_TERMINUS_QUANTUM = 0.005;
/** Keyhole radius as a fraction of the smaller viewport dimension. */
const SCOPE_KEYHOLE_RADIUS_RATIO = 0.44;

let _canvas = null;
let _container = null;
let _getCameraHeight = null;
let _enabled = false;
let _featherRatio = SCOPE_FEATHER_RATIO_DEFAULT;
let _resizeObserver = null;
let _dprQuery = null;
let _dprListener = null;
/** Quantized terminus alpha currently PAINTED (drives the repaint gate). */
let _terminusAlpha = SCOPE_OUTSIDE_ALPHA;
/** Whether the canvas currently holds ink (drives the disabled-state early-out). */
let _painted = false;
/** Set while a coalescing scope is open; draw() defers to its single paint. */
let _paintDirty = false;
let _coalescingPaint = false;

/**
 * Smoothstep ramp from the globe-scale terminus to full black. Pure.
 * @param {number} heightM - Camera height above the ellipsoid, in metres.
 * @returns {number} Terminus alpha in [SCOPE_OUTSIDE_ALPHA, 1].
 */
export function scopeTerminusAlpha(heightM) {
  const h = Number(heightM);
  if (!Number.isFinite(h)) return SCOPE_OUTSIDE_ALPHA; // unknown height → globe-scale default
  if (h >= SCOPE_TERMINUS_FAR_M) return SCOPE_OUTSIDE_ALPHA;
  if (h <= SCOPE_TERMINUS_NEAR_M) return SCOPE_TERMINUS_ALPHA_NEAR;
  // 0 at the far edge → 1 at the near edge, eased so neither end steps visibly.
  const t = (SCOPE_TERMINUS_FAR_M - h) / (SCOPE_TERMINUS_FAR_M - SCOPE_TERMINUS_NEAR_M);
  const eased = t * t * (3 - 2 * t);
  return SCOPE_OUTSIDE_ALPHA + (SCOPE_TERMINUS_ALPHA_NEAR - SCOPE_OUTSIDE_ALPHA) * eased;
}

/**
 * Snap a terminus alpha to the repaint grid. Equal quantized values mean the
 * paint would be indistinguishable, so the repaint is skipped. Pure.
 * @param {number} alpha
 * @returns {number}
 */
export function quantizeScopeTerminusAlpha(alpha) {
  const a = Math.max(0, Math.min(1, Number(alpha) || 0));
  // Round the PRODUCT too: n * 0.005 lands on values like 0.9400000000000001,
  // which would ride straight into the rgba() string.
  return Math.round(Math.round(a / SCOPE_TERMINUS_QUANTUM) * SCOPE_TERMINUS_QUANTUM * 1000) / 1000;
}

/**
 * Live camera height via the injected callback, or +Inf when unknown.
 * @returns {number}
 */
function currentCameraHeightM() {
  try {
    const h = _getCameraHeight?.();
    return Number.isFinite(h) ? h : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** @returns {number} Quantized terminus the current camera height implies. */
function currentTerminusTarget() {
  return quantizeScopeTerminusAlpha(scopeTerminusAlpha(currentCameraHeightM()));
}

/**
 * Backing-store scale actually used by the last draw().
 * @param {number} [ratio]
 * @returns {number}
 */
export function scopeMaskDevicePixelRatio(
  ratio = typeof window !== 'undefined' ? window.devicePixelRatio : 1,
) {
  return Math.min(2, Number(ratio) || 1);
}

/**
 * Compute the gradient geometry for the scope mask. Pure.
 * @param {number} width - Container CSS width.
 * @param {number} height - Container CSS height.
 * @param {number} [featherRatio] - Edge feather as a fraction of keyhole radius.
 * @returns {{centerX:number, centerY:number, innerR:number, outerR:number}|null}
 *   Geometry, or null when the viewport is degenerate.
 */
export function scopeMaskGeometry(width, height, featherRatio = _featherRatio) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0) || !(h > 0)) return null;
  const radius = Math.min(w, h) * SCOPE_KEYHOLE_RADIUS_RATIO;
  if (!(radius > 0)) return null;
  const feather = Math.max(0, Math.min(1, Number(featherRatio) || 0));
  // Feather straddles the keyhole edge so the visible radius stays anchored.
  const half = radius * feather * 0.5;
  return {
    centerX: w / 2,
    centerY: h / 2,
    innerR: Math.max(0, radius - half),
    outerR: radius + half,
  };
}

/**
 * Run `fn` with paints COALESCED: any draw() it triggers only marks the canvas
 * dirty, and exactly one paint happens at the end. The case that matters is a
 * DPR change landing on the same tick as a terminus step.
 * @param {Function} fn
 * @returns {void}
 */
function withCoalescedPaint(fn) {
  if (_coalescingPaint) {
    fn();
    return;
  }
  _coalescingPaint = true;
  _paintDirty = false;
  try {
    fn();
  } finally {
    _coalescingPaint = false;
    if (_paintDirty) {
      _paintDirty = false;
      draw();
    }
  }
}

function draw() {
  if (_coalescingPaint) {
    _paintDirty = true;
    return;
  }
  if (!_canvas || !_container) return;
  // SCOPE OFF is the cheapest state, not a painted one: bail out BEFORE the
  // backing-store resize + clear. The last painted mask is cleared exactly
  // once, on the transition; after that a disabled mask does no canvas work.
  if (!_enabled) {
    if (!_painted) return;
    const clearCtx = _canvas.getContext('2d');
    if (clearCtx) {
      clearCtx.setTransform(1, 0, 0, 1, 0, 0);
      clearCtx.clearRect(0, 0, _canvas.width, _canvas.height);
    }
    _painted = false;
    return;
  }
  const width = _container.clientWidth;
  const height = _container.clientHeight;
  if (!(width > 0) || !(height > 0)) return;
  const dpr = scopeMaskDevicePixelRatio();
  _canvas.width = Math.round(width * dpr);
  _canvas.height = Math.round(height * dpr);
  const ctx = _canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  _painted = false; // resize+clear wiped the surface; ink goes on below
  const geo = scopeMaskGeometry(width, height, _featherRatio);
  if (!geo) return;
  const { r, g, b } = SCOPE_OUTSIDE_COLOR;
  if (geo.outerR - geo.innerR < 1) {
    // Zero/near-zero feather: a radial gradient with equal radii is DEGENERATE
    // in Canvas2D (Chromium paints nothing). Draw the hard crop explicitly:
    // rect minus circle, evenodd. The hard crop honors the same altitude
    // terminus — a hard edge at city scale must be fully opaque too.
    ctx.fillStyle = `rgba(${r},${g},${b},${_terminusAlpha})`;
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.arc(geo.centerX, geo.centerY, Math.max(1, geo.innerR), 0, Math.PI * 2);
    ctx.fill('evenodd');
    _painted = true;
    return;
  }
  const gradient = ctx.createRadialGradient(
    geo.centerX, geo.centerY, geo.innerR,
    geo.centerX, geo.centerY, geo.outerR,
  );
  gradient.addColorStop(0, `rgba(${r},${g},${b},0)`);
  gradient.addColorStop(1, `rgba(${r},${g},${b},${_terminusAlpha})`);
  // Points beyond outerR take the end-stop color, so one fillRect covers the
  // whole viewport: transparent keyhole, feathered edge, terminus outside.
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  _painted = true;
}

/**
 * Watch for devicePixelRatio changes and redraw. The ResizeObserver only fires
 * on content-box changes, so dragging the window between a 1x and a 2x monitor
 * keeps the same CSS size while the backing store goes stale — the
 * `(resolution: Ndppx)` re-armed listener covers that.
 * @returns {void}
 */
function watchDevicePixelRatio() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  teardownDevicePixelRatioWatch();
  const dpr = window.devicePixelRatio || 1;
  let query;
  try {
    query = window.matchMedia(`(resolution: ${dpr}dppx)`);
  } catch {
    return; // resize still covers the common case
  }
  _dprQuery = query;
  _dprListener = () => {
    withCoalescedPaint(() => {
      watchDevicePixelRatio(); // re-arm against the NEW ratio first
      if (_enabled) _terminusAlpha = currentTerminusTarget();
      draw();
    });
  };
  if (typeof query.addEventListener === 'function')
    query.addEventListener('change', _dprListener, { once: true });
  else if (typeof query.addListener === 'function') query.addListener(_dprListener);
}

function teardownDevicePixelRatioWatch() {
  if (_dprQuery && _dprListener) {
    if (typeof _dprQuery.removeEventListener === 'function')
      _dprQuery.removeEventListener('change', _dprListener);
    else if (typeof _dprQuery.removeListener === 'function')
      _dprQuery.removeListener(_dprListener);
  }
  _dprQuery = null;
  _dprListener = null;
}

/**
 * Install the scope mask into a container element. Idempotent. Starts DISABLED
 * (the module is opt-in); call setScopeMaskEnabled(true) to show it.
 * @param {Object} options
 * @param {HTMLElement} options.container - The globe container element.
 * @param {() => number} [options.getCameraHeight] - Callback returning the live
 *   camera height in metres; used to re-sync the terminus on re-enable and DPR
 *   changes. Omit it and the terminus stays at the globe-scale default until
 *   updateScopeMaskAltitude() is called.
 * @returns {void}
 */
export function initScopeMask({ container, getCameraHeight } = {}) {
  if (_canvas || !container?.appendChild) return;
  _container = container;
  _getCameraHeight = typeof getCameraHeight === 'function' ? getCameraHeight : null;
  _canvas = document.createElement('canvas');
  _canvas.id = 'ci-scope-mask';
  _canvas.setAttribute('aria-hidden', 'true');
  _canvas.style.position = 'absolute';
  _canvas.style.inset = '0';
  _canvas.style.width = '100%';
  _canvas.style.height = '100%';
  _canvas.style.pointerEvents = 'none';
  _canvas.style.zIndex = '1'; // below any detection/overlay surfaces
  _container.appendChild(_canvas);
  _resizeObserver = new ResizeObserver(() => draw());
  _resizeObserver.observe(_container);
  watchDevicePixelRatio();
  // Seed from the live camera so the first paint is already correct for the
  // current altitude instead of flashing the globe-scale terminus.
  _terminusAlpha = currentTerminusTarget();
  draw();
}

/**
 * Enable or disable the scope mask.
 * @param {boolean} enabled
 * @returns {void}
 */
export function setScopeMaskEnabled(enabled) {
  const next = Boolean(enabled);
  const reEnabled = next && !_enabled;
  _enabled = next;
  if (reEnabled) {
    // The camera moved freely while the mask was off and nothing sampled it,
    // so the painted terminus may be a whole altitude band stale. Re-sync once.
    _terminusAlpha = currentTerminusTarget();
  }
  draw();
}

/** @returns {boolean} Whether the scope mask is currently enabled. */
export function isScopeMaskEnabled() {
  return _enabled;
}

/**
 * Set the edge feather as a fraction of the keyhole radius. Repaints once.
 * @param {number} ratio - [0, 1]; 0 is a hard crop.
 * @returns {void}
 */
export function setScopeMaskFeather(ratio) {
  _featherRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  draw();
}

/** @returns {number} The current feather ratio. */
export function getScopeMaskFeather() {
  return _featherRatio;
}

/**
 * Explicit altitude invalidation — the ONLY per-frame-adjacent entry point.
 * The integrator (not this module) decides how often to sample the camera;
 * this function repaints ONLY when the quantized terminus actually moves.
 * @param {number} cameraHeightMeters - Camera height above the ellipsoid.
 * @returns {boolean} Whether this call repainted.
 */
export function updateScopeMaskAltitude(cameraHeightMeters) {
  if (!_enabled) return false;
  const target = quantizeScopeTerminusAlpha(scopeTerminusAlpha(cameraHeightMeters));
  if (target === _terminusAlpha) return false; // the whole perf story lives here
  _terminusAlpha = target;
  draw();
  return true;
}

/** @returns {number} The terminus alpha currently painted. */
export function getScopeMaskTerminusAlpha() {
  return _terminusAlpha;
}

/**
 * Tear the mask down (canvas + observers). Reinstall with initScopeMask.
 * @returns {void}
 */
export function destroyScopeMask() {
  _resizeObserver?.disconnect();
  _resizeObserver = null;
  teardownDevicePixelRatioWatch();
  _canvas?.remove();
  _canvas = null;
  _container = null;
  _getCameraHeight = null;
  _painted = false;
  _paintDirty = false;
  _coalescingPaint = false;
}
