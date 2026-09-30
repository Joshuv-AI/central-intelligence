/* Docked panel: one at a time, ~340px left overlay / bottom sheet on mobile.
   Panels: layers, connections, feed, regions, guide, system (status pill detail).
   Cross-module navigation goes through the emit bus — no import cycles. */
import {
  store, on, emit,
  REGIONS, regionMatches,
} from '../data/store.js';
import { applyFilters } from '../globe/markers.js';
import { flyToRegion } from '../globe/camera.js';
import { esc, timeAgo, fmtDateTime } from '../data/format.js';
import { fetchHealth } from '../data/api.js';
import { satellitesEnabled, satelliteCount, setSatellites } from '../globe/satellites/index.js';
import { militaryEnabled, civilEnabled, setMilitary, setCivil } from '../globe/flights/index.js';
import { weatherLayers, weatherEnabled, setWeather } from '../globe/weather/index.js';
import { cyclonesEnabled, cycloneCount, setCyclones } from '../globe/cyclones/index.js';
import { launchesEnabled, launchCount, setLaunches } from '../globe/launches/index.js';
import { earthquakesEnabled, earthquakeCount, setEarthquakes } from '../globe/earthquakes/index.js';
import { vesselsEnabled, vesselCount, setVessels, getVesselStatus } from '../globe/vessels/index.js';
import { installationsEnabled, setInstallations } from '../globe/installations/index.js';
import { submarineCablesEnabled, setSubmarineCables } from '../globe/submarineCables/index.js';
import { infrastructureEnabled, setInfrastructure } from '../globe/infrastructure/index.js';
import { copySceneLink, scheduleHashWrite } from '../globe/share.js';

let panelEl, bodyEl, titleEl, kickerEl, closeBtn, handleEl;
let current = null;
let closeTimer = 0;
// Async-toggle guards: survive panel re-renders (renderLayers re-runs on every
// store 'data' event, so DOM classes alone can't track an in-flight poll).
let vesBusy = false;
let cycBusy = false;
// Background layer loads (Joshua 2026-09-30): toggles resolve instantly and
// each layer module dispatches 'layer-ready' when its first fetch lands (or
// fails). Bound once; renderLayers re-runs on every store 'data' event.
let layerReadyBound = false;
let shipsNoteTimer = 0;

/** Show a transient note under the Ships row (module-level: the global
    layer-ready listener needs it too). */
function showShipsNote(msg, ms = 8000) {
  if (!bodyEl) return;
  const n = bodyEl.querySelector('.vessel-note');
  if (!n) return;
  n.textContent = msg;
  n.classList.remove('hidden');
  clearTimeout(shipsNoteTimer);
  shipsNoteTimer = setTimeout(() => {
    const n2 = bodyEl && bodyEl.querySelector('.vessel-note');
    if (n2) n2.classList.add('hidden');
  }, ms);
}

/** Terminal AIS stream states from the background connect (vessels). */
function onShipsReady(state) {
  if (!bodyEl) return;
  const row = bodyEl.querySelector('[data-vessels="ships"]');
  if (state === 'down') {
    // Connection dead — don't leave the toggle on with nothing to show.
    if (vesselsEnabled()) setVessels(false);
    if (row) { row.classList.toggle('off', true); row.classList.remove('busy'); }
    showShipsNote('Ship feed is unavailable right now — try again later.');
  } else if (state === 'no_key') {
    if (row) row.classList.remove('busy');
    emit('data'); // re-render — row shows "no key on server"
    showShipsNote('No AISStream key on the server yet — ships stay off until one is set.');
  } else if (state === 'auth_failed') {
    if (row) row.classList.remove('busy');
    emit('data'); // re-render — row shows the rejected state
    showShipsNote('The server\u2019s AISStream key was rejected — it needs replacing on the server.');
  } else if (state === 'ok') {
    if (row) {
      row.classList.toggle('off', !vesselsEnabled());
      row.classList.remove('busy');
    }
    emit('data'); // re-render — count label flips from '…' to the live count
  }
}

const LAYER_READY_ROWS = {
  quakes:   { row: '[data-quakes="usgs"]',       count: '[data-quake-count]',   getCount: earthquakeCount, enabled: earthquakesEnabled },
  launches: { row: '[data-launches="upcoming"]', count: '[data-launch-count]',  getCount: launchCount,     enabled: launchesEnabled },
  cyclones: { row: '[data-cyclones="storms"]',   count: '[data-cyclone-count]', getCount: cycloneCount,    enabled: cyclonesEnabled },
  satellites: { row: '[data-orbit="satellites"]', count: '[data-sat-count]',   getCount: satelliteCount,  enabled: satellitesEnabled },
};

