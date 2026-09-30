/* Infrastructure layer — OSM-derived datacenters rendered through the
   generic local-GeoJSON engine (frontend/src/data/localGeojson.js).

   Data: frontend/src/data/datacenters.json (4,351 features, pre-centroided to
   points at build time), slimmed to name/operator only. Zero network at
   runtime; bundled into the app JS.

   2026-09-30 (Joshua): dams removed from this toggle — datacenters only.

   ODbL attribution: © OpenStreetMap contributors under the Open Database
   License 1.0. Keep that credit in the UI wherever this layer is surfaced. */
import { createLocalGeojsonLayer } from '../../data/localGeojson.js';
import DATACENTERS from '../../data/datacenters.json';

let viewer = null;
let enabled = false;
let datacenterLayer = null;

export function infrastructureEnabled() { return enabled; }

export function setInfrastructure(on) {
  enabled = on;
  if (!viewer) return enabled;
  ensureLayers();
  if (enabled) datacenterLayer.show();
  else datacenterLayer.hide();
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
}
