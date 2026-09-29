/* Launch visualization — adapted from God's Eye View
   (src/layers/launches/launchPad.js, orbitRendering.js, replay.js, MIT).

   Three pieces:

   1. Tactical orbit-line GLSL material (audit 2.29): dashes + direction-of-
      travel chevrons on a polyline instead of a plain polyline — "where is it
      going" readable at a glance. Time-scrolled via a `phaseTime` uniform;
      tick it while visible.

   2. Launch-pad radial zone (audit 2.30): pads get a radial keep-out/interest
      zone rendered on the globe — geographic context beyond a point marker.
      Direct adaptation of GEV's GevLaunchPadZone shader on an ellipse
      GroundPrimitive with depth-bias render state.

   3. Launch ascent-path replay (audit 2.31): a scrub-able replay of the
      ascent path. `reconstructAscentPath()` builds a plausible gravity-turn
      path from pad coordinates + target inclination when no provider
      trajectory is available (marked reconstructed); `createAscentReplay()`
      animates a vehicle marker along any Cartesian3 path with play/pause/seek.

   Usage:
     const mat = createTacticalOrbitMaterial('#22d3ee');
     const zone = showLaunchPadZone(viewer, { id, lon, lat, radiusM: 8000 });
     const replay = createAscentReplay(viewer);
     replay.load(pathPositions, { durationSec: 480 });
     replay.play();
*/
import * as Cesium from 'cesium';

/* ------------------------------------------------------------------ */
/* 1. Tactical orbit-line GLSL material                                 */
/* ------------------------------------------------------------------ */

// st.s runs 0..1 along the line, st.t 0..1 across it. Dashes mark distance;
// chevrons (V shapes pointing +s, the direction of travel) scroll with time.
const TACTICAL_ORBIT_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    float s = materialInput.st.s * dashRepeat - phaseTime * scrollSpeed;
    float t = materialInput.st.t;
    // Direction-of-travel chevrons: V shapes pointing +s.
    float chevCoord = fract(s + abs(t - 0.5) * chevronSlope);
    float chevron = smoothstep(0.0, 0.06, chevCoord) * (1.0 - smoothstep(0.30, 0.38, chevCoord));
    // Dashes along the line.
    float dash = smoothstep(0.0, 0.03, fract(s * 0.5)) * (1.0 - smoothstep(0.42, 0.5, fract(s * 0.5)));
    float edge = 1.0 - smoothstep(0.30, 0.5, abs(t - 0.5));
    float ends = smoothstep(0.0, 0.01, materialInput.st.s) * (1.0 - smoothstep(0.99, 1.0, materialInput.st.s));
    float glow = chevron * 0.9 + dash * 0.35;
    material.diffuse = mix(color.rgb, vec3(1.0), chevron * 0.55);
    material.emission = color.rgb * glow * 0.8;
    material.alpha = color.a * (dash * 0.55 + chevron * 0.95) * edge * ends;
    return material;
}
`;

const tacticalMaterials = new Set();

export function createTacticalOrbitMaterial(
  colorCss = '#22d3ee',
  {
    dashRepeat = 90,
    chevronSlope = 1.6,
    scrollSpeed = 0.35,
    alpha = 0.85,
  } = {},
) {
  const material = new Cesium.Material({
    fabric: {
      type: 'CiTacticalOrbit',
      uniforms: {
        color: Cesium.Color.fromCssColorString(colorCss).withAlpha(alpha),
        phaseTime: 0,
        dashRepeat,
        chevronSlope,
        scrollSpeed,
      },
      source: TACTICAL_ORBIT_SOURCE,
    },
    translucent: true,
  });
  tacticalMaterials.add(material);
  return material;
}

/** Advance every live tactical orbit material's scroll phase. Call each
 * rendered frame while any are visible; register a render-governor hold. */
export function tickTacticalMaterials(elapsedSeconds) {
  if (!Number.isFinite(elapsedSeconds)) return;
  const t = Math.max(0, elapsedSeconds) % 10000;
  for (const m of tacticalMaterials) {
    if (m.isDestroyed?.()) {
      tacticalMaterials.delete(m);
      continue;
    }
    m.uniforms.phaseTime = t;
  }
}

export function destroyTacticalMaterial(material) {
  tacticalMaterials.delete(material);
  if (!material.isDestroyed?.()) material.destroy();
}

/** Build a one-instance orbit polyline with the tactical material.
 * Returns { primitive, material, tick } — tick(elapsedSeconds) scrolls it. */
export function createTacticalOrbitLine(viewer, positions, options = {}) {
  const material = createTacticalOrbitMaterial(options.color, options);
  const primitive = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.PolylineGeometry({
        positions,
        width: options.width ?? 2.5,
        vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
      }),
    }),
    appearance: new Cesium.PolylineMaterialAppearance({
      material,
      translucent: true,
      renderState: { depthTest: { enabled: true }, depthMask: false },
    }),
    asynchronous: false,
    allowPicking: false,
  });
  viewer.scene.primitives.add(primitive);
  viewer.scene.requestRender();
  return {
    primitive,
    material,
    tick: (t) => {
      if (!material.isDestroyed?.()) material.uniforms.phaseTime = t;
    },
    destroy() {
      if (!primitive.isDestroyed()) {
        viewer.scene.primitives.remove(primitive);
        primitive.destroy();
      }
      destroyTacticalMaterial(material);
      viewer.scene.requestRender();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2. Launch-pad radial zone                                            */
/* ------------------------------------------------------------------ */

const PAD_ZONE_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 centered = (materialInput.st - vec2(0.5)) * 2.0;
  float radius = length(centered);
  float inside = 1.0 - smoothstep(0.985, 1.0, radius);
  float rim = smoothstep(0.952, 0.985, radius) * inside;
  material.diffuse = color.rgb;
  material.emission = color.rgb * rim * 0.35;
  material.alpha = color.a * inside * mix(fillAlpha, rimAlpha, rim);
  return material;
}
`;

