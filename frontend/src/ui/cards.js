/* Floating detail card (marker click) + lightweight hover preview (desktop).
   The card tracks its marker via postRender projection; it never takes a rail. */
import * as Cesium from 'cesium';
import { store, on, emit, DOMAIN_LABELS } from '../data/store.js';
import { getViewer } from '../globe/viewer.js';
import { pickAt, screenPositionOf } from '../globe/markers.js';
import { esc, fmtDateTime, fmtCoords } from '../data/format.js';

let cardEl, tipEl;
let openEventId = null;
let anchorCartesian = null;
let postRenderHandler = null;
let hoverRaf = 0;
let lastHover = 0;

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

export function isCardOpen() { return openEventId !== null; }

export function openEventCard(eventId, clientX, clientY) {
  const e = store.eventById(eventId);
  if (!e || !cardEl) return;
  openEventId = eventId;
  renderCard(e);
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');

  // Anchor: use the click point first, then track the marker each frame.
  const viewer = getViewer();
  anchorCartesian = e && Number.isFinite(e.lon) && Number.isFinite(e.lat)
    ? Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 0)
    : null;
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId });
}

export function closeEventCard() {
  if (!openEventId) return;
  openEventId = null;
  anchorCartesian = null;
  stopTracking();
  if (cardEl) {
    cardEl.classList.remove('open');
    setTimeout(() => { if (!openEventId) cardEl.classList.add('hidden'); }, 220);
  }
  emit('card-closed', null);
}

function renderCard(e) {
  const severity = e.severity || 'low';
  const conns = store.connectionsForEvent(e.id);
  const where = [e.region, fmtCoords(e.lat, e.lon)].filter((v) => v && v !== '—').join(' · ') || '—';
  cardEl.className = `sev-${severity}`;
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>${esc((DOMAIN_LABELS[e.domain] || e.domain || 'SIGNAL').toUpperCase())} · ${esc(severity.toUpperCase())}</div>
    <h3 class="card-title">${esc(e.title)}</h3>
    <div class="card-fields">
      <div class="card-field"><span class="k">Where</span><span class="v">${esc(where)}</span></div>
      <div class="card-field"><span class="k">When</span><span class="v">${esc(fmtDateTime(e.time))}</span></div>
      <div class="card-field"><span class="k">Source</span><span class="v">${esc(e.source || '—')}</span></div>
      ${e.attribution ? `<div class="card-field"><span class="k">Credit</span><span class="v dim">${esc(e.attribution)}</span></div>` : ''}
    </div>
    ${e.summary ? `<p class="card-summary">${esc(e.summary)}</p>` : ''}
    ${conns.length ? `
      <div class="card-links">
        <span class="micro">LINKED CONNECTIONS</span>
        ${conns.map((c) => `<button class="card-conn" data-conn-id="${esc(c.id)}">${esc(c.title)}</button>`).join('')}
      </div>` : ''}
    ${e.url ? `<a class="card-src" href="${esc(e.url)}" target="_blank" rel="noopener">SOURCE →</a>` : ''}`;

  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  cardEl.querySelectorAll('.card-conn').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeEventCard();
      emit('focus-connection', { connectionId: btn.dataset.connId });
    });
  });
}

function placeCard(x, y) {
  const pad = 16;
  const w = cardEl.offsetWidth || 300;
  const h = cardEl.offsetHeight || 200;
  let left = x + 18;
  let top = y - h / 2;
  if (left + w > window.innerWidth - pad) left = x - w - 18;
  if (top < pad) top = pad;
  if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
  cardEl.style.left = `${Math.max(pad, left)}px`;
  cardEl.style.top = `${Math.max(pad, top)}px`;
}

function startTracking() {
  stopTracking();
  const viewer = getViewer();
  if (!viewer) return;
  postRenderHandler = () => {
    if (!openEventId || !anchorCartesian) return;
    const p = screenPositionOf(anchorCartesian);
    if (!p) {
      cardEl.style.opacity = '0';
      return;
    }
    cardEl.style.opacity = '';
    placeCard(p.x, p.y);
  };
  viewer.scene.postRender.addEventListener(postRenderHandler);
}

function stopTracking() {
  const viewer = getViewer();
  if (viewer && postRenderHandler) {
    viewer.scene.postRender.removeEventListener(postRenderHandler);
  }
  postRenderHandler = null;
}

/* ——— hover preview (desktop, throttled, lightweight) ——— */
function onMouseMove(ev) {
  if (isMobile() || openEventId) { hideTip(); return; }
  const now = performance.now();
  if (now - lastHover < 90 || hoverRaf) return;
  lastHover = now;
  const { clientX, clientY } = ev;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    try {
      const hit = pickAt(clientX, clientY);
      if (!hit || hit.type === 'cluster') { hideTip(); return; }
      const e = hit.type === 'event'
        ? store.eventById(hit.eventId)
        : null;
      if (hit.type === 'connection') {
        const c = store.connectionById(hit.connectionId);
        if (c) showTip(clientX, clientY, c.title, `CORRELATION · ${c.severity || ''}`, c.severity);
        else hideTip();
        return;
      }
      if (e) showTip(clientX, clientY, e.title, `${e.domain || ''} · ${e.severity || ''}`, e.severity);
      else hideTip();
    } catch { hideTip(); }
  });
}

function showTip(x, y, title, sub, severity) {
  tipEl.className = `sev-${severity || 'low'} open`;
  tipEl.innerHTML = `<div class="tip-title">${esc(title)}</div><div class="tip-sub">${esc(sub)}</div>`;
  const w = 260;
  let left = x + 16;
  if (left + w > window.innerWidth - 12) left = x - w - 16;
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${Math.min(window.innerHeight - 90, y + 14)}px`;
}

function hideTip() {
  if (tipEl) tipEl.classList.remove('open');
}

export function initCards() {
  cardEl = document.getElementById('detail-card');
  tipEl = document.getElementById('hover-tip');
  if (!cardEl) return;

  const globe = document.getElementById('globe-container');
  if (globe && window.matchMedia('(pointer: fine)').matches) {
    globe.addEventListener('mousemove', onMouseMove);
    globe.addEventListener('mouseleave', hideTip);
  }

  on('close-panels', closeEventCard);
  on('data', () => {
    // If the open event vanished from state, close quietly.
    if (openEventId && !store.eventById(openEventId)) closeEventCard();
  });
}
