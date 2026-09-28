/* Earthquakes — USGS M4.5+ past-day GeoJSON feed (keyless, CORS-open,
   direct browser fetch). Marker size scales with magnitude; color encodes
   depth. 15-minute refresh. Data: USGS (US public domain). */
import * as Cesium from 'cesium';

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
    fresh.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      point: {
        pixelSize: size,
        color: color.withAlpha(0.85),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        disableDepthTestDistance: 1e7,
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
      try {
        await refresh();
      } catch (err) {
        console.warn('[earthquakes] unavailable:', err);
        enabled = false;
        return enabled;
      }
    } else {
      dataSource.show = true;
    }
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        refresh().catch((err) => console.warn('[earthquakes] refresh failed:', err));
      }, REFRESH_MS);
    }
  } else if (dataSource) {
    dataSource.show = false;
  }
  return enabled;
}

export function initEarthquakes(v) {
  viewer = v;
}
