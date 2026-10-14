/**
 * J4-09 · Analyst quick actions + J4-10 · Accessibility shell.
 *
 * One catalog row ("Analyst tools") with chips:
 *  - COMPARE: pick two intel events → side-by-side aligned-field card
 *  - MEASURE / AREA: click-the-map distance / area (§L: B2+ only, gated hint)
 *  - EXPORT JSON / EXPORT TXT: timestamped view+data download (timestamp
 *    burned into the content; server-rendered image export NOT built)
 *  - READ SUMMARY: screen-reader "current picture" announced via live region
 *
 * Jump-to is the already-decided dock search (Rulings 2026-10-13 §2) — this
 * module does not build a second search; Alt+1 focuses it (J4-10).
 *
 * J4-10 installs at factory time (catalog construction — always runs): skip
 * links, bounded keyboard traversal (Alt+1 dock · Alt+2 layers · Alt+3 intel ·
 * Alt+G globe), and the aria-live region. The measure/compare/export tools
 * need the row enabled (they need the viewer); a11y works regardless.
 */
import * as Cesium from 'cesium';
import {
  claimPointer,
  releasePointer,
} from '../../data/inputOwnership.js';
import {
  bandForHeight,
  cameraHeightM,
} from '../../sources/live/gate.js';
import {
  MEASURE_GATED_HINT,
  formatArea,
  formatDistance,
  measureAllowed,
  pathLengthKm,
  polygonAreaKm2,
} from './measure.js';
import {
  buildExportPayload,
  downloadFile,
  exportFileName,
  renderExportJson,
  renderExportTxt,
} from './export.js';
import { buildCurrentPicture } from './summary.js';

const HINT_LINE = 'Pick a shape, then click the map';
const ANALYST_POINTER_OWNER = 'analyst-measure';

/* ------------------------------------------------------------------ */
/* J4-10 — installed once at factory time, independent of row state.   */
/* ------------------------------------------------------------------ */

