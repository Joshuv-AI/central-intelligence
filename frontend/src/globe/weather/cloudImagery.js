/* Satellite cloud imagery — adapted from God's Eye View
   (src/layers/weather/infraredImage.js + infraredAlpha.js, MIT).

   Real satellite cloud/IR imagery composited as an alpha layer over the
   globe (and optionally into the weather shell stack), giving true
   current-conditions context — "what does the sky look like right now".

   Sources are keyless WMS, CORS-open, matching CI's existing weather/index.js
   pattern (NOAA nowCOAST GeoServer). Two products:
     - clouds  : GOES true-color / visible cloud mosaic
     - ir      : infrared cloud-top imagery (night-capable)

   The layer can also feed a snapshot canvas into the 3D shell stack
   (weatherShells.js) so clouds render as a raised shell instead of a flat
   decal — see setShellHook().

   Usage:
     import { setCloudImagery, initCloudImagery } from './cloudImagery.js';
     initCloudImagery(viewer);
     setCloudImagery('clouds', true);
*/
import * as Cesium from 'cesium';

const SAT = 'https://nowcoast.noaa.gov/geoserver/satellite/ows';

const LAYERS = {
  clouds: {
    label: 'Clouds (visible)',
    swatch: '#bcd8ff',
    url: SAT,
    layers: 'abi_conus_truecolor',
    alpha: 0.8,
  },
  ir: {
    label: 'Clouds (infrared)',
    swatch: '#8fb4ff',
    url: SAT,
    layers: 'abi_conus_ir',
    alpha: 0.7,
  },
};

let viewer = null;
// key -> ImageryLayer
const active = new Map();
// Optional hook: (product, imageryLayer) => void — used to push a snapshot
// into the 3D weather shell stack.
let shellHook = null;

export function cloudImageryLayers() {
  return LAYERS;
}

export function cloudImageryEnabled(key) {
  const layer = active.get(key);
  return !!layer && layer.show !== false;
}

export function setShellHook(fn) {
  shellHook = typeof fn === 'function' ? fn : null;
}

export function setCloudImagery(key, on) {
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
        try {
          shellHook?.(key, layer);
        } catch {
          /* shell compositing is optional */
        }
      } catch (err) {
        console.warn(`[cloudImagery] ${key} unavailable:`, err);
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

export function initCloudImagery(v) {
  viewer = v;
}
