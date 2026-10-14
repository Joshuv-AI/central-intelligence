/* Lane G — intel surfaces entry (B1→B10 wiring).
   Called once from constructCatalog (registry seam): starts the data
   client + DOM surfaces immediately (feed visible on fresh load) and
   returns the Cesium layer for the catalog. */
import { IntelClient } from './client.js';
import { createIntelLayer } from './layer.js';
import { store, runtime } from './store.js';
import { initIntelUi, handlePick, openEventCard, openConnectionCard } from './ui.js';
import { createPerfSentinel, sentinelLabel } from '../ui/perfSentinel.js';

let started = false;

/* J4-29: the sentinel's apply ladder. The decision machinery (measure →
   breach → step with hysteresis) lives in ui/perfSentinel.js; these are the
   quality knobs, ordered cheapest-truthful-first. Quality scales, function
   never changes: no data layer is ever thinned, no feature disabled.
   Deeper rungs (particle counts, post-FX, label budgets) hang off this same
   seam in a later wave — the seam is the contract. */
const SENTINEL_DPR = { L0: 1, L1: 0.85, L2: 0.7, L3: 0.6 };
function applySentinelLevel(level) {
  const viewer = runtime.viewer;
  if (!viewer) return;
  const scale = SENTINEL_DPR[level] ?? 1;
  try {
    if (typeof viewer.resolutionScale === 'number') viewer.resolutionScale = scale;
  } catch { /* viewer not ready — next level change retries */ }
  try {
    // L3 only: ask for coarser terrain/imagery tiles too (fewer tiles in
    // flight). Reverted on step-up by re-applying L0..L2 (no SSE change).
    if (viewer.scene?.globe && level === 'L3') viewer.scene.globe.maximumScreenSpaceError = 4;
    else if (viewer.scene?.globe) viewer.scene.globe.maximumScreenSpaceError = 2;
  } catch { /* best-effort */ }
  try {
    window.__ciDiagnostics?.publishSentinel?.(sentinelLabel(level));
  } catch { /* diagnostics may not be installed */ }
}

export function createApplicationIntel() {
  const layer = createIntelLayer({ onPick: handlePick });
  if (!started) {
    started = true;
    const client = new IntelClient({
      onSnapshot: (snap, info) => store.setSnapshot(snap, info),
      onStatus: (diag) => store.setClientDiag(diag),
    });
    // Phase 4 pre-cutover fix: catalog construction must be DOM-free (node
    // composition tests build the catalog without a browser). Everything
    // below touches document/window/EventSource; it runs only when a DOM
    // exists — which is always true in the shipped app, so behavior there
    // is unchanged.
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      initIntelUi(client);
      client.start();
      // J4-29: frame/heap watchdog. Disabled for test via ?nosentinel=1 or
      // window.__ciDisablePerfSentinel=true (documented disable-for-test
      // switch — the §I protocol names it so §I measures the real system).
      const sentinel = createPerfSentinel({
        apply: applySentinelLevel,
        onLevel: (level) => {
          try { window.__ciDiagnostics?.publishSentinel?.(sentinelLabel(level)); } catch { /* see above */ }
        },
        getHeapRatio: () => {
          const mem = performance?.memory;
          if (!mem || !mem.jsHeapSizeLimit) return null;
          return mem.usedJSHeapSize / mem.jsHeapSizeLimit;
        },
      });
      window.__ciPerfSentinel = sentinel;
      // Gate/testing handle: the merged build's intel state, inspectable.
      window.__ciIntel = { store, client, layer, runtime, ui: { handlePick, openEventCard, openConnectionCard }, version: 1 };
    }
  }
  return layer;
}

export { IntelClient } from './client.js';
export { createIntelLayer } from './layer.js';
