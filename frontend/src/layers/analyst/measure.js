/**
 * J4-09 · Measure tool math — pure, no Cesium, no DOM.
 *
 * Distance: haversine over WGS-84 sphere. Area: spherical-excess ring area
 * (same family as the naturalEarthRegions pack math). Good to ~0.5% for the
 * analyst use case; the UI labels results as approximate.
 */
const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total path length through ordered {lat, lon} points. */
export function pathLengthKm(points) {
  const pts = Array.isArray(points) ? points : [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  }
  return total;
}

/** Spherical-excess area of a polygon; the ring is closed implicitly. */
export function polygonAreaKm2(points) {
  const pts = Array.isArray(points) ? points : [];
  const n = pts.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = [pts[i].lon, pts[i].lat];
    const [lon2, lat2] = [pts[(i + 1) % n].lon, pts[(i + 1) % n].lat];
    sum += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

export function formatDistance(km) {
  if (!Number.isFinite(km) || km < 0) return '—';
  if (km < 1) return `≈${Math.round(km * 1000)} m`;
  if (km < 100) return `≈${km.toFixed(1)} km`;
  return `≈${Math.round(km).toLocaleString('en-US')} km`;
}

export function formatArea(km2) {
  if (!Number.isFinite(km2) || km2 < 0) return '—';
  if (km2 < 100) return `≈${km2.toFixed(1)} km²`;
  return `≈${Math.round(km2).toLocaleString('en-US')} km²`;
}

/** Measure is only meaningful zoomed in — §L: active at B2 and below. */
export function measureAllowed(band) {
  return band === 'B2' || band === 'B3' || band === 'B4' || band === 'B5';
}

export const MEASURE_GATED_HINT =
  'Zoom in to at least regional view to measure — globe-scale measuring is noise.';
