/* Central Intelligence — frontend entry.
   Fullscreen Cesium globe + minimal chrome. Backend contract:
   GET /api/snapshot, /api/events, /api/health, /api/stream (SSE). */
import './styles/tokens.css';
import './styles/base.css';
import './styles/boot.css';
import './styles/chrome.css';
import './styles/panels.css';
import './styles/cards.css';
import './styles/mobile.css';

import * as Cesium from 'cesium';
import { createViewer, getViewer } from './globe/viewer.js';
import {
  initMarkers, syncEvents, syncConnections, applyFilters,
  pickAt, pulseAt, highlightEvent, eventScreenPos,
} from './globe/markers.js';
import { flyToPoint, flyToRegion, flyChain } from './globe/camera.js';
import { fetchSnapshot } from './data/api.js';
import { connectStream } from './data/sse.js';
import { store, on, emit, REGIONS } from './data/store.js';
import { buildBootWord, runBoot } from './ui/boot.js';
import { initSensorLooks } from './globe/sensors/index.js';
import { initSatellites } from './globe/satellites/index.js';
import { initFlights } from './globe/flights/index.js';
import { initWeather } from './globe/weather/index.js';
import { initCyclones } from './globe/cyclones/index.js';
import { initLaunches } from './globe/launches/index.js';
import { initEarthquakes } from './globe/earthquakes/index.js';
import { initInstallations } from './globe/installations/index.js';
import { initSubmarineCables } from './globe/submarineCables/index.js';
import { initInfrastructure } from './globe/infrastructure/index.js';
import { initAwareness } from './globe/awareness/index.js';
import { readSceneFromHash, applyScene, initShareTracking } from './globe/share.js';
import { haltIdleSpin } from './globe/viewer.js';
import { initRail } from './ui/rail.js';
import { initPanels, openPanel, closePanel, isPanelOpen, syncRegionPill } from './ui/panels.js';
import { initStatus } from './ui/status.js';
import { initTicker } from './ui/ticker.js';
import { initCards, openEventCard, openFlightCard, openQuakeCard, openSatelliteCard, openVesselCard, closeEventCard, isCardOpen } from './ui/cards.js';
import { initSharpen } from './globe/sharpen.js';
import { bindShortcuts } from './ui/shortcuts.js';
import { installGenerationBumps } from './globe/cameraGen.js';
import { initFollowMode, followedId } from './globe/aircraft/followMode.js';
import { initVessels } from './globe/vessels/index.js';
import { createOrbitRings } from './globe/satellites/orbitRings.js';
import { flyToEvent } from './globe/eventFraming.js';

buildBootWord();

/* ————————— snapshot lifecycle ————————— */
let refreshing = false;

function applySnapshot(snap) {
  store.setSnapshot(snap);
  syncEvents(store.events);
  syncConnections(store.connections);
  hideError();
}

async function refreshSnapshot() {
  if (refreshing) return;
  refreshing = true;
  try {
    const snap = await fetchSnapshot();
    applySnapshot(snap);
  } catch (err) {
    console.warn('[snapshot] refresh failed:', err.message);
  } finally {
    refreshing = false;
  }
}

/* ————————— error state ————————— */
function showError(err) {
  const el = document.getElementById('error-state');
  const detail = document.getElementById('error-detail');
  if (detail) {
    detail.textContent =
      `Could not load the intelligence snapshot (${err && err.message ? err.message : 'network error'}). ` +
      'The globe will wait — retry when ready.';
  }
  if (el) el.classList.remove('hidden');
}

function hideError() {
  const el = document.getElementById('error-state');
  if (el) el.classList.add('hidden');
}

