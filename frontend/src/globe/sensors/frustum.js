/**
 * Sensor-frustum ground projection — pure math, NO Cesium, NO DOM, NO I/O.
 * Unit-testable; safe to import anywhere.
 *
 * Port of the corner-ray + far-cap math from bilawalsidhu/gods-eye-view
 * (MIT, © 2026 Bilawal Sidhu — see THIRD-PARTY-NOTICES.md):
 *   - src/layers/cctv/geometry.js (computeFrustumGeometry — the pitched
 *     frustum pyramid: mount, far-cap center, four far-plane corners)
 *   - src/data/cctvFootprint.js (planeDimensions — half-widths from the
 *     horizontal FOV, vertical FOV derived from the 16:9 plane aspect)
 *   - src/layers/cctv/model.js (projectPoint — spherical-earth direct
 *     geodesic destination formula, R = 6371 km)
 *
 * This is the projection TECHNIQUE only. It turns a sensor pose into a ground
 * footprint polygon — for satellite footprints and event affected-radius
 * cones. It is NOT a camera layer and performs no scene queries.
 *
 * Model: the sensor sits at (lat, lon) and looks along `headingDeg`,
 * depressed `tiltDeg` below the horizontal, with a horizontal field of view
 * `fovDeg` and a slant range `rangeMeters`. The frustum's far-cap rectangle is
 * computed in plan view (dropped to the ground) and returned as a closed
 * [lon, lat] ring. That rectangle IS the true ground footprint for a nadir
 * look (tiltDeg = 90); for shallow tilts it is the far-cap's ground
 * projection — an approximation that ignores sensor altitude, which is exact
 * enough for coverage overlays and honest about being one (see below).
 */

const EARTH_RADIUS_M = 6371000;
/** Plane aspect the vertical FOV is derived from (16:9 monitor plane). */
const PLANE_VERT_ASPECT = 16 / 9;
const DEG = Math.PI / 180;

const toRad = (deg) => deg * DEG;
const toDeg = (rad) => rad / DEG;

/**
 * Destination point: project from (lat, lon) along a bearing by a distance.
 * Spherical-earth direct geodesic formula. Pure.
 * @param {number} latDeg - Origin latitude, degrees.
 * @param {number} lonDeg - Origin longitude, degrees.
 * @param {number} bearingDeg - Azimuth from north, degrees (any value).
 * @param {number} distanceM - Distance, metres (may be negative).
 * @returns {{lat:number, lon:number}} Destination in degrees; lon normalized.
 */
function destinationPoint(latDeg, lonDeg, bearingDeg, distanceM) {
  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(latDeg);
  const lon1 = toRad(lonDeg);
  const sinLat2 =
    Math.sin(lat1) * Math.cos(angular) +
    Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const y = Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1);
  const x = Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2);
  const lon2 = lon1 + Math.atan2(y, x);
  let lonDegOut = toDeg(lon2);
  lonDegOut = ((lonDegOut + 540) % 360) - 180; // normalize to [-180, 180]
  return { lat: toDeg(lat2), lon: lonDegOut };
}

/**
 * Far-cap rectangle dimensions for a pose. Pure.
 * @param {number} rangeM - Slant range, metres.
 * @param {number} tiltDeg - Depression below horizontal, degrees.
 * @param {number} fovDeg - Horizontal field of view, degrees.
 * @returns {{halfW:number, halfH:number, horiz:number, upHoriz:number, vFovDeg:number}}
 */
function frustumDimensions(rangeM, tiltDeg, fovDeg) {
  const R = rangeM;
  const tilt = toRad(tiltDeg);
  const hFov = toRad(fovDeg);
  const halfW = R * Math.tan(hFov / 2);
  const vFov = 2 * Math.atan(Math.tan(hFov / 2) / PLANE_VERT_ASPECT);
  const halfH = R * Math.tan(vFov / 2);
  return {
    halfW,
    halfH,
    // Plan-view extent of the cap center along the heading.
    horiz: R * Math.cos(tilt),
    // In-plane "up" decomposed: a downward tilt throws the cap's top forward.
    upHoriz: Math.sin(tilt) * halfH,
    vFovDeg: toDeg(vFov),
  };
}

/**
 * Validate a frustum pose. Honest refusal: null on anything degenerate —
 * never guess a footprint from bad numbers.
 * @param {Object} params
 * @returns {Object|null} Cleaned pose {lat, lon, headingDeg, fovDeg, rangeMeters, tiltDeg}, or null.
 */
function validateFrustumPose(params) {
  if (!params || typeof params !== 'object') return null;
  const lat = Number(params.lat);
  const lon = Number(params.lon);
  const headingDeg = Number(params.headingDeg);
  const fovDeg = Number(params.fovDeg);
  const rangeMeters = Number(params.rangeMeters);
  const tiltDeg = Number(params.tiltDeg);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon)) return null;
  if (!Number.isFinite(headingDeg)) return null;
  if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) return null;
  if (!Number.isFinite(rangeMeters) || rangeMeters <= 0) return null;
  if (!Number.isFinite(tiltDeg) || tiltDeg < 0 || tiltDeg > 90) return null;
  return { lat, lon, headingDeg, fovDeg, rangeMeters, tiltDeg };
}

