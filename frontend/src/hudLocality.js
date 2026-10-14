/**
 * @module hudLocality
 * @description The locality half of the HUD summary line — either "NEAR <landmark>"
 * or the "SECTOR <lat/lon>" fallback.
 *
 * Split out of `hud.js` purely so it is unit-testable: `hud.js` pulls in the `mgrs`
 * CommonJS package, which Vite resolves but plain Node cannot import by named export.
 */

/**
 * Maximum distance to a curated POI that still reads as "NEAR" it.
 *
 * The 2026-08-20 QA hunt found the HUD announcing NEAR SACRE-COEUR (PARIS) 2470KM
 * while parked over Moscow, and NEAR LINCOLN MEMORIAL 962KM over Chicago — the old
 * bound was 2,500 km, roughly a continent. The POI catalogue only covers eight
 * cities, so anywhere else on Earth matched whichever landmark happened to be
 * closest and reported an absurd distance as if it were a locality.
 *
 * 150 km is metro scale: a camera over San Francisco still reads NEAR ALCATRAZ, a
 * camera over DC still reads NEAR its monuments, and Chicago (962 km from the
 * nearest catalogued POI) correctly falls through to the SECTOR readout that
 * already worked for Honolulu and Rio.
 */
export const NEAR_POI_MAX_KM = 150;

/**
 * Convert a decimal-degree value to a degrees-minutes-seconds string.
 *
 * Integer-centisecond math: 59.996" rounds up and carries into minutes (and
 * degrees) instead of printing an impossible 60.00" — the 2026-10-13 Stage-2
 * hands-on pass caught the HUD printing `17°59'60.00"N`.
 *
 * @param {number} decimal Coordinate in decimal degrees.
 * @param {'lat'|'lon'} type Axis selector; controls hemisphere letter and
 *   zero-padding width (2 digits for lat, 3 for lon).
 * @returns {string} Formatted DMS string, e.g. `"38°53'21.48"N"`.
 */
export function toDMS(decimal, type) {
  const totalCentisec = Math.round(Math.abs(decimal) * 360000);
  const deg = Math.floor(totalCentisec / 360000);
  const min = Math.floor((totalCentisec % 360000) / 6000);
  const sec = ((totalCentisec % 6000) / 100).toFixed(2);

  let dir;
  if (type === 'lat') dir = decimal >= 0 ? 'N' : 'S';
  else dir = decimal >= 0 ? 'E' : 'W';

  const degStr =
    type === 'lon'
      ? String(deg).padStart(3, '0')
      : String(deg).padStart(2, '0');
  return `${degStr}°${String(min).padStart(2, '0')}'${String(sec).padStart(5, '0')}"${dir}`;
}

/**
 * Format one hemisphere-tagged coordinate, e.g. `21.33N` / `157.80W`.
 * @param {number} value Signed decimal degrees.
 * @param {string} positive Suffix when the value is >= 0.
 * @param {string} negative Suffix when the value is < 0.
 * @returns {string}
 */
function coordinateTag(value, positive, negative) {
  return `${Math.abs(value).toFixed(2)}${value >= 0 ? positive : negative}`;
}

/**
 * Build the locality tag for the HUD summary line.
 *
 * @param {{poi: string, city: string, distKm: number}|null|undefined} nearest
 *   Closest catalogued POI with its great-circle distance, or null when the
 *   catalogue is empty.
 * @param {number} latDeg Camera latitude in decimal degrees.
 * @param {number} lonDeg Camera longitude in decimal degrees.
 * @returns {string} `NEAR <POI> (<CITY>) <N>KM` within the bound (inclusive),
 *   otherwise `SECTOR <lat> <lon>`.
 */
export function composeLocalityTag(nearest, latDeg, lonDeg) {
  const distKm = Number(nearest?.distKm);
  if (nearest && Number.isFinite(distKm) && distKm <= NEAR_POI_MAX_KM) {
    return `NEAR ${String(nearest.poi).toUpperCase()} (${String(nearest.city).toUpperCase()}) ${Math.round(distKm)}KM`;
  }
  return `SECTOR ${coordinateTag(latDeg, 'N', 'S')} ${coordinateTag(lonDeg, 'E', 'W')}`;
}
