/* GPU wind streamlines — ported from God's Eye View
   (src/layers/wind/streamlines.js + gpuRendering.js + model.js, MIT).

   Wind renders as animated streamlines where the geometry is baked ONCE from
   a wind field snapshot and animation is a shader uniform tick — no CPU
   per-frame particle advection. The "living atmosphere" look.

   Two halves:
   1. bakeWindStreamlines(field, opts) — golden-angle equal-area seeds,
      midpoint streamline integration through a bilinearly-sampled u/v grid.
      Paths stop at the seam, poles, calm or missing samples.
   2. createWindStreamlines({ getViewer }) — builds per-cell Cesium primitives
      with a flow material (persistent ghost curve + moving tapered highlight),
      per-path phase offsets via a per-instance seed attribute, horizon
      culling per cell, and a camera-height fade.

   Field format: { u, v, nx, ny, dx, dy, lo1, la1 } — north-to-south,
   seam-wrapped grids (GRIB2-style, e.g. GFS 10 m winds). u/v are
   Float32Array in m/s.

   Data source is intentionally decoupled: the integration step fetches the
   field (e.g. a server-side GFS endpoint like GEV's /api/wind/manifest) and
   hands it to setField(). See /tmp/weather-sat-integration.md.

   Usage:
     const wind = createWindStreamlines({ getViewer: () => viewer });
     await wind.setField(field);        // bake + build geometry
     wind.setShow(true);
     // per frame (register a render-governor hold while visible):
     wind.tick(elapsedSeconds);
     wind.updateVisibility(viewer.scene.camera);
*/
import * as Cesium from 'cesium';

// Desktop density is bounded independently of viewport zoom; camera motion
// never triggers a regional rebake. Narrow-screen cost stays at 1200 paths.
export const WIND_PATH_LIMIT = 7200;
export const WIND_NARROW_PATH_LIMIT = 1200;
export const WIND_PATH_STEPS = 16;
export const WIND_DISPLAY_HEIGHT_METERS = 12000;
export const WIND_CELL_DEGREES = 30;
export const WIND_FADE_LOW_METERS = 15000;
export const WIND_FADE_HIGH_METERS = 60000;

const DEGREE_METERS = 111320;
const GOLDEN_ANGLE = 137.50776405003785;

export function normalizeLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function metersPerDegreeLon(lat) {
  return DEGREE_METERS * Math.cos((lat * Math.PI) / 180);
}

function interpolate(array, a, b, c, d, tx, ty) {
  return (
    (array[a] * (1 - tx) + array[b] * tx) * (1 - ty) +
    (array[c] * (1 - tx) + array[d] * tx) * ty
  );
}

/** Sample a north-to-south, seam-wrapped wind grid bilinearly. */
export function sampleWind(field, lon, lat, result = {}) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    result.u = 0;
    result.v = 0;
    return result;
  }
  const { u, v, nx, ny, lo1, la1, dx, dy } = field;
  const x = ((normalizeLongitude(lon - lo1) + 360) % 360) / dx;
  const y = (la1 - lat) / dy;
  const x0 = Math.floor(x);
  const tx = x - x0;
  const yClamped = Math.max(0, Math.min(ny - 1, y));
  const y0 = Math.floor(yClamped);
  const y1 = Math.min(ny - 1, y0 + 1);
  const ty = yClamped - y0;
  const left = ((x0 % nx) + nx) % nx;
  const right = (left + 1) % nx;
  const a = y0 * nx + left;
  const b = y0 * nx + right;
  const c = y1 * nx + left;
  const d = y1 * nx + right;
  result.u = interpolate(u, a, b, c, d, tx, ty);
  result.v = interpolate(v, a, b, c, d, tx, ty);
  return result;
}

/** One bounded midpoint step. The integration interval is field time. */
function advance(field, point, seconds, scratch) {
  sampleWind(field, point[0], point[1], scratch);
  if (
    !Number.isFinite(scratch.u + scratch.v) ||
    Math.hypot(scratch.u, scratch.v) < 0.15
  )
    return null;
  const lonRate = scratch.u / metersPerDegreeLon(point[1]);
  const latRate = scratch.v / DEGREE_METERS;
  // Bound each geographic segment, including fast winds near the poles.
  const dt =
    Math.sign(seconds) *
    Math.min(
      Math.abs(seconds),
      0.75 / Math.max(Math.abs(lonRate), Math.abs(latRate), 1e-12),
    );
  const midLat = point[1] + latRate * dt * 0.5;
  if (Math.abs(midLat) > 88.5) return null;
  sampleWind(field, point[0] + lonRate * dt * 0.5, midLat, scratch);
  if (!Number.isFinite(scratch.u + scratch.v)) return null;
  const lon = normalizeLongitude(
    point[0] + (scratch.u * dt) / metersPerDegreeLon(midLat),
  );
  const lat = point[1] + (scratch.v * dt) / DEGREE_METERS;
  if (Math.abs(lat) > 88.5 || Math.abs(lon - point[0]) > 180) return null;
  if (Math.abs(lon - point[0]) + Math.abs(lat - point[1]) < 1e-8) return null;
  return [lon, lat];
}

