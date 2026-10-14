// Lane I perf harness — (c) stress scene frame rate vs the §I FAIL line.
// Max practical layers ON, camera flown to a metro framing (Orlando,
// ~120 km — inside the civil-flights 650 km gate, ARCH §7 B3), then the
// camera keeps moving (heading rotation + height oscillation) for the
// sample window while rAF cadence is recorded per second.
// §I.2: "any drop below 30 fps sustained = FAIL". Harness definition of
// sustained: >=5 consecutive 1 s buckets under 30 fps (see README — the
// independent binding tester ratifies/replaces this definition).
// NOTE: under SwiftShader the renderer is CPU-bound; [ENV] fps here is a
// floor/apparatus check, not the production-profile §I measurement.
import { writeFileSync } from 'node:fs';
import { launchSession, bootAndWait, evalT, dismissFirstRun, diagSnapshot, listLayers, toggleLayer, sampleFrames, longestBelow, consoleErrors, sleep, resultBase, ENV_LABEL } from './lib/session.mjs';

const SAMPLE_SEC = Number(process.env.CI_PERF_STRESS_SEC || 60);
const viewport = process.env.CI_PERF_MOBILE === '1'
  ? { name: 'mobile', width: 390, height: 844, mobile: true }
  : { name: 'desktop', width: 1440, height: 900, mobile: false };
const { browser, url } = await launchSession(viewport);
const out = { ...resultBase('stress'), viewport, sampleSec: SAMPLE_SEC, failLine: { fps: 30, sustainedSec: 5 } };
try {
  out.boot = await bootAndWait(browser, url);
  await dismissFirstRun(browser);
  const layers = await listLayers(browser);
  out.enabled = [];
  out.enableFailed = [];
  for (const layer of layers) {
    if (!layer.btn) continue;
    const r = await toggleLayer(browser, layer.id, true);
    (r.ok ? out.enabled : out.enableFailed).push(layer.id);
    await sleep(300);
  }
  await sleep(8000); // let enables settle / fetches fire
  // Fly to metro framing and start continuous camera motion in-page.
  out.camera = await evalT(browser, `(() => { const v = window.__godsEyeView && window.__godsEyeView.viewer;
    if (!v) return { ok: false, reason: 'no-viewer-handle' };
    const C = window.Cesium;
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(-81.38, 28.54, 120000),
      orientation: { heading: 0, pitch: C.Math.toRadians(-55), roll: 0 } });
    let t = 0;
    window.__perfSpin = setInterval(() => { t += 1;
      const h = (t * 2.2) % 360; const alt = 120000 + Math.sin(t / 6) * 45000;
      v.camera.setView({ destination: C.Cartesian3.fromDegrees(-81.38, 28.54, alt),
        orientation: { heading: C.Math.toRadians(h), pitch: C.Math.toRadians(-55), roll: 0 } });
      v.scene.requestRender();
    }, 100);
    return { ok: true }; })()`);
  const heapBefore = await diagSnapshot(browser);
  const frames = await sampleFrames(browser, SAMPLE_SEC);
  const heapAfter = await diagSnapshot(browser);
  await evalT(browser, `clearInterval(window.__perfSpin); true`, 10000);
  out.frames = frames;
  out.heapBeforeMB = heapBefore?.heapMB ?? null;
  out.heapAfterMB = heapAfter?.heapMB ?? null;
  out.longestBelow30Sec = longestBelow(frames.fpsBuckets, 30);
  out.verdict = out.longestBelow30Sec >= out.failLine.sustainedSec
    ? 'REHEARSAL-FAIL (sustained <30 fps in this ENV)'
    : 'REHEARSAL-PASS (no sustained <30 fps in this ENV)';
  out.consoleErrorCount = consoleErrors(browser).length;
  out.consoleErrors = consoleErrors(browser).slice(0, 10);
  console.log(`[stress ${viewport.name}] avg=${frames.fpsAvg} fps min-bucket=${frames.fpsMin} longest<30=${out.longestBelow30Sec}s heap ${out.heapBeforeMB?.toFixed(1)}->${out.heapAfterMB?.toFixed(1)}MB :: ${out.verdict}`);
} finally {
  await browser.close();
}
const file = new URL(`./results/stress-${viewport.name}-${Date.now()}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`wrote ${file.pathname}\nENV: ${ENV_LABEL}`);
