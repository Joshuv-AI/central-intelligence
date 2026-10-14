// Lane I perf harness — (b) JS heap idle + per-layer-on.
// Heap comes from the app's diagnostics overlay (performance.memory via
// window.__ciDiagnostics.snapshot()). Method: boot idle -> measure; then for
// each catalog layer: ON -> settle -> measure -> OFF -> settle. This
// attributes a marginal heap delta per layer; layers gated at globe zoom
// (e.g. civil flights, ARCH §7) will show ~0 marginal heap at the opening
// globe framing — that is the gate working, and is recorded as-is.
// GEV anchors (M5/Chrome): idle ~105 MB, cables ~412 MB, stress ~872 MB.
import { writeFileSync } from 'node:fs';
import { launchSession, bootAndWait, dismissFirstRun, diagSnapshot, listLayers, toggleLayer, sleep, resultBase, ENV_LABEL } from './lib/session.mjs';

const SETTLE_MS = Number(process.env.CI_PERF_LAYER_SETTLE_MS || 5000);
const { browser, url } = await launchSession({ width: 1440, height: 900 });
const out = { ...resultBase('heap-layers'), gevAnchorsMB: { idle: 105, cables: 412, stressCombined: 872 }, layers: [] };
try {
  const boot = await bootAndWait(browser, url);
  out.boot = boot;
  await dismissFirstRun(browser);
  await sleep(5000);
  const idle = await diagSnapshot(browser);
  out.idleHeapMB = idle?.heapMB ?? null;
  console.log(`idle heap = ${out.idleHeapMB?.toFixed(1)} MB`);
  const layers = await listLayers(browser);
  out.catalogCount = layers.length;
  console.log(`catalog rows: ${layers.length}`);
  for (const layer of layers) {
    const rec = { id: layer.id, label: layer.label };
    if (!layer.btn) { rec.skipped = 'no-toggle-btn'; out.layers.push(rec); continue; }
    const on = await toggleLayer(browser, layer.id, true);
    rec.toggle = on;
    if (!on?.ok) { rec.skipped = on ? 'toggle-failed' : 'toggle-eval-timeout [ENV load]'; out.layers.push(rec); continue; } // REHEARSAL SWEEP fix 2026-10-13: eval timeouts under load return null — record, don't crash the run
    await sleep(SETTLE_MS);
    const snap = await diagSnapshot(browser);
    rec.heapMB = snap?.heapMB ?? null;
    rec.marginalMB = rec.heapMB != null && out.idleHeapMB != null ? +(rec.heapMB - out.idleHeapMB).toFixed(1) : null;
    rec.fps = snap?.fps ?? null;
    const rowAfter = ((await listLayers(browser)) || []).find((r) => r.id === layer.id); // REHEARSAL SWEEP fix 2026-10-13: null-guard (was the crash: listLayers eval timed out under load after local-datacenters)
    rec.rowTextAfter = rowAfter?.rowText ?? null;
    console.log(`${layer.id}: heap=${rec.heapMB?.toFixed(1)}MB marginal=${rec.marginalMB}MB`);
    await toggleLayer(browser, layer.id, false);
    await sleep(1500);
    out.layers.push(rec);
  }
  await sleep(3000);
  const back = await diagSnapshot(browser);
  out.heapAfterAllOffMB = back?.heapMB ?? null;
} finally {
  await browser.close();
}
const file = new URL(`./results/heap-layers-${Date.now()}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`wrote ${file.pathname}\nENV: ${ENV_LABEL}`);
