/* Camera telemetry readout — a subtle HUD line naming where the camera is.
   Minimal phase of the GEV HUD idea (bilawalsidhu/gods-eye-view, MIT,
   © 2026 Bilawal Sidhu — see THIRD-PARTY-NOTICES.md): src/hudLocality.js
   (composeLocalityTag — the SECTOR <lat> <lon> fallback) and src/hud.js
   (_updateCameraData).

   GEV's key lesson, kept here: ship the coordinate fallback and skip any POI
   catalog — unbounded "NEAR <POI> <N>KM" readouts produced absurd results.
   Explicitly WITHOUT any fake classification banner: fake markings on a real
   intel dashboard read as LARPing.

   Usage:
     import { initTelemetry } from './ui/telemetry.js';
     initTelemetry(viewer); // appends a chip into #telemetry-slot, or body
*/
import * as Cesium from 'cesium';

function coordinateTag(value, positive, negative) {
  return `${Math.abs(value).toFixed(2)}${value >= 0 ? positive : negative}`;
}

/** `SECTOR 25.20N 55.27E` — the honest coordinate fallback. */
export function sectorTag(latDeg, lonDeg) {
  return `SECTOR ${coordinateTag(latDeg, 'N', 'S')} ${coordinateTag(lonDeg, 'E', 'W')}`;
}

function formatAltitude(m) {
  if (!Number.isFinite(m)) return '—';
  if (m >= 1_000_000) return `${(m / 1_000_000).toFixed(2)}M km`;
  if (m >= 1_000) return `${(m / 1_000).toFixed(1)}k km`;
  return `${Math.round(m)} m`;
}

let chip = null;
let rafId = 0;
let destroyed = false;

/**
 * Mount the telemetry chip. Updates on throttled camera.changed — the same
 * rAF-throttle pattern viewer.js uses for its dynamic-SSE update.
 * @param {object} viewer Cesium viewer
 * @param {HTMLElement} [slot] mount point; defaults to a #telemetry-slot div
 *   if present, else document.body
 */
export function initTelemetry(viewer, slot) {
  if (chip || destroyed || !viewer) return chip;
  chip = document.createElement('div');
  chip.className = 'ci-telemetry';
  chip.setAttribute('aria-live', 'off');
  const mount = slot
    || document.getElementById('telemetry-slot')
    || document.body;
  mount.appendChild(chip);

  const scratch = new Cesium.Cartographic();
  const update = () => {
    rafId = 0;
    if (destroyed || !viewer || viewer.isDestroyed()) return;
    try {
      const camera = viewer.camera;
      const carto = camera.positionCartographic;
      if (!carto) return;
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const alt = carto.height;
      const heading = ((Cesium.Math.toDegrees(camera.heading) % 360) + 360) % 360;
      chip.textContent =
        `${sectorTag(lat, lon)} · ALT ${formatAltitude(alt)} · HDG ${Math.round(heading)}°`;
    } catch { /* camera not ready */ }
  };

  viewer.camera.changed.addEventListener(() => {
    if (!rafId && !destroyed) rafId = requestAnimationFrame(update);
  });
  update();
  return chip;
}

/** Remove the chip and stop updates. */
export function destroyTelemetry() {
  destroyed = true;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (chip) chip.remove();
  chip = null;
}
