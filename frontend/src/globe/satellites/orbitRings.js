/* Flicker-free selected-satellite orbit rings — ported from God's Eye View
   (src/layers/satellites/rendering.js + orbits.js, MIT).

   Selecting a satellite draws its orbit as a smooth ring that never flickers
   or z-fights:

   - SGP4 samples are baked ONCE into a single synchronous Cesium.Primitive
     (asynchronous: false — the previous entity-polyline approach rebuilt
     geometry asynchronously on every assignment, blinking once per rebuild).
   - Each tick only rotates the primitive's modelMatrix by ΔGMST — no SGP4
     here, no geometry rebuild. WGS84 is rotationally symmetric about Z, so a
     rigid Z-rotation of the baked inertial-frame ring exactly equals rebaking.
     Sign: Cesium.Matrix3.fromRotationZ(θ) rotates +X toward +Y, i.e.
     INCREASES longitude by θ — baked points must be rotated by −ΔGMST.
   - depthFailAppearance dims (not hides) the behind-Earth segment via the
     per-instance depthFailColor attribute — the mechanism the entity STATIC
     batch uses, which a dynamic CallbackProperty polyline silently drops.

   Usage:
     import { createOrbitRings } from './orbitRings.js';
     const rings = createOrbitRings(viewer);
     rings.show('25544', satrec, { color: '#67e8f9' }); // ISS
     // per tick (2 s cadence matches CI's satellite update):
     rings.tick(new Date());
     rings.hide('25544');
     rings.hideAll();
*/
import * as Cesium from 'cesium';
import { gstime, propagate, eciToGeodetic, degreesLong, degreesLat } from 'satellite.js';

const ORBIT_PATH_STEPS = 180;
const DEFAULT_COLOR = '#22d3ee';

/** One full orbit's ECEF positions, baked at a fixed GMST so the ring closes.
 * Without a fixed GMST, Earth rotation during the orbit period (~24° for LEO)
 * shifts the end point west of the start, leaving a visible gap. */
export function computeOrbitPath(satrec, referenceDate, steps = ORBIT_PATH_STEPS) {
  const meanMotion = satrec.no * (1440 / (2 * Math.PI)); // rev/day
  const periodSec = 86400 / Math.max(meanMotion, 0.1);
  const stepSec = periodSec / steps;
  const baseTime = referenceDate.getTime();
  const fixedGmst = gstime(referenceDate);
  const positions = [];
  for (let i = 0; i <= steps; i++) {
    const t = new Date(baseTime + i * stepSec * 1000);
    let pv;
    try {
      pv = propagate(satrec, t);
    } catch {
      continue;
    }
    if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
    try {
      const geo = eciToGeodetic(pv.position, fixedGmst);
      positions.push(
        Cesium.Cartesian3.fromDegrees(
          degreesLong(geo.longitude),
          degreesLat(geo.latitude),
          Math.max(0, geo.height * 1000),
        ),
      );
    } catch {
      continue;
    }
  }
  return positions;
}

/** Build the rigid ECEF transform keeping a ring baked at one GMST aligned
 * with live SGP4 positions at another epoch. Writes into `result` in place. */
export function orbitFrameModelMatrix(gmstAtBake, nowDate, result = new Cesium.Matrix4()) {
  const deltaGmst = gstime(nowDate) - gmstAtBake;
  // Wraparound: gstime is in [0, 2π); the raw difference can be off by exact
  // multiples of 2π, which a rotation cannot distinguish. No unwrap needed.
  const rotation = Cesium.Matrix3.fromRotationZ(-deltaGmst);
  return Cesium.Matrix4.fromRotationTranslation(rotation, Cesium.Cartesian3.ZERO, result);
}

export function createOrbitRings(viewer) {
  const rings = new Map(); // key -> { primitive, gmstAtBake }

  function show(key, satrec, { color = DEFAULT_COLOR, width = 2.0 } = {}) {
    if (rings.has(key)) return true;
    if (!viewer || !satrec) return false;
    const bakeDate = new Date();
    const positions = computeOrbitPath(satrec, bakeDate);
    if (positions.length < 2) return false;
    const pathColor = Cesium.Color.fromCssColorString(color);
    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions,
          width,
          vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            pathColor.withAlpha(0.6),
          ),
          depthFailColor: Cesium.ColorGeometryInstanceAttribute.fromColor(
            pathColor.withAlpha(0.35),
          ),
        },
      }),
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      depthFailAppearance: new Cesium.PolylineColorAppearance({
        translucent: true,
      }),
      asynchronous: false, // build this frame — no async-rebuild blink window
      allowPicking: false, // ring clicks fall through to satellites/deselect
    });
    viewer.scene.primitives.add(primitive);
    // Same Date object as computeOrbitPath's internal fixedGmst → identical
    // GMST value (gstime is pure), so delta starts at exactly 0 and the
    // initial identity modelMatrix is correct until the first tick.
    rings.set(key, { primitive, gmstAtBake: gstime(bakeDate) });
    viewer.scene.requestRender();
    return true;
  }

  function hide(key) {
    const ring = rings.get(key);
    if (!ring) return false;
    rings.delete(key);
    if (!ring.primitive.isDestroyed()) {
      viewer.scene.primitives.remove(ring.primitive);
      ring.primitive.destroy();
    }
    viewer.scene.requestRender();
    return true;
  }

  function hideAll() {
    for (const key of [...rings.keys()]) hide(key);
  }

  /** Re-align every baked ring to current GMST. Call on the satellite update
   * cadence (2 s); cheap — synchronous uniform writes, no geometry work. */
  function tick(nowDate = new Date()) {
    if (rings.size === 0) return;
    for (const ring of rings.values()) {
      if (!ring.primitive || ring.primitive.isDestroyed()) continue;
      orbitFrameModelMatrix(ring.gmstAtBake, nowDate, ring.primitive.modelMatrix);
    }
    viewer.scene.requestRender();
  }

  function has(key) {
    return rings.has(key);
  }

  function destroy() {
    hideAll();
  }

  return { show, hide, hideAll, tick, has, destroy };
}
