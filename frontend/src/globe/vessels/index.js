/* AIS vessel layer — real ships via the server-side AISStream hub
   (Joshua 2026-09-30: AISStream keys must stay server-side, so the browser
   no longer opens the AISStream WebSocket itself). The backend holds the
   key (AISSTREAM_KEY env on the server, never in the repo or the browser)
   and fans vessel positions out over SSE at /api/vessels/stream. This
   module keeps the same rendering: one BillboardCollection, dead reckoning
   between fixes, horizon culling via EllipsoidalOccluder.

   DATA HONESTY: positions stream live from the server hub. Honest states:
   'no_key' (server has no key configured), 'connecting', 'auth_failed'
   (server's key rejected), 'down', 'ok'. The layer NEVER fabricates
   vessel positions.

   (Tap-to-info card is not wired yet — vessels render without cards.) */

import * as Cesium from 'cesium';
import { vesselIcon } from './vesselIcons.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { screenProjectedRotation, stabilizeScreenRotation } from '../aircraft/iconOrientation.js';

const KNOTS_TO_DEG_LAT_PER_S = 1 / 3600;
const HISTORY_MAX = 120; // ~1 h of fixes per vessel, for trail seeding
const STALE_MS = 10 * 60 * 1000; // drop vessels silent this long
const SWEEP_MS = 60 * 1000;
const MAX_VESSELS = 25000; // globe can't usefully show more; drop oldest first

let viewer = null;
let billboards = null;
let enabled = false;
let stream = null;
let sweepTimer = 0;
let preRenderRemove = null;
let occluder = null;
let lastCullAt = 0;

// Layer status for the dock / System Status:
// 'no_key' | 'connecting' | 'auth_failed' | 'down' | 'ok' | 'off'
const vesselStatus = { state: 'off', lastOk: 0, lastErr: '' };
/** Honest layer status: { state, lastOk, lastErr }. */
export function getVesselStatus() { return vesselStatus; }

// mmsi -> { billboard, lat, lon, sog, cog, heading, name, type, navStatus,
//            lastUpdate, history: [Cartesian3...] }
const vessels = new Map();

function toCartesian(lat, lon, result) {
  // NOTE: fromDegrees is (lon, lat, height, ellipsoid, result) — the 4th slot
  // is the ellipsoid, NOT the result (see flights/index.js). Pass undefined
  // for the default WGS84 ellipsoid.
  return Cesium.Cartesian3.fromDegrees(lon, lat, 0, undefined, result); // surface — ships float
}

function deadReckon(v, dt) {
  if (!Number.isFinite(v.cog) || !Number.isFinite(v.sog) || v.sog <= 0) return;
  const dDeg = v.sog * KNOTS_TO_DEG_LAT_PER_S * dt;
  const cr = (v.cog * Math.PI) / 180;
  v.lat += dDeg * Math.cos(cr);
  const cosLat = Math.cos((v.lat * Math.PI) / 180);
  v.lon += (dDeg * Math.sin(cr)) / Math.max(cosLat, 0.2);
}

