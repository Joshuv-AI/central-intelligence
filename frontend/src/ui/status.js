/* Top-left status pill: wordmark + live dot + SOURCES n/m + sweep age + direction.
   Click → system detail panel. */
import { store, on, emit } from '../data/store.js';
import { timeAgo } from '../data/format.js';

let pillEl;
let metaEl;
let dotEl;

function dirClass(direction) {
  if (direction === 'RISK-ON') return 'dir-risk-on';
  if (direction === 'RISK-OFF') return 'dir-risk-off';
  return 'dir-mixed';
}

export function renderStatus() {
  if (!pillEl) return;
  const meta = store.meta;
  const sources = (meta && meta.sources) || {};
  const names = Object.keys(sources);
  const healthy = names.filter((n) => sources[n].status === 'ok').length;
  const status = (meta && meta.status) || {};
  const direction = status.direction || '—';
  const lastSweepAt = meta && meta.lastSweep
    ? (typeof meta.lastSweep === 'object' ? meta.lastSweep.at : meta.lastSweep)
    : null;
  const sweepAge = lastSweepAt ? `SWEEP ${timeAgo(lastSweepAt)}` : 'SWEEP —';

  metaEl.innerHTML =
    `<span><span class="src-word">SOURCES </span>${healthy}/${names.length || '—'}</span>` +
    `<span class="meta-extra"><span> · </span><span>${sweepAge}</span>` +
    `<span> · </span><span class="${dirClass(direction)}">${direction}</span></span>`;
}

export function initStatus() {
  pillEl = document.getElementById('status-pill');
  metaEl = document.getElementById('status-meta');
  dotEl = document.getElementById('live-dot');
  if (!pillEl) return;

  pillEl.addEventListener('click', () => {
    emit('open-panel', { name: 'system' });
  });

  on('data', renderStatus);
  on('stream-status', ({ connected, reconnecting }) => {
    store.streamConnected = connected;
    store.streamReconnecting = reconnecting;
    if (dotEl) {
      dotEl.classList.toggle('off', !connected);
      dotEl.title = connected ? 'Live connection' : reconnecting ? 'Reconnecting…' : 'Offline';
    }
  });

  // Keep sweep age fresh.
  setInterval(renderStatus, 15000);
  renderStatus();
}
