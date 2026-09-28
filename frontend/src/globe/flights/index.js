/* Live flights — military via /proxy/adsblol/mil, civil via /proxy/adsblol/near
   (camera-target centered, 250 NM). One BillboardCollection, 15 s polls,
   ~12 Hz dead reckoning between polls (track + ground speed), NearFarScalar
   distance scaling, horizon culling via EllipsoidalOccluder.
   Data: adsb.lol (ODbL 1.0 — credited in the Layers panel). */
import * as Cesium from 'cesium';

const POLL_MS = 15 * 1000;
const KNOTS_TO_DEG_LAT_PER_S = 1 / 3600; // 1 knot = 1 NM/h; 1 NM = 1 arc-minute

let viewer = null;
let billboards = null;
let milOn = false;
let civOn = false;
let pollTimer = 0;
let preRenderRemove = null;
let occluder = null;

// hex -> { billboard, lat, lon, track, gs, alt, lastUpdate }
const aircraft = new Map();

function planeSprite(tint) {
  const size = 48;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  g.rotate(Math.PI / 2); // draw pointing up; billboard rotation adds heading
  g.fillStyle = tint;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 2;
  // Simple swept-wing plane silhouette.
  g.beginPath();
  g.moveTo(0, -20);
  g.lineTo(4, -6);
  g.lineTo(18, 6);
  g.lineTo(18, 10);
  g.lineTo(4, 4);
  g.lineTo(2, 12);
  g.lineTo(6, 16);
  g.lineTo(6, 19);
  g.lineTo(0, 17);
  g.lineTo(-6, 19);
  g.lineTo(-6, 16);
  g.lineTo(-2, 12);
  g.lineTo(-4, 4);
  g.lineTo(-18, 10);
  g.lineTo(-18, 6);
  g.lineTo(-4, -6);
  g.closePath();
  g.fill();
  g.stroke();
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
  if (!a) {
    const bb = billboards.add({
      image: military ? planeSprite('#ffb347') : planeSprite('#7fd4ff'),
      scaleByDistance: new Cesium.NearFarScalar(2e5, 1.4, 4e7, 0.35),
      disableDepthTestDistance: 1e7,
    });
    a = { billboard: bb, hex };
    aircraft.set(hex, a);
  }
  a.lat = ac.lat;
  a.lon = ac.lon;
  a.track = Number(ac.track);
  a.gs = Number(ac.gs);
  a.alt = altM;
  a.military = military;
  a.label = (ac.flight || '').trim() || ac.r || hex;
  a.lastUpdate = performance.now();
  a.billboard.position = toCartesian(a.lat, a.lon, a.alt);
  a.billboard.rotation = Number.isFinite(a.track) ? ((a.track * Math.PI) / 180) : 0;
}

function cullHorizon() {
  if (!occluder) return;
  occluder.cameraPosition = viewer.scene.camera.positionWC;
  for (const a of aircraft.values()) {
    const p = toCartesian(a.lat, a.lon, a.alt);
    a.billboard.show = occluder.isPointVisible(p);
  }
}

async function poll() {
  const jobs = [];
  if (milOn) jobs.push(fetch('/proxy/adsblol/mil').then((r) => r.json()).then((d) => ({ d, military: true })));
  if (civOn) {
    const cam = viewer.scene.camera;
    const carto = Cesium.Ellipsoid.WGS84.cartesianToCartographic(cam.positionWC);
    const lat = (carto.latitude * 180) / Math.PI;
    const lon = (carto.longitude * 180) / Math.PI;
    jobs.push(
      fetch(`/proxy/adsblol/near?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&dist=250`)
        .then((r) => r.json())
        .then((d) => ({ d, military: false }))
    );
  }
  if (!jobs.length) return;
  try {
    const results = await Promise.all(jobs);
    const seen = new Set();
    for (const { d, military } of results) {
      for (const ac of d.ac || []) {
        if (!ac.hex) continue;
        seen.add(ac.hex);
        upsert(ac, military);
      }
    }
    // Drop aircraft that vanished from both feeds.
    for (const [hex, a] of aircraft) {
      if (!seen.has(hex)) {
        billboards.remove(a.billboard);
        aircraft.delete(hex);
      }
    }
    cullHorizon();
  } catch (err) {
    console.warn('[flights] poll failed:', err);
  }
}

function startLoop() {
  if (pollTimer || !(milOn || civOn)) return;
  ensureBillboards();
  let last = performance.now();
  preRenderRemove = viewer.scene.preRender.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 1);
    last = now;
    for (const a of aircraft.values()) {
      deadReckon(a, dt);
      a.billboard.position = toCartesian(a.lat, a.lon, a.alt);
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
  if (billboards) {
    billboards.removeAll();
  }
  aircraft.clear();
}

export function militaryEnabled() { return milOn; }
export function civilEnabled() { return civOn; }
export function flightCount() { return aircraft.size; }

export async function setMilitary(on) {
  milOn = on;
  if (!viewer) return milOn;
  if (milOn || civOn) startLoop(); else stopLoop();
  if (milOn) poll();
  return milOn;
}

export async function setCivil(on) {
  civOn = on;
  if (!viewer) return civOn;
  if (milOn || civOn) startLoop(); else stopLoop();
  if (civOn) poll();
  return civOn;
}

export function initFlights(v) {
  viewer = v;
}
