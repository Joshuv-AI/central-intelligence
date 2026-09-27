/* Keyless search: client-side over loaded events (title/summary/region/source).
   Select → fly-to + marker pulse + detail card. */
import { store, emit, on } from '../data/store.js';
import { esc } from '../data/format.js';

const MAX_RESULTS = 8;
let inputEl;
let resultsEl;
let activeQuery = '';

function matches(e, q) {
  const hay = `${e.title || ''} ${e.summary || ''} ${e.region || ''} ${e.source || ''}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
}

function renderResults(list, q) {
  if (!q) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }
  if (list.length === 0) {
    resultsEl.innerHTML = `<div class="search-empty">No signals match “${esc(q)}”.</div>`;
  } else {
    resultsEl.innerHTML = list
      .map(
        (e) => `
        <button class="search-hit sev-${e.severity || 'low'}" data-event-id="${esc(e.id)}" role="option">
          <span class="hit-dot"></span>
          <span>
            <span class="hit-title">${esc(e.title)}</span>
            <span class="hit-sub">${esc(e.domain || '')}${e.region ? ` · ${esc(e.region)}` : ''}</span>
          </span>
        </button>`
      )
      .join('');
  }
  resultsEl.classList.remove('hidden');
}

function runSearch() {
  const q = inputEl.value.trim().toLowerCase();
  activeQuery = q;
  if (!q) {
    renderResults([], '');
    return;
  }
  const hits = [];
  for (const e of store.events) {
    if (matches(e, q)) {
      hits.push(e);
      if (hits.length >= MAX_RESULTS) break;
    }
  }
  renderResults(hits, inputEl.value.trim());
}

export function closeSearch() {
  if (resultsEl) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
  }
  if (inputEl && document.activeElement === inputEl) inputEl.blur();
  activeQuery = '';
}

export function initSearch() {
  inputEl = document.getElementById('search-input');
  resultsEl = document.getElementById('search-results');
  if (!inputEl || !resultsEl) return;

  let debounce = 0;
  inputEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 120);
  });
  inputEl.addEventListener('focus', runSearch);
  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      closeSearch();
    } else if (ev.key === 'Enter') {
      const first = resultsEl.querySelector('.search-hit');
      if (first) first.click();
    }
  });

  resultsEl.addEventListener('click', (ev) => {
    const hit = ev.target.closest('.search-hit');
    if (!hit) return;
    const eventId = hit.dataset.eventId;
    closeSearch();
    inputEl.value = '';
    emit('focus-event', { eventId, openCard: true });
  });

  // Click-away closes.
  document.addEventListener('pointerdown', (ev) => {
    if (!resultsEl.classList.contains('hidden') &&
        !ev.target.closest('#search-wrap')) {
      closeSearch();
    }
  });

  on('data', () => { if (activeQuery) runSearch(); });
  on('close-panels', closeSearch);
}
