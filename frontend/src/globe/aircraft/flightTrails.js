/* Selected-contact trail manager.
   Inspired by God's Eye View's trail approach (src/layers/flights/tracking.js,
   src/layers/vessels/tracking.js — MIT). CI simplification: one Entity-based
   polyline per tracked contact, seeded from the layer's locally-accumulated
   position history, with an optional async backfill hook.

   Design notes:
   - The trail body is a static polyline Entity (cheap: rebuilt only when a new
     fix arrives, at poll cadence — never per frame).
   - A CallbackProperty head segment bridges the last body fix to the current
     live position so the trail stays glued to the moving icon between polls.
   - Ground contacts get no trail body (a taxi path is noise) — the layer
     decides what to feed in.
   - Backfill is OPTIONAL and fire-and-forget: any failure silently keeps the
     local-only trail. See integration doc for backend options
     (adsb.lol's archive endpoint was removed in 2025; OpenSky /tracks needs
     auth — local accumulation is the primary source). */

import * as Cesium from 'cesium';

export const TRAIL_MAX_POINTS = 400;
const TRAIL_WIDTH = 2.5;

/**
 * Create a trail manager for one tracked contact.
 * @param {Cesium.Viewer} viewer
 * @param {object} [opts]
 * @param {string} [opts.color='#39d0ff'] - CSS trail color.
 * @param {number} [opts.maxPoints=400]
 * @param {() => Cesium.Cartesian3|null} [opts.getLivePosition] - current
 *   live position provider for the head segment (e.g. dead-reckoned icon).
 * @returns {{ start(seedFixes), appendFix(cartesian), setLivePositionProvider(fn),
 *   clear(), destroy(), get count() }}
 *   seedFixes: array of Cesium.Cartesian3, oldest → newest.
 */
export function createTrailManager(viewer, opts = {}) {
  const color = opts.color || '#39d0ff';
  const maxPoints = opts.maxPoints || TRAIL_MAX_POINTS;
  let getLivePosition = opts.getLivePosition || null;
  let positions = [];
  let trailEntity = null;
  let headEntity = null;
  let backfillToken = 0;
  let destroyed = false;

  function ensureEntities() {
    if (trailEntity || !viewer || viewer.isDestroyed()) return;
    const mat = Cesium.Color.fromCssColorString(color).withAlpha(0.85);
    trailEntity = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => positions.slice(), false),
        width: TRAIL_WIDTH,
        material: mat,
        depthFailMaterial: mat.withAlpha(0.4),
        arcType: Cesium.ArcType.GEODESIC,
        clampToGround: false,
      },
    });
    headEntity = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          if (positions.length < 1 || !getLivePosition) return [];
          const live = getLivePosition();
          if (!live) return [];
          return [positions[positions.length - 1], Cesium.Cartesian3.clone(live)];
        }, false),
        width: TRAIL_WIDTH,
        material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
        depthFailMaterial: Cesium.Color.fromCssColorString(color).withAlpha(0.45),
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
  }

  function trim() {
    if (positions.length > maxPoints) {
      positions = positions.slice(positions.length - maxPoints);
    }
  }

  return {
    /** Begin a trail, seeded with oldest→newest fixes. Invalidates backfills. */
    start(seedFixes = []) {
      backfillToken += 1;
      positions = seedFixes.filter(Boolean).map((p) => Cesium.Cartesian3.clone(p));
      trim();
      ensureEntities();
      if (trailEntity) trailEntity.show = true;
      if (headEntity) headEntity.show = true;
    },

    /** Optional async backfill: fn(token) resolves to oldest→newest fixes
     *  strictly OLDER than the current oldest. Spliced ahead, capped. */
    async backfill(backfillFn) {
      const token = backfillToken;
      let older = null;
      try {
        older = await backfillFn(token);
      } catch {
        return; // silent fallback to the local-only trail
      }
      if (!older || !older.length || token !== backfillToken || destroyed) return;
      positions = older.map((p) => Cesium.Cartesian3.clone(p)).concat(positions);
      trim();
    },

    /** Append one live fix (oldest→newest order maintained by caller). */
    appendFix(cartesian) {
      if (!cartesian || destroyed) return;
      positions.push(Cesium.Cartesian3.clone(cartesian));
      trim();
    },

    setLivePositionProvider(fn) {
      getLivePosition = fn || null;
    },

    /** Clear the trail; invalidates pending backfills. Entities kept for reuse. */
    clear() {
      backfillToken += 1;
      positions = [];
      if (trailEntity) trailEntity.show = false;
      if (headEntity) headEntity.show = false;
    },

    destroy() {
      destroyed = true;
      backfillToken += 1;
      if (viewer && !viewer.isDestroyed()) {
        if (trailEntity) viewer.entities.remove(trailEntity);
        if (headEntity) viewer.entities.remove(headEntity);
      }
      trailEntity = null;
      headEntity = null;
      positions = [];
    },

    get count() { return positions.length; },
    get token() { return backfillToken; },
  };
}
