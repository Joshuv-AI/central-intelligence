/* Camera flights — 900–1400ms eased; the globe glides, never cuts. */
import * as Cesium from 'cesium';
import { getViewer } from './viewer.js';
import { REGIONS } from '../data/store.js';

function viewerOrThrow() {
  const v = getViewer();
  if (!v) throw new Error('viewer not ready');
  return v;
}

/** Fly to a lon/lat point. Resolves when the flight completes or cancels. */
export function flyToPoint(lon, lat, { height = 6_000_000, duration = 1.2 } = {}) {
  const viewer = viewerOrThrow();
  return new Promise((resolve) => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      duration,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
      complete: resolve,
      cancel: resolve,
    });
  });
}

/** Fly to a region view from the REGIONS table. */
export function flyToRegion(regionId, duration = 1.3) {
  const region = REGIONS.find((r) => r.id === regionId) || REGIONS[0];
  return flyToPoint(region.lon, region.lat, { height: region.height, duration });
}

/** Frame a set of lon/lat points comfortably. */
export function flyToBounds(points, { duration = 1.3, pad = 1.35 } = {}) {
  const viewer = viewerOrThrow();
  const pts = points.filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (pts.length === 0) return Promise.resolve();
  if (pts.length === 1) return flyToPoint(pts[0].lon, pts[0].lat, { height: 4_000_000, duration });

  const rect = Cesium.Rectangle.fromCartographicArray(
    pts.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat))
  );
  const center = Cesium.Rectangle.center(rect);
  const widthM = Cesium.Rectangle.computeWidth(rect) * 6371000;
  const heightM = Cesium.Rectangle.computeHeight(rect) * 6371000;
  const span = Math.max(widthM, heightM, 1_000_000) * pad;
  const lon = Cesium.Math.toDegrees(center.longitude);
  const lat = Cesium.Math.toDegrees(center.latitude);
  return flyToPoint(lon, lat, { height: Math.min(span * 1.6, 24_000_000), duration });
}

/** Fly along a connection chain, resolving after each leg. */
export async function flyChain(chain, { onStep } = {}) {
  const pts = (chain || []).filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat));
  if (pts.length === 0) return;
  if (pts.length <= 2) {
    await flyToBounds(pts, { duration: 1.2 });
    for (const s of chain) onStep && onStep(s);
    return;
  }
  for (const step of pts) {
    onStep && onStep(step);
    // eslint-disable-next-line no-await-in-loop
    await flyToPoint(step.lon, step.lat, { height: 5_000_000, duration: 1.0 });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 350));
  }
}
