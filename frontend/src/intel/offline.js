/* Wave 1 (J4-11) — offline resilience: cached last picture, persistent
   age chrome, motion frozen when stale.

   Rules (from the §J evaluation):
   - On disconnect: the last good snapshot is cached (localStorage, bounded);
     the age becomes PERSISTENT chrome ("OFFLINE — last picture 42 m ago") —
     never a dismissible pill. On mobile only the *detail* is collapsible;
     the age line itself never hides.
   - Motion freezes when stale: the Cesium clock multiplier drops to 0 so no
     telemetry/TLE/propagation keeps animating from dead data. Live again →
     the stored multiplier is restored. Reconnect resumes live (the client
     refetches; nothing here replays the past as live).
   - Age labels are coarse ("42 m") and refreshed on minute boundaries, not
     per-second.

   Pure cache helpers are unit-testable; the watcher needs DOM + viewer. */

import { formatAge } from '../ui/ageFormat.js';

export const OFFLINE_CACHE_KEY = 'ci.last-snapshot.v1';
const CACHE_BYTES_CAP = 512 * 1024; // half a megabyte — a snapshot, not history

/**
 * Cache the last good snapshot. Returns true when cached.
 * Silently skips oversized payloads rather than blowing the quota.
 */
export function saveOfflineSnapshot(snap, storage = null) {
  const ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!ls || !snap || !Array.isArray(snap.markers)) return false;
  try {
    const slim = {
      v: 1,
      savedAt: Date.now(),
      markers: snap.markers,
      connections: Array.isArray(snap.connections) ? snap.connections : [],
      feed: Array.isArray(snap.feed) ? snap.feed : [],
      meta: snap.meta || null,
    };
    const text = JSON.stringify(slim);
    if (text.length > CACHE_BYTES_CAP) return false;
    ls.setItem(OFFLINE_CACHE_KEY, text);
    return true;
  } catch {
    return false; // quota or privacy mode: offline cache is best-effort
  }
}

/** Load the cached snapshot, or null when absent/corrupt/stale-shaped. */
export function loadOfflineSnapshot(storage = null) {
  const ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!ls) return null;
  try {
    const raw = ls.getItem(OFFLINE_CACHE_KEY);
    if (!raw) return null;
    const slim = JSON.parse(raw);
    if (!slim || slim.v !== 1 || !Array.isArray(slim.markers) || !Number.isFinite(slim.savedAt)) return null;
    return slim;
  } catch {
    return null;
  }
}

/** True when the client is in a disconnected episode (down/reconnecting). */
export function isOfflineEpisode(diag) {
  return !!diag && (diag.state === 'down' || diag.state === 'reconnecting');
}

/**
 * Offline watcher: drives the persistent chrome + clock freeze from the
 * intel client's diag state and navigator.onLine. Install once.
 *
 * @param {object} deps
 * @param {() => object|null} deps.getDiag current client diag
 * @param {() => object|null} deps.getViewer Cesium viewer (for clock freeze)
 * @param {() => number|null} deps.getLastSnapshotAt
 * @param {() => void} deps.onWentLive refetch hook
 */
