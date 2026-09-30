/* Tropical cyclones — NHC CurrentStorms.json via /proxy (no CORS at source),
   forecast cone/track/points from the NHC tropical MapServer (CORS-open,
   queried directly as GeoJSON). 10-minute refresh.
   Data: NOAA National Hurricane Center (US public domain). */
import * as Cesium from 'cesium';
import { makeBackgroundLoader } from '../layerLoad.js';
import { isHidden, registerPoll } from '../../data/visibility.js';
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

function cycloneSprite(colorCss) {
  const base = 56;
  const SS = 3; // retina-sharp on DPR-3 phones
  const size = base * SS;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(SS, SS); // draw in base coordinates
  g.strokeStyle = colorCss;
  g.lineWidth = 5;
  g.lineCap = 'round';
  // Spiral arms.
  for (let arm = 0; arm < 3; arm++) {
    g.beginPath();
    for (let t = 0; t <= 1.001; t += 0.05) {
      const a = t * Math.PI * 1.6 + (arm * Math.PI * 2) / 3;
      const r = 6 + t * 19;
      const x = base / 2 + Math.cos(a) * r;
      const y = base / 2 + Math.sin(a) * r;
      if (t === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.fillStyle = colorCss;
  g.beginPath();
  g.arc(base / 2, base / 2, 5, 0, Math.PI * 2);
  g.fill();
  return c;
}

async function load() {
  const res = await fetch('/proxy/nhc/storms');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const storms = data.activeStorms || [];

  const fresh = new Cesium.CustomDataSource('cyclones');
  for (const s of storms) {
    const lat = Number(s.latitudeNumeric);
    const lon = Number(s.longitudeNumeric);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const color = stormColor(s.classification);
    const name = s.name && s.name !== 'Unknown' ? s.name : s.id;
    // T5: storm markers are surface contacts — canonical resolver with the
    // standing 0 m surface policy (resolves to 0, as the old literal did).
    const stormH = pickRenderAltitudeM({ onGround: true, surfaceM: 0 }) ?? 0;
    fresh.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, stormH),
      billboard: {
        image: cycloneSprite(color.toCssColorString()),
        width: 56,
        height: 56,
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
        pixelOffset: new Cesium.Cartesian2(0, -34),
        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 2e7, 0.0),
      },
      description:
        `<b>${s.classification || ''} ${name}</b><br>` +
        `Intensity: ${s.intensity || '?'} kt · ${s.pressure || '?'} mb<br>` +
        `Movement: ${s.movementDir ?? '?'}° at ${s.movementSpeed ?? '?'} kt`,
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
        refresh().catch((err) => console.warn('[cyclones] refresh failed:', err));
      }, REFRESH_MS);
      registerPoll('cyclones', refresh);
    }
  } else if (dataSource) {
    dataSource.show = false;
  }
  return enabled;
}

export function initCyclones(v) {
  viewer = v;
}
