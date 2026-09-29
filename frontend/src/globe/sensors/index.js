/* Sensor looks — post-processing styles for the globe.
   Shader sources adapted from bilawalsidhu/gods-eye-view (MIT, © 2026 Bilawal
   Sidhu — see THIRD-PARTY-NOTICES.md): src/styles/{thermal,surveillance,retro,
   noir}.js, used verbatim. This manager is ours: it builds one
   Cesium.PostProcessStage per style, crossfades via the `intensity` uniform,
   and ticks the `time` uniform for animated effects (scanlines, grain, bloom).
*/
import * as Cesium from 'cesium';
import { thermalShader } from './thermal.js';
import { nightVisionShader } from './surveillance.js';
import { retroShader } from './retro.js';
import { noirShader } from './noir.js';
import { initScopeMask, setScopeMaskEnabled } from './scopeMask.js';

export const SENSOR_LOOKS = {
  flir: { label: 'FLIR', shader: thermalShader },
  nvg: { label: 'NVG', shader: nightVisionShader },
  crt: { label: 'CRT', shader: retroShader },
  noir: { label: 'NOIR', shader: noirShader },
};

const FADE_MS = 500;

let stages = {};
let targets = {};   // key -> 0..1 target intensity
let current = null; // active look key, or null
let rafId = 0;
let startTime = 0;
let scheduleSensorTick = () => {};

export function currentSensorLook() { return current; }

export function initSensorLooks(viewer) {
  startTime = performance.now();
  // Scope mask viewport for NVG/FLIR (audit 1.15) — zero rAF, repaints only on demand.
  initScopeMask({
    container: viewer.container,
    getCameraHeight: () => viewer.camera.positionCartographic.height,
  });
  for (const [key, { shader }] of Object.entries(SENSOR_LOOKS)) {
    const uniforms = { intensity: 0 };
    if (shader.fragmentShader.includes('uniform float time')) uniforms.time = 0;
    for (const [uname, udef] of Object.entries(shader.uniforms || {})) {
      if (!(uname in uniforms) && udef && typeof udef.default === 'number') {
        uniforms[uname] = udef.default;
      }
    }
    const stage = new Cesium.PostProcessStage({
      name: 'sensor-' + key,
      fragmentShader: shader.fragmentShader,
      uniforms,
    });
    stage.enabled = false; // stays off until its intensity fades above zero
    viewer.scene.postProcessStages.add(stage);
    stages[key] = stage;
    targets[key] = 0;
  }

  // Gated tick: the rAF loop exists only while a transition is in flight
  // or an animated stage is visible (audit 2.13). At rest (all targets 0,
  // all intensities settled at 0) there is zero background cost.
  const needsTick = () => {
    for (const [key, stage] of Object.entries(stages)) {
      if (targets[key] > 0) return true;                       // fading in / on
      if (stage.uniforms.intensity > 0.001) return true;        // fading out
      if (stage.enabled && 'time' in stage.uniforms) return true; // animated + visible
    }
    return false;
  };
  let last = performance.now();
  const tick = () => {
    rafId = 0;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = (now - startTime) / 1000;
    const step = dt / (FADE_MS / 1000);
    for (const [key, stage] of Object.entries(stages)) {
      const target = targets[key];
      const u = stage.uniforms;
      if (u.intensity !== target) {
        const next = u.intensity + Math.sign(target - u.intensity) * step;
        u.intensity = target === 1 ? Math.min(1, next) : Math.max(0, next);
        stage.enabled = u.intensity > 0.001;
      }
      if (stage.enabled && 'time' in u) u.time = t;
    }
    if (needsTick()) rafId = requestAnimationFrame(tick);
  };
  const kickTick = () => {
    if (!rafId) {
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  };
  scheduleSensorTick = kickTick;
}

/** Activate a sensor look (key of SENSOR_LOOKS) or null for off. */
export function setSensorLook(key) {
  if (key && !SENSOR_LOOKS[key]) return;
  current = key || null;
  for (const k of Object.keys(stages)) targets[k] = (k === current) ? 1 : 0;
  scheduleSensorTick(); // re-arm the gated loop for the fade transition
  // Scope mask: circular tube viewport for NVG/FLIR looks (audit 1.15).
  setScopeMaskEnabled(key === 'nvg' || key === 'flir');
}
