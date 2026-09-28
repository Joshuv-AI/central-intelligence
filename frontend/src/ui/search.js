/* Keyless search: client-side over loaded events (title/summary/region/source),
   plus Photon (photon.komoot.io, keyless) for place/coordinate/landmark search.
   Select → fly-to + marker pulse + detail card. */
import { store, emit, on } from '../data/store.js';
import { esc } from '../data/format.js';
import { flyToPoint } from '../globe/camera.js';

const MAX_RESULTS = 8;
const PHOTON_URL = 'https://photon.komoot.io/api/';
let inputEl;
let resultsEl;
let activeQuery = '';
let placeHits = [];
let placeToken = 0;

function matches(e, q) {
  const hay = `${e.title || ''} ${e.summary || ''} ${e.region || ''} ${e.source || ''}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
}

function placeLabel(p) {
  const bits = [p.name || p.street, p.city, p.state, p.country].filter(Boolean);
  return bits.join(', ');
}

function renderResults(list, q) {
  if (!q) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }
  let html = '';
  if (list.length === 0 && placeHits.length === 0) {
    html = `<div class="search-empty">No signals match “${esc(q)}”.</div>`;
  } else {
    html = list
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
    if (placeHits.length > 0) {
      html += `<div class="search-div">PLACES</div>` + placeHits
        .map(
          (p, i) => `
          <button class="search-hit place-hit" data-place-idx="${i}" role="option">
            <span class="hit-dot place-dot"></span>
            <span>
              <span class="hit-title">${esc(placeLabel(p))}</span>
              <span class="hit-sub">${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°</span>
            </span>
          </button>`
        )
        .join('');
    }
  }
  resultsEl.innerHTML = html;
  resultsEl.classList.remove('hidden');
}

async function searchPlaces(q) {
  const token = ++placeToken;
  if (q.length < 3) {
    placeHits = [];
    if (activeQuery === q) renderResults(currentSignalHits(), inputEl.value.trim());
    return;
  }
  try {
    const res = await fetch(`${PHOTON_URL}?q=${encodeURIComponent(q)}&limit=5`);
    if (!res.ok) throw new Error('photon ' + res.status);
    const geo = await res.json();
    if (token !== placeToken) return; // stale
    placeHits = (geo.features || []).map((f) => ({
      label: placeLabel(f.properties || {}),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));
  } catch {
    if (token !== placeToken) return;
    placeHits = [];
  }
  if (activeQuery === q.toLowerCase()) renderResults(currentSignalHits(), inputEl.value.trim());
}

function currentSignalHits() {
  const q = activeQuery;
  const hits = [];
  for (const e of store.events) {
    if (matches(e, q)) {
      hits.push(e);
      if (hits.length >= MAX_RESULTS) break;
    }
  }
  return hits;
}

function runSearch() {
  const q = inputEl.value.trim().toLowerCase();
  activeQuery = q;
  if (!q) {
    placeToken++; // cancel in-flight place search
    placeHits = [];
    renderResults([], '');
    return;
  }
  renderResults(currentSignalHits(), inputEl.value.trim());
  clearTimeout(runSearch._pt);
  runSearch._pt = setTimeout(() => searchPlaces(inputEl.value.trim()), 400);
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
    if (hit.dataset.placeIdx !== undefined) {
      const p = placeHits[Number(hit.dataset.placeIdx)];
      closeSearch();
      inputEl.value = '';
      if (p) flyToPoint(p.lon, p.lat, { height: 1_500_000, duration: 1.6 });
      return;
    }
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
