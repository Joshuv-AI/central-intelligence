/* Submarine cable layer — TeleGeography bundled data, rendered locally.

   Data: TeleGeography, CC BY-NC-SA 3.0 — personal use OK; MUST be
   removed/relicensed if this project goes commercial.
   Attribution required in the UI: "© TeleGeography — submarinecablemap.com"

   What it does: renders 712 submarine cable systems as subtle clamped-to-
   ground route polylines (one color) plus 1,917 landing-point markers.
   Zero network at runtime — both GeoJSON files are bundled and imported.
   Layer defaults OFF; entities are built on first enable and the data source
   is removed (not hidden) on disable, so an off layer costs nothing.

   Ported rendering pattern from God's Eye View src/layers/submarineCables/
   (MIT), simplified: no reference stems, no overlay label lane, no per-cable
   colors — one subtle color for the whole dataset. */
import * as Cesium from 'cesium';
import CABLES from '../../data/cable-geo.json';
import LANDINGS from '../../data/landing-point-geo.json';

const CABLE_COLOR = '#2dd4bf'; // teal, subtle
const LANDING_COLOR = '#fbbf24'; // amber
const MAX_LINE_VERTICES = 400; // cap degenerate lines; honest trim, keeps shape

let viewer = null;
let enabled = false;
let dataSource = null;

export function submarineCablesEnabled() { return enabled; }

function cleanText(v) {
  const t = String(v ?? '').trim();
  return t || null;
}

function buildEntities() {
  const ds = new Cesium.CustomDataSource('submarine-cables');
  const cableColor = Cesium.Color.fromCssColorString(CABLE_COLOR).withAlpha(0.55);
  const entities = ds.entities;
  let cableCount = 0;
  for (const feature of CABLES.features || []) {
    const name = cleanText(feature?.properties?.name) || 'Unnamed cable';
    const lines = feature?.geometry?.type === 'MultiLineString'
      ? feature.geometry.coordinates
      : [];
    for (let i = 0; i < lines.length; i++) {
      const coords = lines[i];
      if (!Array.isArray(coords) || coords.length < 2) continue;
      // Thin out absurdly dense lines; stride keeps every vertex otherwise.
      const stride = Math.max(1, Math.ceil(coords.length / MAX_LINE_VERTICES));
      const pts = [];
      for (let j = 0; j < coords.length; j += stride) {
        const lon = Number(coords[j][0]);
        const lat = Number(coords[j][1]);
        if (Number.isFinite(lon) && Number.isFinite(lat)) pts.push([lon, lat]);
      }
      if (pts.length < 2) continue;
      entities.add({
        id: `cable:${cableCount}:${i}`,
        name,
        polyline: {
          positions: pts.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
          width: 1.5,
          material: cableColor,
          clampToGround: true,
        },
      });
    }
    cableCount++;
  }
  const landingColor = Cesium.Color.fromCssColorString(LANDING_COLOR);
  let landingCount = 0;
  for (const feature of LANDINGS.features || []) {
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const props = feature.properties || {};
    entities.add({
      id: `landing:${landingCount}`,
      name: cleanText(props.name) || 'Landing point',
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize: props.is_tbd ? 4 : 6,
        color: props.is_tbd ? landingColor.withAlpha(0.5) : landingColor.withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
    landingCount++;
  }
  return ds;
}

export function setSubmarineCables(on) {
  enabled = on;
  if (!viewer) return enabled;
  if (enabled) {
    if (!dataSource) {
      dataSource = buildEntities();
      viewer.dataSources.add(dataSource);
    }
  } else if (dataSource) {
    // Remove, don't hide: a hidden source's visualizers are still walked
    // every frame. The parsed JSON stays cached, so re-enable is free.
    viewer.dataSources.remove(dataSource, true);
    dataSource = null;
  }
  return enabled;
}

export function initSubmarineCables(v) {
  viewer = v;
}