/* ————————— globe picking ————————— */
function initGlobeClick() {
  const viewer = getViewer();
  const canvas = viewer.scene.canvas;
  let downX = 0;
  let downY = 0;

  canvas.addEventListener('pointerdown', (ev) => {
    downX = ev.clientX;
    downY = ev.clientY;
  });
  canvas.addEventListener('pointerup', (ev) => {
    // Ignore drags — only true clicks select markers.
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6) return;
    let hit = null;
    try {
      hit = pickAt(ev.clientX, ev.clientY);
    } catch (err) {
      console.warn('[pick] failed:', err.message);
      return;
    }
    if (!hit) {
      closeEventCard();
      return;
    }
    if (hit.type === 'cluster') {
      zoomToCluster(hit);
    } else if (hit.type === 'event') {
      openEventCard(hit.eventId, ev.clientX, ev.clientY);
    } else if (hit.type === 'connection') {
      emit('focus-connection', { connectionId: hit.connectionId });
    } else if (hit.type === 'flight') {
      // UX-2: tapping the tracked entity itself must NOT untrack it.
      // followMode renders its own pickable billboard (id "flight-<hex>") for
      // the tracked plane — just re-open its card (data refresh) and return
      // early, without anything that stops follow. A different flight while
      // following keeps the normal behavior below.
      if (followedId() === 'flight-' + hit.hex) {
        import('./globe/flights/index.js').then(({ getAircraft }) => {
          const a = getAircraft(hit.hex);
          if (a) openFlightCard(a, ev.clientX, ev.clientY);
        });
        return;
      }
      // Dynamically import to avoid circular deps (flights imports viewer).
      import('./globe/flights/index.js').then(({ getAircraft }) => {
        const a = getAircraft(hit.hex);
        if (a) openFlightCard(a, ev.clientX, ev.clientY);
      });
    } else if (hit.type === 'vessel') {
      // UX-1: vessels are pickable — dynamically import to avoid circular deps.
      import('./globe/vessels/index.js').then(({ getVessel }) => {
        const v = getVessel(hit.mmsi);
        if (v) openVesselCard(v, ev.clientX, ev.clientY);
      });
    } else if (hit.type === 'quake') {
      import('./globe/earthquakes/index.js').then(({ getEarthquake }) => {
        const q = getEarthquake(hit.quakeId);
        if (q) openQuakeCard(q, ev.clientX, ev.clientY);
      });
    } else if (hit.type === 'satellite') {
      import('./globe/satellites/index.js').then(({ getSatellite }) => {
        const s = getSatellite(hit.satIdx);
        if (s) openSatelliteCard(s, ev.clientX, ev.clientY);
      });
    }
  });
}

function zoomToCluster(hit) {
  const viewer = getViewer();
  if (!viewer || !hit.position) return;
  const carto = Cesium.Cartographic.fromCartesian(hit.position);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const height = Math.max(viewer.camera.positionCartographic.height * 0.42, 1_200_000);
  flyToPoint(lon, lat, { height, duration: 1.1 }).catch(() => {});
}

/* ————————— cross-module focus actions ————————— */
function initFocusHandlers() {
  on('focus-event', async ({ eventId, openCard }) => {
    const e = store.eventById(eventId);
    if (!e) return;
    if (Number.isFinite(e.lat) && Number.isFinite(e.lon)) {
      try {
        // Angled cinematic framing (audit 1.4): -35° pitch shows the event
        // against the horizon instead of a flat top-down view.
        await flyToEvent(e.lon, e.lat, { duration: 1.2 });
      } catch { /* flight cancelled — still pulse */ }
      pulseAt(e.lon, e.lat, e.severity);
      if (openCard) {
        const p = eventScreenPos(eventId) || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        openEventCard(eventId, p.x, p.y);
      }
    } else if (openCard) {
      // Non-geographic: card only, centered.
      openEventCard(eventId, window.innerWidth / 2, window.innerHeight / 2);
    }
  });

  on('focus-connection', async ({ connectionId }) => {
    const c = store.connectionById(connectionId);
    if (!c) return;
    closeEventCard();
    openPanel('connections', { focusId: connectionId });
    try {
      await flyChain(c.chain || [], {
        onStep: (step) => { if (step.eventId) highlightEvent(step.eventId); },
      });
    } catch { /* cancelled */ }
  });
}

