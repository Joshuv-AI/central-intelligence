/* Infrastructure layer — OSM-derived datacenters + dams rendered through the
   generic local-GeoJSON engine (frontend/src/data/localGeojson.js).

   Data: frontend/src/data/datacenters.json (4,351 features, pre-centroided to
   points at build time) + frontend/src/data/dams.json (704 features).
   Zero network at runtime; bundled into the app JS (slimmed to name/operator/
   output/river only, ~820KB total).

   ODbL attribution: both datasets are © OpenStreetMap contributors under the
   Open Database License 1.0 (dams also credit Open Infrastructure Map).
   Keep that credit in the UI wherever this layer is surfaced. */
import { createLocalGeojsonLayer } from '../../data/localGeojson.js';
import DATACENTERS from '../../data/datacenters.json';
import DAMS from '../../data/dams.json';

let viewer = null;
let enabled = false;
let datacenterLayer = null;
let damLayer = null;

export function infrastructureEnabled() { return enabled; }

export function setInfrastructure(on) {
  enabled = on;
  if (!viewer) return enabled;
  ensureLayers();
  if (enabled) {
    datacenterLayer.show();
    damLayer.show();
  } else {
    datacenterLayer.hide();
    damLayer.hide();
  }
  return enabled;
}

export function initInfrastructure(v) {
  viewer = v;
}

function ensureLayers() {
  if (datacenterLayer) return;
  datacenterLayer = createLocalGeojsonLayer(viewer, {
    id: 'local-datacenters',
    data: DATACENTERS,
    name: 'Datacenters',
    color: '#22d3ee', // cyan
    dotPx: 9,
    stemHeightM: 3000,
    maxHeightM: 12_000_000,
    detailHeightM: 2_500_000,
    labelMax: 120,
  });
  damLayer = createLocalGeojsonLayer(viewer, {
    id: 'local-dams',
    data: DAMS,
    name: 'Dams',
    color: '#3b82f6', // blue
    dotPx: 10,
    stemHeightM: 3500,
    maxHeightM: 12_000_000,
    detailHeightM: 2_500_000,
    labelMax: 120,
  });
}