/**
 * Unwrap ring longitudes so consecutive vertices never jump more than 180°.
 * Pure.
 * @param {Array<[number, number]>} ring - [lon, lat] vertices.
 * @returns {Array<[number, number]>} New ring with continuous longitudes.
 */
function unwrapLongitudes(ring) {
  const out = [];
  let prev = null;
  for (const [lon, lat] of ring) {
    let l = lon;
    if (prev !== null) {
      while (l - prev > 180) l -= 360;
      while (l - prev < -180) l += 360;
    }
    out.push([l, lat]);
    prev = l;
  }
  return out;
}

/**
 * Haversine distance, metres. Pure.
 */
function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial bearing from point 1 to point 2, degrees from north. Pure.
 */
function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Project a sensor frustum onto the ground.
 * @param {Object} params
 * @param {number} params.lat - Sensor latitude, degrees [-90, 90].
 * @param {number} params.lon - Sensor longitude, degrees.
 * @param {number} params.headingDeg - Look azimuth from north, degrees.
 * @param {number} params.fovDeg - Horizontal field of view, degrees (0, 180).
 * @param {number} params.rangeMeters - Slant range, metres (> 0).
 * @param {number} params.tiltDeg - Depression below horizontal, degrees
 *   [0, 90]; 90 is a straight-down (nadir) look.
 * @returns {Array<[number, number]>|null} Closed [lon, lat] ring
 *   (tl → tr → br → bl → tl), longitudes unwrapped across the antimeridian,
 *   or null on degenerate input.
 */
export function projectFrustum(params) {
  const pose = validateFrustumPose(params);
  if (!pose) return null;
  const { lat, lon, headingDeg, fovDeg, rangeMeters, tiltDeg } = pose;
  const dims = frustumDimensions(rangeMeters, tiltDeg, fovDeg);

  const cap = destinationPoint(lat, lon, headingDeg, dims.horiz);
  const left = destinationPoint(cap.lat, cap.lon, headingDeg - 90, dims.halfW);
  const right = destinationPoint(cap.lat, cap.lon, headingDeg + 90, dims.halfW);
  const corner = (side, sign) => {
    const p = destinationPoint(side.lat, side.lon, headingDeg, sign * dims.upHoriz);
    return [p.lon, p.lat];
  };
  const ring = [
    corner(left, 1), // tl
    corner(right, 1), // tr
    corner(right, -1), // br
    corner(left, -1), // bl
  ];
  const unwrapped = unwrapLongitudes(ring);
  unwrapped.push([...unwrapped[0]]); // close the ring
  return unwrapped;
}

/**
 * Centroid of the ground-projected footprint.
 * @param {Object} params - Same pose as projectFrustum.
 * @returns {[number, number]|null} [lon, lat] of the footprint center, or null
 *   on degenerate input.
 */
export function frustumCenter(params) {
  const ring = projectFrustum(params);
  if (!ring) return null;
  // Average the four corners (drop the closing duplicate); longitudes are
  // already unwrapped, so the mean is antimeridian-safe.
  const corners = ring.slice(0, 4);
  const lon = corners.reduce((s, [lo]) => s + lo, 0) / corners.length;
  const lat = corners.reduce((s, [, la]) => s + la, 0) / corners.length;
  return [((lon + 540) % 360) - 180, lat];
}

/**
 * Clamp every vertex of a footprint ring to a maximum ground distance from
 * the mount point (the horizon cap for a range-limited sensor).
 * @param {Array<[number, number]>} ring - [lon, lat] vertices (open or closed).
 * @param {Object} center
 * @param {number} center.lat - Mount latitude, degrees.
 * @param {number} center.lon - Mount longitude, degrees.
 * @param {number} center.maxRangeM - Maximum ground distance, metres (> 0).
 * @returns {Array<[number, number]>|null} Clamped ring (closure preserved),
 *   or null on degenerate input.
 */
export function clampFrustumToHorizon(ring, center) {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  if (!center || typeof center !== 'object') return null;
  const lat = Number(center.lat);
  const lon = Number(center.lon);
  const maxRangeM = Number(center.maxRangeM);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon)) return null;
  if (!Number.isFinite(maxRangeM) || maxRangeM <= 0) return null;
  const out = ring.map((pt) => {
    if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1]))
      return null;
    const d = haversineM(lat, lon, pt[1], pt[0]);
    if (d <= maxRangeM) return [pt[0], pt[1]];
    const bearing = initialBearingDeg(lat, lon, pt[1], pt[0]);
    const p = destinationPoint(lat, lon, bearing, maxRangeM);
    return [p.lon, p.lat];
  });
  if (out.some((pt) => pt === null)) return null;
  return unwrapLongitudes(out);
}