/** Show a radial zone around a launch pad. Returns a handle with destroy().
 * radiusM defaults to a conservative 8 km when pad data has no zone. */
export function showLaunchPadZone(
  viewer,
  { id = 'pad', lon, lat, radiusM = 8000, colorCss = '#22e6e6' } = {},
) {
  const material = new Cesium.Material({
    fabric: {
      type: 'CiLaunchPadZone',
      uniforms: {
        color: Cesium.Color.fromCssColorString(colorCss),
        fillAlpha: 0.105,
        rimAlpha: 0.72,
      },
      source: PAD_ZONE_SOURCE,
    },
  });
  const geometry = new Cesium.EllipseGeometry({
    center: Cesium.Cartesian3.fromDegrees(lon, lat),
    semiMajorAxis: radiusM,
    semiMinorAxis: radiusM,
    granularity: Cesium.Math.toRadians(0.08),
    vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
  });
  const primitive = new Cesium.GroundPrimitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry,
      id: `launch-pad-zone:${id}`,
    }),
    appearance: new Cesium.MaterialAppearance({
      material,
      translucent: true,
      closed: false,
      faceForward: true,
      flat: true,
      // Keep the zone classified onto the surface, but bias only its
      // rasterized depth toward the camera. Avoids coplanar fragments being
      // intermittently buried at oblique angles without floating the ring.
      renderState: {
        depthTest: { enabled: true },
        polygonOffset: {
          enabled: true,
          factor: -1,
          units: -1,
        },
      },
    }),
    allowPicking: false,
    asynchronous: true,
  });
  viewer.scene.primitives.add(primitive);
  viewer.scene.requestRender();
  return {
    primitive,
    destroy() {
      if (!primitive.isDestroyed()) {
        if (viewer.scene.primitives.contains(primitive))
          viewer.scene.primitives.remove(primitive);
        primitive.destroy();
      }
      if (!material.isDestroyed()) material.destroy();
      viewer.scene.requestRender();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3. Ascent-path reconstruction + replay                              */
/* ------------------------------------------------------------------ */

function destinationPoint(lonDeg, latDeg, bearingDeg, distanceM) {
  const R = 6371000;
  const d = distanceM / R;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (latDeg * Math.PI) / 180;
  const lon1 = (lonDeg * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

/** Reconstruct a plausible gravity-turn ascent path when no provider
 * trajectory exists. Pad -> vertical rise -> pitch-over toward the target
 * inclination's launch azimuth -> orbital insertion altitude. The result is
 * marked reconstructed: true — never present it as measured telemetry. */
export function reconstructAscentPath(
  padLon,
  padLat,
  {
    inclinationDeg = 51.6,
    altitudeM = 400000,
    durationSec = 520,
    stepSec = 5,
  } = {},
) {
  // Launch azimuth for a target inclination (prograde), simplified.
  const latR = (padLat * Math.PI) / 180;
  const incR = (inclinationDeg * Math.PI) / 180;
  const cosAz = Math.cos(incR) / Math.max(Math.cos(latR), 1e-6);
  const azimuthDeg =
    (Math.acos(Math.min(1, Math.max(-1, cosAz))) * 180) / Math.PI;
  const positions = [];
  // ~7.8 km/s orbital velocity; downrange distance at insertion.
  const downrangeM = 7800 * durationSec * 0.55;
  for (let t = 0; t <= durationSec; t += stepSec) {
    const f = t / durationSec;
    // Altitude: fast initial rise, flattening toward insertion.
    const alt = altitudeM * (1 - Math.pow(1 - f, 2.2));
    // Downrange: gravity turn — mostly vertical early, mostly horizontal late.
    const dist = downrangeM * Math.pow(f, 1.6);
    const [lon, lat] = destinationPoint(padLon, padLat, azimuthDeg, dist);
    positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(0, alt)));
  }
  return { positions, reconstructed: true, azimuthDeg, durationSec };
}

/** Scrub-able ascent replay: animates a vehicle marker along a Cartesian3
 * path. Drive with play()/pause()/seek(); tick with clock elapsed seconds
 * (or call tick manually). Register a render-governor hold while playing. */
export function createAscentReplay(viewer) {
  let pathPrimitive = null;
  let marker = null;
  let positions = [];
  let durationSec = 480;
  let elapsed = 0;
  let playing = false;
  let destroyed = false;

  function makeMarker() {
    const c = document.createElement('canvas');
    c.width = c.height = 40;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(20, 20, 0, 20, 20, 20);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,200,120,0.95)');
    grad.addColorStop(1, 'rgba(255,150,60,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 40, 40);
    return c;
  }

  function positionAt(fraction) {
    if (!positions.length) return null;
    const f = Math.min(1, Math.max(0, fraction));
    const idx = f * (positions.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(positions.length - 1, i0 + 1);
    const t = idx - i0;
    return Cesium.Cartesian3.lerp(
      positions[i0],
      positions[i1],
      t,
      new Cesium.Cartesian3(),
    );
  }

  return {
    /** Load a path (Cartesian3[]) and draw it with the tactical material. */
    load(pathPositions, { duration = 480, color = '#ffb14e' } = {}) {
      this.unload();
      positions = pathPositions.slice();
      durationSec = duration;
      elapsed = 0;
      const line = createTacticalOrbitLine(viewer, positions, {
        color,
        width: 3,
      });
      pathPrimitive = line;
      marker = viewer.entities.add({
        position: positionAt(0),
        billboard: {
          image: makeMarker(),
          width: 22,
          height: 22,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      viewer.scene.requestRender();
    },
    play() {
      playing = true;
    },
    pause() {
      playing = false;
    },
    isPlaying() {
      return playing;
    },
    /** Jump to a fraction of the ascent (0..1). */
    seek(fraction) {
      elapsed = Math.min(1, Math.max(0, fraction)) * durationSec;
      if (marker) marker.position = positionAt(elapsed / durationSec);
      viewer.scene.requestRender();
    },
    /** Advance the replay by dt seconds. Returns the current fraction. */
    tick(dtSec) {
      if (destroyed || !playing || !positions.length) return elapsed / durationSec;
      elapsed += dtSec;
      if (elapsed >= durationSec) {
        elapsed = durationSec;
        playing = false;
      }
      if (marker) marker.position = positionAt(elapsed / durationSec);
      pathPrimitive?.tick(elapsed);
      viewer.scene.requestRender();
      return elapsed / durationSec;
    },
    unload() {
      playing = false;
      if (marker && !viewer.entities.isDestroyed?.()) {
        viewer.entities.remove(marker);
        marker = null;
      }
      pathPrimitive?.destroy();
      pathPrimitive = null;
      positions = [];
      viewer.scene.requestRender();
    },
    destroy() {
      destroyed = true;
      this.unload();
    },
  };
}
