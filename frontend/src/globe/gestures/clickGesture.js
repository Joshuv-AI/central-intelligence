/* Drag-vs-click gesture classification for marker selection.
   Ported from God's Eye View src/data/trackingClickGesture.js (MIT —
   bilawalsidhu/gods-eye-view). The inputOwnership dependency was dropped
   (CI has no draw tools yet); everything else is a faithful port.

   Why: ending a camera drag over a marker must not select it. A press is a
   SELECTION gesture when pointer travel stays within 6px (duration ignored —
   a stationary long press may still select). It is a full CLICK gesture
   (safe for destructive actions like deselect) only when ALSO short (<400ms).
   Travel accumulates segment-by-segment so an orbit nudge that returns to
   its start pixel cannot masquerade as a zero-distance click. */

import * as Cesium from 'cesium';

export const MAX_CLICK_TRAVEL_PX = 6;
export const MAX_CLICK_DURATION_MS = 400;

/**
 * Selection-safe? Travel-only classifier: stationary long-press selects.
 * @param {{travelPx?: number}} gesture
 */
export function isSelectionGesture(gesture = {}) {
  const travelPx = Number.isFinite(gesture.travelPx)
    ? Math.max(0, gesture.travelPx)
    : Number.POSITIVE_INFINITY;
  return travelPx <= MAX_CLICK_TRAVEL_PX;
}

/**
 * Full click? Travel + duration classifier for destructive actions
 * (deselect, dismiss).
 * @param {{travelPx?: number, durationMs?: number}} gesture
 */
export function isClickGesture(gesture = {}) {
  const durationMs = Number.isFinite(gesture.durationMs)
    ? Math.max(0, gesture.durationMs)
    : Number.POSITIVE_INFINITY;
  return isSelectionGesture(gesture) && durationMs <= MAX_CLICK_DURATION_MS;
}

/**
 * Bind LEFT_DOWN / MOUSE_MOVE / LEFT_UP accounting ahead of LEFT_CLICK.
 * Every scene click reaches onClick with its gesture metadata; the caller
 * decides whether selection (travel-only) or deselection (travel+duration)
 * is allowed.
 * @param {Cesium.ScreenSpaceEventHandler} handler
 * @param {(click: object, gesture: {travelPx: number, durationMs: number}) => void} onClick
 * @param {object} [options] - { now?: () => number }
 */
export function bindClickGesture(handler, onClick, options = {}) {
  const now = options.now || (() => performance.now());
  const eventTypes = Cesium.ScreenSpaceEventType;
  let pressActive = false;
  let pressStartedAt = 0;
  let previousPosition = null;
  let travelPx = 0;
  let completedGesture = null;

  const appendTravel = (position) => {
    if (!pressActive || !Number.isFinite(position?.x) || !Number.isFinite(position?.y))
      return;
    if (previousPosition) {
      travelPx += Math.hypot(position.x - previousPosition.x, position.y - previousPosition.y);
    }
    previousPosition = { x: position.x, y: position.y };
  };

  const finishPress = (position) => {
    if (!pressActive) return;
    appendTravel(position);
    completedGesture = { travelPx, durationMs: Math.max(0, now() - pressStartedAt) };
    pressActive = false;
    previousPosition = null;
  };

  handler.setInputAction((event) => {
    pressActive = true;
    pressStartedAt = now();
    previousPosition = null;
    travelPx = 0;
    completedGesture = null;
    appendTravel(event?.position);
  }, eventTypes.LEFT_DOWN);

  handler.setInputAction((event) => {
    appendTravel(event?.endPosition ?? event?.position);
  }, eventTypes.MOUSE_MOVE);

  handler.setInputAction((event) => {
    finishPress(event?.position);
  }, eventTypes.LEFT_UP);

  handler.setInputAction((click) => {
    if (pressActive) finishPress(click?.position);
    const gesture = completedGesture || { travelPx: 0, durationMs: 0 };
    completedGesture = null;
    onClick(click, gesture);
  }, eventTypes.LEFT_CLICK);
}
