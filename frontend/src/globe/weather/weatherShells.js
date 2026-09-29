/* Stacked 3D weather shells — ported from God's Eye View
   (src/layers/weather/shellRendering.js, MIT).

   Weather renders as stacked volumetric shells at separated altitudes with
   altitude fading, camera-lift compensation, and coarse/detail texture
   blending — weather you can see *in* rather than a flat decal on the map.

   Each shell is one raised rectangle primitive with a WeatherFrame-style GLSL
   material sampling a full-extent image and, inside a window around the view,
   an optional sharper detail image. Shells draw in the opaque pass in
   ascending-height order (alpha-blended, no depth writes) so higher shells
   draw over lower ones without z-fighting.

   Usage:
     import { createWeatherShellStack, SHELL_HEIGHTS } from './weatherShells.js';
     const stack = createWeatherShellStack(viewer);
     stack.shell('clouds').setImage(canvasOrImage);
     stack.shell('radar').setImage(canvasOrImage);
     stack.shell('radar').setAlpha(0.6);
     stack.shell('radar').setShow(false);
     stack.destroy();
*/
import * as Cesium from 'cesium';

/** Metres above the ellipsoid. Lower shells draw first. */
export const SHELL_HEIGHTS = Object.freeze({
  wind: 5000,
  clouds: 5500,
  'clouds-regional': 5800,
  radar: 6200,
  temperature: 7000,
  pressure: 7500,
});

// From far away the terrain/raster surface rises above the shells, so the
// shells rise with the camera: 4 m per kilometre of camera height, at most
// 60 km, in 500 m steps. (GEV shellRendering.js: LIFT_PER_METRE etc.)
const LIFT_PER_METRE = 0.004;
const MAX_LIFT = 60000;
const LIFT_STEP = 500;

const MATERIAL_TYPE = 'CiWeatherFrame';
// Renders after an image swap: one queues the upload, one uploads and draws,
// one spare.
const UPLOAD_FRAMES = 3;
// An empty detail window: the full-extent image shows everywhere.
const NO_WINDOW = Object.freeze({ west: 0, south: 0, east: -1, north: -1 });
// Detail windows, in degrees.
const DETAIL_MIN_WIDTH = 6;
const DETAIL_GRID = 0.5;

const MATERIAL_SOURCE = `czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  vec4 coarse = texture(image, st);
  vec2 dst = (st - window.xy) / max(window.zw - window.xy, vec2(1e-6));
  float inside = float(all(greaterThanEqual(st, window.xy)) && all(lessThanEqual(st, window.zw)));
  float useDetail = inside * step(1.5, float(detailDimensions.x));
  vec4 c = mix(coarse, texture(detail, clamp(dst, 0.0, 1.0)), useDetail);
  material.diffuse = czm_gammaCorrect(c.rgb);
  material.alpha = c.a * alpha * step(1.5, float(imageDimensions.x));
  return material;
}
`;

function registerMaterial(cesium) {
  const cache = cesium.Material._materialCache;
  if (cache.getMaterial(MATERIAL_TYPE)) return;
  cache.addMaterial(MATERIAL_TYPE, {
    fabric: {
      type: MATERIAL_TYPE,
      uniforms: {
        image: cesium.Material.DefaultImageId,
        detail: cesium.Material.DefaultImageId,
        alpha: 1,
        window: { type: 'vec4', x: 0, y: 0, z: -1, w: -1 },
      },
      source: MATERIAL_SOURCE,
    },
    translucent: false,
  });
}

const sameEdges = (a, b) =>
  a.west === b.west &&
  a.south === b.south &&
  a.east === b.east &&
  a.north === b.north;

/** Metres every shell rises for a camera this high above the ellipsoid. */
export function shellLift(cameraHeight) {
  if (!(cameraHeight > 0)) return 0;
  const lift = Math.min(MAX_LIFT, cameraHeight * LIFT_PER_METRE);
  return Math.round(lift / LIFT_STEP) * LIFT_STEP;
}

const shellHeights = new WeakMap();

/** Keep weather shells first in the primitive collection, in ascending height:
 * higher shells draw over lower ones and other opaque content draws over both. */
export function orderWeatherShells(primitives, primitive, height) {
  shellHeights.set(primitive, height);
  if (typeof primitives.lowerToBottom !== 'function') return;
  const shells = [];
  for (let i = 0; i < primitives.length; i++) {
    const item = primitives.get(i);
    if (shellHeights.has(item)) shells.push(item);
  }
  const ordered = [...shells].sort(
    (a, b) => shellHeights.get(a) - shellHeights.get(b),
  );
  if (ordered.every((item, i) => primitives.get(i) === item)) return;
  for (const item of ordered.reverse()) primitives.lowerToBottom(item);
}

/** One raised rectangle drawing one full-extent image and, inside a window of
 * it, an optional detail image. The owner calls destroy(). */
