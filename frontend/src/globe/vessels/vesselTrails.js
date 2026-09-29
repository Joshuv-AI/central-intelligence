/* Selected-vessel trail — thin wrapper over the shared trail manager.
   Reuses createTrailManager from ../aircraft/flightTrails.js so flight and
   vessel trails share the body/head-segment behavior and the 400-point cap. */

import { createTrailManager } from '../aircraft/flightTrails.js';

const VESSEL_TRAIL_COLOR = '#39d5ff';

/**
 * @param {Cesium.Viewer} viewer
 * @returns trail manager (see flightTrails.js for the full API)
 */
export function createVesselTrail(viewer) {
  return createTrailManager(viewer, { color: VESSEL_TRAIL_COLOR });
}
