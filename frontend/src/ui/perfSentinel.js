/* Wave 1 (J4-29) — performance sentinel: frame/heap watchdog with an
   honest step-down ladder and a documented disable-for-test switch.

   Why: the §E budgets have no runtime enforcement — on a 1 GB box, an
   unenforced budget is a wish. The sentinel measures real frame times (rAF
   deltas) and JS heap (performance.memory where available) and steps
   quality down a ladder when a sustained breach is measured:

     L0 normal → L1: DPR capped at 1.25 → L2: DPR 1.0 + halved particle
     counts → L3: post-FX off (bloom) + reduced label budgets

   The ladder never removes data or function — quality scales, function
   doesn't change (§L.2 #3). Stepping down is announced with a quiet,
   honest indicator ("Quality scaled for smoothness"), never presented as
   broken; full detail goes to diagnostics.

   Hysteresis: step down only after a sustained breach (5 s over budget);
   step back up only after 20 s clean, one rung at a time. No oscillation.

   DISABLE-FOR-TEST SWITCH (binds the §I protocol): the sentinel must never
   thin layers mid-test and invalidate a §I run. Disable with either:
     - URL: ?nosentinel=1
     - pre-boot: window.__ciDisablePerfSentinel = true
   When disabled, the sentinel measures nothing, steps nothing, and logs
   one line: "[perf-sentinel] disabled for test". The switch's existence is
   part of the §I protocol — see MASTER-CHECKLIST §J.4 J4-29.

   Pure ladder logic is unit-testable; the rAF loop needs a browser. */

export const SENTINEL_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);
export const DISABLE_FLAG = '__ciDisablePerfSentinel';

const FRAME_BUDGET_MS = 50; // sustained p95 over this = breach (§E mobile budget)
const BREACH_WINDOW_MS = 5_000;
const RECOVER_WINDOW_MS = 20_000;
const SAMPLE_CAP = 240;

/** True when the disable-for-test switch is engaged. Pure for tests. */
export function sentinelDisabled({ search = '', flag = false } = {}) {
  if (flag === true) return true;
  try {
    return new URLSearchParams(search).get('nosentinel') === '1';
  } catch {
    return false;
  }
}

/**
 * Decide the next ladder level from the measured state. Pure.
 * @param {object} s { level, breachMs, cleanMs, frameP95Ms, heapRatio }
 *   heapRatio: usedJSHeapSize / jsHeapSizeLimit (null when unavailable)
 * @returns {'L0'|'L1'|'L2'|'L3'} next level
 */
export function nextSentinelLevel({ level = 'L0', breachMs = 0, cleanMs = 0, frameP95Ms = 0, heapRatio = null } = {}) {
  const idx = SENTINEL_LEVELS.indexOf(level);
  const here = idx < 0 ? 0 : idx;
  const heapBreach = heapRatio !== null && heapRatio >= 0.85;
  const frameBreach = frameP95Ms >= FRAME_BUDGET_MS;
  const breaching = frameBreach || heapBreach;
  if (breaching && breachMs >= BREACH_WINDOW_MS && here < SENTINEL_LEVELS.length - 1)
    return SENTINEL_LEVELS[here + 1]; // step down one rung
  if (!breaching && cleanMs >= RECOVER_WINDOW_MS && here > 0)
    return SENTINEL_LEVELS[here - 1]; // recover one rung, slowly
  return SENTINEL_LEVELS[here];
}

/** Human label for the indicator. */
export function sentinelLabel(level) {
  return level === 'L0' ? 'Full quality' : `Scaled for smoothness (${level})`;
}

/**
 * Install the sentinel. `apply` receives each level change and performs the
 * actual quality step-down (DPR caps, particle counts, post-FX, label
 * budgets) — the app owns the knobs, the sentinel owns the decision.
 */
export function createPerfSentinel({ apply, onLevel, getHeapRatio } = {}) {
  const disabled =
    (typeof window !== 'undefined' && window[DISABLE_FLAG] === true) ||
    (typeof location !== 'undefined' && sentinelDisabled({ search: location.search }));
  if (disabled) {
    console.log('[perf-sentinel] disabled for test — measuring nothing, stepping nothing');
    return { disabled: true, level: 'L0', destroy() {} };
  }

  let level = 'L0';
  let samples = [];
  let breachMs = 0;
  let cleanMs = 0;
  let lastT = 0;
  let raf = 0;
  let destroyed = false;

  function p95() {
    if (!samples.length) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }

  function tick(t) {
    if (destroyed) return;
    if (lastT > 0) {
      samples.push(t - lastT);
      if (samples.length > SAMPLE_CAP) samples.shift();
    }
    lastT = t;
    // Evaluate once per second of samples, not per frame.
    if (samples.length >= 60 && samples.length % 60 === 0) {
      const frameP95Ms = p95();
      let heapRatio = null;
      try { heapRatio = getHeapRatio ? getHeapRatio() : null; } catch { heapRatio = null; }
      const breaching = frameP95Ms >= FRAME_BUDGET_MS || (heapRatio !== null && heapRatio >= 0.85);
      if (breaching) { breachMs += 1000; cleanMs = 0; } else { cleanMs += 1000; breachMs = 0; }
      const next = nextSentinelLevel({ level, breachMs, cleanMs, frameP95Ms, heapRatio });
      if (next !== level) {
        level = next;
        breachMs = 0; cleanMs = 0;
        try { apply?.(level); } catch (err) { console.error('[perf-sentinel] apply failed:', err); }
        try { onLevel?.(level); } catch { /* listener errors never break the sentinel */ }
      }
    }
    raf = requestAnimationFrame(tick);
  }

  raf = requestAnimationFrame(tick);

  return {
    disabled: false,
    get level() { return level; },
    get frameP95Ms() { return p95(); },
    destroy() { destroyed = true; cancelAnimationFrame(raf); },
  };
}
