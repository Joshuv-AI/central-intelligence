/* Generic local-GeoJSON overlay engine — simplified port of God's Eye View
   src/data/localGeojsonCore.js + localGeojsonLod.js (MIT, adapted).

   Loads an imported GeoJSON FeatureCollection (Point features — polygons are
   pre-centroided to points at build time) and renders:
     - billboard dots (one BillboardCollection, canvas sprite per layer color)
     - terrain-anchored stems (one PolylineCollection, vertical lines from
       ellipsoid height 0 up to a fixed tip height; dots themselves clamp to
       the globe/terrain via HeightReference.CLAMP_TO_GROUND)
     - a label budget (one LabelCollection, at most `labelMax` labels, only
       for named features)

   LOD is zoom-gated on camera height (Cesium has no zoom level; thresholds
   are metres above the ellipsoid, same convention as flights/index.js):
     - dots show below `maxHeightM`
     - stems + labels only below `detailHeightM`
   The gate re-evaluates on camera moveEnd — never per frame.

   ODbL NOTE: OSM-derived datasets rendered through this engine (datacenters,
   dams) are © OpenStreetMap contributors under the Open Database License 1.0.
   Keep that attribution wherever a layer built on this engine is surfaced. */
import * as Cesium from 'cesium';

function makeDotSprite(cssColor, px) {
  const S = px + 8;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const cx = S / 2;
  const color = Cesium.Color.fromCssColorString(cssColor);
  const grad = g.createRadialGradient(cx, cx, 0, cx, cx, px / 2 + 4);
  grad.addColorStop(0, color.withAlpha(0.25).toCssColorString());
  grad.addColorStop(1, color.withAlpha(0).toCssColorString());
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cx, px / 2 + 4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = color.toCssColorString();
  g.beginPath();
  g.arc(cx, cx, px / 2, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.lineWidth = 1;
  g.stroke();
  return c;
}

function cleanText(v) {
  const t = String(v ?? '').trim();
  return t || null;
}

/** @returns {Array<{lon:number,lat:number,name:string|null,sub:string|null}>} */
export function extractPoints(featureCollection) {
  const feats = featureCollection?.features;
  if (!Array.isArray(feats)) return [];
  const out = [];
  for (const f of feats) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
    const p = f.properties || {};
    out.push({
      lon,
      lat,
      name: cleanText(p.name),
      sub: cleanText(p.operator ?? p.output ?? p.river),
    });
  }
  return out;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {object} config
 * @param {string} config.id            stable id (debugging)
 * @param {object} config.data          imported GeoJSON FeatureCollection
 * @param {string} config.color         CSS dot/stem color
 * @param {number} [config.dotPx=9]
 * @param {number} [config.stemHeightM=2500]   stem tip above ellipsoid
 * @param {number} [config.maxHeightM=12000000] dots visible below this
 * @param {number} [config.detailHeightM=2500000] stems+labels below this
 * @param {number} [config.labelMax=120]   label budget (named features only)
 */
export function createLocalGeojsonLayer(viewer, config) {
  const points = extractPoints(config.data);
  const dotPx = config.dotPx ?? 9;
  const stemHeightM = config.stemHeightM ?? 2500;
  const maxHeightM = config.maxHeightM ?? 12_000_000;
  const detailHeightM = config.detailHeightM ?? 2_500_000;
  const labelMax = config.labelMax ?? 120;
  const color = Cesium.Color.fromCssColorString(config.color || '#ffffff');
  const scene = viewer.scene;

  const billboards = scene.primitives.add(
    new Cesium.BillboardCollection({ scene }),
  );
  const stems = scene.primitives.add(new Cesium.PolylineCollection());
  const labels = scene.primitives.add(new Cesium.LabelCollection({ scene }));
  billboards.show = stems.show = labels.show = false;

  const dotSprite = makeDotSprite(config.color || '#ffffff', dotPx);
  const idPrefix = config.idPrefix || null; // e.g. 'dc-' — makes billboards pickable for detail cards
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    billboards.add({
      ...(idPrefix ? { id: `${idPrefix}${i}` } : null),
      image: dotSprite,
      width: dotPx + 8,
      height: dotPx + 8,
      position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, 0),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: 150000, // visible through terrain only close-in
    });
    const base = Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, 0, undefined, new Cesium.Cartesian3());
    const tip = Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, stemHeightM);
    stems.add({
      positions: [base, tip],
      width: 1,
      material: Cesium.Material.fromType('Color', {
        color: color.withAlpha(0.35),
      }),
    });
  }
  // Label budget: first `labelMax` named features (stable, deterministic).
  let labeled = 0;
  for (const pt of points) {
    if (labeled >= labelMax) break;
    if (!pt.name) continue;
    labels.add({
      text: pt.name,
      position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, stemHeightM),
      font: '11px system-ui, sans-serif',
      fillColor: Cesium.Color.WHITE.withAlpha(0.92),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
      outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -6),
      disableDepthTestDistance: 150000,
    });
    labeled++;
  }

  function cameraHeightM() {
    return viewer.scene.camera.positionCartographic.height;
  }

  function refreshLod() {
    const h = cameraHeightM();
    const dotsOn = h < maxHeightM;
    const detailOn = h < detailHeightM;
    billboards.show = dotsOn && layer.enabled;
    stems.show = detailOn && layer.enabled;
    labels.show = detailOn && layer.enabled;
  }

  let moveEndRemove = null;
  const layer = {
    id: config.id,
    count: points.length,
    points, // exposed for detail-card getters (e.g. getDatacenter)
    enabled: false,
    show() {
      layer.enabled = true;
      if (!moveEndRemove) {
        moveEndRemove = viewer.camera.moveEnd.addEventListener(refreshLod);
      }
      refreshLod();
    },
    hide() {
      layer.enabled = false;
      billboards.show = stems.show = labels.show = false;
    },
    refreshLod,
    destroy() {
      if (moveEndRemove) {
        moveEndRemove();
        moveEndRemove = null;
      }
      scene.primitives.remove(billboards);
      scene.primitives.remove(stems);
      scene.primitives.remove(labels);
    },
  };
  return layer;
}
