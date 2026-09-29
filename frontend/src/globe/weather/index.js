/* Weather imagery — NOAA nowCOAST GeoServer WMS (keyless, CORS-open):
   NEXRAD radar mosaic, lightning strike density. Each is a toggleable
   Cesium imagery layer, refreshed by re-requesting (WMS always serves
   the latest time when TIME is omitted). */
import * as Cesium from 'cesium';

const BASE = 'https://nowcoast.noaa.gov/geoserver/observations';

const LAYERS = {
  radar: {
    label: 'Radar',
    swatch: '#37e08b',
    url: `${BASE}/weather_radar/ows`,
    layers: 'conus_base_reflectivity_mosaic',
    alpha: 0.75,
  },
  lightning: {
    label: 'Lightning',
    swatch: '#ffe14d',
    url: `${BASE}/lightning_detection/ows`,
    layers: 'lightning_density',
    alpha: 0.8,
  },
};

let viewer = null;
// key -> ImageryLayer
const active = new Map();

export function weatherEnabled(key) {
  return active.has(key);
}

export function weatherLayers() {
  return LAYERS;
}

export function setWeather(key, on) {
  const def = LAYERS[key];
  if (!viewer || !def) return false;
  const existing = active.get(key);
  if (on && !existing) {
    try {
      const provider = new Cesium.WebMapServiceImageryProvider({
        url: def.url,
        layers: def.layers,
        parameters: { transparent: 'TRUE', format: 'image/png' },
      });
      const layer = viewer.imageryLayers.addImageryProvider(provider);
      layer.alpha = def.alpha;
      active.set(key, layer);
    } catch (err) {
      console.warn(`[weather] ${key} unavailable:`, err);
      return false;
    }
  } else if (!on && existing) {
    viewer.imageryLayers.remove(existing, true);
    active.delete(key);
  }
  return active.has(key);
}

export function initWeather(v) {
  viewer = v;
}
