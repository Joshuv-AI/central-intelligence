/* Live flights — military via /proxy/adsblol/mil, civil via /proxy/adsblol/near
   (camera-target centered, 250 NM). One BillboardCollection, 15 s polls,
   ~12 Hz dead reckoning between polls (track + ground speed), NearFarScalar
   distance scaling, horizon culling via EllipsoidalOccluder.
   Data: adsb.lol (ODbL 1.0 — credited in the Layers panel). */
import * as Cesium from 'cesium';
import { classifyAircraft, CLASS_SCALE_2D } from '../aircraft/aircraftClass.js';
import { aircraftIcon, FLEET_ICON_PX, FLEET_ICON_PX_RETINA } from '../aircraft/aircraftIcons.js';
import { isTaggedMilitary } from '../aircraft/militaryRegistry.js';

const POLL_MS = 15 * 1000;
const KNOTS_TO_DEG_LAT_PER_S = 1 / 3600; // 1 knot = 1 NM/h; 1 NM = 1 arc-minute

let viewer = null;
let billboards = null;
let milOn = false;
let civOn = false;
let pollTimer = 0;
let preRenderRemove = null;
let occluder = null;
// Source heartbeat for the dock: last successful poll + last error, per feed.
const feedStatus = {
  military: { lastOk: 0, lastErr: '' },
  civil: { lastOk: 0, lastErr: '' },
};
/** Heartbeat for the Live Source Dock: { lastOk, lastErr } per feed. */
export function flightStatus() { return feedStatus; }

// hex -> { billboard, lat, lon, track, gs, alt, lastUpdate, missedPolls }
const aircraft = new Map();

function planeSprite(tint) {
  const size = 56;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  // Draw pointing up (north); billboard rotation adds heading.
  // More detailed airliner silhouette: fuselage, swept wings, tailplane,
  // vertical stabilizer, and engine nacelles.
  g.fillStyle = tint;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1.5;

  // Fuselage: rounded nose to tapered tail.
  g.beginPath();
  g.moveTo(0, -24);                    // nose tip
  g.bezierCurveTo(3, -20, 3, -12, 2.5, -4);
  g.lineTo(2.5, 10);                   // mid fuselage
  g.bezierCurveTo(2.5, 16, 1.5, 20, 0, 22); // tail taper
  g.bezierCurveTo(-1.5, 20, -2.5, 16, -2.5, 10);
  g.lineTo(-2.5, -4);
  g.bezierCurveTo(-3, -12, -3, -20, 0, -24);
  g.closePath();
  g.fill();
  g.stroke();

  // Main wings: swept back, tapered.
  g.beginPath();
  g.moveTo(2, -2);
  g.lineTo(22, 8);                     // right wingtip leading
  g.lineTo(22, 11);                    // right wingtip trailing
  g.lineTo(2, 6);                      // wing root trailing
  g.closePath();
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(-2, -2);
  g.lineTo(-22, 8);
  g.lineTo(-22, 11);
  g.lineTo(-2, 6);
  g.closePath();
  g.fill();
  g.stroke();

  // Engine nacelles under wings.
  g.beginPath();
  g.ellipse(9, 6, 2.5, 4, 0.15, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.beginPath();
  g.ellipse(-9, 6, 2.5, 4, -0.15, 0, Math.PI * 2);
  g.fill();
  g.stroke();

  // Horizontal stabilizers (tailplane).
  g.beginPath();
  g.moveTo(1.5, 14);
  g.lineTo(10, 19);
  g.lineTo(10, 21);
  g.lineTo(1.5, 17);
  g.closePath();
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(-1.5, 14);
  g.lineTo(-10, 19);
  g.lineTo(-10, 21);
  g.lineTo(-1.5, 17);
  g.closePath();
  g.fill();
  g.stroke();

  // Vertical stabilizer.
  g.beginPath();
  g.moveTo(0, 12);
  g.lineTo(0, 22);
  g.lineTo(-2.5, 18);
  g.lineTo(-2.5, 14);
  g.closePath();
  g.fillStyle = tint;
  g.fill();
  g.stroke();

  // Cockpit windows (subtle dark band near nose).
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.beginPath();
  g.ellipse(0, -18, 1.8, 2.5, 0, 0, Math.PI * 2);
  g.fill();

  return c;
}

function ensureBillboards() {
  if (billboards) return;
  const scene = viewer.scene;
  billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    viewer.scene.camera.positionWC
  );
}

function toCartesian(lat, lon, altM) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(altM, 0));
}