function bindLayerReadyOnce() {
  if (layerReadyBound) return;
  layerReadyBound = true;
  window.addEventListener('layer-ready', (ev) => {
    const detail = (ev && ev.detail) || {};
    const { layer, failed, state } = detail;
    if (!layer || !bodyEl) return;
    if (layer === 'ships') { onShipsReady(state); return; }
    const cfg = LAYER_READY_ROWS[layer];
    if (!cfg) return;
    const row = bodyEl.querySelector(cfg.row);
    if (row) {
      // Success: confirm the row; failure: the module already flipped itself
      // off — revert the optimistic toggle.
      row.classList.toggle('off', !cfg.enabled());
      row.classList.remove('busy');
      const countEl = row.querySelector(cfg.count);
      if (countEl) countEl.textContent = cfg.getCount() || '';
    }
  });
}

const META = {
  layers: { kicker: 'SIGNAL LAYERS', title: 'Layers' },
  connections: { kicker: 'FUSED INTELLIGENCE', title: 'Connections' },
  feed: { kicker: 'REALTIME', title: 'Feed' },
  regions: { kicker: 'AREA FOCUS', title: 'Regions' },
  guide: { kicker: 'FIELD MANUAL', title: 'Guide' },
  system: { kicker: 'SYSTEM', title: 'System status' },
};

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
  const nonGeo = store.events.filter((e) => !store.isGeo(e)).length;
  let html = '';
  // Live orbit layer (CelesTrak TLEs, client-side SGP4) — independent of domains.
  const satsOn = satellitesEnabled();
  html += `<div class="layer-family"><span class="micro">ORBIT</span>
    <div class="layer-row ${satsOn ? '' : 'off'}" data-orbit="satellites">
      <span class="layer-swatch" style="background:#a0dcff"></span>
      <span class="layer-name">Satellites</span>
      <span class="layer-count" data-sat-count>${satelliteCount() || ''}</span>
      <span class="layer-toggle"></span>
    </div>
    <span class="micro">TLE data: CelesTrak</span>`;
  const launchesOn = launchesEnabled();
  html += `
    <div class="layer-row ${launchesOn ? '' : 'off'}" data-launches="upcoming">
      <span class="layer-swatch" style="background:#b48cff"></span>
      <span class="layer-name">Launches</span>
      <span class="layer-count" data-launch-count>${launchCount() || ''}</span>
      <span class="layer-toggle"></span>
    </div>
    <span class="micro">Launches: The Space Devs</span></div>`;
  // Live fire perimeters removed — earthquakes only.
  const quakesOn = earthquakesEnabled();
  html += `<div class="layer-family"><span class="micro">QUAKES</span>
    <div class="layer-row ${quakesOn ? '' : 'off'}" data-quakes="usgs">
      <span class="layer-swatch" style="background:#ff2d78"></span>
      <span class="layer-name">Earthquakes</span>
      <span class="layer-count" data-quake-count>${earthquakeCount() || ''}</span>
      <span class="layer-toggle"></span>
    </div>
    <span class="micro">Quakes: USGS M4.5+ / 24h</span></div>`;
  // Live flights (adsb.lol via /proxy, ODbL) — independent of domains.
  const milOn = militaryEnabled();
  const civOn = civilEnabled();
  html += `<div class="layer-family"><span class="micro">FLIGHTS</span>
    <div class="layer-row ${milOn ? '' : 'off'}" data-flights="military">
      <span class="layer-swatch" style="background:#ffb347"></span>
      <span class="layer-name">Military (zoom in to view)</span>
      <span class="layer-toggle"></span>
    </div>
    <div class="layer-row ${civOn ? '' : 'off'}" data-flights="civil">
      <span class="layer-swatch" style="background:#7fd4ff"></span>
      <span class="layer-name">Civil (zoom in to view)</span>
      <span class="layer-toggle"></span>
    </div>
    <span class="micro">ADS-B: adsb.lol</span></div>`;
  // Vessels (server-side AISStream hub — the key lives on the server, never in the browser).
  const vesOn = vesselsEnabled();
  const vesStatus = getVesselStatus() || {};
  const vesState = vesStatus.state || 'off';
  const vesCount = vesselCount();
  const vesCountLabel = vesState === 'no_key' ? 'no key'
    : vesState === 'auth_failed' ? 'bad key'
    : vesState === 'connecting' ? '…'
    : vesState === 'down' ? 'unavailable'
    : (vesCount || '');
  const vesSubLabel = vesState === 'no_key' ? 'server key not set'
    : vesState === 'auth_failed' ? 'server key rejected'
    : vesState === 'connecting' ? 'connecting…'
    : vesState === 'down' ? (vesStatus.lastErr || 'feed unavailable')
    : vesState === 'off' ? 'off'
    : 'live';
  html += `<div class="layer-family"><span class="micro">VESSELS</span>
    <div class="layer-row ${vesOn ? '' : 'off'}" data-vessels="ships">
      <span class="layer-swatch" style="background:#4ade80"></span>
      <span class="layer-name">Ships</span>
      <span class="layer-count">${vesCountLabel}</span>
      <span class="layer-toggle"></span>
    </div>
    <span class="micro">AIS: ${vesSubLabel}</span>
    <div class="layer-note vessel-note hidden"></div></div>`;
  // Weather imagery (NOAA nowCOAST WMS, keyless) — independent of domains.
  html += `<div class="layer-family"><span class="micro">WEATHER</span>`;
  for (const [key, def] of Object.entries(weatherLayers())) {
    const on = weatherEnabled(key);
    html += `
    <div class="layer-row ${on ? '' : 'off'}" data-weather="${key}">
      <span class="layer-swatch" style="background:${def.swatch}"></span>
      <span class="layer-name">${def.label}</span>
      <span class="layer-toggle"></span>
    </div>`;
  }
  html += `<span class="micro">Imagery: NOAA nowCOAST</span>`;
  const cycOn = cyclonesEnabled();
  html += `
    <div class="layer-row ${cycOn ? '' : 'off'}" data-cyclones="storms">
      <span class="layer-swatch" style="background:#ff2d2d"></span>
      <span class="layer-name">Cyclones</span>
      <span class="layer-count" data-cyclone-count>${cycloneCount() || ''}</span>
      <span class="layer-toggle"></span>
    </div>
    <span class="micro">Storms: NOAA NHC</span></div>`;
  // Intel layers (audit T2/T3/T4): tile-sourced military land, bundled
  // TeleGeography cable routes, bundled OSM infrastructure points.
  const instOn = installationsEnabled();
  const cabOn = submarineCablesEnabled();
  const infOn = infrastructureEnabled();
  html += `<div class="layer-family"><span class="micro">INTEL LAYERS</span>
    <div class="layer-row ${instOn ? '' : 'off'}" data-intel="installations">
      <span class="layer-swatch" style="background:#9ca6b0"></span>
      <span class="layer-name">Military installations</span>
      <span class="layer-toggle"></span>
    </div>
    <span class="micro">© OpenMapTiles © OpenStreetMap contributors</span>
    <div class="layer-row ${cabOn ? '' : 'off'}" data-intel="cables">
      <span class="layer-swatch" style="background:#2dd4bf"></span>
      <span class="layer-name">Submarine cables</span>
      <span class="layer-toggle"></span>
    </div>
    <span class="micro">© TeleGeography — submarinecablemap.com</span>
    <div class="layer-row ${infOn ? '' : 'off'}" data-intel="infrastructure">
      <span class="layer-swatch" style="background:#22d3ee"></span>
      <span class="layer-name">Datacenters</span>
      <span class="layer-toggle"></span>
    </div>
    <span class="micro">© OpenStreetMap contributors (ODbL)</span></div>`;
  if (nonGeo > 0) {
    html += `<div class="layer-note">${nonGeo} event${nonGeo === 1 ? '' : 's'} without coordinates live${nonGeo === 1 ? 's' : ''} in the feed and layer counts, not on the globe.</div>`;
  }
  el.innerHTML = html;

  const orbitRow = el.querySelector('[data-orbit="satellites"]');
  if (orbitRow) {
    orbitRow.addEventListener('click', () => {
      // Optimistic UI: toggle immediately, sync in background.
      const targetOn = !satellitesEnabled();
      orbitRow.classList.toggle('off', !targetOn);
      orbitRow.classList.add('busy');
      setSatellites(targetOn).then((on) => {
        orbitRow.classList.toggle('off', !on);
        const countEl = orbitRow.querySelector('[data-sat-count]');
        if (countEl) countEl.textContent = satelliteCount() || '';
      }).catch(() => {
        orbitRow.classList.toggle('off', targetOn); // revert on failure
      }).finally(() => {
        orbitRow.classList.remove('busy');
      });
    });
  }
  const quakeRow = el.querySelector('[data-quakes="usgs"]');
  if (quakeRow) {
    quakeRow.addEventListener('click', () => {
      const targetOn = !earthquakesEnabled();
      quakeRow.classList.toggle('off', !targetOn);
      quakeRow.classList.add('busy');
      setEarthquakes(targetOn).then((on) => {
        quakeRow.classList.toggle('off', !on);
        const countEl = quakeRow.querySelector('[data-quake-count]');
        if (countEl) countEl.textContent = earthquakeCount() || '';
      }).catch(() => {
        quakeRow.classList.toggle('off', targetOn);
      }).finally(() => {
        quakeRow.classList.remove('busy');
      });
    });
  }
  const milRow = el.querySelector('[data-flights="military"]');
  if (milRow) {
    milRow.addEventListener('click', () => {
      const targetOn = !militaryEnabled();
      milRow.classList.toggle('off', !targetOn);
      milRow.classList.add('busy');
      setMilitary(targetOn).then((on) => {
        milRow.classList.toggle('off', !on);
      }).catch(() => {
        milRow.classList.toggle('off', targetOn);
      }).finally(() => {
        milRow.classList.remove('busy');
      });
    });
  }
  const civRow = el.querySelector('[data-flights="civil"]');
  if (civRow) {
    civRow.addEventListener('click', () => {
      const targetOn = !civilEnabled();
      civRow.classList.toggle('off', !targetOn);
      civRow.classList.add('busy');
      setCivil(targetOn).then((on) => {
        civRow.classList.toggle('off', !on);
      }).catch(() => {
        civRow.classList.toggle('off', targetOn);
      }).finally(() => {
        civRow.classList.remove('busy');
      });
    });
  }
  // Vessels toggle — honest states. When the key is missing or rejected the
  // toggle stays ON and the key form appears below; only a dead connection
  // flips it back off. (Silently reverting reads as "the toggle is broken".)
  // NOTE: store 'data' events re-render this panel (innerHTML), so the row
  // captured below can be detached mid-poll — always re-query the live row.
  const vesRowSel = '[data-vessels="ships"]';
  const liveVesRow = () => el.querySelector(vesRowSel);
  const liveVesNote = () => el.querySelector('.vessel-note');
  const vesRow = liveVesRow();
  if (vesRow) {
    vesRow.addEventListener('click', () => {
      const row = liveVesRow();
      if (!row || vesBusy) return; // poll in flight — ignore
      vesBusy = true;
      const targetOn = !vesselsEnabled();
      const note = liveVesNote();
      if (note) note.classList.add('hidden');
      row.classList.toggle('off', !targetOn);
      row.classList.add('busy');
      setVessels(targetOn).then((on) => {
        // setVessels resolves instantly now (Joshua 2026-09-30) — the hub
        // connects in the background and 'layer-ready' carries the terminal
        // state (ok / auth_failed / down / no_key) to onShipsReady.
        const r2 = liveVesRow();
        if (r2) r2.classList.toggle('off', !on);
        emit('data'); // re-render layers now — count label shows connecting/live
      }).catch(() => {
        const r3 = liveVesRow();
        if (r3) r3.classList.toggle('off', targetOn);
      }).finally(() => {
        const r4 = liveVesRow();
        if (r4) r4.classList.remove('busy');
        vesBusy = false;
      });
    });
  }
  el.querySelectorAll('[data-weather]').forEach((row) => {
    row.addEventListener('click', () => {
      const key = row.dataset.weather;
      const on = setWeather(key, !weatherEnabled(key));
      row.classList.toggle('off', !on);
    });
  });
  // Intel layers (audit T2/T3/T4) — simple sync toggles, like weather rows.
  el.querySelectorAll('[data-intel]').forEach((row) => {
    row.addEventListener('click', () => {
      const key = row.dataset.intel;
      let on;
      if (key === 'installations') on = setInstallations(!installationsEnabled());
      else if (key === 'cables') on = setSubmarineCables(!submarineCablesEnabled());
      else on = setInfrastructure(!infrastructureEnabled());
      row.classList.toggle('off', !on);
    });
  });
  const cycRowSel = '[data-cyclones="storms"]';
  const liveCycRow = () => el.querySelector(cycRowSel);
  const cycRow = liveCycRow();
  if (cycRow) {
    cycRow.addEventListener('click', () => {
      const row = liveCycRow();
      if (!row || cycBusy) return;
      cycBusy = true;
      const targetOn = !cyclonesEnabled();
      row.classList.toggle('off', !targetOn);
      row.classList.add('busy');
      setCyclones(targetOn).then((on) => {
        const r2 = liveCycRow();
        if (r2) {
          r2.classList.toggle('off', !on);
          const countEl = r2.querySelector('[data-cyclone-count]');
          if (countEl) countEl.textContent = cycloneCount() || '';
        }
      }).catch(() => {
        const r3 = liveCycRow();
        if (r3) r3.classList.toggle('off', targetOn);
      }).finally(() => {
        const r4 = liveCycRow();
        if (r4) r4.classList.remove('busy');
        cycBusy = false;
      });
    });
  }
  const launchRow = el.querySelector('[data-launches="upcoming"]');
  if (launchRow) {
    launchRow.addEventListener('click', () => {
      const targetOn = !launchesEnabled();
      launchRow.classList.toggle('off', !targetOn);
      launchRow.classList.add('busy');
      setLaunches(targetOn).then((on) => {
        launchRow.classList.toggle('off', !on);
        const countEl = launchRow.querySelector('[data-launch-count]');
        if (countEl) countEl.textContent = launchCount() || '';
      }).catch(() => {
        launchRow.classList.toggle('off', targetOn);
      }).finally(() => {
        launchRow.classList.remove('busy');
      });
    });
  }
  // Background layer loads notify via 'layer-ready' (bound once globally).
  bindLayerReadyOnce();
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
// Feed v2: stories, not raw rows. Connections sharing a cause collapse into
// one story card with a plain-language "why it matters" line, so a glance
// gives the picture instead of a scroll through near-duplicates.
function feedKindLabel(f) {
  if (f.kind === 'connection') return f.count > 1 ? 'STORY' : 'LINK';
  return KIND_LABELS[f.kind] || String(f.kind || '').toUpperCase();
}

