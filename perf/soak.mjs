// Lane I perf harness — (d) 30-minute soak runner (§I.2).
// Boots the merged build, enables a standard layer set, nudges the camera
// every minute, and samples heap / fps / console-error count every 60 s.
// Progress is appended as JSONL so interim numbers exist even mid-run.
// Launch detached:  setsid nohup node perf/soak.mjs >> perf/results/soak.out 2>&1 &
// §I criteria watched: no memory creep, no degradation, no runaway timers;
// background-tab behaviour is a separate manual/prod-profile check.
import { appendFileSync, writeFileSync } from 'node:fs';
import { launchSession, bootAndWait, evalT, dismissFirstRun, diagSnapshot, toggleLayer, sampleFrames, consoleErrors, sleep, resultBase } from './lib/session.mjs';

const DURATION_MIN = Number(process.env.CI_PERF_SOAK_MIN || 30);
const SAMPLE_EVERY_SEC = 60;
const ts = Date.now();
const jsonl = new URL(`./results/soak-${ts}.jsonl`, import.meta.url);
const summaryFile = new URL(`./results/soak-${ts}-summary.json`, import.meta.url);
const emit = (o) => { appendFileSync(jsonl, JSON.stringify(o) + '\n'); console.log(JSON.stringify(o)); };

const STANDARD_SET = ['satellites', 'flights', 'military', 'ais-live-vessels', 'earthquakes', 'weather-radar', 'local-datacenters', 'cctv'];
const { browser, url } = await launchSession({ width: 1440, height: 900 });
const startedAt = Date.now();
const samples = [];
try {
  const boot = await bootAndWait(browser, url);
  await dismissFirstRun(browser);
  for (const id of STANDARD_SET) { await toggleLayer(browser, id, true).catch(() => {}); await sleep(300); }
  emit({ ...resultBase('soak-start'), boot, layers: STANDARD_SET });
  const endAt = startedAt + DURATION_MIN * 60000;
  let i = 0;
  while (Date.now() < endAt) {
    await sleep(SAMPLE_EVERY_SEC * 1000);
    i++;
    // Gentle camera nudge each sample (keeps the render loop honest).
    await evalT(browser, `(() => { const v = window.__godsEyeView && window.__godsEyeView.viewer; if (!v) return false;
      const C = window.Cesium; const h = v.camera.heading + C.Math.toRadians(15);
      v.camera.setView({ destination: v.camera.position, orientation: { heading: h, pitch: v.camera.pitch, roll: 0 } });
      v.scene.requestRender(); return true; })()`).catch(() => {});
    const frames = await sampleFrames(browser, 5);
    const diag = await diagSnapshot(browser);
    const s = { tMin: +((Date.now() - startedAt) / 60000).toFixed(1), heapMB: diag?.heapMB ?? null,
      fps5sAvg: frames.fpsAvg, frameP95Ms: frames.frameP95Ms, consoleErrors: consoleErrors(browser).length };
    samples.push(s);
    emit({ kind: 'soak-sample', ...s });
  }
} finally {
  await browser.close();
}
const heaps = samples.map((s) => s.heapMB).filter((x) => x != null);
const summary = { ...resultBase('soak-summary'), durationMin: DURATION_MIN, samples: samples.length,
  heapFirstMB: heaps[0] ?? null, heapLastMB: heaps[heaps.length - 1] ?? null,
  heapCreepMB: heaps.length > 1 ? +(heaps[heaps.length - 1] - heaps[0]).toFixed(1) : null,
  heapMaxMB: heaps.length ? Math.max(...heaps) : null,
  finalConsoleErrors: samples.length ? samples[samples.length - 1].consoleErrors : null };
writeFileSync(summaryFile, JSON.stringify(summary, null, 1));
emit(summary);
