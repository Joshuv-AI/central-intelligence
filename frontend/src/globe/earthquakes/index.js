/* Earthquakes — USGS M4.5+ past-day GeoJSON feed (keyless, CORS-open,
   direct browser fetch). Marker size scales with magnitude; color encodes
   depth. 15-minute refresh. Data: USGS (US public domain). */
import * as Cesium from 'cesium';
import { makeBackgroundLoader } from '../layerLoad.js';
import { isHidden, registerPoll } from '../../data/visibility.js';
import { pickRenderAltitudeM } from '../../data/renderAltitude.js';

const URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const REFRESH_MS = 15 * 60 * 1000;

let viewer = null;
let dataSource = null;
let refreshTimer = 0;
let enabled = false;

function quakeColor(depthKm) {
  // Shallow = red, deep = blue.
  const t = Math.min(1, Math.max(0, (depthKm || 0) / 300));
  return Cesium.Color.fromHsl(0.02 + t * 0.6, 0.95, 0.55);
}

// Shade a Cesium color toward white (amt > 0) or black (amt < 0), |amt|<=1.
function shade(color, amt) {
  const t = Math.max(-1, Math.min(1, amt));
  const target = t >= 0 ? Cesium.Color.WHITE : Cesium.Color.BLACK;
  return Cesium.Color.lerp(color, target, Math.abs(t), new Cesium.Color());
}

// Premium quake marker (Joshua 2026-09-30): a glowing orb — bright core,
// saturated mid, darker rim, soft outer halo — instead of the flat dot.
// Sprites are cached by (color, disc size); a day of M4.5+ quakes is small.
const quakeSpriteCache = new Map();
function quakeSprite(color, discPx) {
  const key = `${color.toCssColorString()}|${discPx}`;
  const hit = quakeSpriteCache.get(key);
  if (hit) return hit;
  const pad = Math.ceil(discPx * 0.9); // halo padding around the disc
  const S = discPx + pad * 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const cx = S / 2;
  const r = discPx / 2;
  // Outer halo: color glow fading to transparent.
  let grad = g.createRadialGradient(cx, cx, r * 0.5, cx, cx, r + pad);
  grad.addColorStop(0, color.withAlpha(0.38).toCssColorString());
  grad.addColorStop(1, color.withAlpha(0).toCssColorString());
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cx, r + pad, 0, Math.PI * 2);
  g.fill();
  // Disc: hot core -> saturated color -> darker edge.
  grad = g.createRadialGradient(cx, cx, 0, cx, cx, r);
  grad.addColorStop(0, shade(color, 0.6).toCssColorString());
  grad.addColorStop(0.45, color.toCssColorString());
  grad.addColorStop(1, shade(color, -0.22).toCssColorString());
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cx, r, 0, Math.PI * 2);
  g.fill();
  // Rim light.
  g.strokeStyle = shade(color, 0.32).withAlpha(0.9).toCssColorString();
  g.lineWidth = Math.max(1.5, discPx * 0.07);
  g.beginPath();
  g.arc(cx, cx, r - g.lineWidth / 2, 0, Math.PI * 2);
  g.stroke();
  const sprite = { image: c, px: S };
  quakeSpriteCache.set(key, sprite);
  if (quakeSpriteCache.size > 80) {
    quakeSpriteCache.delete(quakeSpriteCache.keys().next().value);
  }
  return sprite;
}
const firstLoad = makeBackgroundLoader('quakes');

