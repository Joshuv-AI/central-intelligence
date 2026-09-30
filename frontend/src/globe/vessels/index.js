/* AIS vessel layer — real ships via AISStream (Joshua's direction 2026-09-30).
   Structure mirrors frontend/src/globe/flights/index.js: one
   BillboardCollection, dead reckoning between fixes, horizon culling via
   EllipsoidalOccluder.

   DATA HONESTY: positions stream live from AISStream over a WebSocket opened
   directly from this browser (see ./aisStream.js). The API key lives ONLY in
   this browser's localStorage — never in the repo, never on our backend.
   Honest states: 'needs_key' (no key saved yet), 'connecting',
   'auth_failed' (key rejected), 'down', 'ok'. The layer NEVER fabricates
   vessel positions.

   Selection: tap a chevron → getVessel(mmsi) → card via ui/cards.js.
   Trails: vesselTrails reuses the shared createTrailManager; seed from
   the per-vessel position history ring buffer kept here. */

import * as Cesium from 'cesium';
import { vesselIcon } from './vesselIcons.js';
import { createAisStream, getAisKey, setAisKey, hasAisKey } from './aisStream.js';
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
// 'needs_key' | 'connecting' | 'auth_failed' | 'down' | 'ok' | 'off'
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

// Resolves on the first terminal stream state: 'ok' | 'auth_failed' | 'down'.
function connectStream() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(state);
    };
    const timer = setTimeout(() => finish('down'), 12000);
    stream = createAisStream({
      onVessel: (sv) => upsert(sv),
      onState: (state, detail) => {
        if (state === 'connecting') {
          vesselStatus.state = 'connecting';
          vesselStatus.lastErr = '';
        } else if (state === 'ok') {
          vesselStatus.state = 'ok';
          vesselStatus.lastOk = Date.now();
          vesselStatus.lastErr = '';
          finish('ok');
        } else if (state === 'auth_failed') {
          vesselStatus.state = 'auth_failed';
          vesselStatus.lastErr = detail || 'key rejected';
          finish('auth_failed');
        } else { // 'down'
          vesselStatus.state = 'down';
          vesselStatus.lastErr = detail || 'connection lost';
          finish('down');
        }
      },
    });
    stream.connect();
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
  if (stream) { stream.disconnect(); stream = null; }
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
/** Get vessel record by MMSI (for tap-to-info). */
export function getVessel(mmsi) { return vessels.get(String(mmsi)) || null; }
/** Position history (oldest→newest Cartesian3) for trail seeding. */
export function getVesselHistory(mmsi) {
  const v = vessels.get(String(mmsi));
  return v ? v.history.slice() : [];
}

export async function setVessels(on) {
  enabled = on;
  if (!viewer) return enabled;
  if (enabled) {
    startLoop();
    if (!hasAisKey()) {
      // Waiting on Joshua's key — stay "on" so the layers panel can show
      // the key form instead of silently flipping the toggle back off.
      vesselStatus.state = 'needs_key';
      vesselStatus.lastErr = 'AISStream key not saved yet';
      return enabled;
    }
    // Await the first terminal state so callers see reality
    // (ok / auth_failed / down) instead of racing the socket.
    await connectStream();
  } else {
    stopLoop();
  }
  return enabled;
}

/** Save the AISStream key (localStorage, this browser only) and connect
    if the layer is on. Returns the resulting status state. */
export async function saveAisKeyAndConnect(key) {
  setAisKey(key);
  if (!enabled || !viewer) {
    vesselStatus.state = hasAisKey() ? vesselStatus.state : 'needs_key';
    return vesselStatus.state;
  }
  if (stream) { stream.disconnect(); stream = null; }
  await connectStream();
  return vesselStatus.state;
}

/** Forget the saved key and drop the connection. */
export function clearAisKey() {
  setAisKey('');
  if (stream) { stream.disconnect(); stream = null; }
  if (enabled) {
    vesselStatus.state = 'needs_key';
    vesselStatus.lastErr = 'AISStream key removed';
  }
  return vesselStatus.state;
}

export { getAisKey, hasAisKey };

export function initVessels(v) {
  viewer = v;
}
