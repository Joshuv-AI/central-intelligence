/**
 * Hidden diagnostics overlay (MASTER-CHECKLIST §E; §I.2 measurements depend
 * on it). OFF by default. Toggle: `?diag=1` in the URL, or Ctrl+Shift+D.
 *
 * Shows: FPS (1 s window), frame-time p95 (rolling 240-frame ring), render
 * governor state (any lane may publish {mode, holds} via
 * `window.__ciDiagnostics.publishGovernor({mode, holds})`), JS heap where
 * the browser exposes it (performance.memory, Chromium), and the build SHA
 * baked in at build time (import.meta.env.VITE_BUILD_SHA — must match
 * /api/health deploySha at cutover, §I.6).
 */
const state = {
  frames: [],
  fps: 0,
  governor: { mode: '—', holds: '—' },
  sentinel: 'Full quality', // J4-29: perf sentinel level label
  visible: false,
  raf: 0,
  last: 0,
  el: null,
  timer: 0,
};

function frameP95() {
  if (state.frames.length < 20) return null;
  const sorted = [...state.frames].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function render() {
  if (!state.el) return;
  const heap = performance.memory
    ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB heap`
    : 'heap n/a';
  const p95 = frameP95();
  state.el.textContent =
    `CI DIAG · build ${import.meta.env.VITE_BUILD_SHA || 'dev'} · ` +
    `${state.fps} fps · frame p95 ${p95 ? p95.toFixed(1) + ' ms' : '—'} · ` +
    `governor ${state.governor.mode} · holds ${state.governor.holds} · ${heap} · ` +
    `sentinel ${state.sentinel}`;
}

function loop(t) {
  if (!state.visible) return;
  if (state.last) {
    const dt = t - state.last;
    if (dt > 0 && dt < 1000) {
      state.frames.push(dt);
      if (state.frames.length > 240) state.frames.shift();
    }
  }
  state.last = t;
  state.raf = requestAnimationFrame(loop);
}

let fpsWindow = [];
function fpsLoop(t) {
  fpsWindow.push(t);
  fpsWindow = fpsWindow.filter((x) => t - x < 1000);
  state.fps = fpsWindow.length;
  if (state.visible) requestAnimationFrame(fpsLoop);
}

function setVisible(on) {
  state.visible = on;
  if (!state.el) {
    state.el = document.createElement('div');
    state.el.id = 'ci-diagnostics';
    state.el.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:99999;padding:6px 10px;' +
      'background:rgba(4,12,20,.88);color:#9fe8ff;font:11px/1.5 monospace;' +
      'border:1px solid #1d4b63;border-radius:6px;pointer-events:none;white-space:pre';
    document.body.appendChild(state.el);
  }
  state.el.style.display = on ? 'block' : 'none';
  if (on) {
    state.last = 0;
    state.raf = requestAnimationFrame(loop);
    requestAnimationFrame(fpsLoop);
    state.timer = setInterval(render, 500);
    render();
  } else {
    cancelAnimationFrame(state.raf);
    clearInterval(state.timer);
  }
}

export function initDiagnostics() {
  window.__ciDiagnostics = {
    publishGovernor({ mode, holds } = {}) {
      if (mode !== undefined) state.governor.mode = String(mode);
      if (holds !== undefined) state.governor.holds = String(holds);
    },
    // J4-29: the perf sentinel publishes its level label here.
    publishSentinel(label) {
      if (typeof label === 'string' && label) state.sentinel = label;
    },
    snapshot: () => ({
      fps: state.fps,
      frameP95Ms: frameP95(),
      governor: { ...state.governor },
      heapMB: performance.memory
        ? performance.memory.usedJSHeapSize / 1048576
        : null,
      build: import.meta.env.VITE_BUILD_SHA || 'dev',
    }),
  };
  if (new URLSearchParams(location.search).get('diag') === '1')
    setVisible(true);
  addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      setVisible(!state.visible);
    }
  });
}