// Advance a position by speed/track over dt seconds (flat-earth approx —
// fine for 15 s hops: at 500 kt that's ~2 NM).
function deadReckon(a, dt) {
  if (!Number.isFinite(a.track) || !Number.isFinite(a.gs) || a.gs <= 0) return;
  const dDeg = a.gs * KNOTS_TO_DEG_LAT_PER_S * dt;
  const tr = (a.track * Math.PI) / 180;
  a.lat += dDeg * Math.cos(tr);
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  a.lon += (dDeg * Math.sin(tr)) / Math.max(cosLat, 0.2);
}

function upsert(ac, military) {
  const hex = ac.hex;
  if (!hex || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return;
  let a = aircraft.get(hex);
  const altM = ac.alt_baro === 'ground' ? 0 : Number(ac.alt_baro) * 0.3048 || 0;
  // Per-class silhouette (audit 1.6): classify by ICAO type designator.
  const typeCode = (ac.t || '').trim().toUpperCase();
  const klass = classifyAircraft({ typeCode });
  if (!a) {
    const taggedMil = isTaggedMilitary(hex);
    const bb = billboards.add({
      id: `flight-${hex}`,
      image: aircraftIcon(klass, FLEET_ICON_PX_RETINA),
      scaleByDistance: new Cesium.NearFarScalar(2e5, 1.4, 4e7, 0.35),
      disableDepthTestDistance: 0,
    });
    bb.scale = (CLASS_SCALE_2D[klass] || 1) * (FLEET_ICON_PX / FLEET_ICON_PX_RETINA);
    // Tint: operator-tagged red / military amber / civil blue.
    bb.color = Cesium.Color.fromCssColorString(
      taggedMil ? '#ff6b6b' : military ? '#ffb347' : '#7fd4ff'
    );
    a = { billboard: bb, hex, klass };
    aircraft.set(hex, a);
    // New aircraft: start at the reported position (no interpolation needed).
    a.lat = ac.lat;
    a.lon = ac.lon;
    a.dispLat = ac.lat;
    a.dispLon = ac.lon;
  } else {
    // Existing aircraft: set target, interpolate display position smoothly.
    // This prevents visible jumping when API position differs from dead-reckoned.
    a.lat = ac.lat;
    a.lon = ac.lon;
    if (!Number.isFinite(a.dispLat)) { a.dispLat = ac.lat; a.dispLon = ac.lon; }
    // Re-image if the type arrived late (audit 1.6).
    if (klass !== a.klass) {
      a.klass = klass;
      a.billboard.image = aircraftIcon(klass, FLEET_ICON_PX_RETINA);
      a.billboard.scale = (CLASS_SCALE_2D[klass] || 1) * (FLEET_ICON_PX / FLEET_ICON_PX_RETINA);
    }
  }
  // Enrichment fields for richer cards (audit 1.9).
  a.typeCode = typeCode;
  a.vertRateFpm = Number(ac.baro_rate);   // ft/min, NaN when absent
  a.seenSec = Number(ac.seen);            // seconds since last ADS-B update
  a.squawk = ac.squawk || '';
  a.emergency = ac.emergency || 'none';
  a.stale = (a.missedPolls || 0) > 0;
  // Position history for selected-flight trails (audit 1.7).
  // Recorded AFTER altitude assignment so the point carries this poll's altitude.
  a.history = a.history || [];
  a.history.push(toCartesian(a.lat, a.lon, altM));
  if (a.history.length > 120) a.history.shift(); // ~30 min at 15 s polls
  // Track: null/undefined/empty means "unknown" (use movement fallback).
  // Number(null) is 0, which would falsely point the plane north.
  a.track = (ac.track == null || ac.track === '') ? NaN : Number(ac.track);
  a.gs = Number(ac.gs);
  a.alt = altM;
  a.military = military;
  a.label = (ac.flight || '').trim() || ac.r || hex;
  a.lastUpdate = performance.now();
  a.billboard.position = toCartesian(a.lat, a.lon, a.alt);
  // Heading: prefer ADS-B track, else estimate from position delta,
  // else keep last rotation (never snap back to 0).
  let heading = null;
  if (Number.isFinite(a.track)) {
    heading = a.track;
  } else if (Number.isFinite(a.prevLat) && Number.isFinite(a.prevLon) &&
             (a.prevLat !== a.lat || a.prevLon !== a.lon)) {
    const dLon = (a.lon - a.prevLon) * Math.cos((a.lat * Math.PI) / 180);
    const dLat = a.lat - a.prevLat;
    heading = (Math.atan2(dLon, dLat) * 180) / Math.PI;
    if (heading < 0) heading += 360;
  }
  if (heading !== null) {
    a.billboard.rotation = (heading * Math.PI) / 180;
  }
  a.prevLat = a.lat;
  a.prevLon = a.lon;
}

function cullHorizon() {
  if (!occluder) return;
  occluder.cameraPosition = viewer.scene.camera.positionWC;
  for (const a of aircraft.values()) {
    const layerOn = a.military ? milOn : civOn;
    const p = toCartesian(a.lat, a.lon, a.alt);
    a.billboard.show = layerOn && occluder.isPointVisible(p);
  }
}

let pollGen = 0;

async function poll() {
  const gen = ++pollGen;
  const jobs = [];
  if (milOn) jobs.push(
    fetch('/proxy/adsblol/mil').then((r) => r.json())
      .then((d) => ({ d, military: true, ok: true }))
      .catch((err) => ({ military: true, ok: false, err }))
  );
  if (civOn) {
    const cam = viewer.scene.camera;
    const carto = Cesium.Ellipsoid.WGS84.cartesianToCartographic(cam.positionWC);
    const lat = (carto.latitude * 180) / Math.PI;
    const lon = (carto.longitude * 180) / Math.PI;
    jobs.push(
      fetch(`/proxy/adsblol/near?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&dist=250`)
        .then((r) => r.json())
        .then((d) => ({ d, military: false, ok: true }))
        .catch((err) => ({ military: false, ok: false, err }))
    );
  }
  if (!jobs.length) return;
  const results = await Promise.all(jobs);
  if (gen !== pollGen) return; // stale poll — a newer poll started, discard results
  const seen = new Set();
  let anyOk = false;
  for (const { d, military, ok, err } of results) {
    const key = military ? 'military' : 'civil';
    if (ok) {
      anyOk = true;
      feedStatus[key].lastOk = Date.now();
      feedStatus[key].lastErr = '';
    } else {
      feedStatus[key].lastErr = String((err && err.message) || err || 'fetch failed');
      console.warn(`[flights] ${key} poll failed:`, err);
      continue;
    }
    for (const ac of d.ac || []) {
      if (!ac.hex) continue;
      seen.add(ac.hex);
      upsert(ac, military);
    }
  }
  // If ALL feeds failed (network outage), skip cleanup entirely — don't
  // penalize existing aircraft for a connectivity blip. This prevents the
  // flicker where everything vanishes and reappears.
  if (!anyOk) return;
  // Drop aircraft that vanished from both feeds. Use a grace period of
  // 3 missed polls (~45s) to avoid flickering when the API is inconsistent.
  for (const [hex, a] of aircraft) {
    if (!seen.has(hex)) {
      a.missedPolls = (a.missedPolls || 0) + 1;
      if (a.missedPolls >= 3) {
        billboards.remove(a.billboard);
        aircraft.delete(hex);
      }
    } else {
      a.missedPolls = 0;
    }
  }
  cullHorizon();
}

function startLoop() {
  if (pollTimer || !(milOn || civOn)) return;
  ensureBillboards();
  let last = performance.now();
  preRenderRemove = viewer.scene.preRender.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 1);
    last = now;
    // Interpolation factor: smooth over ~1.5s (frame-rate independent).
    const t = 1 - Math.pow(0.001, dt / 1.5);
    for (const a of aircraft.values()) {
      deadReckon(a, dt);
      // Smoothly interpolate display position towards target.
      // This eliminates visible jumping when API updates arrive.
      if (Number.isFinite(a.dispLat)) {
        a.dispLat += (a.lat - a.dispLat) * t;
        a.dispLon += (a.lon - a.dispLon) * t;
      } else {
        a.dispLat = a.lat; a.dispLon = a.lon;
      }
      a.billboard.position = toCartesian(a.dispLat, a.dispLon, a.alt);
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
  // Don't clear aircraft data — keep it cached for instant re-show.
  // Billboards are hidden via show flag in setMilitary/setCivil.
}

export function militaryEnabled() { return milOn; }
export function civilEnabled() { return civOn; }
/** Per-feed aircraft count for the dock (true = military, false = civil). */
export function flightCountBy(military) {
  let n = 0;
  for (const a of aircraft.values()) if (!!a.military === military) n++;
  return n;
}
/** Get aircraft data by hex (for tap-to-info). */
export function getAircraft(hex) { return aircraft.get(hex) || null; }

export async function setMilitary(on) {
  milOn = on;
  if (!viewer) return milOn;
  if (milOn || civOn) startLoop(); else stopLoop();
  // Show/hide existing billboards instantly; only fetch if we have no data.
  let hasMil = false;
  for (const a of aircraft.values()) {
    if (a.military) { hasMil = true; a.billboard.show = on; }
  }
  if (milOn && !hasMil) poll();
  return milOn;
}

export async function setCivil(on) {
  civOn = on;
  if (!viewer) return civOn;
  if (milOn || civOn) startLoop(); else stopLoop();
  let hasCiv = false;
  for (const a of aircraft.values()) {
    if (!a.military) { hasCiv = true; a.billboard.show = on; }
  }
  if (civOn && !hasCiv) poll();
  return civOn;
}

export function initFlights(v) {
  viewer = v;
}
