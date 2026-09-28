/* Live Source Dock — bottom-center chip strip showing every live source's
   heartbeat: status dot (live/stale/error/off), name, live count. Tap a chip
   to toggle its source; long-press (or hover on desktop) for a detail popup
   with source attribution, freshness, and status. Re-renders every 5 s so
   counts and freshness stay honest. */
import { emit } from '../data/store.js';
import { timeAgo } from '../data/format.js';
import {
  militaryEnabled, civilEnabled, flightCountBy, flightStatus,
  setMilitary, setCivil,
} from '../globe/flights/index.js';
import { satellitesEnabled, satelliteCount, satelliteStatus, setSatellites } from '../globe/satellites/index.js';
import { launchesEnabled, launchCount, launchStatus, setLaunches } from '../globe/launches/index.js';
import { firesEnabled, fireCount, fireStatus, setFires } from '../globe/fires/index.js';
import { earthquakesEnabled, earthquakeCount, earthquakeStatus, setEarthquakes } from '../globe/earthquakes/index.js';
import { weatherEnabled, weatherLayers, setWeather } from '../globe/weather/index.js';
import { cyclonesEnabled, cycloneCount, cycloneStatus, setCyclones } from '../globe/cyclones/index.js';

/* id, short label, full label, attribution, stale-after ms, accessors. */
const SOURCES = [
  {
    id: 'mil', label: 'MIL', name: 'Military flights', credit: 'adsb.lol · ODbL 1.0',
    staleAfter: 45_000,
    enabled: militaryEnabled, count: () => flightCountBy(true),
    status: () => flightStatus().military, toggle: () => setMilitary(!militaryEnabled()),
  },
  {
    id: 'civ', label: 'CIV', name: 'Civil flights', credit: 'adsb.lol · ODbL 1.0',
    staleAfter: 45_000,
    enabled: civilEnabled, count: () => flightCountBy(false),
    status: () => flightStatus().civil, toggle: () => setCivil(!civilEnabled()),
  },
  {
    id: 'sat', label: 'SAT', name: 'Satellites', credit: 'CelesTrak · SGP4',
    staleAfter: 3 * 3600_000,
    enabled: satellitesEnabled, count: satelliteCount,
    status: satelliteStatus, toggle: () => setSatellites(!satellitesEnabled()),
  },
  {
    id: 'lnch', label: 'LAUNCH', name: 'Launches', credit: 'The Space Devs',
    staleAfter: 3600_000,
    enabled: launchesEnabled, count: launchCount,
    status: launchStatus, toggle: () => setLaunches(!launchesEnabled()),
  },
  {
    id: 'fire', label: 'FIRE', name: 'Fire perimeters', credit: 'NIFC / WFIGS',
    staleAfter: 2 * 3600_000,
    enabled: firesEnabled, count: fireCount,
    status: fireStatus, toggle: () => setFires(!firesEnabled()),
  },
  {
    id: 'quake', label: 'QUAKE', name: 'Earthquakes', credit: 'USGS M4.5+ / 24h',
    staleAfter: 30 * 60_000,
    enabled: earthquakesEnabled, count: earthquakeCount,
    status: earthquakeStatus, toggle: () => setEarthquakes(!earthquakesEnabled()),
  },
  {
    id: 'cyc', label: 'CYCLONE', name: 'Cyclones', credit: 'NOAA NHC',
    staleAfter: 30 * 60_000,
    enabled: cyclonesEnabled, count: cycloneCount,
    status: cycloneStatus, toggle: () => setCyclones(!cyclonesEnabled()),
  },
];

let dockEl, chipsEl, popEl;
let renderTimer = 0;
let popFor = null;
let longPressTimer = 0;
let lastSig = '';

function dotState(src) {
  if (!src.enabled()) return 'off';
  const st = src.status ? src.status() : null;
  if (st) {
    if (st.lastErr) return 'error';
    if (st.lastOk && Date.now() - st.lastOk > src.staleAfter) return 'stale';
  }
  return 'live';
}

function fmtCount(n) {
  if (n == null || Number.isNaN(n)) return '';
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}

function statusLine(src) {
  const st = src.status ? src.status() : null;
  const state = dotState(src);
  if (state === 'off') return 'Off';
  if (state === 'error') return `Error — ${st.lastErr || 'fetch failed'}`;
  if (state === 'stale') return `Stale — updated ${timeAgo(st.lastOk)}`;
  if (st && st.lastOk) return `Live — updated ${timeAgo(st.lastOk)}`;
  return 'Live';
}

