/* Radio tuner dial — ported from bilawalsidhu/gods-eye-view (MIT),
   src/layers/radio/tuning.js + tuningNoise.js + ui/radioTunerModel.js +
   ui/radioBindings.js.

   Gesture grammar: drag/scrub across the dial PREVIEWS each station
   (readout shows name/category/channel, camera hook optional) without
   starting audio. Release COMMITS the exact frozen snapshot captured at
   gesture start — if the directory changed mid-gesture, release still
   commits the previewed snapshot object, never retargets to a new slot.

   While scrubbing, low-volume synthesized static (WebAudio, bandpass
   1650 Hz, max gain RADIO_TUNER_STATIC_MAX_GAIN = 0.018) plays; on commit
   it fades out while the real stream fades in. Escape / pointer-cancel
   abandons the gesture with no audio change.

   AudioContext and the shared <audio> element are only touched inside user
   gesture handlers — no autoplay, ever. DOM/CSS is self-contained; honors
   prefers-reduced-motion (no needle glide or transitions).
*/
import {
  RADIO_TUNER_STATIC_MAX_GAIN,
  RADIO_CATEGORY_COLORS,
  RADIO_CATEGORY_LABELS,
} from './policy.js';

const CSS = `
.ci-tuner{font:12px/1.45 "JetBrains Mono",monospace;color:#dfe9f2;background:rgba(5,11,22,.88);
  border:1px solid rgba(140,180,220,.18);border-radius:10px;padding:10px 12px;user-select:none}
.ci-tuner-readout{display:flex;align-items:center;gap:8px;margin-bottom:8px;min-height:20px}
.ci-tuner-swatch{width:10px;height:10px;border-radius:50%;background:#9aa7b3;flex:none}
.ci-tuner-name{font-weight:700;letter-spacing:.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ci-tuner-cat{font-size:10px;letter-spacing:.12em;opacity:.75;white-space:nowrap}
.ci-tuner-chan{margin-left:auto;font-size:11px;opacity:.75;white-space:nowrap}
.ci-tuner-strip{position:relative;height:44px;background:rgba(255,255,255,.03);
  border:1px solid rgba(140,180,220,.14);border-radius:6px;cursor:ew-resize;touch-action:none;outline:none}
.ci-tuner-strip:focus-visible{border-color:#44adff}
.ci-tuner-ticks{position:absolute;inset:0;overflow:hidden}
.ci-tuner-tick{position:absolute;bottom:0;width:1px;background:rgba(180,210,240,.35)}
.ci-tuner-tick.is-major{background:rgba(180,210,240,.7)}
.ci-tuner-tick.is-cur{background:#44adff;width:2px}
.ci-tuner-tick .lab{position:absolute;bottom:2px;left:3px;font-size:9px;color:rgba(200,220,240,.6)}
.ci-tuner-needle{position:absolute;top:0;bottom:0;width:2px;background:#44adff;
  box-shadow:0 0 8px rgba(68,173,255,.8);transition:left .12s ease-out}
.ci-tuner.is-static .ci-tuner-needle{background:#f2b84b;box-shadow:0 0 8px rgba(242,184,75,.8)}
.ci-tuner-hint{margin-top:6px;font-size:10px;letter-spacing:.08em;opacity:.55}
@media (prefers-reduced-motion:reduce){.ci-tuner-needle{transition:none}}
`;

let styleEl = null;
function ensureCss() {
  if (styleEl || typeof document === 'undefined') return;
  styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);
}

// ——— synthesized tuner static (WebAudio, module-singleton) ———
let noiseCtx = null, noiseGain = null;

function ensureNoise() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return false;
  if (!noiseCtx) noiseCtx = new AC();
  if (noiseCtx.state === 'suspended') void noiseCtx.resume().catch(() => {});
  if (noiseGain) return true;
  const len = Math.max(1, Math.floor(noiseCtx.sampleRate * 0.75));
  const buf = noiseCtx.createBuffer(1, len, noiseCtx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i += 1) ch[i] = Math.random() * 2 - 1;
  const src = noiseCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const filt = noiseCtx.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = 1650;
  filt.Q.value = 0.55;
  noiseGain = noiseCtx.createGain();
  noiseGain.gain.value = 0;
  src.connect(filt);
  filt.connect(noiseGain);
  noiseGain.connect(noiseCtx.destination);
  src.start();
  return true;
}

