// src/data/renderAltitude.js — canonical render-altitude resolver.
//
// Ported from God's Eye View src/data/renderAltitude.js (Task 6 of
// docs/plans/2026-07-05-entity-height-datum-fix.md). Pure priority-chain
// helper: every layer that places an entity on the globe asks this ONE
// function for the render height, so the "is this MSL or ellipsoid?" question
// is answered in exactly one place.
//
// Datum semantics (the whole reason this module exists):
//   The globe needs ELLIPSOIDAL height (h = H + N) for
//   `Cartesian3.fromDegrees(lon, lat, h)`. A WGS84 geometric altitude
//   (adsb.lol `alt_geom`, SGP4 `eciToGeodetic` height) is ALREADY ellipsoidal
//   and is handed through VERBATIM. A barometric/MSL altitude (`alt_baro`)
//   is only a VISUAL FALLBACK when no geometric value exists — it is
//   corrected by adding the local geoid undulation N (h ≈ H + N) so it lands
//   close to the ellipsoid instead of sinking into high-elevation terrain.
//   This module makes NO claim that baro+N is geometrically exact.
//
// CI note (2026-09-30): CI has no geoid module and no ellipsoidal-ground
// cache, so no layer computes `geoidN` or `surfaceM` today — callers pass
// `geoidN` as absent (treated as 0) and `surfaceM` as 0/absent per their
// existing policy, until a geoid source lands. The `null` sentinel below is
// load-bearing: the helper NEVER invents a fallback, so it can't drift from
// the caller's own sticky/default policy.

/**
 * Canonical render-altitude priority chain.
 *
 * @param {object} params
 * @param {number|null|undefined} params.geoAltM - Geometric/WGS84-ellipsoidal
 *   altitude (m), if reported (e.g. adsb.lol `alt_geom`, SGP4 height).
 * @param {number|null|undefined} params.baroAltM - Barometric/MSL altitude
 *   (m), if reported.
 * @param {boolean} params.onGround - Contact is on the ground (e.g.
 *   adsb.lol `alt_baro === 'ground'`; ships/vessels are surface by
 *   definition).
 * @param {number|null|undefined} params.surfaceM - Ellipsoidal ground height
 *   at this lat/lon, if known; CI has no ground cache, so surface contacts
 *   pass 0 (their existing policy) or nothing.
 * @param {number|null|undefined} [params.geoidN] - Geoid undulation N (m) at
 *   this lat/lon; treated as 0 when absent (no layer computes one in CI yet,
 *   so baro falls back uncorrected for now).
 * @returns {number|null} Ellipsoidal render height in metres, or `null`
 *   (sentinel) when none of the above are usable — the caller applies its OWN
 *   existing fallback (sticky last-known, 0, etc.). Never invents one.
 */
export function pickRenderAltitudeM({
  geoAltM,
  baroAltM,
  onGround,
  surfaceM,
  geoidN,
}) {
  if (onGround && Number.isFinite(surfaceM)) {
    return surfaceM;
  }
  if (Number.isFinite(geoAltM)) {
    return geoAltM;
  }
  if (Number.isFinite(baroAltM)) {
    return baroAltM + (Number.isFinite(geoidN) ? geoidN : 0);
  }
  return null;
}
