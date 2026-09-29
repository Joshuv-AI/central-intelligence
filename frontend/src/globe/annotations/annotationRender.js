/**
 * World-space annotation renderer.
 *
 * Ported from God's Eye View (MIT) `src/annotations/worldAnnotationRenderer.js`.
 * Renders stored/session marks as native Cesium entities on a dedicated
 * CustomDataSource (separate from CI's data markers):
 * - areas: clampToGround polygon fill + glowing draped outline
 * - lines: clamped polyline with the animated flow-dash material
 * - pins: billboard dot + camera-scaled range ring (ringRadius())
 *
 * ANIMATION: live color/alpha/pulse and the flow-dash `time` uniform are all
 * driven by CallbackProperty / getValue reading the wall clock — zero per-frame
 * JS bookkeeping, no rAF owned by this module. This relies on CI rendering
 * continuously (it does: the idle spin). If CI ever moves to
 * requestRenderMode, the integrator must request renders while flow/pulse
 * marks are visible, or the dashes freeze.
 */
import * as Cesium from 'cesium';

const PALETTE = {
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
};

// CI's surface is the terrain globe (no photoreal 3D tiles), so fills classify
// against the terrain. Polylines drape with clampToGround.
const CLASSIFY = Cesium.ClassificationType.TERRAIN;

/* Registry so updateAnnotationColors can reach per-mark live state. */
const REGISTRIES = new WeakMap(); // dataSource -> Map(id -> entry)

/**
 * Render marks into a data source, diffing by id (add new, update color refs,
 * remove gone). Marks: [{ id, kind, vertices: [[lon,lat]], label, color }].
 * @param {{ viewer: Cesium.Viewer, dataSource?: Cesium.CustomDataSource, marks: Array<object> }} opts
 * @returns {{ dataSource: Cesium.CustomDataSource, updateColors: Function, setMarks: Function, destroy: Function }}
 */
export function renderAnnotations({ viewer, dataSource, marks = [] } = {}) {
  if (!viewer) throw new Error('renderAnnotations: viewer is required');
  const source =
    dataSource || new Cesium.CustomDataSource('ci-annotations');
  if (!dataSource) viewer.dataSources.add(source);

  ensureFlowFabricRegistered();
  const registry = new Map();
  REGISTRIES.set(source, registry);

  const render = (nextMarks) => {
    const seen = new Set();
    for (const mark of nextMarks || []) {
      if (!mark || seen.has(mark.id)) continue;
      seen.add(mark.id);
      const existing = registry.get(mark.id);
      if (existing) {
        existing.css = colorCss(mark);
        existing.mark = mark;
      } else {
        registry.set(mark.id, addMark(viewer, source, mark));
      }
    }
    for (const [id, entry] of [...registry]) {
      if (!seen.has(id)) {
        removeMark(source, entry);
        registry.delete(id);
      }
    }
  };

  render(marks);

  return {
    dataSource: source,
    /** Re-render after the integrator's mark list changes. */
    setMarks: render,
    /** Push new colors into live materials (see updateAnnotationColors). */
    updateColors: (nextMarks) =>
      updateAnnotationColors({ dataSource: source, marks: nextMarks }),
    destroy() {
      for (const [, entry] of registry) removeMark(source, entry);
      registry.clear();
      REGISTRIES.delete(source);
      try {
        viewer.dataSources.remove(source, true);
      } catch {
        /* viewer already disposed */
      }
    },
  };
}

/**
 * Update colors of already-rendered marks without re-creating entities.
 * The CallbackProperty live colors read the entry's css on every frame, so
 * mutating it (and raising definitionChanged) is enough.
 */
export function updateAnnotationColors({ dataSource, marks = [] } = {}) {
  const registry = dataSource && REGISTRIES.get(dataSource);
  if (!registry) return 0;
  let updated = 0;
  for (const mark of marks) {
    const entry = mark && registry.get(mark.id);
    if (!entry) continue;
    entry.css = colorCss(mark);
    entry.mark = mark;
    for (const prop of entry.liveProps) {
      try {
        prop.definitionChanged.raiseEvent(prop);
      } catch {
        /* noop */
      }
    }
    updated += 1;
  }
  return updated;
}

function colorCss(mark) {
  return PALETTE[mark?.color] || PALETTE.primary;
}