export function createShellSurface({ viewer, rectangle, height, onSettled = () => {} }) {
  const cesium = Cesium;
  registerMaterial(cesium);
  const scene = viewer.scene;
  const primitives = scene.primitives;
  const material = new cesium.Material({
    fabric: { type: MATERIAL_TYPE },
    translucent: false,
  });
  // Flat shading keeps the product colours independent of the viewing angle.
  const appearance = new cesium.EllipsoidSurfaceAppearance({
    aboveGround: true,
    flat: true,
    translucent: false,
    material,
  });
  // Draw in the opaque pass in scene.primitives order, alpha-blended and
  // without depth writes, so higher shells draw over lower ones and nothing
  // is hidden or picked through a shell.
  appearance.getRenderState = () => ({
    depthTest: { enabled: true },
    depthMask: false,
    blending: cesium.BlendingState.ALPHA_BLEND,
  });
  const primitive = new cesium.Primitive({
    geometryInstances: new cesium.GeometryInstance({
      geometry: new cesium.RectangleGeometry({
        rectangle,
        height,
        granularity: cesium.Math.toRadians(0.5),
        vertexFormat: cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
      }),
    }),
    appearance,
    asynchronous: true,
    allowPicking: false,
  });
  primitives.add(primitive);
  orderWeatherShells(primitives, primitive, height);

  // A uniform scale about the Earth's centre lifts every shell alike and keeps
  // their order.
  let lift = 0;
  const offLift = scene.preRender?.addEventListener(() => {
    const next = shellLift(scene.camera?.positionCartographic?.height);
    if (next === lift) return;
    lift = next;
    primitive.modelMatrix = cesium.Matrix4.fromUniformScale(
      1 + lift / cesium.Ellipsoid.WGS84.maximumRadius,
    );
  });

  let image = null;
  let frames = 0;
  let detail = null;
  let detailFrames = 0;
  let pendingWindow = null;
  let offRender = null;
  let destroyed = false;

  const fits = (size, value) =>
    !size || (size.x === value.width && size.y === value.height);
  const uploaded = () =>
    image !== null && fits(material.uniforms.imageDimensions, image);
  const detailDrawn = () =>
    detail !== null &&
    detailFrames === 0 &&
    fits(material.uniforms.detailDimensions, detail);
  const drawn = () =>
    primitive.ready &&
    uploaded() &&
    frames === 0 &&
    (detail === null || (detailDrawn() && pendingWindow === null));
  function appliedWindow() {
    const { x, y, z, w } = material.uniforms.window;
    return z < x ? null : { west: x, south: y, east: z, north: w };
  }
  function setWindow(rect) {
    const next = rect ?? NO_WINDOW;
    const { x, y, z, w } = material.uniforms.window;
    if (x === next.west && y === next.south && z === next.east && w === next.north)
      return;
    material.uniforms.window = new cesium.Cartesian4(
      next.west,
      next.south,
      next.east,
      next.north,
    );
    scene.requestRender();
  }
  function tick() {
    if (primitive.ready && primitive.show) {
      if (frames > 0) frames--;
      if (detailFrames > 0) detailFrames--;
      if (pendingWindow && detailDrawn()) {
        setWindow(pendingWindow);
        pendingWindow = null;
      }
    }
    if (primitive.show && !drawn()) {
      scene.requestRender();
      return;
    }
    offRender?.();
    offRender = null;
    if (drawn()) onSettled();
  }
  function wake() {
    if (destroyed || !primitive.show || image === null || drawn()) return;
    offRender ??= scene.postRender.addEventListener(tick);
    scene.requestRender();
  }

  return {
    setImage(next) {
      if (destroyed || next === image) return;
      image = next;
      material.uniforms.image = next;
      frames = UPLOAD_FRAMES;
      wake();
    },
    setAlpha(value) {
      if (destroyed || material.uniforms.alpha === value) return;
      material.uniforms.alpha = value;
      scene.requestRender();
    },
    /** Draw `next` inside `rect` (west/south/east/north in the full-extent
     * image's texture coordinates, 0–1); null clears it. */
    setDetail(next, rect) {
      if (destroyed) return;
      if (!next) {
        if (detail === null) return;
        detail = null;
        detailFrames = 0;
        pendingWindow = null;
        material.uniforms.detail = cesium.Material.DefaultImageId;
        setWindow(null);
        scene.requestRender();
        return;
      }
      if (next !== detail) {
        detail = next;
        material.uniforms.detail = next;
        detailFrames = UPLOAD_FRAMES;
      }
      const applied = appliedWindow();
      if (applied && sameEdges(applied, rect)) {
        pendingWindow = null;
      } else {
        setWindow(null);
        pendingWindow = rect;
      }
      wake();
    },
    setShow(value) {
      const show = Boolean(value);
      if (destroyed || primitive.show === show) return false;
      primitive.show = show;
      wake();
      scene.requestRender();
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offRender?.();
      offRender = null;
      offLift?.();
      if (!primitives.isDestroyed?.() && primitives.contains(primitive))
        primitives.remove(primitive);
      if (!primitive.isDestroyed()) primitive.destroy();
      if (!material.isDestroyed()) material.destroy();
      image = null;
      detail = null;
      pendingWindow = null;
      scene.requestRender();
    },
    getDiagnostics() {
      return {
        height,
        ready: Boolean(primitive.ready),
        uploaded: uploaded(),
        show: primitive.show,
        alpha: material.uniforms.alpha,
        rendering: offRender !== null,
      };
    },
  };
}

