/* Bottom-center single-line ticker: latest feed items cycling, mono,
   pauses on hover, click opens the Feed panel. */
import { store, on, emit } from '../data/store.js';

const CYCLE_MS = 4500;
let tickerEl, textEl, dotEl;
let idx = 0;
let timer = 0;
let paused = false;

function items() {
  return (store.feed || []).slice(0, 6);
}

function show(i) {
  const list = items();
  if (!list.length) {
    tickerEl.classList.add('hidden');
    return;
  }
  tickerEl.classList.remove('hidden');
  const f = list[i % list.length];
  textEl.classList.add('swap');
  setTimeout(() => {
    textEl.textContent = f.headline || f.text || '';
    // Severity tint comes from the sev-* class scope (--sev var).
    dotEl.className = `ticker-dot sev-${f.severity || 'low'}`;
    textEl.classList.remove('swap');
  }, 200);
  idx = (i + 1) % list.length;
}

function arm() {
  clearInterval(timer);
  if (!items().length) return;
  timer = setInterval(() => { if (!paused) show(idx); }, CYCLE_MS);
}

export function initTicker() {
  tickerEl = document.getElementById('ticker');
  textEl = document.getElementById('ticker-text');
  dotEl = document.getElementById('ticker-dot');
  if (!tickerEl) return;

  tickerEl.addEventListener('mouseenter', () => { paused = true; });
  tickerEl.addEventListener('mouseleave', () => { paused = false; });
  tickerEl.addEventListener('click', () => emit('open-panel', { name: 'feed' }));

  on('data', () => {
    idx = 0;
    show(0);
    arm();
  });

  show(0);
  arm();
}
