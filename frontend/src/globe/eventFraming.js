/* Cinematic event framing — angled 3/4 arrivals instead of top-down.
   Approach adapted from bilawalsidhu/gods-eye-view (MIT, © 2026 Bilawal
   Sidhu — see THIRD-PARTY-NOTICES.md): src/worldFocus.js
   (flyToWorldTarget — flyToBoundingSphere with HeadingPitchRange, ~−32°
   pitch, heading inherited from the camera, CUBIC_IN_OUT easing).

   The ~−32° pitch reads as cinematic and keeps terrain and context visible,
   where a straight top-down arrival flattens everything. Use for event-card
   "focus" arrivals; keep instant setView for share-link restores where the
   arrival beat is unwanted.
*/
import * as Cesium from 'cesium';
import { getViewer } from './viewer.js';

/** Default cinematic profile: pitch −32°, range scales to the event. */
export const CINEMATIC_PITCH_DEG = -32;
export const EVENT_FOCUS_DURATION_SEC = 1.9;

function viewerOrThrow() {
  const v = getViewer();
  if (!v) throw new Error('viewer not ready');
  return v;
}

/**
 * Fly to a lon/lat event with an angled 3/4 cinematic frame.
 * @param {number} lon degrees
 * @param {number} lat degrees
 * @param {{rangeM?: number, radiusM?: number, duration?: number, pitchDeg?: number}} opts
 *   rangeM: eye distance from target (default 1,200,000)
 *   radiusM: bounding-sphere radius around the target (default 60,000)
 */
export function flyToEvent(lon, lat, { rangeM = 1_200_000, radiusM = 60_000, duration = EVENT_FOCUS_DURATION_SEC, pitchDeg = CINEMATIC_PITCH_DEG } = {}) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return Promise.resolve(false);
  const viewer = viewerOrThrow();
  const camera = viewer.camera;
  const position = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  const heading = Number.isFinite(camera.heading) ? camera.heading : 0;
  return new Promise((resolve) => {
    camera.cancelFlight?.();
    camera.flyToBoundingSphere(new Cesium.BoundingSphere(position, radiusM), {
      offset: new Cesium.HeadingPitchRange(
        heading,
        Cesium.Math.toRadians(pitchDeg),
        rangeM,
      ),
      duration,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: () => resolve(true),
      cancel: () => resolve(false),
    });
  });
}

/**
 * Frame a set of lon/lat points at their centroid with the cinematic pitch.
 * For chains, callers should step through flyToEvent per node instead.
 */
export function frameEventBounds(points, { pad = 1.35, duration = EVENT_FOCUS_DURATION_SEC, pitchDeg = CINEMATIC_PITCH_DEG } = {}) {
  const pts = (points || []).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (pts.length === 0) return Promise.resolve(false);
  const rect = Cesium.Rectangle.fromCartographicArray(
    pts.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat)),
  );
  const center = Cesium.Rectangle.center(rect);
  const widthM = Cesium.Rectangle.computeWidth(rect) * 6371000;
  const heightM = Cesium.Rectangle.computeHeight(rect) * 6371000;
  const span = Math.max(widthM, heightM, 500_000) * pad;
  return flyToEvent(
    Cesium.Math.toDegrees(center.longitude),
    Cesium.Math.toDegrees(center.latitude),
    { rangeM: Math.min(span * 1.1, 12_000_000), radiusM: span * 0.08, duration, pitchDeg },
  );
}