function renderFeedBrief(el) {
  const status = store.meta && store.meta.status;
  if (!status) return '';
  const dir = status.direction || 'MIXED';
  const dirClass = dir === 'RISK-ON' ? 'sev-critical' : dir === 'RISK-OFF' ? 'sev-low' : 'sev-moderate';
  const hot = status.hot24 || 0;
  const crit = status.critical24 || 0;
  return `<div class="feed-brief ${dirClass}">
    <span class="feed-brief-dir">${esc(dir)}</span>
    <span class="feed-brief-stats">${hot} hot / 24h · ${crit} critical</span>
  </div>`;
}

function renderFeed(el) {
  const feed = store.feed || [];
  if (feed.length === 0) {
    el.innerHTML = `<div class="panel-empty"><span class="micro">QUIET</span>No feed items yet. New stories, escalations and anomalies stream in here after each sweep.</div>`;
    return;
  }
  el.innerHTML =
    renderFeedBrief(el) +
    feed
      .map((f) => {
        const headline = f.headline || f.text || '';
        const sub = f.sub || '';
        const countBadge =
          f.count > 1 ? `<span class="feed-count">+${f.count - 1} more</span>` : '';
        return `
      <button class="feed-item sev-${f.severity || 'low'}" data-feed-id="${esc(f.id)}">
        <span class="feed-dot"></span>
        <span class="feed-body">
          <span class="feed-top">
            <span class="feed-kind">${esc(feedKindLabel(f))}</span>
            ${countBadge}
            <span class="feed-time">${timeAgo(f.time)} AGO</span>
          </span>
          <span class="feed-headline">${esc(headline)}</span>
          ${sub ? `<span class="feed-sub">${esc(sub)}</span>` : ''}
        </span>
      </button>`;
      })
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
  const geo = store.geoEvents();
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
      <p>Events without coordinates never reach the globe — they live in the feed.</p>
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
    <div style="margin:14px 0 6px"><span class="micro">SHARE</span></div>
    <button class="sys-share-btn" data-action="copy-link">COPY LINK TO THIS VIEW</button>
    <div class="layer-note share-note hidden">Link copied — it reopens this exact view.</div>
    <div style="margin:14px 0 6px"><span class="micro">SOURCES · ${sorted.length}</span></div>
    ${srcRows || '<div class="panel-empty">No source data yet.</div>'}
    ${health && health.deploySha ? `<div class="micro" style="margin-top:10px">BUILD ${esc(String(health.deploySha).slice(0, 8))} — this is the exact deploy running right now</div>` : ''}
    <div class="layer-note">Last sweep ${sweepAt ? fmtDateTime(sweepAt) : '—'} · Brain ${meta.lastBrain ? fmtDateTime(meta.lastBrain) : '—'}</div>`;

  // Refresh from /api/health in the background for live source states.
  if (!health) {
    fetchHealth()
      .then((h) => { if (current === 'system') renderSystem(el, { health: h }); })
      .catch(() => {});
  }

  const shareBtn = el.querySelector('[data-action="copy-link"]');
  if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
      const ok = await copySceneLink();
      const note = el.querySelector('.share-note');
      if (note) {
        note.textContent = ok
          ? 'Link copied — it reopens this exact view.'
          : 'Could not copy — copy the URL from the address bar.';
        note.classList.remove('hidden');
      }
    });
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
