/* Aircraft track/follow mode.
   Inspired by God's Eye View src/layers/flights/tracking.js (MIT).
   CI simplification: a single tracked Entity driven by a CallbackProperty
   position, with viewer.trackedEntity doing the camera work.

   Behavior contract (from GEV's field rules):
   - TRACK locks the camera to the aircraft. viewFrom is calibrated:
     behind + above, range scaled to altitude — readable frame, not a
     billboard-filling close-up.
   - UNTRACK releases the camera IN PLACE — no flyTo, no zoom-out.
     The view stays where the follow left it; the user can orbit immediately.
   - Escape, card close, selecting another contact, or layer disable all
     release cleanly. The billboard that was hidden during tracking is
     restored (caller owns that via onRelease). */

import * as Cesium from 'cesium';
import { screenProjectedRotation, stabilizeScreenRotation } from './iconOrientation.js';

let viewer = null;
let trackedEntity = null;
let trackedId = null;
let escapeHandler = null;
let onReleaseCb = null;
let crossLayerGuard = null;
// P2: stabilized screen rotation of the tracked billboard (reset per follow).
let followPrevRot = null;

/**
 * @param {Cesium.Viewer} v
 */
export function initFollowMode(v) {
  viewer = v;
}

function releaseCameraInPlace() {
  if (!viewer || viewer.isDestroyed()) return;
  // Releasing trackedEntity does NOT move the camera: Cesium resets the
  // lookAt transform in place. The view stays; the user can orbit/zoom.
  viewer.trackedEntity = undefined;
}

function installEscape() {
  if (escapeHandler) return;
  escapeHandler = (e) => {
    if (e.key === 'Escape' && trackedId) stopFollow('escape');
  };
  window.addEventListener('keydown', escapeHandler);
}

/**
 * Begin following a contact.
 * @param {string} id - stable contact id (e.g. ICAO hex).
 * @param {() => Cesium.Cartesian3|null} getPosition - live position provider
 *   (dead-reckoned / interpolated display position).
 * @param {object} [opts]
 * @param {number} [opts.altitudeM=1500] - for viewFrom range calibration.
 * @param {string} [opts.image] - billboard image data URI for the tracked entity.
 * @param {number} [opts.width=28] - tracked billboard width px.
 * @param {Cesium.Color} [opts.color] - billboard tint.
 * @param {() => number} [opts.getCourseDeg] - live course/track in degrees
 *   clockwise from north (for the tracked icon's screen-space rotation).
 * @param {() => void} [opts.onRelease] - called on every release path.
 */
export function startFollow(id, getPosition, opts = {}) {
  if (!viewer || viewer.isDestroyed() || !id || !getPosition) return false;
  stopFollow('switch'); // switching contacts — previous follow tears down first

  trackedId = id;
  onReleaseCb = opts.onRelease || null;
  followPrevRot = null;

  const positionProperty = new Cesium.CallbackProperty(() => {
    return getPosition() || Cesium.Cartesian3.ZERO;
  }, false);

  // P2: the tracked billboard gets the same screen-projected rotation as the
  // fleet icons (audit P1) — without it the followed plane has no heading at
  // all (billboard rotation defaults to 0, nose north forever).
  const rotationProperty = new Cesium.CallbackProperty(() => {
    try {
      const pos = getPosition();
      const course = typeof opts.getCourseDeg === 'function' ? opts.getCourseDeg() : NaN;
      const next = screenProjectedRotation(viewer.scene, pos,
        Number.isFinite(course) ? course : 0, followPrevRot);
      followPrevRot = stabilizeScreenRotation(followPrevRot, next);
      return followPrevRot ?? 0;
    } catch {
      return followPrevRot ?? 0;
    }
  }, false);

  // Calibrated frame: behind + above, distance scaled to altitude.
  const followRange = Math.min(
    Math.max((opts.altitudeM || 1500) * 1.1 + 2500, 3000),
    30000,
  );

  trackedEntity = viewer.entities.add({
    position: positionProperty,
    trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
    billboard: {
      image: opts.image || undefined,
      width: opts.width || 28,
      height: opts.width || 28,
      color: opts.color || Cesium.Color.CYAN,
      rotation: rotationProperty,
      sizeInMeters: false,
      scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5),
      disableDepthTestDistance: Number.POSITIVE_INFINITY, // never buried in terrain
    },
  });
  trackedEntity.viewFrom = new Cesium.Cartesian3(
    0,
    -followRange * 0.8,
    followRange * 0.55,
  );

  // Cross-layer handoff: if ANOTHER layer grabs viewer.trackedEntity, drop our
  // state without touching it (the new owner controls the camera now).
  if (!crossLayerGuard) {
    crossLayerGuard = viewer.trackedEntityChanged.addEventListener(() => {
      if (
        trackedId &&
        viewer.trackedEntity &&
        viewer.trackedEntity !== trackedEntity
      ) {
        stopFollow('handoff', { keepViewerTrack: true });
      }
    });
  }

  installEscape();
  viewer.camera.cancelFlight(); // a mid-flight camera would ignore viewFrom
  viewer.trackedEntity = trackedEntity;
  return true;
}

/**
 * Stop following. Camera stays exactly where it is.
 * @param {string} [reason] - 'user' | 'escape' | 'card-close' | 'switch' | 'handoff' | 'evicted' | 'layer-off' | 'zoom-gate'
 * @param {object} [opts]
 * @param {boolean} [opts.keepViewerTrack] - another layer owns the camera; don't clear it.
 */
export function stopFollow(reason = 'user', opts = {}) {
  if (!trackedId && !trackedEntity) return;
  const id = trackedId;
  trackedId = null;
  if (viewer && !viewer.isDestroyed()) {
    if (!opts.keepViewerTrack) releaseCameraInPlace();
    if (trackedEntity) {
      try { viewer.entities.remove(trackedEntity); } catch { /* already gone */ }
    }
  }
  trackedEntity = null;
  const cb = onReleaseCb;
  onReleaseCb = null;
  if (cb) { try { cb(id, reason); } catch (e) { console.warn('[follow]', e); } }
}

/** Currently followed contact id, or null. */
export function followedId() { return trackedId; }

/** True while a follow is active. */
export function isFollowing() { return trackedId !== null; }
