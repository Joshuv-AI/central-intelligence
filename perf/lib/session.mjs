// Lane I perf harness — shared session helpers.
// Built on the Stage-1 CDP driver patterns (ux/scripts/driver.mjs): headless
// Chromium, --no-proxy-server REQUIRED, SwiftShader GL flags, fresh profile
// per run. No production code is touched; everything is measured through the
// app's own diagnostics overlay (window.__ciDiagnostics) + rAF instrumentation.
import { Browser, sleep } from '../../../gev-rebuild/ux/scripts/driver-d.mjs'; // REHEARSAL SWEEP fix 2026-10-13: driver.mjs hardcodes CDP 9333 (occupied by another lane); driver-d.mjs honours CDP_PORT env for a unique port per run

export { sleep };
export const BASE_URL = process.env.CI_PERF_BASE_URL || 'http://127.0.0.1:3116';
export const ENV_LABEL =
  process.env.CI_PERF_ENV_LABEL ||
  '[ENV] headless Chromium 1243 + SwiftShader (software GL), shared VM, egress-proxy network (external tile/data hosts largely unreachable)';

// The Stage-1 driver's send() has no timeout: a starved/crashed renderer
// leaves promises pending forever (observed under load avg >20: Node exits
// rc=13 "unsettled top-level await"). Every harness call is raced against a
// timeout and treated as a missing sample on expiry — apparatus hardening,
// measurements never fake a value to fill a gap.
export function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise((res) => setTimeout(() => res(fallback), ms)),
  ]);
}
export function evalT(browser, expr, ms = 15000) {
  return withTimeout(browser.eval(expr).catch(() => null), ms, null);
}

let runSeq = 0;

export async function launchSession({ width = 1440, height = 900, mobile = false, diag = true } = {}) {
  const tag = `${mobile ? 'm' : 'd'}-${width}x${height}-${Date.now()}-${++runSeq}`;
  // The shared VM can take >20 s to bring Chromium's debug port up under
  // load (the driver's fixed poll window then throws). Retry the launch —
  // apparatus robustness, not a product measurement.
  let browser = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4 && !browser; attempt++) {
    const candidate = new Browser();
    try {
      await withTimeout(candidate.launch(`/tmp/ci-perf-profile-${tag}-a${attempt}`), 120000, null);
      if (!candidate.ws) throw new Error('launch timed out');
      browser = candidate;
    } catch (e) {
      lastErr = e;
      try { candidate.proc?.kill('SIGKILL'); } catch {}
      await sleep(3000);
    }
  }
  if (!browser) throw lastErr || new Error('chromium launch failed');
  await withTimeout(browser.setViewport(width, height, mobile), 30000, null);
  // rAF frame counter installed before any navigation: first-frame proof.
  await browser.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `window.__perf = { frames: 0, times: [] };
        (function tick(t){ window.__perf.frames++; window.__perf.times.push(t); requestAnimationFrame(tick); })(performance.now());`,
    },
    browser.session,
  );
  return { browser, url: `${BASE_URL}/?diag=${diag ? '1' : '0'}` };
}

// Navigate and wait for the boot ritual to clear. Loader-clear = the
// #loading-screen element carries .hidden / is display:none / removed.
// Returns wall-clock timings from navigation start. Partial timings are
// returned on timeout (never an indefinite hang): in this VM, init can be
// starved for many minutes by external-host waits + shared load, and the
// honest rehearsal datum is WHICH milestones were reached and when.
// Milestones: firstFrame (rAF ticked), diagReady (diagnostics snapshot
// live), shellReady (diag + Cesium canvas), catalogReady (layer rows in
// DOM), loaderClear (boot ritual done; firstFrame NOT required for it —
// under demand-driven rendering + headless compositing, rAF can sit idle
// while the app is in fact up; Lane B's gate used the same DOM evidence).
export async function bootAndWait(browser, url, { timeoutMs = Number(process.env.CI_PERF_BOOT_TIMEOUT_MS || 600000) } = {}) {
  const t0 = Date.now();
  await withTimeout(browser.send('Page.navigate', { url }, browser.session), 30000, null);
  const marks = { firstFrameMs: null, diagReadyMs: null, shellReadyMs: null, catalogReadyMs: null, loaderClearMs: null };
  let loaderStatus = null;
  let sawLoader = false; // an absent element only means "cleared" after it was seen present
  while (Date.now() - t0 < timeoutMs) {
    const s = await evalT(browser, `(() => { const el = document.getElementById('loading-screen');
        const hidden = !!el && (el.classList.contains('hidden') || getComputedStyle(el).display === 'none');
        return { hidden, loaderPresent: !!el, frames: window.__perf ? window.__perf.frames : 0,
                 diag: !!(window.__ciDiagnostics && window.__ciDiagnostics.snapshot),
                 canvas: !!document.querySelector('canvas'),
                 layers: document.querySelectorAll('[data-layer-id]').length,
                 status: document.querySelector('#loading-screen .loader-status')?.textContent?.trim() || null,
                 gev: !!window.__godsEyeView }; })()`, 15000);
    if (s) {
      loaderStatus = s.status;
      if (s.loaderPresent) sawLoader = true;
      if (marks.firstFrameMs === null && s.frames > 1) marks.firstFrameMs = Date.now() - t0;
      if (marks.diagReadyMs === null && s.diag) marks.diagReadyMs = Date.now() - t0;
      if (marks.shellReadyMs === null && s.diag && s.canvas) marks.shellReadyMs = Date.now() - t0;
      if (marks.catalogReadyMs === null && s.layers > 0) marks.catalogReadyMs = Date.now() - t0;
      if (marks.loaderClearMs === null && (s.hidden || (sawLoader && !s.loaderPresent))) marks.loaderClearMs = Date.now() - t0;
      if (marks.loaderClearMs !== null && marks.catalogReadyMs !== null) break;
    }
    await sleep(500);
  }
  return { ...marks, loaderStatusAtEnd: loaderStatus, timedOut: marks.loaderClearMs === null, waitedMs: Date.now() - t0 };
}