function render() {
  if (!chipsEl) return;
  // Only touch the DOM when something actually changed — blind re-renders
  // every 5 s would make chips unstable under the user's finger.
  const sig = SOURCES.map((s) => `${s.id}:${dotState(s)}:${s.enabled() ? s.count() : 'x'}`).join('|')
    + '|' + Object.keys(weatherLayers()).map((k) => `${k}:${weatherEnabled(k) ? 1 : 0}`).join('|');
  if (sig === lastSig) return;
  lastSig = sig;
  let html = '';
  for (const src of SOURCES) {
    const state = dotState(src);
    const n = src.enabled() ? src.count() : null;
    html += `<button class="dock-chip" data-src="${src.id}" data-state="${state}"
        aria-label="${src.name} — ${state}${n != null ? `, ${n}` : ''}"
        title="${src.name} — ${statusLine(src)} (tap to ${src.enabled() ? 'hide' : 'show'}, hold for details)">
      <span class="dock-dot ${state}"></span>
      <span class="dock-label">${src.label}</span>
      ${n != null ? `<span class="dock-count">${fmtCount(n)}</span>` : ''}
    </button>`;
  }
  // Weather layers (imagery — on/off only, no poll heartbeat).
  for (const [key, def] of Object.entries(weatherLayers())) {
    const on = weatherEnabled(key);
    html += `<button class="dock-chip" data-weather="${key}" data-state="${on ? 'live' : 'off'}"
        aria-label="${def.label} — ${on ? 'on' : 'off'}"
        title="${def.label} — ${on ? 'on' : 'off'} (tap to toggle)">
      <span class="dock-dot ${on ? 'live' : 'off'}"></span>
      <span class="dock-label">${def.label.toUpperCase().slice(0, 6)}</span>
    </button>`;
  }
  chipsEl.innerHTML = html;

  chipsEl.querySelectorAll('.dock-chip[data-src]').forEach((chip) => {
    const src = SOURCES.find((s) => s.id === chip.dataset.src);
    chip.addEventListener('click', async () => {
      if (popFor === src.id) { hidePop(); return; }
      hidePop();
      await src.toggle();
      lastSig = ''; // load may have failed and reverted state — force refresh
      render();
    });
    chip.addEventListener('pointerdown', () => {
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => showPop(src, chip), 550);
    });
    chip.addEventListener('pointerup', () => clearTimeout(longPressTimer));
    chip.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
  });
  chipsEl.querySelectorAll('.dock-chip[data-weather]').forEach((chip) => {
    chip.addEventListener('click', () => {
      setWeather(chip.dataset.weather, !weatherEnabled(chip.dataset.weather));
      render();
    });
  });
}

function showPop(src, anchor) {
  popFor = src.id;
  const n = src.enabled() ? src.count() : null;
  popEl.innerHTML = `
    <div class="dock-pop-title">${src.name}</div>
    <div class="dock-pop-row"><span>Source</span><span>${src.credit}</span></div>
    <div class="dock-pop-row"><span>Status</span><span class="dock-pop-${dotState(src)}">${statusLine(src)}</span></div>
    ${n != null ? `<div class="dock-pop-row"><span>Count</span><span>${n}</span></div>` : ''}`;
  popEl.classList.remove('hidden');
  // Anchor above the chip; clamp inside the viewport.
  const r = anchor.getBoundingClientRect();
  popEl.style.left = Math.max(8, Math.min(window.innerWidth - 230, r.left + r.width / 2 - 110)) + 'px';
  popEl.style.bottom = (window.innerHeight - r.top + 10) + 'px';
}

function hidePop() {
  popFor = null;
  if (popEl) popEl.classList.add('hidden');
}

export function initDock() {
  dockEl = document.getElementById('dock');
  chipsEl = document.getElementById('dock-chips');
  popEl = document.getElementById('dock-pop');
  if (!dockEl || !chipsEl) return;
  document.addEventListener('pointerdown', (e) => {
    if (popFor && popEl && !popEl.contains(e.target) && !e.target.closest('.dock-chip')) hidePop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePop(); });
  render();
  clearInterval(renderTimer);
  renderTimer = setInterval(render, 5000);
  // Re-render when layer toggles change state elsewhere (Layers panel).
  window.addEventListener('dock-refresh', render);
}
