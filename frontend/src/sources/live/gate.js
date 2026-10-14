/**
 * §L zoom gates for contact layers (ARCH §7 table v1).
 *
 * Bands are camera height above the ellipsoid:
 * B0 Globe >12,000 km · B1 Continental 4,000–12,000 km · B2 Regional
 * 650–4,000 km · B3 Metro 60–650 km · B4 City 8–60 km · B5 Street <8 km.
 *
 * Civil flights render/fetch only in B3 and below (≤650 km); military
 * flights only in B2 and below (≤4,000 km). While a gate is closed the
 * layer must not fetch at all — gated-off work costs ~zero frame/network
 * budget — and must say so plainly instead of looking broken.
 */

export const CIVIL_GATE_MAX_HEIGHT_M = 650_000;
export const MILITARY_GATE_MAX_HEIGHT_M = 4_000_000;
export const GLOBE_BAND_MIN_HEIGHT_M = 12_000_000;

export const CIVIL_GATE_MESSAGE = 'Zoom in to load civil traffic';
export const MILITARY_GATE_MESSAGE = 'Zoom in to load military traffic';

/** Camera height in metres from a Cesium viewer, or null when unknown. */
export function cameraHeightM(viewer) {
  const height = viewer?.camera?.positionCartographic?.height;
  return Number.isFinite(height) && height > 0 ? height : null;
}

/** §L band id ('B0'…'B5') for a camera height in metres. */
export function bandForHeight(heightM) {
  if (!Number.isFinite(heightM)) return null;
  if (heightM > 12_000_000) return 'B0';
  if (heightM > 4_000_000) return 'B1';
  if (heightM > 650_000) return 'B2';
  if (heightM > 60_000) return 'B3';
  if (heightM > 8_000) return 'B4';
  return 'B5';
}

/** True when `heightM` is at or below `maxHeightM` (unknown height = open,
 * so a layer never wedges shut before the camera is readable). */
export function gateOpen(heightM, maxHeightM) {
  return heightM == null || heightM <= maxHeightM;
}
