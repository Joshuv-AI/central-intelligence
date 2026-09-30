/* Tropical cyclones — NHC CurrentStorms.json via /proxy (no CORS at source),
   forecast cone/track/points from the NHC tropical MapServer (CORS-open,
   queried directly as GeoJSON). 10-minute refresh.
   Data: NOAA National Hurricane Center (US public domain). */
import * as Cesium from 'cesium';
import { makeBackgroundLoader } from '../layerLoad.js';
import { isHidden, registerPoll } from '../../data/visibility.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { pickRenderAltitudeM } from '../../data/renderAltitude.js';

const firstLoad = makeBackgroundLoader('cyclones');

const MAPSERVER =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
const REFRESH_MS = 10 * 60 * 1000;

const CLASS_COLORS = {
  HU: '#ff2d2d', // hurricane
  TS: '#ff8c1a', // tropical storm
  TD: '#ffd21a', // tropical depression
  SD: '#ffd21a', // subtropical depression
  SS: '#ff8c1a', // subtropical storm
  EX: '#9aa4b2', // extratropical
  PT: '#9aa4b2', // post-tropical
};

let viewer = null;
let dataSource = null;
let refreshTimer = 0;
let enabled = false;

function stormColor(cls) {
  return Cesium.Color.fromCssColorString(CLASS_COLORS[cls] || '#9aa4b2');
}

async function layerIdFor(bin, suffix) {
  const res = await fetch(`${MAPSERVER}?f=json`);
  const meta = await res.json();
  const want = `${bin} ${suffix}`;
  const layer = (meta.layers || []).find((l) => l.name === want);
  return layer ? layer.id : null;
}

async function loadStormGIS(bin) {
  const out = {};
  for (const [key, suffix] of [['cone', 'Forecast Cone'], ['track', 'Forecast Track'], ['points', 'Forecast Points']]) {
    try {
      const id = await layerIdFor(bin, suffix);
      if (id == null) continue;
      const res = await fetch(
        `${MAPSERVER}/${id}/query?where=1%3D1&f=geojson&outSR=4326&geometryPrecision=4`
      );
      if (res.ok) out[key] = await res.json();
    } catch (err) {
      console.warn(`[cyclones] ${bin} ${suffix} unavailable:`, err);
    }
  }
  return out;
}

const spriteCache = new Map();