/**
 * Bake geographic streamlines once from an immutable forecast snapshot.
 * Equal-area seeds avoid polar overpopulation. Increasing path position
 * always follows the wind; paths stop at the map seam, poles, calm or
 * missing samples.
 */
export function bakeWindStreamlines(
  field,
  { count = WIND_PATH_LIMIT, steps = WIND_PATH_STEPS, stepSeconds = 1800 } = {},
) {
  if (
    !field ||
    field.nx < 2 ||
    field.ny < 2 ||
    !(field.dx > 0) ||
    !(field.dy > 0) ||
    !field.u ||
    !field.v
  )
    return [];
  const budget = Math.min(
    WIND_PATH_LIMIT,
    Math.max(0, Math.floor(Number.isFinite(count) ? count : WIND_PATH_LIMIT)),
  );
  const halfSteps = Math.min(
    WIND_PATH_STEPS,
    Math.max(1, Math.floor(Number.isFinite(steps) ? steps : WIND_PATH_STEPS)),
  );
  const interval = Math.min(
    3600,
    Math.max(1, Number.isFinite(stepSeconds) ? stepSeconds : 1800),
  );
  const paths = [];
  const scratch = { u: 0, v: 0 };
  for (let seed = 0; seed < budget; seed++) {
    const lon = normalizeLongitude(seed * GOLDEN_ANGLE);
    const lat =
      (Math.asin(
        (((seed + 0.5) / budget) * 2 - 1) * Math.sin((88 * Math.PI) / 180),
      ) *
        180) /
      Math.PI;
    const center = [lon, lat];
    sampleWind(field, lon, lat, scratch);
    const speed = Math.hypot(scratch.u, scratch.v);
    if (!Number.isFinite(speed) || speed < 0.15) continue;
    const backward = [];
    const forward = [];
    for (const [direction, points] of [
      [-1, backward],
      [1, forward],
    ]) {
      let point = center;
      for (let step = 0; step < halfSteps; step++) {
        point = advance(field, point, direction * interval, scratch);
        if (!point) break;
        points.push(point);
      }
    }
    const coordinates = [...backward.reverse(), center, ...forward];
    if (coordinates.length < 3) continue;
    paths.push({
      coordinates,
      speed,
      seed,
      phase: ((seed + 1) * 0.6180339887498949) % 1,
    });
  }
  return paths;
}

/** Group baked paths by their middle coordinate, preserving path and cell order. */
export function groupWindPaths(paths, cellDegrees = WIND_CELL_DEGREES) {
  if (!Number.isFinite(cellDegrees) || cellDegrees <= 0 || cellDegrees > 180)
    throw new RangeError('Wind cell size must be between 0 and 180 degrees');
  const columns = Math.ceil(360 / cellDegrees);
  const rows = Math.ceil(180 / cellDegrees);
  const cells = new Map();
  for (const path of paths) {
    const [lon, lat] = path.coordinates[Math.floor(path.coordinates.length / 2)];
    const col = Math.floor((normalizeLongitude(lon) + 180) / cellDegrees);
    const row = Math.floor((lat + 90) / cellDegrees);
    const key = row * columns + col;
    if (!cells.has(key)) cells.set(key, { paths: [] });
    cells.get(key).paths.push(path);
  }
  return [...cells.values()];
}

// A persistent fine curve plus a moving, tapered highlight.
// The integer part of s identifies a path; its fractional part follows the wind.
const FLOW_MATERIAL = `
in float v_windFacing;
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    float pathId = floor(materialInput.st.s);
    float along = fract(materialInput.st.s);
    float offset = fract((pathId + 1.0) * 0.61803398875);
    float behind = fract(phaseTime * 0.16 + offset - along);
    float tail = (1.0 - smoothstep(0.0, 0.32, behind));
    float tip = 1.0 - smoothstep(0.0, 0.045, behind);
    float ends = smoothstep(0.0, 0.055, along) * (1.0 - smoothstep(0.945, 1.0, along));
    float edge = 1.0 - smoothstep(0.26, 0.5, abs(materialInput.st.t - 0.5));
    float horizon = smoothstep(0.0, 0.065, v_windFacing);
    material.diffuse = mix(vec3(0.50, 0.79, 0.90), vec3(0.91, 0.99, 1.0), tip);
    material.alpha = (ghostAlpha + 0.64 * tail + 0.16 * tip) * ends * edge * horizon * heightFade;
    return material;
}`;

