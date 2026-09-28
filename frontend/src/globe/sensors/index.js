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

export function currentSensorLook() { return current; }

export function initSensorLooks(viewer) {
  startTime = performance.now();
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

  let last = performance.now();
  const tick = () => {
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
    rafId = requestAnimationFrame(tick);
  };
  tick();
}

/** Activate a sensor look (key of SENSOR_LOOKS) or null for off. */
export function setSensorLook(key) {
  if (key && !SENSOR_LOOKS[key]) return;
  current = key || null;
  for (const k of Object.keys(stages)) targets[k] = (k === current) ? 1 : 0;
}