function upsert(sv) {
  const mmsi = String(sv.mmsi || '').trim();
  if (!mmsi || !Number.isFinite(sv.lat) || !Number.isFinite(sv.lon)) return;
  let v = vessels.get(mmsi);
  if (!v) {
    if (vessels.size >= MAX_VESSELS) pruneOldest();
    const bb = billboards.add({
      id: `vessel-${mmsi}`,
      image: vesselIcon(sv.type, false),
      width: 32,
      height: 32,
      scaleByDistance: new Cesium.NearFarScalar(2e5, 1.1, 4e7, 0.3),
      // Depth-test relief only at close range: within 200 km the billboard
      // skips depth testing so vessels stay visible through terrain. Beyond
      // that the globe depth-occludes normally, so far-side vessels can
      // never draw through the planet (Joshua 2026-09-30).
      disableDepthTestDistance: 200000,
    });
    v = { billboard: bb, mmsi, history: [] };
    vessels.set(mmsi, v);
    v.lat = sv.lat;
    v.lon = sv.lon;
    v.dispLat = sv.lat;
    v.dispLon = sv.lon;
  } else {
    v.lat = sv.lat;
    v.lon = sv.lon;
    if (!Number.isFinite(v.dispLat)) { v.dispLat = sv.lat; v.dispLon = sv.lon; }
  }
  v.sog = Number(sv.sog);
  v.cog = Number(sv.cog);
  v.heading = Number.isFinite(sv.heading) ? sv.heading
    : Number.isFinite(sv.cog) ? sv.cog : NaN;
  v.name = String(sv.name || '').trim();
  v.type = sv.type;
  v.navStatus = sv.navStatus || '';
  v.lastUpdate = Date.now();
  v.billboard.position = toCartesian(v.lat, v.lon);
  // P1: rotation in SCREEN space (camera-basis projection) — raw heading is
  // mirrored and camera-blind. Chevron points north at rotation 0.
  if (Number.isFinite(v.heading)) {
    v.courseDeg = v.heading;
    const proj = screenProjectedRotation(viewer.scene, v.billboard.position,
      v.heading, Number.isFinite(v.rotation) ? v.rotation : null);
    if (proj !== null) {
      v.billboard.rotation = proj;
      v.rotation = proj;
    }
  }
  // Ring buffer for trail seeding.
  v.history.push(toCartesian(v.lat, v.lon));
  if (v.history.length > HISTORY_MAX) v.history.shift();
  // Horizon culling is O(vessels); throttle it on a hot stream.
  const now = Date.now();
  if (now - lastCullAt > 5000) { lastCullAt = now; cullHorizon(); }
}

// Drop the oldest silent vessels until we're back under the cap.
function pruneOldest() {
  const sorted = [...vessels.entries()].sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);
  for (const [mmsi, v] of sorted) {
    if (vessels.size <= MAX_VESSELS * 0.8) break;
    billboards.remove(v.billboard);
    vessels.delete(mmsi);
  }
}

// Periodic sweep: drop vessels silent longer than STALE_MS.
function sweepStale() {
  const now = Date.now();
  for (const [mmsi, v] of vessels) {
    if (now - v.lastUpdate > STALE_MS) {
      billboards.remove(v.billboard);
      vessels.delete(mmsi);
    }
  }
  cullHorizon();
}

function cullHorizon() {
  if (!occluder) return;
  occluder.cameraPosition = viewer.scene.camera.positionWC;
  for (const v of vessels.values()) {
    const p = toCartesian(v.lat, v.lon);
    v.billboard.show = enabled && occluder.isPointVisible(p);
  }
}

function ensureBillboards() {
  if (billboards) return;
  const scene = viewer.scene;
  billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    viewer.scene.camera.positionWC,
  );
}

// Resolves on the first terminal hub state: 'ok' | 'auth_failed' | 'down' |
// 'no_key'. Also notifies the Layers panel once via 'layer-ready' (later
// status changes update the dock quietly without touching the toggle).
function connectStream() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.dispatchEvent(
        new CustomEvent('layer-ready', { detail: { layer: 'ships', state } })
      );
      resolve(state);
    };
    const timer = setTimeout(() => finish('down'), 15000);
    const applyStatus = (s) => {
      if (!s || typeof s !== 'object') return;
      const st = s.state;
      if (st === 'ok') {
        vesselStatus.state = 'ok';
        vesselStatus.lastOk = Date.now();
        vesselStatus.lastErr = '';
        finish('ok');
      } else if (st === 'auth_failed') {
        vesselStatus.state = 'auth_failed';
        vesselStatus.lastErr = s.lastErr || 'key rejected';
        finish('auth_failed');
      } else if (st === 'no_key') {
        vesselStatus.state = 'no_key';
        vesselStatus.lastErr = 'no AISStream key on server';
        finish('no_key');
      } else if (st === 'connecting' || st === 'down') {
        vesselStatus.state = st;
        vesselStatus.lastErr = s.lastErr || '';
        if (st === 'down') finish('down');
      }
    };
    let es;
    try {
      es = new EventSource('/api/vessels/stream');
    } catch (err) {
      vesselStatus.state = 'down';
      vesselStatus.lastErr = String((err && err.message) || err);
      finish('down');
      return;
    }
    stream = es;
    es.addEventListener('status', (ev) => {
      try { applyStatus(JSON.parse(ev.data)); } catch { /* malformed: ignore */ }
    });
    es.addEventListener('vessels', (ev) => {
      let batch;
      try { batch = JSON.parse(ev.data); } catch { return; }
      if (Array.isArray(batch)) for (const sv of batch) upsert(sv);
    });
    es.onerror = () => {
      // EventSource retries on its own; only the FIRST terminal state
      // resolves the toggle promise — later drops just mark us down.
      if (!done) {
        vesselStatus.state = 'down';
        vesselStatus.lastErr = 'stream unreachable';
      }
    };
  });
}