async function load() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const fresh = new Cesium.CustomDataSource('earthquakes');
  for (const f of data.features || []) {
    const coords = f.geometry && f.geometry.coordinates;
    const p = f.properties || {};
    if (!coords || coords.length < 3) continue;
    const [lon, lat, depthKm] = coords;
    const mag = Number(p.mag) || 0;
    const color = quakeColor(depthKm);
    const size = Math.max(6, Math.min(28, 4 + mag * 3.2));
    const sprite = quakeSprite(color, Math.round(size));
    const quakeId = f.id || `${lat.toFixed(3)}_${lon.toFixed(3)}_${p.time || ''}`;
    // T5: quake markers are surface contacts (depth feeds color only, not
    // position) — routed through the canonical resolver with the standing
    // 0 m surface policy. Resolves to 0 exactly as the old literal did.
    const quakeH = pickRenderAltitudeM({ onGround: true, surfaceM: 0 }) ?? 0;
    fresh.entities.add({
      id: `quake-${quakeId}`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, quakeH),
      billboard: {
        image: sprite.image,
        width: sprite.px,
        height: sprite.px,
        disableDepthTestDistance: 0,
        scaleByDistance: new Cesium.NearFarScalar(2e5, 1.0, 3e7, 0.45),
      },
      label: {
        text: `M${mag.toFixed(1)}`,
        font: '11px system-ui, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -(size / 2 + 10)),
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 2e7, 0.0),
      },
      properties: {
        kind: 'quake',
        quakeId: quakeId,
        mag: mag,
        place: p.place || 'unknown location',
        depthKm: depthKm,
        time: p.time || null,
      },
      description:
        `<b>M${mag.toFixed(1)} — ${p.place || 'unknown location'}</b><br>` +
        `Depth: ${depthKm != null ? depthKm.toFixed(1) + ' km' : '?'}<br>` +
        `Time: ${p.time ? new Date(p.time).toUTCString() : '?'}`,
    });
  }

  if (dataSource) viewer.dataSources.remove(dataSource, true);
  dataSource = fresh;
  dataSource.show = enabled;
  await viewer.dataSources.add(dataSource);
}

export function earthquakesEnabled() {
  return enabled;
}

/** Get earthquake data by ID (for tap-to-info). */
export function getEarthquake(quakeId) {
  if (!dataSource) return null;
  const entity = dataSource.entities.getById(`quake-${quakeId}`);
  if (!entity) return null;
  const props = entity.properties;
  const getVal = (name) => {
    const v = props && props[name];
    return v && typeof v.getValue === 'function' ? v.getValue() : v;
  };
  const carto = Cesium.Cartographic.fromCartesian(entity.position.getValue());
  return {
    id: quakeId,
    mag: getVal('mag'),
    place: getVal('place'),
    depthKm: getVal('depthKm'),
    time: getVal('time'),
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

export function earthquakeCount() {
  return dataSource ? dataSource.entities.values.length : 0;
}

// Source heartbeat for the dock.
const srcStatus = { lastOk: 0, lastErr: '' };
/** Heartbeat for the Live Source Dock: { lastOk, lastErr }. */
export function earthquakeStatus() { return srcStatus; }

/** load() with heartbeat tracking; rethrows so callers keep their handling. */
async function refresh() {
  try {
    await load();
    srcStatus.lastOk = Date.now();
    srcStatus.lastErr = '';
  } catch (err) {
    srcStatus.lastErr = String((err && err.message) || err || 'fetch failed');
    throw err;
  }
}

export async function setEarthquakes(on) {
  enabled = on;
  if (!viewer) return enabled;
  if (on) {
    if (!dataSource) {
      // First load runs in the background (Joshua 2026-09-30): the toggle
      // resolves instantly and the layer populates when the fetch lands.
      // A failed load flips the layer back off and notifies the panel.
      firstLoad.ensure(async () => {
        try {
          await refresh();
        } catch (err) {
          enabled = false;
          throw err;
        }
      });
    } else {
      dataSource.show = true;
    }
    if (!refreshTimer) {
      // A4-1: skip refreshes while the tab is hidden; one fires on return.
      refreshTimer = setInterval(() => {
        if (isHidden()) return;
        refresh().catch((err) => console.warn('[earthquakes] refresh failed:', err));
      }, REFRESH_MS);
      registerPoll('earthquakes', refresh);
    }
  } else if (dataSource) {
    dataSource.show = false;
  }
  return enabled;
}

export function initEarthquakes(v) {
  viewer = v;
}