/* ---- per-mark entity builders ---------------------------------------- */

function addMark(viewer, source, mark) {
  const entry = {
    mark,
    css: colorCss(mark),
    entities: [],
    liveProps: [],
  };
  // Published BEFORE entities land: a mid-add failure must leave the entities
  // that DID land visible to removeMark(), or they stay on the globe forever.
  const base = () => Cesium.Color.fromCssColorString(entry.css);

  if (mark.kind === 'area' && mark.vertices?.length >= 3) {
    const flat = mark.vertices.flatMap(([lon, lat]) => [lon, lat]);
    const positions = Cesium.Cartesian3.fromDegreesArray(flat);
    const fill = liveColor(entry, base(), { alpha: 0.2, pulse: true });
    entry.entities.push(
      source.entities.add({
        id: `anno-${mark.id}-fill`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: new Cesium.ColorMaterialProperty(fill),
          classificationType: CLASSIFY,
        },
      }),
    );
    const outline = liveColor(entry, base(), { alpha: 1 });
    entry.entities.push(
      source.entities.add({
        id: `anno-${mark.id}-outline`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            closeRing(mark.vertices).flatMap(([lon, lat]) => [lon, lat]),
          ),
          width: 5,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.35,
            color: outline,
          }),
          clampToGround: true,
        },
      }),
    );
  } else if (mark.kind === 'line' && mark.vertices?.length >= 2) {
    const positions = Cesium.Cartesian3.fromDegreesArray(
      mark.vertices.flatMap(([lon, lat]) => [lon, lat]),
    );
    const flow = new FlowMaterialProperty(entry);
    entry.liveProps.push(flow);
    entry.entities.push(
      source.entities.add({
        id: `anno-${mark.id}-line`,
        polyline: {
          positions,
          width: 7,
          material: flow,
          clampToGround: true,
        },
      }),
    );
  } else {
    // pin (or anything that fell through): camera-proportional target ring + dot.
    const [lon, lat] = mark.vertices?.[0] || [0, 0];
    const ring = liveColor(entry, base(), { alpha: 0.38, pulse: true });
    entry.entities.push(
      source.entities.add({
        id: `anno-${mark.id}-ring`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          // semiMajor === semiMinor must hold EVERY frame; both read the same
          // ringRadius() (camera height is constant within a frame).
          semiMajorAxis: new Cesium.CallbackProperty(
            () => ringRadius(viewer),
            false,
          ),
          semiMinorAxis: new Cesium.CallbackProperty(
            () => ringRadius(viewer),
            false,
          ),
          material: new Cesium.ColorMaterialProperty(ring),
          outline: false,
          classificationType: CLASSIFY,
        },
      }),
    );
    const dot = liveColor(entry, base(), { alpha: 1 });
    entry.entities.push(
      source.entities.add({
        id: `anno-${mark.id}-pin`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        billboard: {
          image: pinImage(entry.css),
          width: 40,
          height: 40,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          color: dot,
        },
      }),
    );
  }
  return entry;
}

function removeMark(source, entry) {
  for (const entity of entry.entities) {
    try {
      source.entities.remove(entity);
    } catch {
      /* already gone */
    }
  }
  entry.entities.length = 0;
}

/** Target-ring radius (metres) scaled to camera height so it reads at any altitude. */
export function ringRadius(viewer) {
  const h = viewer?.camera?.positionCartographic?.height ?? 1000;
  return Math.max(14, Math.min(170, h * 0.03));
}

/** A live color that follows the entry's current css (updated in place). */
function liveColor(entry, base, { alpha = 0.9, pulse = false } = {}) {
  const prop = new Cesium.CallbackProperty(() => {
    const a = alpha * (pulse ? pulseFactor() : 1);
    const c = Cesium.Color.fromCssColorString(entry.css || PALETTE.primary);
    return c.withAlpha(Math.max(0, Math.min(1, a)));
  }, false);
  entry.liveProps.push(prop);
  return prop;
}

function pulseFactor() {
  // 0.6 .. 1.0 sinusoid at ~0.8 Hz
  return 0.8 + 0.2 * Math.sin(performance.now() * 0.005);
}

