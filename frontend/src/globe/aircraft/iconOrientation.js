/* Screen-space icon orientation — ported from bilawalsidhu/gods-eye-view (MIT,
   © 2026 Bilawal Sidhu — see THIRD-PARTY-NOTICES.md): src/data/iconOrientation.js,
   adapted to Central Intelligence's module layout.
   SPDX-SnippetLicense: MIT (original)

   THE ORIENTATION PROBLEM: billboards are camera-facing quads, so "point along
   the real-world course" must be computed in SCREEN space. Setting
   billboard.rotation = heading (radians) is wrong twice over: Cesium's
   rotation is CCW-positive in screen space (mat2(cosθ, sinθ, −sinθ, cosθ)),
   so raw heading mirrors east/west — an eastbound icon points west — and it
   ignores the camera heading entirely, so orbiting the camera leaves icons
   pointing at stale compass directions.

   THE FIX: transform the local course vector into world space, then project
   it directly onto the camera's right/up basis. This stays valid when a
   forward probe point would be off-screen or behind the camera during a
   >180° tracked orbit. The camera-basis projection is exact at the viewport
   center and an intentional orthographic approximation elsewhere: an
   off-center contact at oblique pitch can diverge from a pinhole projection
   because the latter also includes the course vector's depth component. The
   approximation keeps rotation continuous through tracked orbits. */
import * as Cesium from 'cesium';

/** Meters used to give the course vector a stable projection magnitude. */
const FORWARD_PROBE_M = 2000;
/**
 * Minimum camera-plane component before we trust the angle — below this the
 * course points almost exactly into/out of the screen and the angle is noise.
 */
const MIN_SCREEN_COMPONENT_M = 0.5;
/** Ignore sub-degree projection noise while retaining deliberate camera-orbit rotation. */
const ROTATION_DEADBAND_RAD = Cesium.Math.toRadians(0.5);

const _scratchEnu = new Cesium.Matrix4();
const _scratchForward = new Cesium.Cartesian3();
const _scratchWorldForward = new Cesium.Cartesian3();

/**
 * Computes the billboard rotation (radians, CCW-positive) that points an icon
 * along its real-world course in screen space.
 *
 * @param {Cesium.Scene} scene - The scene (projection source).
 * @param {Cesium.Cartesian3} position - Entity world position.
 * @param {number} courseDeg - Course/track in degrees clockwise from north.
 * @param {number|null} previous - Rotation to keep when projection is
 *   unavailable (off-screen/behind camera/degenerate).
 * @returns {number|null} Rotation in radians, or `previous` when unknown.
 */
export function screenProjectedRotation(
  scene,
  position,
  courseDeg,
  previous = null,
) {
  const camera = scene?.camera;
  if (!camera?.rightWC || !camera?.upWC || !position) return previous;

  const courseRad = Cesium.Math.toRadians(courseDeg || 0);
  Cesium.Cartesian3.fromElements(
    Math.sin(courseRad) * FORWARD_PROBE_M,
    Math.cos(courseRad) * FORWARD_PROBE_M,
    0,
    _scratchForward,
  );
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
    position,
    Cesium.Ellipsoid.WGS84,
    _scratchEnu,
  );
  Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    _scratchForward,
    _scratchWorldForward,
  );

  // Screen x follows camera-right. Window y grows downward, the opposite of
  // camera-up. Projecting the vector itself avoids clipping/behind-camera
  // failure modes of a forward-point worldToWindowCoordinates probe.
  const dx = Cesium.Cartesian3.dot(_scratchWorldForward, camera.rightWC);
  const dy = -Cesium.Cartesian3.dot(_scratchWorldForward, camera.upWC);
  if (dx * dx + dy * dy < MIN_SCREEN_COMPONENT_M * MIN_SCREEN_COMPONENT_M)
    return previous;

  // Window y grows downward; rotation 0 = icon pointing screen-up.
  // Icon direction in window coords after CCW rotation r is (-sin r, -cos r),
  // so matching the projected course (dx, dy) gives r = atan2(-dx, -dy).
  return Math.atan2(-dx, -dy);
}

/**
 * Hold a billboard rotation when the newly projected angle differs only by
 * sub-degree render noise. The comparison uses the shortest wrapped arc so
 * values around ±π do not jump.
 *
 * @param {number|null} previous Last displayed rotation.
 * @param {number|null} next Newly projected rotation.
 * @param {number} [deadbandRad=ROTATION_DEADBAND_RAD] Angular hold threshold.
 * @returns {number|null} Stable rotation.
 */
export function stabilizeScreenRotation(
  previous,
  next,
  deadbandRad = ROTATION_DEADBAND_RAD,
) {
  if (!Number.isFinite(next))
    return Number.isFinite(previous) ? previous : null;
  if (!Number.isFinite(previous)) return next;
  const delta = Math.atan2(
    Math.sin(next - previous),
    Math.cos(next - previous),
  );
  return Math.abs(delta) < Math.max(0, deadbandRad) ? previous : next;
}
