/* AIS vessel layer — NEW capability (CI has no ships today).
   Structure mirrors frontend/src/globe/flights/index.js: one
   BillboardCollection, 30 s polls, dead reckoning between polls,
   horizon culling via EllipsoidalOccluder.

   DATA HONESTY: there is no reliable keyless AIS source. The layer polls
   the backend proxy `/proxy/ais/live` and reports honest states —
   'needs_key' (AISSTREAM_API_KEY not configured), 'ok', 'degraded',
   'down'. The layer NEVER fabricates vessel positions. Adding the AIS
   provider key needs Joshua's explicit approval (no accounts/billing
   chosen here).

   Expected proxy response (backend normalizes AISStream):
     { status: 'ok'|'needs_key'|'degraded'|'down', vessels: [
       { mmsi, name, lat, lon, sog, cog, heading, type, navStatus } ] }

   Selection: tap a chevron → getVessel(mmsi) → card via ui/cards.js.
   Trails: vesselTrails reuses the shared createTrailManager; seed from
   the per-vessel position history ring buffer kept here. */

import * as Cesium from 'cesium';
import { vesselIcon } from './vesselIcons.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';

const POLL_MS = 30 * 1000;
const KNOTS_TO_DEG_LAT_PER_S = 1 / 3600;
const HISTORY_MAX = 120; // ~1 h of 30 s fixes per vessel, for trail seeding

let viewer = null;
let billboards = null;
let enabled = false;
let pollTimer = 0;
let preRenderRemove = null;
let occluder = null;
let pollGen = 0;

// Layer status for the dock / System Status: 'needs_key' | 'ok' | 'degraded' | 'down' | 'off'
const vesselStatus = { state: 'off', lastOk: 0, lastErr: '' };
/** Honest layer status: { state, lastOk, lastErr }. */
export function getVesselStatus() { return vesselStatus; }

// mmsi -> { billboard, lat, lon, sog, cog, heading, name, type, navStatus,
//            lastUpdate, missedPolls, history: [Cartesian3...] }
const vessels = new Map();

function toCartesian(lat, lon) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, 0); // surface — ships float
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
    const bb = billboards.add({
      id: `vessel-${mmsi}`,
      image: vesselIcon(sv.type, false),
      width: 32,
      height: 32,
      scaleByDistance: new Cesium.NearFarScalar(2e5, 1.1, 4e7, 0.3),
      disableDepthTestDistance: 0,
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
  // Heading preferred, else course-over-ground; chevron points north at rotation 0.
  const hdg = Number.isFinite(sv.heading) ? sv.heading
    : Number.isFinite(sv.cog) ? sv.cog : NaN;
  if (Number.isFinite(hdg)) v.billboard.rotation = (hdg * Math.PI) / 180;
  v.heading = hdg;
  v.name = String(sv.name || '').trim();
  v.type = sv.type;
  v.navStatus = sv.navStatus || '';
  v.lastUpdate = Date.now();
  v.missedPolls = 0;
  v.billboard.position = toCartesian(v.lat, v.lon);
  // Ring buffer for trail seeding.
  v.history.push(toCartesian(v.lat, v.lon));
  if (v.history.length > HISTORY_MAX) v.history.shift();
}

function cullHorizon() {
  if (!occluder) return;
  occluder.cameraPosition = viewer.scene.camera.positionWC;
  for (const v of vessels.values()) {
    const p = toCartesian(v.lat, v.lon);
    v.billboard.show = enabled && occluder.isPointVisible(p);
  }
}

async function poll() {
  const gen = ++pollGen;
  let payload = null;
  let errText = '';
  try {
    const res = await fetch('/proxy/ais/live?maxRows=8000');
    payload = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    errText = String((err && err.message) || err || 'fetch failed');
  }
  if (gen !== pollGen) return; // stale poll

  if (!payload) {
    vesselStatus.state = 'down';
    vesselStatus.lastErr = errText;
    console.warn('[vessels] poll failed:', errText);
    return;
  }
  const state = payload.status || 'ok';
  if (state === 'needs_key') {
    vesselStatus.state = 'needs_key';
    vesselStatus.lastErr = 'AIS provider key not configured';
    return; // no data — and we say so, honestly
  }
  if (state === 'down') {
    vesselStatus.state = 'down';
    vesselStatus.lastErr = payload.error || 'AIS feed down';
    return;
  }
  vesselStatus.state = state === 'degraded' ? 'degraded' : 'ok';
  vesselStatus.lastOk = Date.now();
  vesselStatus.lastErr = state === 'degraded' ? (payload.error || 'degraded') : '';

  const seen = new Set();
  for (const sv of payload.vessels || []) {
    if (!sv.mmsi) continue;
    seen.add(String(sv.mmsi));
    upsert(sv);
  }
  // Drop vessels that vanished: 3 missed polls (~90 s) grace.
  for (const [mmsi, v] of vessels) {
    if (!seen.has(mmsi)) {
      v.missedPolls = (v.missedPolls || 0) + 1;
      v.stale = true;
      if (v.missedPolls >= 3) {
        billboards.remove(v.billboard);
        vessels.delete(mmsi);
      }
    } else {
      v.stale = false;
    }
  }
  cullHorizon();
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

function startLoop() {
  if (pollTimer || !enabled) return;
  ensureBillboards();
  holdContinuousRender('vessels'); // keep animating while camera is parked
  let last = performance.now();
  preRenderRemove = viewer.scene.preRender.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 1);
    last = now;
    const t = 1 - Math.pow(0.001, dt / 1.5);
    for (const v of vessels.values()) {
      deadReckon(v, dt);
      if (Number.isFinite(v.dispLat)) {
        v.dispLat += (v.lat - v.dispLat) * t;
        v.dispLon += (v.lon - v.dispLon) * t;
      } else {
        v.dispLat = v.lat; v.dispLon = v.lon;
      }
      v.billboard.position = toCartesian(v.dispLat, v.dispLon);
    }
  });
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

function stopLoop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = 0;
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
  if (enabled) startLoop(); else stopLoop();
  for (const v of vessels.values()) v.billboard.show = on;
  // Await the first poll so callers see the real feed state (needs_key/down/ok)
  // instead of racing it — the toggle handler depends on this.
  if (enabled && vessels.size === 0) await poll();
  return enabled;
}

export function initVessels(v) {
  viewer = v;
}
