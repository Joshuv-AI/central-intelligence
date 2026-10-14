import * as Cesium from 'cesium';

/**
 * Camera presets for notable locations.
 * User-triggered presets. The opening camera is the whole globe (flyToAustin
 * is kept as the startup entry name; it now frames the planet, see below).
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Opening camera: whole-globe framing (SPEC §3.A KEEP FROM CI — CI viewer.js
 * setView fromDegrees(10, 18, 26_000_000)). Missions and search take the user
 * down; the app does not start at street level (EXPERIENCE-GEV §7.2).
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToAustin(viewer) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(10, 18, 26_000_000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });
  return () => {
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
