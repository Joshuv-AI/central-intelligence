/* Rocket launches — The Space Devs Launch Library 2 (keyless, CORS-open).
   Upcoming launches as pad markers with NET countdown labels. 30-minute
   refresh. Data: The Space Devs (free API). */
import * as Cesium from 'cesium';

const URL = 'https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=40&ordering=net';
const REFRESH_MS = 30 * 60 * 1000;

let viewer = null;
let dataSource = null;
let refreshTimer = 0;
let enabled = false;

function padSprite() {
  const size = 40;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.strokeStyle = '#b48cff';
  g.lineWidth = 3;
  g.lineCap = 'round';
  // Rocket glyph: nose cone + body + fins + flame.
  g.beginPath();
  g.moveTo(size / 2, 6);
  g.quadraticCurveTo(size / 2 + 7, 14, size / 2 + 5, 24);
  g.lineTo(size / 2 + 5, 30);
  g.lineTo(size / 2 - 5, 30);
  g.lineTo(size / 2 - 5, 24);
  g.quadraticCurveTo(size / 2 - 7, 14, size / 2, 6);
  g.stroke();
  g.beginPath();
  g.moveTo(size / 2 - 5, 26);
  g.lineTo(size / 2 - 10, 32);
  g.moveTo(size / 2 + 5, 26);
  g.lineTo(size / 2 + 10, 32);
  g.stroke();
  g.fillStyle = '#ffb347';
  g.beginPath();
  g.moveTo(size / 2 - 3, 32);
  g.lineTo(size / 2 + 3, 32);
  g.lineTo(size / 2, 38);
  g.closePath();
  g.fill();
  return c;
}

function countdown(net) {
  const ms = new Date(net).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms < 0) return 'T+ elapsed';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return d > 0 ? `T-${d}d ${h}h` : `T-${h}h ${m}m`;
}

async function load() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const fresh = new Cesium.CustomDataSource('launches');
  const sprite = padSprite();
  for (const l of data.results || []) {
    const pad = l.pad || {};
    const lat = Number(pad.latitude);
    const lon = Number(pad.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const rocket = (l.rocket && l.rocket.configuration && l.rocket.configuration.name) || l.name || 'Launch';
    const mission = l.mission && l.mission.name ? ` · ${l.mission.name}` : '';
    fresh.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
      billboard: {
        image: sprite,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 3e7, 0.4),
        disableDepthTestDistance: 0,
      },
      label: {
        text: `${rocket}${mission}\n${countdown(l.net)}`,
        font: '12px system-ui, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -30),
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 2e7, 0.0),
      },
      description:
        `<b>${l.name || rocket}</b><br>` +
        `NET: ${l.net || '?'}<br>` +
        `Pad: ${pad.name || '?'}<br>` +
        `Status: ${(l.status && l.status.name) || '?'}`,
    });
  }

  if (dataSource) viewer.dataSources.remove(dataSource, true);
  dataSource = fresh;
  dataSource.show = enabled;
  await viewer.dataSources.add(dataSource);
}

export function launchesEnabled() {
  return enabled;
}

export function launchCount() {
  return dataSource ? dataSource.entities.values.length : 0;
}

// Source heartbeat for the dock.
const srcStatus = { lastOk: 0, lastErr: '' };
/** Heartbeat for the Live Source Dock: { lastOk, lastErr }. */
export function launchStatus() { return srcStatus; }

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

export async function setLaunches(on) {
  enabled = on;
  if (!viewer) return enabled;
  if (on) {
    if (!dataSource) {
      try {
        await refresh();
      } catch (err) {
        console.warn('[launches] unavailable:', err);
        enabled = false;
        return enabled;
      }
    } else {
      dataSource.show = true;
    }
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        refresh().catch((err) => console.warn('[launches] refresh failed:', err));
      }, REFRESH_MS);
    }
  } else if (dataSource) {
    dataSource.show = false;
  }
  return enabled;
}

export function initLaunches(v) {
  viewer = v;
}