function ensureTabbable(el) {
  if (el && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
}

function focusTarget(doc, selector) {
  const el = doc.querySelector(selector);
  if (!el) return false;
  ensureTabbable(el);
  el.focus({ preventScroll: false });
  return doc.activeElement === el;
}

/** Expand a collapsed panel, then focus inside it. Returns true when the focus
 *  landed (or will land after the expand transition settles). */
function revealAndFocus(doc, panelSelector, targetSelector) {
  const body = doc.body;
  // Mobile (≤720px): the panel rails are docked off-canvas until the PANELS
  // toggle opens them as a sheet.
  if (
    body?.classList?.contains('mobile-panels-docked') &&
    !body.classList.contains('mobile-panels-open')
  ) {
    doc.getElementById('mobile-panels-toggle')?.click();
  }
  const panel = panelSelector ? doc.querySelector(panelSelector) : null;
  const needsReveal = Boolean(panel?.classList?.contains('collapsed'));
  if (needsReveal) {
    panel.querySelector('[data-collapse-target]')?.click();
  }
  if (!needsReveal && !body?.classList?.contains('mobile-panels-docked')) {
    return focusTarget(doc, targetSelector);
  }
  // The expand is transitioned (and on mobile the drawer re-homes focus) —
  // wait for it to settle before taking focus.
  const win = doc.defaultView;
  const later = () => focusTarget(doc, targetSelector);
  if (win?.setTimeout) win.setTimeout(later, 400);
  else later();
  return true;
}

export function installAnalystA11y(doc = globalThis.document) {
  if (!doc || typeof doc.createElement !== 'function') return () => {};
  if (doc.getElementById('analyst-a11y-root')) return () => {};
  const root = doc.createElement('div');
  root.id = 'analyst-a11y-root';

  const skip = doc.createElement('div');
  skip.className = 'analyst-skip-links';
  const mkSkip = (label, target, revealPanel = null) => {
    const a = doc.createElement('a');
    a.href = `#${target}`;
    a.className = 'analyst-skip-link';
    a.textContent = label;
    a.addEventListener('click', (event) => {
      event.preventDefault();
      revealAndFocus(doc, revealPanel, `#${target} .data-toggle-btn, #${target}`);
    });
    return a;
  };
  skip.append(mkSkip('Skip to layers panel', 'data-toggles', '#data-panel'), mkSkip('Skip to globe', 'analyst-globe'));
  const live = doc.createElement('div');
  live.id = 'analyst-live-region';
  live.className = 'analyst-sr-only';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('role', 'status');
  root.append(skip, live);
  doc.body.prepend(root);

  const onKeyDown = (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const t = event.target;
    if (t?.matches?.('input, select, textarea') || t?.isContentEditable) return;
    const key = event.key === 'G' ? 'g' : event.key.toLowerCase();
    let done = false;
    if (key === '1') done = focusTarget(doc, '#dock-search-btn');
    else if (key === '2')
      done = revealAndFocus(doc, '#data-panel', '#data-toggles .data-toggle-btn');
    else if (key === '3')
      done = focusTarget(doc, '#intel-hud button, #intel-hud [href], #intel-hud input, #intel-hud [tabindex]');
    else if (key === 'g') done = focusTarget(doc, '#analyst-globe');
    if (done) event.preventDefault();
  };
  doc.addEventListener('keydown', onKeyDown);
  return () => doc.removeEventListener('keydown', onKeyDown);
}

export function announce(doc, text) {
  const live = doc?.getElementById?.('analyst-live-region');
  if (!live) return;
  const write = () => {
    live.textContent = text;
  };
  live.textContent = '';
  // Re-setting in a frame guarantees the SR picks up repeated summaries.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(write);
  else write();
}

/* ------------------------------------------------------------------ */
/* Layer module                                                        */
/* ------------------------------------------------------------------ */

export function createAnalystLayer({
  fetchImpl = (...args) => globalThis.fetch(...args),
  doc = globalThis.document,
  cesium = Cesium,
} = {}) {
  // J4-10: global a11y shell lives as long as the catalog does.
  installAnalystA11y(doc);

  let viewer = null;
  let measureDs = null;
  let enabled = false;
  let destroyed = false;
  let listener = null;
  let mode = null; // null | 'compare' | 'measure' | 'area'
  let measurePoints = [];
  let measureLease = null;
  let clickHandler = null;
  let measureReadout = null;
  let comparePanel = null;
  let lastSummary = '';
  const notify = () => {
    try {
      listener?.();
    } catch {
      /* row refresh must never break the layer */
    }
  };

  async function fetchEvents({ signal } = {}) {
    const response = await fetchImpl('/api/events', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`events backend HTTP ${response.status}`);
    const payload = await response.json().catch(() => null);
    const events = Array.isArray(payload?.events) ? payload.events : null;
    if (!events) throw new Error('Malformed events response');
    return events;
  }

  const SEV_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };
  const topEvents = (events, n = 100) =>
    [...events]
      .sort(
        (a, b) =>
          (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) ||
          Date.parse(b.time || 0) - Date.parse(a.time || 0),
      )
      .slice(0, n);

  /* ---------------- measure ---------------- */

  function clearMeasureDraw() {
    measureDs?.entities.removeAll();
    measurePoints = [];
    measureReadout?.remove();
    measureReadout = null;
  }

  function releaseMeasurePointer() {
    if (clickHandler) {
      try {
        clickHandler.destroy();
      } catch {
        /* noop */
      }
      clickHandler = null;
    }
    if (measureLease) {
      releasePointer(measureLease);
      measureLease = null;
    }
  }

  function endMeasureMode() {
    releaseMeasurePointer();
    mode = null;
    notify();
  }

  function measureResultText() {
    if (mode === 'area' && measurePoints.length >= 3) {
      return `Area ${formatArea(polygonAreaKm2(measurePoints))} — approximate`;
    }
    if (measurePoints.length >= 2) {
      return `Distance ${formatDistance(pathLengthKm(measurePoints))} — approximate`;
    }
    return mode === 'area'
      ? 'Click the map to place corners (3+), double-click to finish'
      : 'Click the map to place points (2+), double-click to finish';
  }

  function drawMeasure() {
    if (!measureDs) return;
    measureDs.entities.removeAll();
    const positions = measurePoints.map((p) =>
      cesium.Cartesian3.fromDegrees(p.lon, p.lat),
    );
    for (const pos of positions) {
      measureDs.entities.add({
        position: pos,
        point: {
          pixelSize: 9,
          color: cesium.Color.YELLOW,
          outlineColor: cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    if (positions.length >= 2 && mode === 'measure') {
      measureDs.entities.add({
        polyline: {
          positions,
          width: 2,
          material: cesium.Color.YELLOW.withAlpha(0.9),
          clampToGround: false,
        },
      });
    }
    if (positions.length >= 3 && mode === 'area') {
      measureDs.entities.add({
        polygon: {
          hierarchy: new cesium.PolygonHierarchy(positions),
          material: cesium.Color.YELLOW.withAlpha(0.25),
          outline: true,
          outlineColor: cesium.Color.YELLOW,
        },
      });
    }
    if (measureReadout) measureReadout.querySelector('.analyst-measure-value').textContent = measureResultText();
  }

  function showMeasureReadout() {
    if (!doc?.body || measureReadout) return;
    measureReadout = doc.createElement('div');
    measureReadout.className = 'analyst-measure-readout';
    measureReadout.setAttribute('role', 'status');
    const value = doc.createElement('div');
    value.className = 'analyst-measure-value';
    const hint = doc.createElement('div');
    hint.className = 'analyst-measure-hint';
    hint.textContent = `${HINT_LINE} · double-click to finish · Esc cancels`;
    const done = doc.createElement('button');
    done.type = 'button';
    done.className = 'analyst-btn';
    done.textContent = 'DONE';
    done.addEventListener('click', () => endMeasureMode());
    measureReadout.append(value, hint, done);
    doc.body.appendChild(measureReadout);
    drawMeasure();
  }

  function startMeasure(kind) {
    if (!viewer) return;
    if (mode === kind) {
      endMeasureMode();
      return;
    }
    endMeasureMode();
    clearMeasureDraw();
    const band = bandForHeight(cameraHeightM(viewer));
    if (!measureAllowed(band)) {
      announce(doc, MEASURE_GATED_HINT);
      mode = 'gated-hint';
      notify();
      setTimeout(() => {
        if (mode === 'gated-hint') {
          mode = null;
          notify();
        }
      }, 4000);
      return;
    }
    const lease = claimPointer(ANALYST_POINTER_OWNER);
    if (!lease) {
      announce(doc, 'Another map tool is using clicks — close it, then measure.');
      return;
    }
    measureLease = lease;
    mode = kind;
    const handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler = handler;
    const pickPoint = (movement) => {
      const cartesian = viewer.camera.pickEllipsoid(
        movement.position,
        viewer.scene.globe.ellipsoid,
      );
      if (!cartesian) return null;
      const carto = cesium.Cartographic.fromCartesian(cartesian);
      return {
        lat: (carto.latitude * 180) / Math.PI,
        lon: (carto.longitude * 180) / Math.PI,
      };
    };
    handler.setInputAction((movement) => {
      const p = pickPoint(movement);
      if (!p) return;
      measurePoints.push(p);
      drawMeasure();
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(() => endMeasureMode(), cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    showMeasureReadout();
    announce(doc, `${kind === 'area' ? 'Area' : 'Distance'} measure: ${HINT_LINE.toLowerCase()}.`);
    notify();
  }

  /* ---------------- compare ---------------- */

  function closeCompare() {
    comparePanel?.remove();
    comparePanel = null;
    if (mode === 'compare') {
      mode = null;
      notify();
    }
  }

  function fieldRows(a, b) {
    const fields = [
      ['Title', a.title, b.title],
      ['Severity', a.severity, b.severity],
      ['Time', a.time, b.time],
      ['Region', a.region, b.region],
      ['Source', a.source, b.source],
      ['Coordinates', a.lat != null && a.lon != null ? `${a.lat.toFixed(2)}, ${a.lon.toFixed(2)}` : '—', b.lat != null && b.lon != null ? `${b.lat.toFixed(2)}, ${b.lon.toFixed(2)}` : '—'],
      ['Summary', a.summary, b.summary],
      ['Link', a.url, b.url],
    ];
    return fields;
  }

  async function openCompare() {
    if (mode === 'compare') {
      closeCompare();
      return;
    }
    endMeasureMode();
    clearMeasureDraw();
    mode = 'compare';
    notify();
    let events = [];
    let loadError = null;
    try {
      events = topEvents(await fetchEvents({}));
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
    if (!doc?.body) return;
    closeCompare();
    comparePanel = doc.createElement('div');
    comparePanel.className = 'analyst-panel';
    comparePanel.setAttribute('role', 'dialog');
    comparePanel.setAttribute('aria-label', 'Compare two events');
    const head = doc.createElement('div');
    head.className = 'analyst-panel-head';
    const title = doc.createElement('strong');
    title.textContent = 'Compare two events';
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'analyst-btn';
    close.textContent = 'CLOSE';
    close.setAttribute('aria-label', 'Close compare');
    close.addEventListener('click', closeCompare);
    head.append(title, close);
    comparePanel.appendChild(head);

    const mkSelect = (labelText) => {
      const wrap = doc.createElement('label');
      wrap.className = 'analyst-select-wrap';
      const span = doc.createElement('span');
      span.textContent = labelText;
      const sel = doc.createElement('select');
      for (const e of events) {
        const opt = doc.createElement('option');
        opt.value = e.id;
        opt.textContent = `[${String(e.severity || 'low').toUpperCase()}] ${(e.title || e.id).slice(0, 80)}`;
        sel.appendChild(opt);
      }
      wrap.append(span, sel);
      return { wrap, sel };
    };
    const result = doc.createElement('div');
    result.className = 'analyst-compare-result';
    if (loadError) {
      const err = doc.createElement('p');
      err.className = 'analyst-error';
      err.textContent = `Could not load events: ${loadError}`;
      comparePanel.append(head, err);
    } else {
      const a = mkSelect('Event A');
      const b = mkSelect('Event B');
      if (b.sel.options.length > 1) b.sel.selectedIndex = 1;
      const go = doc.createElement('button');
      go.type = 'button';
      go.className = 'analyst-btn analyst-btn-primary';
      go.textContent = 'COMPARE';
      go.addEventListener('click', () => {
        const ea = events.find((e) => e.id === a.sel.value);
        const eb = events.find((e) => e.id === b.sel.value);
        result.innerHTML = '';
        if (!ea || !eb) return;
        const table = doc.createElement('table');
        table.className = 'analyst-compare-table';
        const thead = doc.createElement('thead');
        const hr = doc.createElement('tr');
        for (const h of ['', 'A', 'B']) {
          const th = doc.createElement('th');
          th.textContent = h;
          th.setAttribute('scope', 'col');
          hr.appendChild(th);
        }
        thead.appendChild(hr);
        const tbody = doc.createElement('tbody');
        for (const [label, va, vb] of fieldRows(ea, eb)) {
          const tr = doc.createElement('tr');
          const th = doc.createElement('th');
          th.textContent = label;
          th.setAttribute('scope', 'row');
          const tda = doc.createElement('td');
          tda.textContent = va ?? '—';
          const tdb = doc.createElement('td');
          tdb.textContent = vb ?? '—';
          tr.append(th, tda, tdb);
          tbody.appendChild(tr);
        }
        table.append(thead, tbody);
        const stamp = doc.createElement('p');
        stamp.className = 'analyst-stamp';
        stamp.textContent = `Compared ${new Date().toISOString()} · data from /api/events snapshot`;
        result.append(table, stamp);
      });
      comparePanel.append(head, a.wrap, b.wrap, go, result);
    }
    doc.body.appendChild(comparePanel);
    const first = comparePanel.querySelector('select, button');
    first?.focus();
    comparePanel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeCompare();
      }
    });
  }

  /* ---------------- export ---------------- */

  async function doExport(kind) {
    let events = [];
    try {
      events = await fetchEvents({});
    } catch {
      /* export proceeds with zero events, honestly labeled */
    }
    const carto = viewer?.camera?.positionCartographic;
    const camera = carto
      ? {
          lat: (carto.latitude * 180) / Math.PI,
          lon: (carto.longitude * 180) / Math.PI,
          heightKm: (carto.height || 0) / 1000,
        }
      : null;
    const payload = buildExportPayload({
      exportedAt: new Date().toISOString(),
      camera,
      layerHash: typeof location !== 'undefined' ? location.hash : '',
      events,
    });
    const content = kind === 'txt' ? renderExportTxt(payload) : renderExportJson(payload);
    downloadFile(
      exportFileName(payload.exportedAt, kind),
      content,
      kind === 'txt' ? 'text/plain' : 'application/json',
    );
    announce(doc, `Exported ${payload.eventCount} events as ${kind.toUpperCase()} (${payload.staleNote}).`);
  }

  /* ---------------- summary ---------------- */

  async function readSummary() {
    let events = [];
    try {
      events = await fetchEvents({});
    } catch {
      /* honest empty state below */
    }
    lastSummary = buildCurrentPicture(events);
    announce(doc, lastSummary);
    notify();
  }

  /* ---------------- module ---------------- */

  const module = {
    id: 'analyst-tools',
    name: 'Analyst tools',
    icon: '◈',
    source: 'Analyst quick actions',
    refreshInterval: 0,
    showInTogglePanel: true,

    async init(v) {
      if (destroyed) throw new Error('analyst-tools destroyed');
      viewer = v;
      measureDs = new cesium.CustomDataSource('analyst-tools');
      measureDs.show = true;
      viewer.dataSources.add(measureDs);
      const canvas = viewer.scene?.canvas;
      if (canvas && !canvas.id) {
        try {
          canvas.id = 'analyst-globe';
        } catch {
          /* non-DOM canvas stand-in */
        }
      }
      return true;
    },

    async destroy() {
      destroyed = true;
      enabled = false;
      endMeasureMode();
      clearMeasureDraw();
      closeCompare();
      try {
        if (viewer && measureDs) viewer.dataSources.remove(measureDs, true);
      } catch {
        /* noop */
      }
      viewer = null;
      measureDs = null;
      listener = null;
      return true;
    },

    async enable(v) {
      if (v) viewer = v;
      enabled = true;
      return true;
    },

    async disable() {
      enabled = false;
      endMeasureMode();
      clearMeasureDraw();
      closeCompare();
      return true;
    },

    async update() {
      return true; // no data to refresh — never reject the enable transaction
    },

    getStats() {
      return { count: 0, loading: false, error: null, source: 'Analyst quick actions' };
    },

    getRowControls() {
      const chips = [
        { id: 'compare', label: 'COMPARE', title: 'Compare two events side by side', active: mode === 'compare', onClick: () => openCompare() },
        { id: 'measure', label: 'MEASURE', title: `${HINT_LINE} (regional zoom and closer)`, active: mode === 'measure', onClick: () => startMeasure('measure') },
        { id: 'area', label: 'AREA', title: `${HINT_LINE} — polygon area (regional zoom and closer)`, active: mode === 'area', onClick: () => startMeasure('area') },
        { id: 'export-json', label: 'EXPORT JSON', title: 'Download timestamped JSON of the current view + data', onClick: () => doExport('json') },
        { id: 'export-txt', label: 'EXPORT TXT', title: 'Download timestamped text brief of the current view + data', onClick: () => doExport('txt') },
        { id: 'read-summary', label: 'READ SUMMARY', title: 'Announce the current picture (screen reader)', onClick: () => readSummary() },
      ];
      let info = 'Compare · measure · export. Jump-to lives in the dock search (Alt+1).';
      if (mode === 'measure' || mode === 'area') info = `${HINT_LINE} — double-click to finish, Esc to cancel.`;
      if (mode === 'gated-hint') info = MEASURE_GATED_HINT;
      if (lastSummary) info += ` Last summary: ${lastSummary}`;
      return { chips, legend: [], info };
    },

    setRowControlsListener(fn) {
      listener = typeof fn === 'function' ? fn : null;
    },

    async setParams() {
      return false;
    },
    getParams() {
      return {};
    },

    // Test seams.
    _analyst: () => ({ mode, measurePoints: [...measurePoints], lastSummary }),
    _endMeasureMode: endMeasureMode,
  };

  // Escape cancels an armed measure even when the readout is not focused.
  const onDocKey = (event) => {
    if (event.key === 'Escape' && (mode === 'measure' || mode === 'area')) {
      event.stopPropagation();
      endMeasureMode();
      clearMeasureDraw();
    }
  };
  doc?.addEventListener?.('keydown', onDocKey);

  return module;
}
