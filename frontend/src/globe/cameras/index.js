/* Public cameras — Windy webcam feed via our own backend (Joshua 2026-10-03).
   The backend proxies Windy's API (the key lives server-side, never in the
   browser); player tokens expire ~10 min, so the layer is viewport-driven
   (refetch on camera settle) plus a light 10-min revalidation. Mirrors the
   earthquakes layer pattern: background first load, layer-ready events,
   visibility-aware polling. Default OFF. If the server has no Windy key the
   backend returns 503 cameras_unavailable — treated as terminal: the layer
   flips back off and the panel is told explicitly via
   { layer: 'cameras', failed: true, state: 'no_key' }. */
import * as Cesium from 'cesium';
import { makeBackgroundLoader } from '../layerLoad.js';
import { isHidden, registerPoll } from '../../data/visibility.js';

const API = '/api/cameras';
const LIMIT = 150;
// Tokens expire ~10 min — revalidate the current viewport on this cadence.
const REVALIDATE_MS = 10 * 60 * 1000;
// Debounce camera-settle refetches so a drag doesn't spam the backend.
const MOVE_DEBOUNCE_MS = 800;
// Above this height the whole globe is in view — the bbox would be the
// whole world anyway, so keep the existing markers instead of refetching.
const WHOLE_GLOBE_HEIGHT_M = 18_000_000;

let viewer = null;
let dataSource = null;
let enabled = false;
// Terminal "server has no Windy key" state for this session — drives the
// panel's "no key" count label and keeps later toggle attempts honest.
let noKey = false;
let revalidateTimer = 0;
let moveBound = false;

const firstLoad = makeBackgroundLoader('cameras');

// Hoisted cluster-label constants: clusterEvent fires while the camera
// moves, so nothing here may allocate or parse per call (see markers.js).
const CLUSTER_LABEL_FONT = '600 13px "JetBrains Mono", monospace';
const CLUSTER_LABEL_FILL = Cesium.Color.fromCssColorString('#EDF7FE');
const CLUSTER_LABEL_OUTLINE = Cesium.Color.fromCssColorString('#050B16');
const CLUSTER_LABEL_OFFSET = new Cesium.Cartesian2(0, 1);

// Cyan/teal camera dot with a subtle ring — visually distinct from quake
// orbs. Cached as a singleton: every camera shares one sprite.
let spriteCache = null;
function camSprite() {
  if (spriteCache) return spriteCache;
  const S = 30;
  const cx = S / 2;
  const r = 7;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  // Dot: bright core -> cyan -> deeper teal edge.
  let grad = g.createRadialGradient(cx, cx, 0, cx, cx, r);
  grad.addColorStop(0, '#a5f3fc');
  grad.addColorStop(0.55, '#22d3ee');
  grad.addColorStop(1, '#0e7490');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cx, r, 0, Math.PI * 2);
  g.fill();
  // Subtle ring around the dot.
  g.strokeStyle = 'rgba(34, 211, 238, 0.55)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cx, r + 4, 0, Math.PI * 2);
  g.stroke();
  spriteCache = { image: c, px: S };
  return spriteCache;
}