/* ————————— region pill ————————— */
function initRegionMenu() {
  const pill = document.getElementById('region-pill');
  const menu = document.getElementById('region-menu');
  if (!pill || !menu) return;

  menu.innerHTML = REGIONS.map((r) =>
    `<button class="region-item" data-region="${r.id}" role="option">${r.label}</button>`
  ).join('');

  pill.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.classList.toggle('hidden');
  });
  menu.addEventListener('click', (ev) => {
    const item = ev.target.closest('.region-item');
    if (!item) return;
    store.region = item.dataset.region;
    syncRegionPill();
    menu.classList.add('hidden');
    emit('region-changed', { region: store.region });
    emit('filters');
    applyFilters();
    flyToRegion(store.region).catch(() => {});
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!menu.classList.contains('hidden') && !ev.target.closest('#region-wrap')) {
      menu.classList.add('hidden');
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') menu.classList.add('hidden');
  });
  on('region-changed', syncRegionPill);
  syncRegionPill();
}

/* ————————— ESC → clean globe ————————— */
function initEsc() {
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (isCardOpen()) closeEventCard();
    else if (isPanelOpen()) closePanel();
  });
}

/* ————————— boot ————————— */
async function init() {
  createViewer(document.getElementById('globe-container'));
  installGenerationBumps(getViewer()); // camera generation stamping (audit 2.5)
  initSensorLooks(getViewer());
  initSharpen(getViewer()); // baseline unsharp-mask — restrained 0.28 default (audit 1.2)
  initSatellites(getViewer());
  initFlights(getViewer());
  initFollowMode(getViewer()); // aircraft track/follow (audit 1.8)
  initVessels(getViewer()); // AIS vessel layer — key entered in-app, browser-only (2026-09-29)
  initWeather(getViewer());
  initCyclones(getViewer());
  initLaunches(getViewer());
  initEarthquakes(getViewer());
  initInstallations(getViewer());
  initSubmarineCables(getViewer());
  initInfrastructure(getViewer());
  initAwareness(getViewer()); // subject-centered proximity awareness (GEV audit T1/L1)
  const sharedScene = readSceneFromHash();
  if (sharedScene) {
    applyScene(sharedScene); // shared link? restore that exact view, no drift
    haltIdleSpin();
  }
  initShareTracking();             // keep #hash in sync with the camera
  initMarkers();

  initRail();
  initPanels();
  initStatus();
  initTicker();
  initCards();
  initRegionMenu();
  initGlobeClick();
  initEsc();
  initFocusHandlers();
  // Keyboard shortcuts: h toggles HUD (audit 2.20).
  bindShortcuts({
    documentRef: document,
    actions: {
      toggleHudMeta: () => document.body.classList.toggle('hud-hidden'),
    },
  });

  document.getElementById('error-retry').addEventListener('click', async () => {
    hideError();
    await refreshSnapshot();
    if (!store.lastSnapshotAt) showError(new Error('still unreachable'));
  });

  try {
    const snap = await fetchSnapshot();
    applySnapshot(snap);
  } catch (err) {
    console.error('[boot] snapshot failed:', err.message);
    showError(err);
  }

  connectStream({
    onSnapshot: (snap) => applySnapshot(snap),
    onUpdate: () => refreshSnapshot(),
    onStatus: (connected, reconnecting, attempt) =>
      emit('stream-status', { connected, reconnecting, attempt }),
  });
}

const appReady = init().catch((err) => {
  console.error('[boot] init failed:', err);
  showError(err);
});

runBoot(appReady).then(() => {
  const globe = document.getElementById('globe-container');
  if (globe) globe.classList.add('ready');
});

// Read-only diagnostics handle (data already rendered in the DOM).
window.__ci = {
  store,
  version: '0.1.0',
};
