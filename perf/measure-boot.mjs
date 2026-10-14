// Lane I perf harness — (a) boot latency to loader-clear + first frame.
// Desktop 1440x900 and mobile 390x844. Writes perf/results/boot-<ts>.json.
// §I.2 anchor: GEV published settle ~1.86 s on capable hardware (M5/Chrome).
// [ENV] numbers here are SwiftShader/shared-VM — apparatus + regression use.
import { writeFileSync } from 'node:fs';
import { launchSession, bootAndWait, dismissFirstRun, diagSnapshot, resultBase, ENV_LABEL } from './lib/session.mjs';

const results = { ...resultBase('boot'), gevAnchor: { settleSec: 1.86, hardware: 'M5/Chrome (GEV published)' }, viewports: [] };
for (const vp of [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
]) {
  const { browser, url } = await launchSession(vp);
  try {
    const boot = await bootAndWait(browser, url);
    await dismissFirstRun(browser);
    const diag = await diagSnapshot(browser);
    const entry = { ...vp, ...boot, heapMB: diag?.heapMB ?? null, build: diag?.build ?? null };
    entry.loaderClearSec = boot.loaderClearMs != null ? +(boot.loaderClearMs / 1000).toFixed(2) : null;
    console.log(`[boot ${vp.name}] loader-clear=${entry.loaderClearSec}s first-frame=${boot.firstFrameMs}ms heap=${entry.heapMB?.toFixed(1)}MB`);
    results.viewports.push(entry);
  } finally {
    await browser.close();
  }
}
const file = new URL(`./results/boot-${Date.now()}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(results, null, 1));
console.log(`wrote ${file.pathname}\nENV: ${ENV_LABEL}`);