export function createOfflineWatch({ getDiag, getViewer, getLastSnapshotAt, onWentLive } = {}) {
  let offline = false;
  let chromeEl = null;
  let detailEl = null;
  let ageEl = null;
  let savedMultiplier = null;
  let ageTimer = null;
  let destroyed = false;

  function ensureChrome() {
    if (chromeEl) return;
    chromeEl = document.createElement('div');
    chromeEl.id = 'ci-offline-chrome';
    chromeEl.setAttribute('role', 'status');
    chromeEl.innerHTML =
      `<span id="ci-offline-age"></span>` +
      `<button id="ci-offline-detail" type="button" aria-expanded="false" aria-label="Offline details">Details</button>` +
      `<div id="ci-offline-detail-body" hidden></div>`;
    const css = document.createElement('style');
    css.id = 'ci-offline-css';
    css.textContent = `
#ci-offline-chrome{position:fixed;top:0;left:0;right:0;z-index:200;display:flex;align-items:center;gap:10px;
  background:#3a2b06;color:#ffe9b0;border-bottom:2px solid #FFD166;
  font:600 12.5px/1.4 system-ui,sans-serif;padding:8px 12px;min-height:44px;box-sizing:border-box}
#ci-offline-chrome[hidden]{display:none}
#ci-offline-age{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ci-offline-detail{background:none;border:1px solid currentColor;color:inherit;border-radius:8px;
  font:600 12px system-ui,sans-serif;min-height:44px;min-width:44px;padding:6px 12px;cursor:pointer}
#ci-offline-detail-body{position:absolute;top:100%;left:0;right:0;background:#241b04;color:#ffe9b0;
  padding:10px 14px;font-weight:400;border-bottom:2px solid #FFD166}
@media (max-width:720px){#ci-offline-chrome{font-size:12px;padding:8px 10px}}`;
    document.head.appendChild(css);
    document.body.appendChild(chromeEl);
    ageEl = chromeEl.querySelector('#ci-offline-age');
    detailEl = chromeEl.querySelector('#ci-offline-detail-body');
    chromeEl.querySelector('#ci-offline-detail').addEventListener('click', (ev) => {
      const open = detailEl.hidden;
      detailEl.hidden = !open;
      ev.currentTarget.setAttribute('aria-expanded', String(open));
    });
  }

  function paintAge() {
    const last = getLastSnapshotAt?.();
    if (!last) {
      ageEl.textContent = 'OFFLINE — no picture received yet';
      return;
    }
    const age = formatAge(last);
    // "just now" takes no "ago" — "just now ago" is not a sentence.
    ageEl.textContent =
      age === 'just now'
        ? 'OFFLINE — showing last picture (just updated)'
        : `OFFLINE — showing last picture from ${age} ago`;
  }

  function freezeMotion() {
    const viewer = getViewer?.();
    const clock = viewer?.clock;
    if (!clock) return;
    if (savedMultiplier === null) savedMultiplier = clock.multiplier;
    clock.multiplier = 0; // freeze: no animating stale telemetry
  }

  function unfreezeMotion() {
    const viewer = getViewer?.();
    const clock = viewer?.clock;
    if (!clock) return;
    if (savedMultiplier !== null) clock.multiplier = savedMultiplier;
    savedMultiplier = null;
  }

  function enterOffline() {
    if (offline || destroyed) return;
    offline = true;
    ensureChrome();
    paintAge();
    const diag = getDiag?.();
    if (detailEl) {
      detailEl.innerHTML = '';
      const p = document.createElement('p');
      p.style.margin = '0';
      p.textContent =
        `Connection state: ${diag?.state || 'unknown'}. ` +
        'Motion is frozen — nothing on screen is moving on live data. ' +
        'Reconnecting automatically; the live picture resumes on its own.';
      detailEl.appendChild(p);
    }
    chromeEl.hidden = false;
    freezeMotion();
    // Coarse age refresh: minute boundaries, never per-second.
    clearInterval(ageTimer);
    ageTimer = setInterval(paintAge, 30_000);
  }

  function exitOffline() {
    if (!offline || destroyed) return;
    offline = false;
    clearInterval(ageTimer);
    ageTimer = null;
    if (chromeEl) chromeEl.hidden = true;
    unfreezeMotion();
    onWentLive?.();
  }

  function poll() {
    if (destroyed) return;
    const diag = getDiag?.();
    const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (isOfflineEpisode(diag) || browserOffline) enterOffline();
    else exitOffline();
  }

  const timer = setInterval(poll, 5_000);
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', poll);
    window.addEventListener('offline', poll);
  }
  poll();

  return {
    poll, // exposed for tests
    get offline() { return offline; },
    destroy() {
      destroyed = true;
      clearInterval(timer);
      clearInterval(ageTimer);
      if (offline) { offline = false; unfreezeMotion(); }
      chromeEl?.remove();
    },
  };
}