function startLoop() {
  if (preRenderRemove || !enabled) return;
  ensureBillboards();
  holdContinuousRender('vessels'); // keep animating while camera is parked
  let last = performance.now();
  preRenderRemove = viewer.scene.preRender.addEventListener(() => {
    // Never let per-frame work kill the render loop (see flights/index.js).
    try {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1);
      last = now;
      const t = 1 - Math.pow(0.001, dt / 1.5);
      for (const v of vessels.values()) {
        deadReckon(v, dt);
        if (!v.billboard.show) continue; // not drawn — skip the trig
        if (Number.isFinite(v.dispLat)) {
          v.dispLat += (v.lat - v.dispLat) * t;
          v.dispLon += (v.lon - v.dispLon) * t;
        } else {
          v.dispLat = v.lat; v.dispLon = v.lon;
        }
        v.billboard.position = toCartesian(v.dispLat, v.dispLon,
          (v._pos ||= new Cesium.Cartesian3())); // scratch: no per-frame alloc
      }
      // P1: screen-space icon orientation pass — recompute when the camera
      // pose changed or 1 s elapsed; 0.5° deadband, write only on change.
      const sig = cameraPoseSignature();
      if (sig !== lastCamSig || now - lastRotPass > 1000) {
        lastCamSig = sig;
        lastRotPass = now;
        const scene = viewer.scene;
        for (const v of vessels.values()) {
          if (!v.billboard.show) continue;
          const prev = Number.isFinite(v.rotation) ? v.rotation : null;
          const next = screenProjectedRotation(scene, v.billboard.position,
            Number.isFinite(v.courseDeg) ? v.courseDeg : 0, prev);
          const stable = stabilizeScreenRotation(prev, next);
          if (stable !== null && stable !== v.rotation) {
            v.billboard.rotation = stable;
            v.rotation = stable;
          }
        }
      }
    } catch (err) {
      console.error('[vessels] interpolator error (render loop protected):', err);
    }
  });
  sweepTimer = setInterval(sweepStale, SWEEP_MS);
}

// Camera-pose signature for the P1 orientation pass (see flights/index.js).
let lastCamSig = '';
let lastRotPass = 0;
function cameraPoseSignature() {
  const c = viewer.scene.camera;
  const p = c.positionWC;
  return p.x.toFixed(0) + ',' + p.y.toFixed(0) + ',' + p.z.toFixed(0) + ',' +
    c.heading.toFixed(3) + ',' + c.pitch.toFixed(3) + ',' + c.roll.toFixed(3);
}

function stopLoop() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = 0;
  if (stream) { try { stream.close(); } catch { /* noop */ } stream = null; }
  if (preRenderRemove) {
    preRenderRemove();
    preRenderRemove = null;
  }
  releaseContinuousRender('vessels');
  vesselStatus.state = 'off';
}

export function vesselsEnabled() { return enabled; }
/** Vessel count for the dock. */
export function vesselCount() { return vessels.size; }


export async function setVessels(on) {
  enabled = on;
  if (!viewer) return enabled;
  if (enabled) {
    startLoop();
    // Connect in the background (Joshua 2026-09-30): the toggle resolves
    // instantly; the hub's terminal state (ok / auth_failed / down /
    // no_key) arrives via 'layer-ready' instead of blocking here.
    // The key lives on the server — the browser never sees it.
    vesselStatus.state = 'connecting';
    vesselStatus.lastErr = '';
    connectStream();
  } else {
    stopLoop();
  }
  return enabled;
}

export function initVessels(v) {
  viewer = v;
}