/** Native Cesium geometry/material owner. No animation loop or DOM ownership.
 * The owner ticks phaseTime and calls updateVisibility as the camera moves;
 * register a render-governor hold while any cell is visible. */
export function createWindStreamlines({ getViewer }) {
  const C = Cesium;
  const cells = [];
  let occluder = null;
  let collection = null;
  let material = null;
  let paused = false;
  let destroyed = false;
  let shown = false;
  const emptyDiagnostics = () => ({
    pathCount: 0,
    vertexCount: 0,
    buildMs: 0,
    error: null,
    cellCount: 0,
    visibleCells: 0,
    visibleVertexCount: 0,
    heightFade: 0,
  });
  let diagnostics = emptyDiagnostics();

  function supported() {
    const scene = getViewer?.()?.scene;
    return (
      !destroyed &&
      Boolean(
        scene?.primitives &&
        C?.Primitive &&
        C?.GeometryInstance &&
        C?.GeometryInstanceAttribute &&
        C?.ComponentDatatype?.FLOAT !== undefined &&
        C?.PolylineGeometry &&
        C?.PolylineMaterialAppearance &&
        C?.Material &&
        C?.BoundingSphere?.fromPoints &&
        C?.Occluder &&
        C?.Ellipsoid?.WGS84 &&
        C?.Intersect &&
        C?.Cartesian3?.fromDegrees,
      ) &&
      (C.SceneMode?.SCENE3D === undefined ||
        scene.mode === undefined ||
        scene.mode === C.SceneMode.SCENE3D)
    );
  }

  function clear() {
    for (const cell of cells) {
      collection?.remove(cell.primitive);
      if (!cell.primitive.isDestroyed?.()) cell.primitive.destroy?.();
    }
    cells.length = 0;
    occluder = null;
    collection = null;
    material?.destroy?.();
    material = null;
    diagnostics = emptyDiagnostics();
  }

  function setField(field) {
    clear();
    if (!supported() || !field) return false;
    const started = globalThis.performance?.now?.() ?? Date.now();
    try {
      const width = getViewer().scene.canvas?.clientWidth;
      const budget =
        width > 0 && width < 700 ? WIND_NARROW_PATH_LIMIT : WIND_PATH_LIMIT;
      const paths = bakeWindStreamlines(field, { count: budget });
      if (!paths.length) return false;
      let vertexCount = 0;
      material = new C.Material({
        fabric: {
          type: 'CiWindStreamline',
          uniforms: {
            phaseTime: 0,
            ghostAlpha: paused ? 0.34 : 0.25,
            heightFade: 0,
          },
          source: FLOW_MATERIAL,
        },
        translucent: () => true,
      });
      const base = new C.PolylineMaterialAppearance({ material });
      // Extend the public default shader rather than duplicate Cesium's
      // polyline expansion/precision code. Explicit facing also masks the far
      // hemisphere when a scene chooses not to preserve globe depth for
      // translucent objects.
      const source = base.vertexShaderSource;
      if (
        !/void\s+main\s*\(\s*\)/.test(source) ||
        !/v_st\.s\s*=\s*st\.s\s*;/.test(source)
      )
        throw new Error('Wind polyline shader entry unavailable');
      const seededSource = source.replace(
        /v_st\.s\s*=\s*st\.s\s*;/,
        'v_st.s = st.s * 0.999 + czm_batchTable_windSeed(batchId);',
      );
      const vertexShaderSource =
        `out float v_windFacing;\n${seededSource}`.replace(
          /void\s+main\s*\(\s*\)\s*\{/,
          `void main() {\nvec3 windWorld = (czm_model * vec4(position3DHigh + position3DLow, 1.0)).xyz;\nv_windFacing = dot(normalize(windWorld), normalize(czm_viewerPositionWC - windWorld));\n`,
        );
      const scene = getViewer().scene;
      collection = scene.primitives;
      // EllipsoidalOccluder only tests points. Use Cesium's sphere occluder
      // with an inscribed Earth sphere, independent of scene.globe.show.
      occluder = new C.Occluder(
        new C.BoundingSphere(
          C.Cartesian3.ZERO,
          C.Ellipsoid.WGS84.minimumRadius,
        ),
        scene.camera.positionWC,
      );
      for (const group of groupWindPaths(paths)) {
        const cellPositions = [];
        let cellVertexCount = 0;
        const instances = group.paths.map((path) => {
          const positions = path.coordinates.map(([lon, lat]) =>
            C.Cartesian3.fromDegrees(lon, lat, WIND_DISPLAY_HEIGHT_METERS),
          );
          // Pass the native description to Cesium's worker. Per-instance
          // seed attributes avoid touching the expanded vertex buffer on the
          // UI thread.
          const geometry = new C.PolylineGeometry({
            positions,
            width: 2.4,
            arcType: C.ArcType?.NONE,
            vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
          });
          cellPositions.push(...positions);
          cellVertexCount += positions.length * 4 - 4;
          return new C.GeometryInstance({
            geometry,
            attributes: {
              windSeed: new C.GeometryInstanceAttribute({
                componentDatatype: C.ComponentDatatype.FLOAT,
                componentsPerAttribute: 1,
                value: [path.seed],
              }),
            },
          });
        });
        const appearance = new C.PolylineMaterialAppearance({
          material,
          vertexShaderSource,
          translucent: true,
          renderState: { depthTest: { enabled: true }, depthMask: false },
        });
        const primitive = new C.Primitive({
          show: false,
          geometryInstances: instances,
          appearance,
          asynchronous: true,
          allowPicking: false,
          releaseGeometryInstances: true,
          compressVertices: false,
        });
        const cell = {
          primitive,
          sphere: C.BoundingSphere.fromPoints(cellPositions),
          vertexCount: cellVertexCount,
        };
        cells.push(cell);
        collection.add(primitive);
        vertexCount += cellVertexCount;
      }
      diagnostics = {
        ...emptyDiagnostics(),
        cellCount: cells.length,
        pathCount: paths.length,
        vertexCount,
        buildMs: (globalThis.performance?.now?.() ?? Date.now()) - started,
        error: null,
      };
      updateVisibility(getViewer().scene.camera);
      return true;
    } catch (error) {
      clear();
      diagnostics.error =
        error instanceof Error ? error.message : 'Wind geometry unavailable';
      return false;
    }
  }

  // Creates no positions, spheres, appearances or per-cell temporaries.
  function updateVisibility(camera) {
    const height = camera.positionCartographic.height;
    const heightFade = Math.max(
      0,
      Math.min(
        1,
        (height - WIND_FADE_LOW_METERS) /
          (WIND_FADE_HIGH_METERS - WIND_FADE_LOW_METERS),
      ),
    );
    diagnostics.heightFade = heightFade;
    if (material) material.uniforms.heightFade = heightFade;
    diagnostics.visibleCells = 0;
    diagnostics.visibleVertexCount = 0;
    let volume;
    if (heightFade > 0 && cells.length) {
      occluder.cameraPosition = camera.positionWC;
      volume = camera.frustum.computeCullingVolume(
        camera.positionWC,
        camera.directionWC,
        camera.upWC,
      );
    }
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      cell.primitive.show =
        shown &&
        heightFade > 0 &&
        occluder.isBoundingSphereVisible(cell.sphere) &&
        volume.computeVisibility(cell.sphere) !== C.Intersect.OUTSIDE;
      if (cell.primitive.show) {
        diagnostics.visibleCells++;
        diagnostics.visibleVertexCount += cell.vertexCount;
      }
    }
    return diagnostics.visibleCells > 0 && heightFade > 0;
  }

  return {
    supported,
    setField,
    updateVisibility,
    /** Advance the flow animation. Call each rendered frame while visible;
     * register a render-governor hold for the duration. */
    tick(elapsedSeconds) {
      if (material && !paused && Number.isFinite(elapsedSeconds))
        material.uniforms.phaseTime = Math.max(0, elapsedSeconds) % 10000;
    },
    setShow(value) {
      shown = Boolean(value);
      if (!shown) for (const cell of cells) cell.primitive.show = false;
      else updateVisibility(getViewer().scene.camera);
      getViewer()?.scene?.requestRender();
      return shown;
    },
    setPaused(value) {
      paused = Boolean(value);
      if (material) material.uniforms.ghostAlpha = paused ? 0.34 : 0.25;
    },
    isShown() {
      return shown;
    },
    getDiagnostics() {
      return { ...diagnostics, shown };
    },
    destroy() {
      destroyed = true;
      clear();
    },
  };
}
