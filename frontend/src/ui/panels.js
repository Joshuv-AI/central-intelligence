/* Docked panel: one at a time, ~340px left overlay / bottom sheet on mobile.
   Panels: layers, connections, feed, regions, guide, system (status pill detail).
   Cross-module navigation goes through the emit bus — no import cycles. */
import {
  store, on, emit,
  DOMAINS, DOMAIN_LABELS, FAMILIES, FAMILY_LABELS, REGIONS,
  regionMatches, familyOf,
} from '../data/store.js';
import { applyFilters } from '../globe/markers.js';
import { flyToRegion } from '../globe/camera.js';
import { esc, timeAgo, fmtDateTime } from '../data/format.js';
import { fetchHealth } from '../data/api.js';

let panelEl, bodyEl, titleEl, kickerEl, closeBtn, handleEl;
let current = null;
let closeTimer = 0;

const META = {
  layers: { kicker: 'SIGNAL LAYERS', title: 'Layers' },
  connections: { kicker: 'FUSED INTELLIGENCE', title: 'Connections' },
  feed: { kicker: 'REALTIME', title: 'Feed' },
  regions: { kicker: 'AREA FOCUS', title: 'Regions' },
  guide: { kicker: 'FIELD MANUAL', title: 'Guide' },
  system: { kicker: 'SYSTEM', title: 'System status' },
};

export function currentPanel() { return current; }
export function isPanelOpen() { return current !== null; }

export function initPanels() {
  panelEl = document.getElementById('panel');
  bodyEl = document.getElementById('panel-body');
  titleEl = document.getElementById('panel-title');
  kickerEl = document.getElementById('panel-kicker');
  closeBtn = document.getElementById('panel-close');
  handleEl = document.getElementById('sheet-handle');
  if (!panelEl) return;

  closeBtn.addEventListener('click', closePanel);
  initSheetDrag();

  on('open-panel', ({ name, ...opts }) => openPanel(name, opts));
  on('toggle-panel', ({ name }) => {
    if (current === name) closePanel();
    else openPanel(name);
  });
  on('close-panels', closePanel);
  on('filters', () => { if (current) render(current); });
  on('data', () => {
    if (current && current !== 'guide') render(current);
  });
}

export function openPanel(name, opts = {}) {
  if (!META[name] || !panelEl) return;
  current = name;
  kickerEl.textContent = META[name].kicker;
  titleEl.textContent = META[name].title;
  render(name, opts);
  panelEl.classList.remove('hidden');
  // Force reflow so the 240ms rise transition plays.
  void panelEl.offsetWidth;
  panelEl.classList.add('open');
  clearTimeout(closeTimer);
  emit('panel-changed', name);
}

export function closePanel() {
  if (!current || !panelEl) return;
  current = null;
  panelEl.classList.remove('open');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => panelEl.classList.add('hidden'), 260);
  emit('panel-changed', null);
  emit('close-panels', null);
}

function render(name, opts = {}) {
  const fn = {
    layers: renderLayers,
    connections: renderConnections,
    feed: renderFeed,
    regions: renderRegions,
    guide: renderGuide,
    system: renderSystem,
  }[name];
  if (fn) fn(bodyEl, opts);
  bodyEl.scrollTop = 0;
}

/* ————————— Layers ————————— */
function renderLayers(el) {
  const counts = store.countsPerDomain();
  const nonGeo = store.events.filter((e) => !store.isGeo(e)).length;
  let html = '';
  for (const [fam, domains] of Object.entries(FAMILIES)) {
    html += `<div class="layer-family"><span class="micro">${FAMILY_LABELS[fam]}</span>`;
    for (const d of domains) {
      const onState = store.families[fam] && store.domains[d] !== false;
      html += `
        <button class="layer-row ${onState ? '' : 'off'}" data-domain="${d}">
          <span class="layer-swatch"></span>
          <span class="layer-name">${DOMAIN_LABELS[d]}</span>
          <span class="layer-count">${counts[d] || 0}</span>
          <span class="layer-toggle" aria-hidden="true"></span>
        </button>`;
    }
    html += '</div>';
  }
  if (nonGeo > 0) {
    html += `<div class="layer-note">${nonGeo} event${nonGeo === 1 ? '' : 's'} without coordinates live${nonGeo === 1 ? 's' : ''} in the feed and layer counts, not on the globe.</div>`;
  }
  el.innerHTML = html;

  el.querySelectorAll('.layer-row').forEach((row) => {
    row.addEventListener('click', () => {
      const d = row.dataset.domain;
      store.domains[d] = store.domains[d] === false;
      emit('filters');
      applyFilters();
      renderLayers(el);
    });
  });
}

