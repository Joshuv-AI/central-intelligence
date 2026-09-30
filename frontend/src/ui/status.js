/* Top-left status pill: wordmark + live dot + SOURCES n/m + sweep age + direction.
   Click → system detail panel.
   UX-3: visible RECONNECTING pill when the SSE stream is reconnecting for
   > 5 s or attempt ≥ 3 — dismissible, cleared on the next snapshot. */
import { store, on, emit } from '../data/store.js';
import { timeAgo } from '../data/format.js';
import { isHidden } from '../data/visibility.js';

let pillEl;
let metaEl;
let dotEl;
let reconnectEl;
let reconnectTextEl;

// ——— RECONNECTING pill state (UX-3) ———
const RECONNECT_SHOW_AFTER_MS = 5000;
const RECONNECT_SHOW_ATTEMPT = 3;
let reconnectStart = 0;     // Date.now() when the current episode began (0 = none)
let reconnectAttempt = 0;   // highest retry attempt seen in this episode
let reconnectDismissed = false; // per episode; reset on each new disconnect
let reconnectShowTimer = null;

function dirClass(direction) {
  if (direction === 'RISK-ON') return 'dir-risk-on';
  if (direction === 'RISK-OFF') return 'dir-risk-off';
  return 'dir-mixed';
}

function lastSweepAt() {
  const meta = store.meta;
  return meta && meta.lastSweep
    ? (typeof meta.lastSweep === 'object' ? meta.lastSweep.at : meta.lastSweep)
    : null;
}

function updateReconnectPill() {
  if (!reconnectEl) return;
  const reconnecting = store.streamReconnecting === true;
  if (!reconnecting || reconnectDismissed) {
    reconnectEl.classList.add('hidden');
    return;
  }
  const elapsed = reconnectStart ? Date.now() - reconnectStart : 0;
  if (elapsed > RECONNECT_SHOW_AFTER_MS || reconnectAttempt >= RECONNECT_SHOW_ATTEMPT) {
    reconnectTextEl.textContent =
      `RECONNECTING — ${lastSweepAt() ? `showing last sweep from ${timeAgo(lastSweepAt())}` : 'showing last data'}`;
    reconnectEl.classList.remove('hidden');
  } else {
    reconnectEl.classList.add('hidden');
  }
}

function clearReconnect() {
  reconnectStart = 0;
  reconnectAttempt = 0;
  reconnectDismissed = false;
  clearTimeout(reconnectShowTimer);
  reconnectShowTimer = null;
  updateReconnectPill();
}

export function renderStatus() {
  if (!pillEl) return;
  const meta = store.meta;
  const sources = (meta && meta.sources) || {};
  const names = Object.keys(sources);
  const healthy = names.filter((n) => sources[n].status === 'ok').length;
  const status = (meta && meta.status) || {};
  const direction = status.direction || '—';
  const at = lastSweepAt();
  const sweepAge = at ? `SWEEP ${timeAgo(at)}` : 'SWEEP —';

  metaEl.innerHTML =
    `<span><span class="src-word">SOURCES </span>${healthy}/${names.length || '—'}</span>` +
    `<span class="meta-extra"><span> · </span><span>${sweepAge}</span>` +
    `<span> · </span><span class="${dirClass(direction)}">${direction}</span></span>`;

  // Refresh the reconnect pill's sweep age while it is visible.
  updateReconnectPill();
}

export function initStatus() {
  pillEl = document.getElementById('status-pill');
  metaEl = document.getElementById('status-meta');
  dotEl = document.getElementById('live-dot');
  reconnectEl = document.getElementById('reconnect-pill');
  if (reconnectEl) {
    reconnectEl.innerHTML =
      '<span id="reconnect-pill-text"></span>' +
      '<button id="reconnect-pill-x" class="reconnect-x" aria-label="Dismiss reconnecting notice">×</button>';
    reconnectTextEl = document.getElementById('reconnect-pill-text');
    document.getElementById('reconnect-pill-x').addEventListener('click', (ev) => {
      ev.stopPropagation();
      reconnectDismissed = true;
      updateReconnectPill();
    });
  }
  if (!pillEl) return;

  pillEl.addEventListener('click', () => {
    emit('open-panel', { name: 'system' });
  });

  on('data', renderStatus);
  // A snapshot applied = a successful reconnect episode's end.
  on('data', clearReconnect);
  on('stream-status', ({ connected, reconnecting, attempt }) => {
    store.streamConnected = connected;
    store.streamReconnecting = reconnecting;
    if (reconnecting && !reconnectStart) {
      // New reconnect episode.
      reconnectStart = Date.now();
      reconnectAttempt = 0;
      reconnectDismissed = false;
      clearTimeout(reconnectShowTimer);
      // stream-status fires only on transitions; re-check after the 5 s gate
      // so the pill appears even with no further events.
      reconnectShowTimer = setTimeout(updateReconnectPill, RECONNECT_SHOW_AFTER_MS + 100);
    }
    if (Number.isFinite(attempt)) reconnectAttempt = Math.max(reconnectAttempt, attempt);
    if (connected) clearReconnect();
    updateReconnectPill();
    if (dotEl) {
      dotEl.classList.toggle('off', !connected);
      dotEl.title = connected ? 'Live connection' : reconnecting ? 'Reconnecting…' : 'Offline';
    }
  });

  // Keep sweep age fresh (A4-1: skip while the tab is hidden).
  setInterval(() => { if (!isHidden()) renderStatus(); }, 15000);
  renderStatus();
}