/** Ramp static to a 0..RADIO_TUNER_STATIC_MAX_GAIN target (25 ms ramp). */
function setStaticGain(target) {
  if (!noiseCtx || !noiseGain) return;
  const clamped = Math.min(RADIO_TUNER_STATIC_MAX_GAIN, Math.max(0, target));
  const now = noiseCtx.currentTime;
  noiseGain.gain.cancelScheduledValues(now);
  noiseGain.gain.setValueAtTime(noiseGain.gain.value, now);
  noiseGain.gain.linearRampToValueAtTime(clamped, now + 0.025);
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container where the tuner renders
 * @param {object} [opts.source] createRadioSource() (for future refresh use)
 * @param {object} opts.playback playback.js module exports
 * @param {object[]} [opts.stations] initial band (normalized stations)
 * @param {Function} [opts.onCommit] ({ ok, station, snapshot }) after release
 * @param {Function} [opts.onPreview] (station|null) on each scrub preview
 * @param {Function} [opts.onRotate] (station) optional camera hook on preview
 * @returns {{setStations:Function, refresh:Function, destroy:Function}}
 */
export function initTuner({
  container,
  source = null,
  playback,
  stations = [],
  onCommit = null,
  onPreview = null,
  onRotate = null,
} = {}) {
  if (!container) throw new Error('initTuner: container is required');
  if (!playback) throw new Error('initTuner: playback is required');
  ensureCss();

  let band = [...stations];      // live band (setStations)
  let snapshot = null;           // frozen band for the active gesture
  let dragging = false;
  let coord = 0;                 // continuous 0..band.length-1 position
  let reducedMotion = false;
  try {
    reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  } catch { /* noop */ }

  const root = document.createElement('div');
  root.className = 'ci-tuner';
  root.innerHTML = `
    <div class="ci-tuner-readout">
      <span class="ci-tuner-swatch"></span>
      <span class="ci-tuner-name">NO SIGNAL</span>
      <span class="ci-tuner-cat"></span>
      <span class="ci-tuner-chan"></span>
    </div>
    <div class="ci-tuner-strip" tabindex="0" role="slider" aria-label="Radio tuner">
      <div class="ci-tuner-ticks"></div>
      <div class="ci-tuner-needle"></div>
    </div>
    <div class="ci-tuner-hint">DRAG TO TUNE · RELEASE TO COMMIT · ESC TO ABANDON</div>`;
  container.appendChild(root);

  const strip = root.querySelector('.ci-tuner-strip');
  const ticksEl = root.querySelector('.ci-tuner-ticks');
  const needle = root.querySelector('.ci-tuner-needle');
  const nameEl = root.querySelector('.ci-tuner-name');
  const catEl = root.querySelector('.ci-tuner-cat');
  const chanEl = root.querySelector('.ci-tuner-chan');
  const swatch = root.querySelector('.ci-tuner-swatch');

  function stationAt(c) {
    if (!snapshot?.length) return null;
    const i = Math.min(snapshot.length - 1, Math.max(0, Math.round(c)));
    return snapshot[i] || null;
  }

  function renderTicks() {
    ticksEl.innerHTML = '';
    const n = snapshot?.length ?? band.length;
    if (!n) return;
    const w = strip.clientWidth || 300;
    const cur = Math.round(coord);
    for (let i = 0; i < n; i += 1) {
      const t = document.createElement('span');
      t.className =
        'ci-tuner-tick' +
        (i === cur ? ' is-cur' : '') +
        (i % 5 === 0 || i === n - 1 ? ' is-major' : '');
      t.style.left = `${(i / Math.max(1, n - 1)) * 100}%`;
      t.style.height = i === cur ? '100%' : i % 5 === 0 ? '60%' : '35%';
      if (i % 10 === 0 || i === n - 1)
        t.innerHTML = `<span class="lab">${String(i + 1).padStart(2, '0')}</span>`;
      ticksEl.appendChild(t);
    }
  }

  /** Update readout + needle for a continuous coordinate; no audio. */
  function preview(c) {
    const n = snapshot?.length || 0;
    coord = n <= 1 ? 0 : Math.min(n - 1, Math.max(0, c));
    const station = stationAt(coord);
    const ratio = n <= 1 ? 0.5 : coord / (n - 1);
    needle.style.left = `${ratio * 100}%`;
    if (station) {
      const color = RADIO_CATEGORY_COLORS[station.category] || '#9aa7b3';
      nameEl.textContent = station.name || 'Unknown station';
      catEl.textContent = RADIO_CATEGORY_LABELS[station.category] || '';
      chanEl.textContent = `CH ${String(Math.round(coord) + 1).padStart(2, '0')}/${n}`;
      swatch.style.background = color;
      strip.setAttribute(
        'aria-valuetext',
        `${station.name}, channel ${Math.round(coord) + 1} of ${n}`,
      );
    } else {
      nameEl.textContent = 'NO SIGNAL';
      catEl.textContent = '';
      chanEl.textContent = '';
      swatch.style.background = '#9aa7b3';
    }
    renderTicks();
    return station;
  }

  function beginGesture(c) {
    if (dragging || !band.length) return false;
    // Freeze the band: the release commits THIS array, never the live band.
    snapshot = [...band];
    dragging = true;
    coord = Math.min(snapshot.length - 1, Math.max(0, c));
    root.classList.add('is-static');
    ensureNoise();
    setStaticGain(RADIO_TUNER_STATIC_MAX_GAIN);
    try { playback.pausePlayback?.(); } catch { /* noop */ }
    const station = preview(coord);
    if (station) onPreview?.(station);
    return true;
  }

  function endGesture(commit) {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('is-static');
    setStaticGain(0);
    const committed = commit ? stationAt(coord) : null;
    const frozen = snapshot;
    snapshot = null;
    renderTicks();
    if (committed) {
      // Frozen-snapshot commit: the object previewed at release is the one
      // that plays — even if the live band refreshed mid-gesture.
      void playback
        .playStation(committed, { fadeInMs: reducedMotion ? 0 : 400 })
        .then((ok) => onCommit?.({ ok, station: committed, snapshot: frozen }))
        .catch(() => onCommit?.({ ok: false, station: committed, snapshot: frozen }));
    } else {
      onCommit?.({ ok: false, station: null, snapshot: frozen });
    }
  }

  function coordFromEvent(event) {
    const rect = strip.getBoundingClientRect();
    const n = snapshot?.length || 1;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
    return ratio * (n - 1);
  }

  // ——— pointer gesture ———
  let pointerId = null;
  strip.addEventListener('pointerdown', (event) => {
    if (!beginGesture(coordFromEvent(event))) return;
    pointerId = event.pointerId;
    try { strip.setPointerCapture(event.pointerId); } catch { /* best effort */ }
    event.preventDefault();
  });
  strip.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    const station = preview(coordFromEvent(event));
    if (station) {
      onPreview?.(station);
      onRotate?.(station);
    }
    event.preventDefault();
  });
  strip.addEventListener('pointerup', (event) => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    preview(coordFromEvent(event));
    endGesture(true);
    event.preventDefault();
  });
  strip.addEventListener('pointercancel', () => {
    pointerId = null;
    endGesture(false);
  });

  // ——— keyboard gesture (arrows preview, Enter commits, Esc abandons) ———
  strip.addEventListener('keydown', (event) => {
    const n = snapshot?.length ?? band.length;
    if (event.key === 'Escape' && dragging) {
      event.preventDefault();
      pointerId = null;
      endGesture(false);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key))
      return;
    event.preventDefault();
    if (!dragging && !beginGesture(coord)) return;
    const max = Math.max(0, (snapshot?.length || 1) - 1);
    let next = coord;
    if (event.key === 'ArrowLeft') next = coord - 1;
    else if (event.key === 'ArrowRight') next = coord + 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = max;
    else if (event.key === 'Enter') { endGesture(true); return; }
    const station = preview(Math.min(max, Math.max(0, next)));
    if (station) {
      onPreview?.(station);
      onRotate?.(station);
    }
  });

  function setStations(list) {
    band = Array.isArray(list) ? [...list] : [];
    if (!dragging) {
      // Idle: sync readout to the new band without touching audio.
      const live = band;
      snapshot = live.length ? live : null;
      preview(Math.min(coord, Math.max(0, live.length - 1)));
      snapshot = null;
    }
  }

  function refresh() {
    // Re-run the last band fetch via source if one is wired; no-op otherwise.
    return Promise.resolve(band);
  }

  setStations(stations);
  strip.setAttribute('aria-valuemin', '0');
  strip.setAttribute('aria-valuemax', String(Math.max(0, band.length - 1)));

  function destroy() {
    pointerId = null;
    setStaticGain(0);
    try {
      if (noiseCtx && noiseCtx.state === 'running')
        void noiseCtx.suspend().catch(() => {});
    } catch { /* noop */ }
    noiseGain = null;
    root.remove();
  }

  return { setStations, refresh, destroy };
}

/** Module-level destroy for the spec API (also available via the handle). */
export function destroyTuner(handle) {
  try { handle?.destroy?.(); } catch { /* noop */ }
}