// Cluster badge disc — the count is drawn by the cluster label itself.
let clusterSpriteCache = null;
function camClusterSprite() {
  if (clusterSpriteCache) return clusterSpriteCache;
  const S = 44;
  const cx = S / 2;
  const r = 17;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(8, 25, 35, 0.92)';
  g.beginPath();
  g.arc(cx, cx, r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#22d3ee';
  g.lineWidth = 2.5;
  g.beginPath();
  g.arc(cx, cx, r - 1.5, 0, Math.PI * 2);
  g.stroke();
  clusterSpriteCache = { image: c, px: S };
  return clusterSpriteCache;
}

function applyClusterStyling(ds) {
  ds.clustering.enabled = true;
  ds.clustering.pixelRange = 48;
  ds.clustering.minimumClusterSize = 4;
  ds.clustering.clusterEvent.addEventListener((clustered, cluster) => {
    const memberIds = [];
    for (const e of clustered) {
      if (e.id) memberIds.push(e.id);
    }
    cluster.billboard.show = true;
    // Cesium leaves cluster billboard.id unset — tag it ourselves so
    // scene.pick can identify cluster hits (mirrors markers.js).
    cluster.billboard.id = { __clusterIds: memberIds };
    cluster.billboard.image = camClusterSprite().image;
    cluster.billboard.width = 44;
    cluster.billboard.height = 44;
    cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
    cluster.label.show = true;
    cluster.label.text = String(clustered.length);
    cluster.label.font = CLUSTER_LABEL_FONT;
    cluster.label.fillColor = CLUSTER_LABEL_FILL;
    cluster.label.style = Cesium.LabelStyle.FILL_AND_OUTLINE;
    cluster.label.outlineColor = CLUSTER_LABEL_OUTLINE;
    cluster.label.outlineWidth = 3;
    cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
    cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
    cluster.label.pixelOffset = CLUSTER_LABEL_OFFSET;
  });
}

/** [minLon, minLat, maxLon, maxLat] in degrees for the current camera view.
    Guards computeViewRectangle()'s null return and whole-globe views —
    both collapse to the world bbox. */
function currentBbox() {
  try {
    const rect = viewer.camera.computeViewRectangle();
    if (rect) {
      const west = Cesium.Math.toDegrees(rect.west);
      const east = Cesium.Math.toDegrees(rect.east);
      if (east - west < 350) {
        const south = Cesium.Math.toDegrees(rect.south);
        const north = Cesium.Math.toDegrees(rect.north);
        return [west, south, east, north].map((v) => Number(v.toFixed(4)));
      }
    }
  } catch { /* camera not ready — fall through to the world bbox */ }
  return [-180, -90, 180, 90];
}

async function load() {
  const [minLon, minLat, maxLon, maxLat] = currentBbox();
  const res = await fetch(
    `${API}?bbox=${minLon},${minLat},${maxLon},${maxLat}&limit=${LIMIT}`
  );
  if (res.status === 503) {
    // Only the cameras_unavailable shape is terminal-no-key; a bare 503 is
    // just an outage and should retry later like any other failure.
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON 503 */ }
    if (body && body.error === 'cameras_unavailable') {
      const err = new Error(body.message || 'public cameras unavailable');
      err.code = 'cameras_unavailable';
      throw err;
    }
    throw new Error('HTTP 503');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const fresh = new Cesium.CustomDataSource('cameras');
  applyClusterStyling(fresh);
  const sprite = camSprite();
  for (const cam of data.cameras || []) {
    if (!Number.isFinite(cam.lat) || !Number.isFinite(cam.lon)) continue;
    fresh.entities.add({
      id: `cam-${cam.id}`,
      position: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, 0),
      billboard: {
        image: sprite.image,
        width: sprite.px,
        height: sprite.px,
        disableDepthTestDistance: 0,
        scaleByDistance: new Cesium.NearFarScalar(2e5, 1.0, 3e7, 0.45),
      },
      properties: {
        kind: 'cam',
        camId: cam.id,
        title: cam.title,
        city: cam.city,
        country: cam.country,
        status: cam.status,
        thumbnailUrl: cam.thumbnailUrl,
        playerEmbedUrl: cam.playerEmbedUrl,
        windyUrl: cam.windyUrl,
      },
    });
  }

  if (dataSource) viewer.dataSources.remove(dataSource, true);
  dataSource = fresh;
  dataSource.show = enabled;
  await viewer.dataSources.add(dataSource);
}

export function camerasEnabled() {
  return enabled;
}

/** Terminal "server has no Windy key" state — the panel reads this for the
    'no key' count label. Cleared by any later successful load. */
export function camerasNoKey() {
  return noKey;
}

