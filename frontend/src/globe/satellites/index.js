/* Live satellites — TLEs from CelesTrak (keyless, CORS-open), propagated
   client-side with satellite.js (SGP4). Rendered as one BillboardCollection,
   positions refreshed every 2 s. TLE sets are re-fetched hourly.
   Data: CelesTrak (celestrak.org) — credited in the Layers panel. */
import * as Cesium from 'cesium';
import * as satellite from 'satellite.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';

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
    // SGP4 ticks every 2 s; the per-frame interpolator below glides the
    // billboard toward this target so satellites move smoothly instead of
    // visibly jumping each tick while the globe turns.
    s.tgtLon = satellite.degreesLong(geo.longitude);
    s.tgtLat = satellite.degreesLat(geo.latitude);
    s.tgtH = Math.max(0, geo.height * 1000); // km -> m
    if (!Number.isFinite(s.dispLon)) {
      s.dispLon = s.tgtLon; s.dispLat = s.tgtLat; s.dispH = s.tgtH;
    }
  }
}

// Per-frame satellite glide: exponential interpolation toward the latest
// SGP4 target (~1.5 s smoothing, frame-rate independent), writing into a
// scratch Cartesian3 — no per-frame allocation.
let interpOff = null;
function startInterpolator() {
  if (interpOff || !viewer) return;
  let last = performance.now();
  interpOff = viewer.scene.preRender.addEventListener(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 1);
    last = now;
    const t = 1 - Math.pow(0.001, dt / 1.5);
    for (const s of sats) {
      if (!s.billboard || !Number.isFinite(s.tgtLon)) continue;
      // Shortest-path longitude delta: a satellite crossing the antimeridian
      // must not sweep the long way around the globe.
      let dLon = s.tgtLon - s.dispLon;
      if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
      s.dispLon += dLon * t;
      if (s.dispLon > 180) s.dispLon -= 360; else if (s.dispLon < -180) s.dispLon += 360;
      s.dispLat += (s.tgtLat - s.dispLat) * t;
      s.dispH += (s.tgtH - s.dispH) * t;
      s.billboard.position = Cesium.Cartesian3.fromDegrees(
        s.dispLon, s.dispLat, s.dispH, (s._pos ||= new Cesium.Cartesian3()));
    }
  });
}
function stopInterpolator() {
  if (interpOff) { interpOff(); interpOff = null; }
}

function buildBillboards() {
  // Reuse existing billboards when the count matches — avoids the flash
  // from removeAll() during TLE refreshes. Only rebuild if count changed.
  if (billboards && sats.length === billboards.length) {
    for (let i = 0; i < sats.length; i++) {
      sats[i].billboard = billboards.get(i);
    }
    return;
  }
  billboards.removeAll();
  for (let i = 0; i < sats.length; i++) {
    const s = sats[i];
    s.billboard = billboards.add({
      id: `sat-${i}`,
      position: Cesium.Cartesian3.fromDegrees(0, 0, 400000),
      image: dotImage,
      width: 7,
      height: 7,
      disableDepthTestDistance: 0,
    });
  }
}

/** Get satellite data by index (for tap-to-info). */
export function getSatellite(idx) {
  const s = sats[idx];
  if (!s) return null;
  // Extract orbital info from satrec for the info card.
  const satrec = s.satrec;
  return {
    name: s.name,
    group: s.group,
    noradId: satrec.satnum,
    inclination: satrec.inclo ? (satrec.inclo * 180 / Math.PI).toFixed(1) + '°' : '—',
    // Current position is updated in updatePositions; get latest from billboard.
    billboard: s.billboard,
    satrec, // exposed for flicker-free orbit rings (audit 1.14)
  };
}

export function satellitesEnabled() {
  return enabled;
}

export function satelliteCount() {
  return sats.length;
}

let satGen = 0;

export async function setSatellites(on) {
  const gen = ++satGen;
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
    // Load TLEs in background — don't block the toggle. The gen check
    // ensures we don't build if user toggled off during load.
    if (sats.length === 0) {
      loadTLEs().then((loaded) => {
        if (gen !== satGen || !enabled) return;
        sats = loaded;
        buildBillboards();
        updatePositions();
      });
    } else {
      buildBillboards();
      updatePositions();
    }
    if (!timer) timer = setInterval(updatePositions, TICK_MS);
    holdContinuousRender('satellites'); // keep animating while camera is parked
    startInterpolator(); // per-frame glide between 2 s SGP4 ticks
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
    // Clear timers on toggle-off (audit 2026-09-29) — stops background work.
    if (timer) { clearInterval(timer); timer = null; }
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    stopInterpolator();
    releaseContinuousRender('satellites');
  }
  return enabled;
}

export function initSatellites(v) {
  viewer = v;
}