/** The detail window for a view footprint over product bounds (both in degrees;
 * a footprint across the antimeridian has west > east), or null when the
 * full-extent image is already the best available. */
export function detailWindow(footprint, bounds, previous = null) {
  if (!footprint || !bounds) return null;
  const across = footprint.east < footprint.west;
  const span = footprint.east - footprint.west + (across ? 360 : 0);
  let lon = footprint.west + span / 2;
  if (lon > 180) lon -= 360;
  const lat = (footprint.south + footprint.north) / 2;
  const wanted = Math.max(2 * span, DETAIL_MIN_WIDTH);
  if (previous) {
    const width = previous.east - previous.west;
    const height = previous.north - previous.south;
    if (
      Math.abs(lon - (previous.west + previous.east) / 2) <= width / 4 &&
      Math.abs(lat - (previous.south + previous.north) / 2) <= height / 4 &&
      Math.abs(wanted - width) <= width / 2
    )
      return previous;
  }
  const inner = {
    west: Math.ceil(bounds.west / DETAIL_GRID) * DETAIL_GRID,
    south: Math.ceil(bounds.south / DETAIL_GRID) * DETAIL_GRID,
    east: Math.floor(bounds.east / DETAIL_GRID) * DETAIL_GRID,
    north: Math.floor(bounds.north / DETAIL_GRID) * DETAIL_GRID,
  };
  const width = Math.ceil(wanted - 1e-9);
  const height = width / 2;
  const overlaps =
    footprint.south < bounds.north &&
    footprint.north > bounds.south &&
    (across
      ? footprint.west < bounds.east || footprint.east > bounds.west
      : footprint.west < bounds.east && footprint.east > bounds.west);
  if (
    !overlaps ||
    width >= (bounds.east - bounds.west) / 2 ||
    width > inner.east - inner.west ||
    height > inner.north - inner.south
  )
    return null;
  const snap = (value) => Math.round(value / DETAIL_GRID) * DETAIL_GRID;
  const west = Math.min(
    Math.max(snap(lon - width / 2), inner.west),
    inner.east - width,
  );
  const south = Math.min(
    Math.max(snap(lat - height / 2), inner.south),
    inner.north - height,
  );
  const next = { west, south, east: west + width, north: south + height };
  return previous && sameEdges(previous, next) ? previous : next;
}

/** Manage a stack of named weather shells for one viewer.
 * Each shell owns its own surface; the stack handles ordering, lift and
 * per-shell alpha/show/image. rectangle defaults to the whole globe. */
export function createWeatherShellStack(
  viewer,
  { rectangle = null, defaultAlpha = 0.7 } = {},
) {
  const rect =
    rectangle ??
    Cesium.Rectangle.fromDegrees(-180, -90, 180, 90);
  const shells = new Map();

  function shell(name) {
    let entry = shells.get(name);
    if (!entry) {
      const height = SHELL_HEIGHTS[name] ?? 6000;
      const surface = createShellSurface({ viewer, rectangle: rect, height });
      entry = {
        name,
        height,
        setImage: (img) => surface.setImage(img),
        setDetail: (img, r) => surface.setDetail(img, r),
        setAlpha: (v) => surface.setAlpha(v),
        setShow: (v) => surface.setShow(v),
        getDiagnostics: () => surface.getDiagnostics(),
        destroy: () => surface.destroy(),
      };
      surface.setAlpha(defaultAlpha);
      shells.set(name, entry);
    }
    return entry;
  }

  return {
    shell,
    has(name) {
      return shells.has(name);
    },
    setShow(name, value) {
      return shell(name).setShow(value);
    },
    setAlpha(name, value) {
      return shell(name).setAlpha(value);
    },
    remove(name) {
      const entry = shells.get(name);
      if (!entry) return;
      entry.destroy();
      shells.delete(name);
    },
    destroy() {
      for (const entry of shells.values()) entry.destroy();
      shells.clear();
    },
    getDiagnostics() {
      const out = {};
      for (const [name, entry] of shells) out[name] = entry.getDiagnostics();
      return out;
    },
  };
}