/** Get camera data by ID (for tap-to-info). */
export function getCamera(camId) {
  if (!dataSource) return null;
  const entity = dataSource.entities.getById(`cam-${camId}`);
  if (!entity) return null;
  const props = entity.properties;
  const getVal = (name) => {
    const v = props && props[name];
    return v && typeof v.getValue === 'function' ? v.getValue() : v;
  };
  const carto = Cesium.Cartographic.fromCartesian(entity.position.getValue());
  return {
    id: camId,
    title: getVal('title'),
    city: getVal('city'),
    country: getVal('country'),
    status: getVal('status'),
    thumbnailUrl: getVal('thumbnailUrl'),
    playerEmbedUrl: getVal('playerEmbedUrl'),
    windyUrl: getVal('windyUrl'),
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

export function cameraCount() {
  return dataSource ? dataSource.entities.values.length : 0;
}

// Source heartbeat for the dock.
const srcStatus = { lastOk: 0, lastErr: '' };
/** Heartbeat for the Live Source Dock: { lastOk, lastErr }. */
export function cameraStatus() { return srcStatus; }

/** load() with heartbeat tracking; rethrows so callers keep their handling.
    A 503 cameras_unavailable is terminal: flip the layer off and dispatch
    the detailed layer-ready event ourselves, since the background loader's
    generic failed event can't carry the state. */
async function refresh() {
  try {
    await load();
    srcStatus.lastOk = Date.now();
    srcStatus.lastErr = '';
    noKey = false;
  } catch (err) {
    if (err && err.code === 'cameras_unavailable') {
      noKey = true;
      enabled = false;
      srcStatus.lastErr = String(err.message || 'no key');
      window.dispatchEvent(
        new CustomEvent('layer-ready', {
          detail: { layer: 'cameras', failed: true, state: 'no_key' },
        })
      );
    } else {
      srcStatus.lastErr = String((err && err.message) || err || 'fetch failed');
    }
    throw err;
  }
}

export async function setCameras(on) {
  enabled = on;
  if (!viewer) return enabled;
  if (on) {
    if (!dataSource) {
      // First load runs in the background (mirrors earthquakes): the toggle
      // resolves instantly and the layer populates when the fetch lands.
      // A failed load flips the layer back off and notifies the panel.
      firstLoad.ensure(async () => {
        try {
          await refresh();
        } catch (err) {
          enabled = false;
          throw err;
        }
      });
    } else {
      dataSource.show = true;
    }
    if (!revalidateTimer) {
      // Light revalidation: tokens expire ~10 min, so re-pull the current
      // viewport while the layer is on and the tab is visible.
      revalidateTimer = setInterval(() => {
        if (isHidden() || !enabled) return;
        refresh().catch((err) => console.warn('[cameras] revalidate failed:', err));
      }, REVALIDATE_MS);
      // On return from a hidden tab, refresh once — but only while on; a
      // viewport-driven layer has no reason to fetch while off.
      registerPoll('cameras', () => {
        if (!enabled) return Promise.resolve();
        return refresh();
      });
    }
  } else if (dataSource) {
    dataSource.show = false;
  }
  return enabled;
}

export function initCameras(v) {
  viewer = v;
  if (!viewer || moveBound) return;
  moveBound = true;
  // Viewport-driven refetch: when the camera settles (debounced), re-pull
  // for the new bbox — only while the layer is on. Whole-globe views keep
  // the existing markers (the world bbox wouldn't change them).
  let debounce = 0;
  viewer.camera.moveEnd.addEventListener(() => {
    if (!enabled) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        const h = viewer.camera.positionCartographic.height;
        if (!Number.isFinite(h) || h > WHOLE_GLOBE_HEIGHT_M) return;
      } catch { return; }
      refresh().catch((err) => console.warn('[cameras] viewport refetch failed:', err));
    }, MOVE_DEBOUNCE_MS);
  });
}
