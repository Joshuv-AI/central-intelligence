/* Active wildfire perimeters — NIFC WFIGS current interagency perimeters,
   keyless GeoJSON, CORS-open. Rendered via GeoJsonDataSource with per-feature
   styling: red = active, grey = 100% contained. Refreshed every 15 minutes.
   Credits: NIFC / WFIGS (noted in the Layers panel). */
import * as Cesium from 'cesium';

const QUERY_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query' +
  '?where=1%3D1&returnGeometry=true&geometryPrecision=4' +
  '&outFields=poly_IncidentName,poly_GISAcres,attr_PercentContained,attr_FireDiscoveryDateTime' +
  '&f=geojson';

const REFRESH_MS = 15 * 60 * 1000;

let viewer = null;
let dataSource = null;
let refreshTimer = 0;
let enabled = false;

function styleEntity(entity) {
  const p = entity.properties;
  const contained = p && Number(p.attr_PercentContained) >= 100;
  const color = contained
    ? Cesium.Color.fromCssColorString('#888888')
    : Cesium.Color.fromCssColorString('#ff3300');
  if (entity.polygon) {
    entity.polygon.material = color.withAlpha(0.22);
    entity.polygon.outlineColor = color;
    entity.polygon.outlineWidth = 2;
    entity.polygon.outline = true;
  }
  if (p) {
    const name = p.poly_IncidentName || 'Unnamed fire';
    const acres = p.poly_GISAcres ? Math.round(Number(p.poly_GISAcres)).toLocaleString() : '?';
    entity.name = name;
    entity.description =
      `<b>${name}</b><br>Acres: ${acres}<br>Contained: ${p.attr_PercentContained ?? '?'}%`;
  }
}

async function load() {
  const fresh = await Cesium.GeoJsonDataSource.load(QUERY_URL, {
    clampToGround: true,
  });
  for (const entity of fresh.entities.values) styleEntity(entity);
  if (dataSource) viewer.dataSources.remove(dataSource, true);
  dataSource = fresh;
  dataSource.show = enabled;
  await viewer.dataSources.add(dataSource);
}

export function firesEnabled() {
  return enabled;
}

export function fireCount() {
  return dataSource ? dataSource.entities.values.length : 0;
}

export async function setFires(on) {
  enabled = on;
  if (!viewer) return enabled;
  if (on) {
    if (!dataSource) {
      try {
        await load();
      } catch (err) {
        console.warn('[fires] perimeters unavailable:', err);
        enabled = false;
        return enabled;
      }
    } else {
      dataSource.show = true;
    }
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        load().catch((err) => console.warn('[fires] refresh failed:', err));
      }, REFRESH_MS);
    }
  } else if (dataSource) {
    dataSource.show = false;
  }
  return enabled;
}

export function initFires(v) {
  viewer = v;
}
