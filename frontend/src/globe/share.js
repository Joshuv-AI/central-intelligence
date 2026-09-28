/* Shareable scene URLs — the camera position, orientation, and sensor look are
   encoded in location.hash (plain URLSearchParams), so any view can be copied
   and reopened exactly. Adapted pattern from bilawalsidhu/gods-eye-view. */
import * as Cesium from 'cesium';
import { getViewer } from './viewer.js';
import { setSensorLook, currentSensorLook, SENSOR_LOOKS } from './sensors/index.js';

let writeTimer = 0;

function sceneParams() {
  const viewer = getViewer();
  if (!viewer) return null;
  const cam = viewer.camera;
  const target = cam.positionCartographic;
  const lon = Cesium.Math.toDegrees(target.longitude);
  const lat = Cesium.Math.toDegrees(target.latitude);
  return {
    lat: +lat.toFixed(4),
    lon: +lon.toFixed(4),
    h: Math.round(target.height),
    hd: +Cesium.Math.toDegrees(cam.heading).toFixed(1),
    p: +Cesium.Math.toDegrees(cam.pitch).toFixed(1),
    sensor: currentSensorLook() || '',
  };
}

/** Parse #lat=..&lon=..&h=..&hd=..&p=..&sensor=.. — null when absent/invalid. */
export function readSceneFromHash() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const q = new URLSearchParams(hash);
  const lat = parseFloat(q.get('lat'));
  const lon = parseFloat(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const h = parseFloat(q.get('h'));
  const hd = parseFloat(q.get('hd'));
  const p = parseFloat(q.get('p'));
  const sensor = q.get('sensor');
  return {
    lat, lon,
    height: Number.isFinite(h) ? h : 26_000_000,
    heading: Number.isFinite(hd) ? hd : 0,
    pitch: Number.isFinite(p) ? p : -90,
    sensor: sensor && SENSOR_LOOKS[sensor] ? sensor : null,
  };
}

/** Apply a parsed scene to the camera (used at boot). */
export function applyScene(scene) {
  const viewer = getViewer();
  if (!viewer || !scene) return;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(scene.lon, scene.lat, scene.height),
    orientation: {
      heading: Cesium.Math.toRadians(scene.heading),
      pitch: Cesium.Math.toRadians(scene.pitch),
      roll: 0,
    },
  });
  if (scene.sensor) setSensorLook(scene.sensor);
}

/** Write the current scene into location.hash immediately. */
export function writeHashNow() {
  const s = sceneParams();
  if (!s) return;
  const q = new URLSearchParams();
  q.set('lat', s.lat); q.set('lon', s.lon); q.set('h', s.h);
  q.set('hd', s.hd); q.set('p', s.p);
  if (s.sensor) q.set('sensor', s.sensor);
  history.replaceState(null, '', '#' + q.toString());
}

/** Write the current scene into location.hash (debounced). */
export function scheduleHashWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeHashNow, 800);
}

/** Copy the current view's share link. Returns true on success. */
export async function copySceneLink() {
  writeHashNow();
  const url = window.location.href;
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // Fallback for non-secure contexts (http://): select-and-copy via textarea.
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* noop */ }
    ta.remove();
    return ok;
  }
}

/** Start tracking camera moves so the hash always reflects the live view. */
export function initShareTracking() {
  const viewer = getViewer();
  if (!viewer) return;
  viewer.camera.moveEnd.addEventListener(scheduleHashWrite);
}
