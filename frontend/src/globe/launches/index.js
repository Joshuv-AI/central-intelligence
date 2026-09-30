/* Rocket launches — The Space Devs Launch Library 2 (keyless, CORS-open).
   Upcoming launches as pad markers with NET countdown labels. 30-minute
   refresh. Data: The Space Devs (free API). */
import * as Cesium from 'cesium';
import { makeBackgroundLoader } from '../layerLoad.js';
import { isHidden, registerPoll } from '../../data/visibility.js';
import { pickRenderAltitudeM } from '../../data/renderAltitude.js';

const URL = 'https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=40&ordering=net';
const REFRESH_MS = 30 * 60 * 1000;

let viewer = null;
let dataSource = null;
let refreshTimer = 0;
let enabled = false;
let launches = []; // [{ id, name, net, rocket, mission, agency, pad, status, lat, lon }] — for click cards

/** Find a launch record by its entity id (e.g. "launch-<id>"). */
export function getLaunch(launchId) {
  return launches.find((l) => `launch-${l.id}` === launchId) || null;
}

const firstLoad = makeBackgroundLoader('launches');

/* Launch marker, premium badge style (Joshua 2026-09-30 — the cartoon rocket
   looked cheap). A dark mission-patch disc with a violet glow, thin bright
   rim, and a minimal geometric liftoff glyph: a slim rocket silhouette in
   pale silver with a small cyan exhaust flick. */
function padSprite() {
  const base = 48;
  const SS = 3; // retina-sharp on DPR-3 phones
  const size = base * SS;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(SS, SS); // draw in base coordinates
  const cx = base / 2;
  const cy = base / 2;

  // Soft violet halo.
  let glow = g.createRadialGradient(cx, cy, 4, cx, cy, 23);
  glow.addColorStop(0, 'rgba(150, 130, 255, 0.30)');
  glow.addColorStop(1, 'rgba(150, 130, 255, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, base, base);

  // Badge disc: dark navy, subtly lighter at top.
  const discR = 14.5;
  const discGrad = g.createLinearGradient(0, cy - discR, 0, cy + discR);
  discGrad.addColorStop(0, '#232c4e');
  discGrad.addColorStop(1, '#12172c');
  g.fillStyle = discGrad;
  g.beginPath();
  g.arc(cx, cy, discR, 0, Math.PI * 2);
  g.fill();

  // Thin bright rim.
  const rimGrad = g.createLinearGradient(cx - discR, 0, cx + discR, 0);
  rimGrad.addColorStop(0, '#6f7bd8');
  rimGrad.addColorStop(0.5, '#c3cbff');
  rimGrad.addColorStop(1, '#6f7bd8');
  g.strokeStyle = rimGrad;
  g.lineWidth = 1.6;
  g.beginPath();
  g.arc(cx, cy, discR - 0.8, 0, Math.PI * 2);
  g.stroke();

  // Faint outer tracking ring.
  g.strokeStyle = 'rgba(150, 160, 255, 0.28)';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(cx, cy, discR + 3.5, 0, Math.PI * 2);
  g.stroke();

  // Minimal rocket glyph, pointing up, in pale silver.
  g.fillStyle = '#e9edff';
  // Nose + body as one slim shape.
  g.beginPath();
  g.moveTo(cx, cy - 9.5);                       // nose tip
  g.quadraticCurveTo(cx + 3.4, cy - 5.5, cx + 3.4, cy - 1);
  g.lineTo(cx + 3.4, cy + 5.5);                 // body right
  g.lineTo(cx - 3.4, cy + 5.5);                 // body left
  g.lineTo(cx - 3.4, cy - 1);
  g.quadraticCurveTo(cx - 3.4, cy - 5.5, cx, cy - 9.5);
  g.closePath();
  g.fill();
  // Fins: two small swept triangles.
  g.fillStyle = '#a9b3e8';
  g.beginPath();
  g.moveTo(cx - 3.4, cy + 1.5);
  g.lineTo(cx - 7.2, cy + 7.5);
  g.lineTo(cx - 3.4, cy + 6.8);
  g.closePath();
  g.fill();
  g.beginPath();
  g.moveTo(cx + 3.4, cy + 1.5);
  g.lineTo(cx + 7.2, cy + 7.5);
  g.lineTo(cx + 3.4, cy + 6.8);
  g.closePath();
  g.fill();
  // Exhaust: small cyan flick under the nozzle.
  const flameGrad = g.createLinearGradient(0, cy + 5.5, 0, cy + 11.5);
  flameGrad.addColorStop(0, 'rgba(155, 232, 255, 0.95)');
  flameGrad.addColorStop(1, 'rgba(155, 232, 255, 0)');
  g.fillStyle = flameGrad;
  g.beginPath();
  g.moveTo(cx - 2.2, cy + 5.5);
  g.lineTo(cx + 2.2, cy + 5.5);
  g.lineTo(cx, cy + 11.5);
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
  const next = [];
  for (const l of data.results || []) {
    const pad = l.pad || {};
    const lat = Number(pad.latitude);
    const lon = Number(pad.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const rocket = (l.rocket && l.rocket.configuration && l.rocket.configuration.name) || l.name || 'Launch';
    const mission = l.mission && l.mission.name ? ` · ${l.mission.name}` : '';
    next.push({
      id: l.id,
      name: l.name || rocket,
      net: l.net || null,
      rocket,
      mission: (l.mission && l.mission.name) || null,
      agency: (l.launch_service_provider && l.launch_service_provider.name) || null,
      pad: pad.name || null,
      status: (l.status && l.status.name) || null,
      lat,
      lon,
    });
    // T5: launch pads are surface contacts — canonical resolver with the
    // standing 0 m surface policy (resolves to 0, as the old literal did).
    const padH = pickRenderAltitudeM({ onGround: true, surfaceM: 0 }) ?? 0;
    fresh.entities.add({
      id: `launch-${l.id}`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat, padH),
      billboard: {
        image: sprite,
        width: 48,
        height: 48,
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
  launches = next;

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
      // First load runs in the background (Joshua 2026-09-30): the toggle
      // resolves instantly and the layer populates when the fetch lands.
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
        refresh().catch((err) => console.warn('[launches] refresh failed:', err));
      }, REFRESH_MS);
      registerPoll('launches', refresh);
    }
  } else if (dataSource) {
    dataSource.show = false;
  }
  return enabled;
}

export function initLaunches(v) {
  viewer = v;
}