function hexToRgb(css) {
  // css is #rrggbb (from Cesium's toCssColorString()).
  const n = parseInt(css.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function rgba(rgb, a) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

// Storm badge: soft class-color glow, glassy dark disc (same design language
// as the cluster badges) so the mark reads on any basemap, tapered spiral
// arms running white-hot at the eyewall out to the class color at the rim,
// and a glowing eye at the center. Rasterized once per color at 3x.
function cycloneSprite(colorCss) {
  const cached = spriteCache.get(colorCss);
  if (cached) return cached;
  const base = 72;
  const SS = 3; // retina-sharp on DPR-3 phones
  const c = document.createElement('canvas');
  c.width = c.height = base * SS;
  const g = c.getContext('2d');
  g.scale(SS, SS); // draw in base coordinates
  const cx = base / 2;
  const cy = base / 2;
  const col = hexToRgb(colorCss);
  const white = [255, 255, 255];

  // 1. Soft outer glow in the classification color.
  const glow = g.createRadialGradient(cx, cy, 8, cx, cy, 36);
  glow.addColorStop(0, rgba(col, 0.34));
  glow.addColorStop(1, rgba(col, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, base, base);

  // 2. Glassy dark disc.
  const disc = g.createLinearGradient(0, cy - 26, 0, cy + 26);
  disc.addColorStop(0, 'rgba(14, 26, 44, 0.92)');
  disc.addColorStop(1, 'rgba(4, 9, 18, 0.92)');
  g.fillStyle = disc;
  g.beginPath();
  g.arc(cx, cy, 26, 0, Math.PI * 2);
  g.fill();

  // 3. Tapered spiral arms: white-hot near the eye, class color at the rim.
  g.lineCap = 'round';
  for (let arm = 0; arm < 3; arm++) {
    const phase = (arm * Math.PI * 2) / 3;
    const steps = 26;
    let px = 0;
    let py = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps; // 0 at the eye, 1 at the rim
      const a = phase + t * Math.PI * 1.7;
      const rad = 5 + t * 18;
      const x = cx + Math.cos(a) * rad;
      const y = cy + Math.sin(a) * rad;
      if (i > 0) {
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(x, y);
        g.strokeStyle = rgba(mixRgb(white, col, t), 0.95);
        g.lineWidth = 4.6 - t * 3.0;
        g.stroke();
      }
      px = x;
      py = y;
    }
  }

  // 4. The eye — white-hot core ringed in the classification color.
  const eye = g.createRadialGradient(cx - 1.5, cy - 1.5, 0.5, cx, cy, 5.5);
  eye.addColorStop(0, '#ffffff');
  eye.addColorStop(0.55, rgba(mixRgb(white, col, 0.45), 1));
  eye.addColorStop(1, rgba(col, 1));
  g.fillStyle = eye;
  g.beginPath();
  g.arc(cx, cy, 5.5, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(3, 8, 16, 0.6)';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(cx, cy, 5.5, 0, Math.PI * 2);
  g.stroke();

  // 5. Hairline class-color ring + glass catchlight arc.
  g.strokeStyle = rgba(col, 0.75);
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(cx, cy, 26, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, 21.5, Math.PI * 1.15, Math.PI * 1.85);
  g.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  g.lineWidth = 2;
  g.stroke();

  spriteCache.set(colorCss, c);
  return c;
}

// Gentle continuous rotation — the "animation" half of the concept. Spin rate
// follows storm class (hurricanes spin faster than depressions) and direction
// follows the hemisphere, like the real thing. Only a handful of storms ever
// exist at once, so one preRender tick is trivially cheap.
const SPIN_RATE = {
  HU: 0.6,
  TS: 0.45,
  SS: 0.45,
  TD: 0.3,
  SD: 0.3,
  EX: 0.22,
  PT: 0.22,
};
let spinners = [];
let lastSpinT = 0;

function tickSpirals() {
  if (!enabled || !dataSource || spinners.length === 0) return;
  const now = performance.now();
  const dt = lastSpinT ? Math.min((now - lastSpinT) / 1000, 0.1) : 0;
  lastSpinT = now;
  if (dt <= 0) return;
  for (const s of spinners) {
    s.angle = (s.angle + s.rate * dt) % (Math.PI * 2);
    s.ent.billboard.rotation = s.angle;
  }
}

async function load() {
  const res = await fetch('/proxy/nhc/storms');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const storms = data.activeStorms || [];

  const fresh = new Cesium.CustomDataSource('cyclones');
  spinners = [];
  for (const s of storms) {
    const lat = Number(s.latitudeNumeric);
    const lon = Number(s.longitudeNumeric);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const color = stormColor(s.classification);
    const name = s.name && s.name !== 'Unknown' ? s.name : s.id;
    // T5: storm markers are surface contacts — canonical resolver with the
    // standing 0 m surface policy (resolves to 0, as the old literal did).
    const stormH = pickRenderAltitudeM({ onGround: true, surfaceM: 0 }) ?? 0;
    const ent = fresh.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, stormH),
      billboard: {
        image: cycloneSprite(color.toCssColorString()),
        width: 64,
        height: 64,
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 3e7, 0.4),
        disableDepthTestDistance: 0,
      },
      label: {
        text: `${s.classification || ''} ${name} · ${s.intensity || '?'} kt`.trim(),
        font: '12px system-ui, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -38),
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 2e7, 0.0),
      },
      description:
        `<b>${s.classification || ''} ${name}</b><br>` +
        `Intensity: ${s.intensity || '?'} kt · ${s.pressure || '?'} mb<br>` +
        `Movement: ${s.movementDir ?? '?'}° at ${s.movementSpeed ?? '?'} kt`,
    });
    // Register the storm for gentle rotation: faster for stronger classes,
    // counterclockwise north of the equator / clockwise south of it, with a
    // random phase so multiple storms never spin in sync.
    spinners.push({
      ent,
      rate: (SPIN_RATE[s.classification] || 0.3) * (lat >= 0 ? 1 : -1),
      angle: Math.random() * Math.PI * 2,
    });

    // Forecast cone + track + points (best effort per storm).
    if (s.binNumber) {
      const gis = await loadStormGIS(s.binNumber);
      if (gis.cone) {
        for (const f of gis.cone.features || []) {
          if (f.geometry && f.geometry.type === 'Polygon') {
            fresh.entities.add({
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(
                  f.geometry.coordinates[0].map(([lo, la]) =>
                    Cesium.Cartesian3.fromDegrees(lo, la)
                  )
                ),
                material: color.withAlpha(0.16),
                outline: true,
                outlineColor: color.withAlpha(0.7),
              },
            });
          }
        }
      }
      if (gis.track) {
        for (const f of gis.track.features || []) {
          if (f.geometry && f.geometry.type === 'LineString') {
            fresh.entities.add({
              polyline: {
                positions: f.geometry.coordinates.map(([lo, la]) =>
                  Cesium.Cartesian3.fromDegrees(lo, la)
                ),
                width: 2,
                material: color.withAlpha(0.9),
                clampToGround: true,
              },
            });
          }
        }
      }
      if (gis.points) {
        for (const f of gis.points.features || []) {
          if (f.geometry && f.geometry.type === 'Point') {
            const [lo, la] = f.geometry.coordinates;
            // T5: forecast points are surface contacts — canonical resolver,
            // 0 m surface policy (resolves to 0, as the old literal did).
            const ptH = pickRenderAltitudeM({ onGround: true, surfaceM: 0 }) ?? 0;
            fresh.entities.add({
              position: Cesium.Cartesian3.fromDegrees(lo, la, ptH),
              point: { pixelSize: 6, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
            });
          }
        }
      }
    }
  }

  if (dataSource) viewer.dataSources.remove(dataSource, true);
  dataSource = fresh;
  dataSource.show = enabled;
  await viewer.dataSources.add(dataSource);
}

export function cyclonesEnabled() {
  return enabled;
}

export function cycloneCount() {
  return dataSource ? dataSource.entities.values.filter((e) => e.billboard).length : 0;
}

// Source heartbeat for the dock.
const srcStatus = { lastOk: 0, lastErr: '' };
/** Heartbeat for the Live Source Dock: { lastOk, lastErr }. */
export function cycloneStatus() { return srcStatus; }

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

export async function setCyclones(on) {
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
          releaseContinuousRender('cyclones');
          throw err;
        }
      });
    } else {
      dataSource.show = true;
    }
    // Keep the scene rendering while enabled so the preRender spiral
    // rotation animates even with the camera parked (request-render mode).
    holdContinuousRender('cyclones');
    if (!refreshTimer) {
      // A4-1: skip refreshes while the tab is hidden; one fires on return.
      refreshTimer = setInterval(() => {
        if (isHidden()) return;
        refresh().catch((err) => console.warn('[cyclones] refresh failed:', err));
      }, REFRESH_MS);
      registerPoll('cyclones', refresh);
    }
  } else if (dataSource) {
    dataSource.show = false;
    releaseContinuousRender('cyclones');
  }
  return enabled;
}

export function initCyclones(v) {
  viewer = v;
  viewer.scene.preRender.addEventListener(tickSpirals);
}
