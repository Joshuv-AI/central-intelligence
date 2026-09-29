/* Weather imagery — NOAA nowCOAST GeoServer WMS (keyless, CORS-open):
   NEXRAD radar mosaic. Toggleable Cesium imagery layer, refreshed by
   re-requesting (WMS always serves the latest time when TIME is omitted). */
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
};

let viewer = null;
// key -> ImageryLayer
const active = new Map();

export function weatherEnabled(key) {
  const layer = active.get(key);
  return !!layer && layer.show !== false;
}

export function weatherLayers() {
  return LAYERS;
}

export function setWeather(key, on) {
  const def = LAYERS[key];
  if (!viewer || !def) return false;
  let layer = active.get(key);
  if (on) {
    if (!layer) {
      try {
        const provider = new Cesium.WebMapServiceImageryProvider({
          url: def.url,
          layers: def.layers,
          parameters: { transparent: 'TRUE', format: 'image/png' },
        });
        layer = viewer.imageryLayers.addImageryProvider(provider);
        layer.alpha = def.alpha;
        active.set(key, layer);
      } catch (err) {
        console.warn(`[weather] ${key} unavailable:`, err);
        return false;
      }
    }
    // Toggle visibility instead of add/remove — instant, no re-fetch.
    layer.show = true;
  } else if (layer) {
    // Hide but keep cached for instant re-show.
    layer.show = false;
  }
  return on;
}

export function initWeather(v) {
  viewer = v;
}