// Wait until the layer catalog rows exist (returns the wait in ms or null).
export async function waitForCatalog(browser, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = (await evalT(browser, `document.querySelectorAll('[data-layer-id]').length`, 10000)) ?? 0;
    if (n > 0) return Date.now() - t0;
    await sleep(1000);
  }
  return null;
}

// Dismiss the first-run missions modal the way a newcomer can: ESC, or the
// EXPLORE MANUALLY choice. Returns what it did (null if no modal was up).
export async function dismissFirstRun(browser) {
  // REHEARSAL SWEEP fix 2026-10-13: every call timeout-wrapped — the raw
  // driver send() has no timeout and a starved renderer hung the console
  // sweep here indefinitely (Node exited on an unsettled top-level await).
  const present = await withTimeout(
    browser.eval(`(() => { const t = document.body.innerText || ''; return t.includes('MISSION CONTROL') || t.includes('Choose your first view'); })()`).catch(() => false),
    15000, false);
  if (!present) return null;
  const clicked = await withTimeout(browser.clickText('EXPLORE MANUALLY').catch(() => null), 15000, null);
  if (clicked) { await sleep(800); return 'explore-manually'; }
  await withTimeout(browser.key('Escape', 'Escape').catch(() => null), 10000, null);
  await sleep(800);
  return 'escape';
}

export async function diagSnapshot(browser) {
  return evalT(browser, `(() => { try { return window.__ciDiagnostics.snapshot(); } catch { return null; } })()`, 10000);
}

// Sample rAF cadence for `seconds`: per-second fps buckets + frame-time stats.
export async function sampleFrames(browser, seconds = 30) {
  await evalT(browser, `window.__perf.times = []; window.__perf.frames = 0; true`, 10000);
  await sleep(seconds * 1000);
  const times = await evalT(browser, `window.__perf.times`, 15000);
  const buckets = [];
  if (Array.isArray(times) && times.length > 1) {
    const start = times[0];
    const n = Math.ceil((times[times.length - 1] - start) / 1000);
    for (let i = 0; i < n; i++) buckets.push(0);
    for (const t of times) buckets[Math.min(n - 1, Math.floor((t - start) / 1000))]++;
    buckets.pop(); // last bucket is partial
  }
  const deltas = [];
  if (Array.isArray(times)) for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
  deltas.sort((a, b) => a - b);
  const p = (q) => (deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))] : null);
  return {
    seconds: buckets.length,
    fpsBuckets: buckets,
    fpsAvg: buckets.length ? +(buckets.reduce((a, b) => a + b, 0) / buckets.length).toFixed(2) : null,
    fpsMin: buckets.length ? Math.min(...buckets) : null,
    frameP50Ms: p(0.5) ? +p(0.5).toFixed(2) : null,
    frameP95Ms: p(0.95) ? +p(0.95).toFixed(2) : null,
    frameP99Ms: p(0.99) ? +p(0.99).toFixed(2) : null,
    totalFrames: Array.isArray(times) ? times.length : 0,
  };
}

// Longest run of consecutive 1 s buckets below `fps` (the harness's working
// definition of "sustained" for the §I <30 fps FAIL line — the independent
// binding tester ratifies or replaces this definition; see perf/README.md).
export function longestBelow(buckets, fps = 30) {
  let best = 0, cur = 0;
  for (const b of buckets) { cur = b < fps ? cur + 1 : 0; best = Math.max(best, cur); }
  return best;
}

export async function listLayers(browser) {
  return evalT(browser, `(() => [...document.querySelectorAll('[data-layer-id]')].map(r => ({
    id: r.getAttribute('data-layer-id'),
    label: (r.querySelector('.data-layer-name, .layer-name, span')?.textContent || '').trim().slice(0, 40),
    btn: !!r.querySelector('.data-toggle-btn'),
    active: r.querySelector('.data-toggle-btn')?.classList.contains('active') || false,
    rowText: (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
  })))()`, 15000);
}

// Toggle a layer by clicking its catalog toggle button in-page (the same
// button a user clicks). Returns the row's post-click state.
export async function toggleLayer(browser, id, wantOn) {
  return evalT(browser, `(() => { const r = document.querySelector('[data-layer-id="${id}"]');
    if (!r) return { ok: false, reason: 'row-not-found' };
    const b = r.querySelector('.data-toggle-btn');
    if (!b) return { ok: false, reason: 'no-toggle-btn' };
    const on = b.classList.contains('active');
    if (on !== ${wantOn ? 'true' : 'false'}) b.click();
    return { ok: true, wasOn: on, nowOn: b.classList.contains('active'),
             aria: b.getAttribute('aria-label'), rowText: (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 140) }; })()`, 15000);
}

export function consoleErrors(browser) {
  return browser.consoleLog.filter((c) => c.type === 'error' || c.type === 'EXCEPTION');
}

export function resultBase(kind) {
  return { kind, at: new Date().toISOString(), env: ENV_LABEL, baseUrl: BASE_URL, rehearsal: true, binding: false };
}
