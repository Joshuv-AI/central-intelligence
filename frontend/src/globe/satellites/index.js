/* Live satellites — TLEs from CelesTrak (keyless, CORS-open), propagated
   client-side with satellite.js (SGP4). Rendered as one BillboardCollection,
   positions refreshed every 2 s. TLE sets are re-fetched hourly.
   Data: CelesTrak (celestrak.org) — credited in the Layers panel. */
import * as Cesium from 'cesium';
import * as satellite from 'satellite.js';

const GROUPS = ['stations', 'visual', 'weather', 'noaa', 'goes'];
const TLE_URL = (g) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`;
const REFRESH_MS = 60 * 60 * 1000;
const TICK_MS = 2000;

let viewer = null;
let billboards = null;
let sats = []; // { satrec, name, group }
let timer = 0;
let refreshTimer = 0;
let enabled = false;
let dotImage = null;
// Source heartbeat for the dock.
const srcStatus = { lastOk: 0, lastErr: '' };
/** Heartbeat for the Live Source Dock: { lastOk, lastErr }. */
export function satelliteStatus() { return srcStatus; }

function makeDotImage() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(160,220,255,0.9)');
  grad.addColorStop(1, 'rgba(120,200,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return c;
}

function parseTLE(text, group) {
  const lines = text.split('\n').map((l) => l.trimEnd());
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!name || !l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    try {
      out.push({ name, group, satrec: satellite.twoline2satrec(l1, l2) });
    } catch {
      /* skip malformed entries */
    }
  }
  return out;
}

async function loadTLEs() {
  const all = [];
  let okGroups = 0;
  for (const group of GROUPS) {
    try {
      const res = await fetch(TLE_URL(group));
      if (!res.ok) throw new Error('celestrak ' + res.status);
      all.push(...parseTLE(await res.text(), group));
      okGroups++;
    } catch (err) {
      console.warn(`[satellites] ${group} unavailable:`, err);
    }
  }
  if (okGroups > 0) {
    srcStatus.lastOk = Date.now();
    srcStatus.lastErr = '';
  } else if (all.length === 0) {
    srcStatus.lastErr = 'CelesTrak unreachable';
  }
  return all;
}

function updatePositions() {
  if (!billboards || sats.length === 0) return;
  const now = new Date();
  const gmst = satellite.gstime(now);
  for (const s of sats) {
    let pv;
    try {
      pv = satellite.propagate(s.satrec, now);
    } catch {
      continue;
    }
    if (!pv || !pv.position || !s.billboard) continue;
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    const lon = satellite.degreesLong(geo.longitude);
    const lat = satellite.degreesLat(geo.latitude);
    const height = Math.max(0, geo.height * 1000); // km -> m
    s.billboard.position = Cesium.Cartesian3.fromDegrees(lon, lat, height);
  }
}

function buildBillboards() {
  billboards.removeAll();
  for (const s of sats) {
    s.billboard = billboards.add({
      position: Cesium.Cartesian3.fromDegrees(0, 0, 400000),
      image: dotImage,
      width: 7,
      height: 7,
      disableDepthTestDistance: 0,
    });
  }
}

export function satellitesEnabled() {
  return enabled;
}

export function satelliteCount() {
  return sats.length;
}

export async function setSatellites(on) {
  if (on === enabled && billboards) return enabled;
  enabled = on;
  if (!viewer) return enabled;

  if (on) {
    if (!billboards) {
      if (!dotImage) dotImage = makeDotImage();
      billboards = new Cesium.BillboardCollection({ scene: viewer.scene });
      viewer.scene.primitives.add(billboards);
    }
    billboards.show = true;
    if (sats.length === 0) sats = await loadTLEs();
    buildBillboards();
    updatePositions();
    if (!timer) timer = setInterval(updatePositions, TICK_MS);
    if (!refreshTimer) {
      refreshTimer = setInterval(async () => {
        sats = await loadTLEs();
        if (enabled) {
          buildBillboards();
          updatePositions();
        }
      }, REFRESH_MS);
    }
  } else {
    if (billboards) billboards.show = false;
  }
  return enabled;
}

export function initSatellites(v) {
  viewer = v;
}
