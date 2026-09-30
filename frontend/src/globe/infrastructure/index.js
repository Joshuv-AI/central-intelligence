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

/** Point record for a datacenter billboard (for the detail card). */
export function getDatacenter(idx) {
  const pts = datacenterLayer?.points;
  const p = pts && pts[idx];
  return p ? { idx, name: p.name, operator: p.sub, lon: p.lon, lat: p.lat } : null;
}

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
    dotPx: 7, // slightly larger than the 5px pass (9px overloaded the globe at 4,351 features)
    idPrefix: 'dc-', // clickable: billboards carry `dc-<index>` ids so pickAt can open a detail card.
    stemHeightM: 3000,
    // Zoom-gated rendering: dots only appear below 650 km camera height
    // (same gate convention as civil flights in globe/flights/index.js —
    // CIVIL_ZOOM_HEIGHT_M = 650_000), so the global view stays clean and the
    // layer no longer floods the globe with dots. Stems + labels only below
    // 250 km, i.e. genuinely zoomed into a region.
    maxHeightM: 650_000,
    detailHeightM: 250_000,
    labelMax: 120,
  });
}