/** The ring with its first vertex repeated at the end, so an outline closes. */
function closeRing(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) return vertices;
  const [fl, fa] = vertices[0];
  const [ll, la] = vertices[vertices.length - 1];
  return fl === ll && fa === la ? vertices : [...vertices, vertices[0]];
}

/* ---- pin sprite (self-contained; CI's Sprites module is for data markers) ---- */
const _pinCache = new Map();
function pinImage(css) {
  if (_pinCache.has(css)) return _pinCache.get(css);
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(24, 24, 2, 24, 24, 22);
  g.addColorStop(0, css);
  g.addColorStop(0.45, css);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(24, 24, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#06121c';
  ctx.beginPath();
  ctx.arc(24, 24, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = css;
  ctx.beginPath();
  ctx.arc(24, 24, 6, 0, Math.PI * 2);
  ctx.fill();
  const url = canvas.toDataURL();
  _pinCache.set(css, url);
  return url;
}

/* ---- flow-dash material ------------------------------------------------ */

let _flowFabricRegistered = false;
/** Register the CiRouteFlow fabric ONCE so Material.fromType() can build it.
 * Constructing one Material with the fabric caches it under its type name. */
export function ensureFlowFabricRegistered() {
  if (_flowFabricRegistered) return;
  makeRouteFlowMaterial('#ffffff'); // side effect: registers 'CiRouteFlow'
  _flowFabricRegistered = true;
}

/**
 * A custom Fabric polyline material whose dashes flow toward the destination.
 * `materialInput.st.s` is the along-line coordinate (0 = origin, 1 = dest), so
 * `fract(s*repeat - time*speed)` scrolls the pattern toward the end.
 */
function makeRouteFlowMaterial(colorCss) {
  return new Cesium.Material({
    fabric: {
      type: 'CiRouteFlow',
      uniforms: {
        color: Cesium.Color.fromCssColorString(colorCss).withAlpha(0.95),
        time: 0.0,
        repeat: 64.0, // dash cells along the whole route
        duty: 0.46, // fraction of each cell that is "on"
        speed: 0.55, // cells per second toward the destination
      },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          float s = materialInput.st.s;                  // 0 origin -> 1 dest
          float flow = fract(s * repeat - time * speed); // scroll toward dest
          float on = smoothstep(duty + 0.08, duty - 0.08, flow);
          // keep a faint baseline so the whole line stays readable between dashes
          float a = max(on, 0.18);
          m.diffuse = color.rgb;
          m.emission = color.rgb * on * 0.9;             // glow on the lit cells
          m.alpha = color.a * a;
          return m;
        }`,
    },
  });
}

/**
 * MaterialProperty for the animated line. Cesium builds the rendered Material
 * once from getType() (our registered CiRouteFlow fabric), then EACH FRAME calls
 * getValue(time, result.uniforms) and uses whatever we write INTO that uniforms
 * object — it ignores the return value. So getValue writes color/time/repeat/
 * duty/speed straight onto `result` (the live uniforms). The animated `time` is
 * read from the wall clock here, so the dashes flow every rendered frame with
 * no per-frame JS bookkeeping. Bound to the registry ENTRY (not the css string)
 * so updateAnnotationColors re-colors live lines without re-creating them.
 */
export function FlowMaterialProperty(entry) {
  this._entry = entry;
  this._definitionChanged = new Cesium.Event();
}
Object.defineProperties(FlowMaterialProperty.prototype, {
  isConstant: {
    get() {
      return false;
    },
  }, // re-evaluated each frame → it animates
  definitionChanged: {
    get() {
      return this._definitionChanged;
    },
  },
});
FlowMaterialProperty.prototype.getType = function getType() {
  return 'CiRouteFlow';
};
FlowMaterialProperty.prototype.getValue = function getValue(time, result) {
  // `result` IS the live uniforms object Cesium renders — write into it directly.
  if (!Cesium.defined(result)) result = {};
  result.color = Cesium.Color.fromCssColorString(
    this._entry.css || PALETTE.primary,
  ).withAlpha(0.95);
  result.time = performance.now() / 1000; // the per-frame animated value
  result.repeat = 64.0;
  result.duty = 0.46;
  result.speed = 0.55;
  return result;
};
FlowMaterialProperty.prototype.equals = function equals(other) {
  return this === other;
};
