/* Camera ground-clearance guard — never leave an arrival buried in, or
   pressed against, the rendered surface.
   Adapted from bilawalsidhu/gods-eye-view (MIT, © 2026 Bilawal Sidhu — see
   THIRD-PARTY-NOTICES.md): src/cameraGroundGuard.js
   (MIN_EYE_CLEARANCE_M, GUARD_ATTEMPTS, groundClearanceDeficitM, the
   sample-after-arrival policy). GEV's cameraArrival ownership half is
   replaced here by the generation-stamping in ./cameraGen.js.

   Arrival framing is computed before the destination's tiles exist, so after
   a flight lands and tiles have streamed in, this measures the rendered
   surface under the camera and lifts the eye if it sits below a usable
   clearance. Heading and pitch are held, so the correction reads as the
   shot settling.
*/
import * as Cesium from 'cesium';
import { isStaleGeneration } from './cameraGen.js';

/** Minimum eye height above the rendered surface for a usable view. */
export const MIN_EYE_CLEARANCE_M = 120;
/** Retries while tiles stream in; sampling fails until the mesh exists. */
export const GUARD_ATTEMPTS = 8;
export const GUARD_INTERVAL_MS = 600;
/** Ignore sub-metre noise rather than nudging the camera forever. */
const GUARD_EPSILON_M = 2;

const probeScratch = new Cesium.Cartographic();

/**
 * How far the camera must rise to clear the ground, given a measured
 * surface. Pure — testable without a scene.
 */
export function groundClearanceDeficitM(cameraHeightM, groundHeightM, clearanceM = MIN_EYE_CLEARANCE_M) {
  if (!Number.isFinite(cameraHeightM) || !Number.isFinite(groundHeightM)) return 0;
  const deficit = groundHeightM + clearanceM - cameraHeightM;
  return deficit > GUARD_EPSILON_M ? deficit : 0;
}

function sampleSurfaceM(scene, cells) {
  let heightM = Number.NaN;
  let sampled = 0;
  if (typeof scene?.sampleHeight !== 'function') return { heightM, sampled };
  for (const cell of cells) {
    try {
      const height = scene.sampleHeight(
        Cesium.Cartographic.fromDegrees(cell.lon, cell.lat, 0, probeScratch),
      );
      if (!Number.isFinite(height)) continue;
      sampled += 1;
      heightM = Number.isFinite(heightM) ? Math.max(heightM, height) : height;
    } catch { /* tiles not ready for this cell */ }
  }
  return { heightM, sampled };
}

/**
 * Watch an arrival and lift the camera once the real surface is measurable.
 * Stops quietly on a clear view, exhausted attempts, user takeover, or a
 * stale generation. Returns a cancel function.
 *
 * @param {object} viewer Cesium viewer
 * @param {number} gen camera generation captured when the flight started
 * @param {Array<{lat:number, lon:number}>} [cells] probe cells; defaults to
 *   the camera's ground point
 */
export function guardArrival(viewer, gen, cells) {
  let cancelled = false;
  let attempts = 0;
  let timer = 0;

  const stop = () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = 0;
  };

  const probeCells = () => {
    if (cells && cells.length) return cells;
    const carto = viewer.camera.positionCartographic;
    if (!carto) return [];
    return [{
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    }];
  };

  const step = () => {
    timer = 0;
    if (cancelled || isStaleGeneration(gen)) return;
    attempts += 1;
    try {
      const { heightM, sampled } = sampleSurfaceM(viewer.scene, probeCells());
      if (sampled > 0) {
        const deficit = groundClearanceDeficitM(
          viewer.camera.positionCartographic.height,
          heightM,
        );
        if (deficit > 0) {
          const pos = viewer.camera.positionCartographic;
          viewer.camera.setView({
            destination: Cesium.Cartesian3.fromRadians(
              pos.longitude, pos.latitude, pos.height + deficit,
            ),
          });
        }
        return; // measured — done either way
      }
    } catch { /* keep retrying while tiles stream in */ }
    if (attempts < GUARD_ATTEMPTS && !cancelled) {
      timer = setTimeout(step, GUARD_INTERVAL_MS);
    }
  };
  timer = setTimeout(step, GUARD_INTERVAL_MS);

  // User takes the controls → stand down.
  const canvas = viewer.scene.canvas;
  const onUserInput = () => stop();
  canvas.addEventListener('pointerdown', onUserInput, { once: true });
  canvas.addEventListener('wheel', onUserInput, { once: true });
  return () => {
    canvas.removeEventListener('pointerdown', onUserInput);
    canvas.removeEventListener('wheel', onUserInput);
    stop();
  };
}
