/* Visibility-aware polling (audit A4-1): suspends layer poll loops while the
   tab is hidden (battery + upstream 429-budget win) and fires each registered
   layer refresh exactly once on return to visible. Only WHEN polls fire
   changes — cadences, gates, and what the polls do are untouched. */

const refreshFns = new Map();
let refreshInFlight = false;

export function isHidden() {
  return typeof document !== 'undefined' && document.hidden;
}

export function onVisible(fn) {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (!isHidden()) { try { fn(); } catch { /* never break the app */ } }
  });
}

export function onHidden(fn) {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (isHidden()) { try { fn(); } catch { /* never break the app */ } }
  });
}

/** Register a layer refresh to run once when the tab becomes visible again. */
export function registerPoll(id, refreshFn) {
  if (typeof refreshFn === 'function') refreshFns.set(id, refreshFn);
}

/** Internal: on return-to-visible, run every registered refresh once.
    Guarded against re-entrancy so a burst of visibility events can't stack. */
async function handleVisibility() {
  if (isHidden() || refreshInFlight) return;
  const fns = [...refreshFns.values()];
  if (!fns.length) return;
  refreshInFlight = true;
  try {
    for (const fn of fns) {
      try { await fn(); }
      catch (err) { console.warn('[visibility] refresh on return failed:', err); }
    }
  } finally {
    refreshInFlight = false;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', handleVisibility);
}