/* ————————— Connections ————————— */
function renderConnections(el, { focusId } = {}) {
  const conns = store.connections || [];
  if (conns.length === 0) {
    el.innerHTML = `<div class="panel-empty"><span class="micro">NO CORRELATIONS</span>The fusion engine has not linked any cross-source chains yet. They appear here when independent sources start telling the same story.</div>`;
    return;
  }
  el.innerHTML = conns
    .map((c) => {
      const steps = (c.chain || [])
        .map((s) => `
          <div class="conn-step sev-${s.severity || 'low'}">
            <span class="step-dot"></span>
            <span>
              <span class="step-role">${esc(s.role || 'link')}</span>
              <span class="step-title">${esc(s.title || '')}</span>
            </span>
          </div>`)
        .join('');
      const tags = (c.tags || []).slice(0, 6)
        .map((t) => `<span class="conn-tag">${esc(t)}</span>`).join('');
      return `
        <button class="conn-card sev-${c.severity || 'low'} ${c.id === focusId ? 'active' : ''}" data-conn-id="${esc(c.id)}">
          <span class="conn-top">
            <span class="conn-tier">${esc(c.tier || 'standard')}</span>
            <span class="conn-score">SCORE ${c.score ?? '—'}</span>
          </span>
          <span class="conn-title">${esc(c.title)}</span>
          <span class="conn-summary">${esc(c.summary || '')}</span>
          <span class="conn-chain">${steps}</span>
          ${tags ? `<span class="conn-tags">${tags}</span>` : ''}
        </button>`;
    })
    .join('');

  el.querySelectorAll('.conn-card').forEach((card) => {
    card.addEventListener('click', () => {
      emit('focus-connection', { connectionId: card.dataset.connId, keepPanel: true });
    });
  });

  if (focusId) {
    const target = el.querySelector(`[data-conn-id="${CSS.escape(focusId)}"]`);
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ————————— Feed ————————— */
const KIND_LABELS = { connection: 'CORRELATION', escalation: 'ESCALATION', event: 'EVENT', anomaly: 'ANOMALY' };

function renderFeed(el) {
  const feed = store.feed || [];
  if (feed.length === 0) {
    el.innerHTML = `<div class="panel-empty"><span class="micro">QUIET</span>No feed items yet. New correlations, escalations and anomalies stream in here after each sweep.</div>`;
    return;
  }
  el.innerHTML = feed
    .map((f) => `
      <button class="feed-item sev-${f.severity || 'low'}" data-feed-id="${esc(f.id)}">
        <span class="feed-dot"></span>
        <span>
          <span class="feed-kind">${esc(KIND_LABELS[f.kind] || String(f.kind || '').toUpperCase())}</span>
          <span class="feed-text">${esc(f.text)}</span>
          <span class="feed-time">${fmtDateTime(f.time)} · ${timeAgo(f.time)} AGO</span>
        </span>
      </button>`)
    .join('');

  el.querySelectorAll('.feed-item').forEach((item) => {
    item.addEventListener('click', () => {
      const f = store.feed.find((x) => x.id === item.dataset.feedId);
      if (!f) return;
      if (f.eventId) emit('focus-event', { eventId: f.eventId, openCard: true });
      else if (f.connectionId) emit('focus-connection', { connectionId: f.connectionId, keepPanel: true });
    });
  });
}

/* ————————— Regions ————————— */
function renderRegions(el) {
  const geo = store.geoEvents().filter(
    (e) => store.families[familyOf(e.domain)] && store.domains[e.domain] !== false
  );
  el.innerHTML = REGIONS.map((r) => {
    const n = r.id === 'world' ? geo.length : geo.filter((e) => regionMatches(r.id, e)).length;
    return `
      <button class="region-row ${store.region === r.id ? 'active' : ''}" data-region="${r.id}">
        <span class="region-name">${r.label.charAt(0)}${r.label.slice(1).toLowerCase()}</span>
        <span class="region-count">${n} SIGNALS</span>
      </button>`;
  }).join('');

  el.querySelectorAll('.region-row').forEach((row) => {
    row.addEventListener('click', () => {
      store.region = row.dataset.region;
      emit('region-changed', { region: store.region });
      emit('filters');
      applyFilters();
      flyToRegion(store.region).catch(() => {});
      renderRegions(el);
      syncRegionPill();
    });
  });
}

export function syncRegionPill() {
  const label = document.getElementById('region-label');
  const region = REGIONS.find((r) => r.id === store.region);
  if (label && region) label.textContent = region.label;
  document.querySelectorAll('.region-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.region === store.region);
  });
}

/* ————————— Guide ————————— */
function renderGuide(el) {
  el.innerHTML = `
    <div class="guide-section">
      <h3>Reading the globe</h3>
      <p>
        <span class="guide-marker"><span class="guide-swatch" style="background:#7FCEF0"></span>Event — a dot in its severity color, ringed.</span><br>
        <span class="guide-marker"><span class="guide-swatch" style="background:transparent;border:2px solid #7FCEF0;width:7px;height:7px"></span>Correlation — a double ring that breathes slowly. Fused intelligence reads differently from raw events on purpose.</span><br>
        <span class="guide-marker"><span class="guide-swatch" style="background:#0A1526;border:1.5px solid #9CC8E2"></span>Cluster — a number. Zoom in and it resolves into individual events.</span>
      </p>
      <h3>Severity</h3>
      <ul>
        <li><span class="guide-swatch" style="background:#7FCEF0"></span><b>Low</b> — routine signal, background noise.</li>
        <li><span class="guide-swatch" style="background:#FFD166"></span><b>Moderate</b> — worth a look.</li>
        <li><span class="guide-swatch" style="background:#FFB020"></span><b>High</b> — significant development.</li>
        <li><span class="guide-swatch" style="background:#FF5A5A"></span><b>Critical</b> — demands attention now.</li>
      </ul>
      <h3>Layers</h3>
      <p><b>Live</b> — disasters, space weather, signals in motion.<br>
      <b>Intel</b> — conflict, cyber, sanctions, social.<br>
      <b>Environment</b> — health, environment, economic.<br>
      Events without coordinates never reach the globe — they live in layer counts and the feed.</p>
      <h3>Direction</h3>
      <ul>
        <li><b>RISK-ON</b> — critical events or multiple anomalies in the last 24h.</li>
        <li><b>MIXED</b> — elevated but not critical.</li>
        <li><b>RISK-OFF</b> — nothing hot in the last 24h.</li>
      </ul>
      <h3>Where this comes from</h3>
      <p>Events stream from public sources swept in tiers — fast movers every few minutes, slow ones daily. Correlations are rule-based fusions of independent sources sharing time, place and impact. No black boxes: every card names its sources.</p>
    </div>`;
}

/* ————————— System detail ————————— */
const SRC_ORDER = { ok: 0, pending: 1, stale: 2, error: 3, needs_key: 4 };

function renderSystem(el, { health } = {}) {
  const meta = store.meta || {};
  const sources = (health && health.sources) || Object.values(meta.sources || {});
  const status = meta.status || {};
  const delta = meta.deltaSummary || {};
  const sweepAt = meta.lastSweep && typeof meta.lastSweep === 'object' ? meta.lastSweep.at : meta.lastSweep;
  const dir = status.direction || '—';
  const dirCls = dir === 'RISK-ON' ? 'dir-risk-on' : dir === 'RISK-OFF' ? 'dir-risk-off' : '';

  const sorted = sources.slice().sort(
    (a, b) => (SRC_ORDER[a.status] ?? 5) - (SRC_ORDER[b.status] ?? 5) || String(a.name).localeCompare(String(b.name))
  );
  const srcRows = sorted.map((s) => `
    <div class="src-row">
      <span class="src-dot ${esc(s.status || 'pending')}"></span>
      <span class="src-name">${esc(s.name)}</span>
      <span class="src-meta">${s.count ?? 0} EV · ${s.ms ?? 0}MS</span>
    </div>`).join('');

  el.innerHTML = `
    <div class="sys-grid">
      <div class="sys-stat"><span class="micro">Direction</span><span class="stat-val ${dirCls}">${esc(dir)}</span></div>
      <div class="sys-stat"><span class="micro">Hot 24H</span><span class="stat-val">${status.hot24 ?? '—'}</span></div>
      <div class="sys-stat"><span class="micro">Critical 24H</span><span class="stat-val">${status.critical24 ?? '—'}</span></div>
      <div class="sys-stat"><span class="micro">Anomalies</span><span class="stat-val">${(status.anomalies || []).length}</span></div>
    </div>
    <div style="margin-top:14px"><span class="micro">LAST SWEEP DELTA</span></div>
    <div class="delta-line"><span>NEW</span><span>${delta.new ?? '—'}</span></div>
    <div class="delta-line"><span>ESCALATED</span><span>${delta.escalated ?? '—'}</span></div>
    <div class="delta-line"><span>DE-ESCALATED</span><span>${delta.deescalated ?? '—'}</span></div>
    <div class="delta-line"><span>RESOLVED</span><span>${delta.resolved ?? '—'}</span></div>
    <div style="margin:14px 0 6px"><span class="micro">SOURCES · ${sorted.length}</span></div>
    ${srcRows || '<div class="panel-empty">No source data yet.</div>'}
    <div class="layer-note">Last sweep ${sweepAt ? fmtDateTime(sweepAt) : '—'} · Brain ${meta.lastBrain ? fmtDateTime(meta.lastBrain) : '—'}</div>`;

  // Refresh from /api/health in the background for live source states.
  if (!health) {
    fetchHealth()
      .then((h) => { if (current === 'system') renderSystem(el, { health: h }); })
      .catch(() => {});
  }
}

/* ————————— bottom-sheet drag (mobile) ————————— */
function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function initSheetDrag() {
  if (!handleEl) return;
  let startY = 0;
  let dy = 0;
  let dragging = false;

  handleEl.addEventListener('pointerdown', (ev) => {
    if (!isMobile() || !current) return;
    dragging = true;
    startY = ev.clientY;
    dy = 0;
    handleEl.setPointerCapture(ev.pointerId);
    panelEl.style.transition = 'none';
  });
  handleEl.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    dy = Math.max(0, ev.clientY - startY);
    panelEl.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    panelEl.style.transition = '';
    panelEl.style.transform = '';
    if (dy > 90) closePanel();
    dy = 0;
  };
  handleEl.addEventListener('pointerup', end);
  handleEl.addEventListener('pointercancel', end);
}
