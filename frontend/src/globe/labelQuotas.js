/* Shared cross-layer label quotas — adapted from God's Eye View
   (src/overlays/worldOverlay.js: WORLD_OVERLAY_PAINT_LANES, MIT).

   A single priority scheme across layers so the important label never loses
   a collision to decoration:

     detection → ambient-label → ambient-track → ambient-card →
     thumbnail → selected → tracked

   Selected/tracked entries bypass budgets entirely (pinned/selected bypass).
   Everything else competes for a per-lane budget, highest priority first.

   This module is engine-agnostic: it does NOT render anything. Layers
   register candidate labels and ask which may render; the renderer (e.g.
   markers.js clustering, billboard label toggles) applies the decision.

   Usage:
     import { createLabelQuotas, PAINT_LANES } from './labelQuotas.js';
     const quotas = createLabelQuotas({ budgets: { 'ambient-label': 40 } });
     quotas.register('sat-25544', 'tracked', { priority: 100 });
     quotas.register('evt-123', 'ambient-label', { priority: 10 });
     const visible = quotas.resolve(); // Set of ids allowed to show labels
     // per frame or on data change; selected/tracked always included.
*/
import * as Cesium from 'cesium';

export const PAINT_LANES = Object.freeze([
  'detection',
  'ambient-label',
  'ambient-track',
  'ambient-card',
  'thumbnail',
  'selected',
  'tracked',
]);

const LANE_INDEX = new Map(PAINT_LANES.map((lane, i) => [lane, i]));

// Lanes that bypass all budgets — the important label never yields.
const BYPASS_LANES = new Set(['selected', 'tracked', 'detection']);

const DEFAULT_BUDGETS = Object.freeze({
  detection: 24,
  'ambient-label': 60,
  'ambient-track': 40,
  'ambient-card': 24,
  thumbnail: 12,
  selected: Infinity,
  tracked: Infinity,
});

export function createLabelQuotas({ budgets = {} } = {}) {
  const laneBudgets = { ...DEFAULT_BUDGETS, ...budgets };
  // id -> { lane, priority, data }
  const entries = new Map();

  function register(id, lane, { priority = 0, data = null } = {}) {
    if (!LANE_INDEX.has(lane))
      throw new RangeError(`Unknown paint lane: ${lane}`);
    entries.set(id, { lane, priority, data });
  }

  function unregister(id) {
    entries.delete(id);
  }

  function clear() {
    entries.clear();
  }

  /** Resolve which label ids may render. Returns a Set of ids.
   * Bypass lanes always resolve true. Other lanes fill their budget in
   * priority order (then lane order for ties). Also marks occluded-behind-
   * globe candidates: pass a viewer to cull labels on the far hemisphere. */
  function resolve(viewer = null) {
    const visible = new Set();
    const byLane = new Map();
    for (const [id, entry] of entries) {
      if (BYPASS_LANES.has(entry.lane)) {
        visible.add(id);
        continue;
      }
      if (!byLane.has(entry.lane)) byLane.set(entry.lane, []);
      byLane.get(entry.lane).push([id, entry]);
    }
    for (const [lane, list] of byLane) {
      const budget = laneBudgets[lane] ?? 0;
      list.sort(
        (a, b) =>
          b[1].priority - a[1].priority ||
          LANE_INDEX.get(a[1].lane) - LANE_INDEX.get(b[1].lane),
      );
      for (let i = 0; i < Math.min(budget, list.length); i++)
        visible.add(list[i][0]);
    }
    if (viewer) cullOccluded(viewer, visible);
    return visible;
  }

  /** Remove ids whose anchor is occluded by the globe from the visible set.
   * Entries may carry data.position (Cartesian3). In-place. */
  function cullOccluded(viewer, visible) {
    let occluder = null;
    try {
      occluder = new Cesium.Occluder(
        new Cesium.BoundingSphere(
          Cesium.Cartesian3.ZERO,
          Cesium.Ellipsoid.WGS84.minimumRadius,
        ),
        viewer.scene.camera.positionWC,
      );
    } catch {
      return;
    }
    for (const id of [...visible]) {
      const entry = entries.get(id);
      const pos = entry?.data?.position;
      if (!pos) continue;
      // Bypass lanes still cull when physically behind the globe — the
      // priority guarantee is about collisions, not x-ray vision.
      const cart = pos instanceof Cesium.Cartesian3 ? pos : null;
      if (!cart) continue;
      if (!occluder.isPointVisible(cart)) visible.delete(id);
    }
  }

  function getDiagnostics() {
    const perLane = {};
    for (const lane of PAINT_LANES) perLane[lane] = 0;
    for (const entry of entries.values()) perLane[entry.lane]++;
    return { total: entries.size, perLane, budgets: { ...laneBudgets } };
  }

  return {
    register,
    unregister,
    clear,
    resolve,
    getDiagnostics,
    lanes: PAINT_LANES,
  };
}
