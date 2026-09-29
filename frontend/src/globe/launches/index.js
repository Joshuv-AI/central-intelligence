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
  const size = 48;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2;
  // Glow backdrop.
  const glow = g.createRadialGradient(cx, 20, 2, cx, 20, 22);
  glow.addColorStop(0, 'rgba(180, 140, 255, 0.35)');
  glow.addColorStop(1, 'rgba(180, 140, 255, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, size, size);

  // Rocket body: nose cone + fuselage with shading.
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // Main body.
  const bodyGrad = g.createLinearGradient(cx - 6, 0, cx + 6, 0);
  bodyGrad.addColorStop(0, '#8a6fd1');
  bodyGrad.addColorStop(0.5, '#d0bfff');
  bodyGrad.addColorStop(1, '#8a6fd1');
  g.fillStyle = bodyGrad;
  g.strokeStyle = '#5a4a9a';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(cx, 4);                          // nose tip
  g.quadraticCurveTo(cx + 6, 10, cx + 5, 18);
  g.lineTo(cx + 5, 30);                     // body right
  g.lineTo(cx - 5, 30);                     // body left
  g.lineTo(cx - 5, 18);
  g.quadraticCurveTo(cx - 6, 10, cx, 4);
  g.closePath();
  g.fill();
  g.stroke();

  // Nose cap.
  g.fillStyle = '#ff5a5a';
  g.beginPath();
  g.moveTo(cx, 4);
  g.quadraticCurveTo(cx + 3.5, 8, cx + 4.5, 12);
  g.lineTo(cx - 4.5, 12);
  g.quadraticCurveTo(cx - 3.5, 8, cx, 4);
  g.closePath();
  g.fill();

  // Window.
  g.fillStyle = '#1a2b4a';
  g.beginPath();
  g.arc(cx, 16, 2.2, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#5a4a9a';
  g.lineWidth = 1;
  g.stroke();

  // Fins.
  g.fillStyle = '#b48cff';
  g.strokeStyle = '#5a4a9a';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(cx - 5, 24);
  g.lineTo(cx - 11, 34);
  g.lineTo(cx - 5, 32);
  g.closePath();
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(cx + 5, 24);
  g.lineTo(cx + 11, 34);
  g.lineTo(cx + 5, 32);
  g.closePath();
  g.fill();
  g.stroke();

  // Engine nozzle.
  g.fillStyle = '#3a3a4a';
  g.fillRect(cx - 3, 30, 6, 3);

  // Flame: layered teardrop.
  const flameGrad = g.createLinearGradient(0, 33, 0, 44);
  flameGrad.addColorStop(0, '#fff3b0');
  flameGrad.addColorStop(0.4, '#ffb347');
  flameGrad.addColorStop(1, 'rgba(255, 90, 90, 0)');
  g.fillStyle = flameGrad;
  g.beginPath();
  g.moveTo(cx - 3, 33);
  g.quadraticCurveTo(cx, 38, cx - 1.5, 44);
  g.quadraticCurveTo(cx, 40, cx + 1.5, 44);
  g.quadraticCurveTo(cx, 38, cx + 3, 33);
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
