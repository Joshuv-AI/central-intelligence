/**
 * Wave 3 shared marker/zone layer factory (§J builds: hazards, gps-jamming,
 * cf-radar, chokepoints).
 *
 * Implements the LayerLifecycle module contract (init/enable/disable/destroy/
 * update/getStats/getRowControls/setParams) over Cesium entities, so each new
 * layer is configuration + data mapping, not lifecycle code.
 *
 * §L behavior is built in, not bolted on:
 *  - optional fetch gate (camera height): while gated the layer fetches
 *    NOTHING and the row carries the plain-language guidance instead of
 *    looking empty-but-on (the civil-flights precedent);
 *  - label budgets per zoom band (B0…B5), halved on narrow viewports;
 *  - refresh only while enabled (the lifecycle owns the interval).
 *
 * Honesty (J4-14): every failure lands in getStats() as an error or a
 * guidance status — never as silent emptiness. Sub-source chips toggle
 * visibility; they never fabricate data.
 */
import * as Cesium from 'cesium';
import {
  bandForHeight,
  cameraHeightM,
  gateOpen,
} from '../../sources/live/gate.js';

const DEFAULT_COLORS = Object.freeze({
  critical: '#ff5252',
  high: '#ff9e40',
  moderate: '#ffd54f',
  low: '#9ccc65',
  unknown: '#b0bec5',
});

const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };

/** Coarse viewport class for label budgets: narrow (phone) halves budgets. */
function viewportClass(matchMedia) {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches)
      return 'narrow';
  } catch {
    /* unknown viewport: treat as desktop */
  }
  return 'wide';
}

export function createWave3MarkerLayer({
  id,
  name,
  icon = '●',
  source = 'unknown',
  // async ({ signal }) → { items, fetchedAt, sourceLabel? } or throws.
  // item: { id, lat, lon, title, sub?, severity?, url?, subSource? }
  fetchItems,
  // { maxHeightM, message } or null — no gate.
  fetchGate = null,
  // 'points' | 'zones' (zones render 1° rectangles around lat/lon)
  render = 'points',
  // label budget per band id → max labels ('wide' viewport; halved narrow).
  labelBudget = { B0: 0, B1: 8, B2: 15, B3: 25, B4: 30, B5: 30 },
  colors = DEFAULT_COLORS,
  refreshInterval = 15 * 60 * 1000,
  pointPixelSize = 10,
  // (state) → { chips?, legend?, info?, infoTitle?, list? } — row extras.
  describeRowControls = null,
  // Permanent honesty line shown in the row info (e.g. "derived, not measured").
  permanentInfo = '',
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openExternal = (url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
  cesium = Cesium,
} = {}) {
  if (!id || typeof id !== 'string') throw new TypeError('Wave3 layer needs an id');
  if (typeof fetchItems !== 'function')
    throw new TypeError('Wave3 layer needs fetchItems');

  let viewer = null;
  let dataSource = null;
  let destroyed = false;
  let enabled = false;
  let aborter = null;
  let listener = null;
  let cameraHandler = null;
  let cameraTimer = null;

  const state = {
    items: [],
    loading: false,
    error: null,
    guidance: null, // { status, message } — honest non-error states (gated, key needed)
    fetchedAt: null,
    sourceLabel: source,
    subVisibility: new Map(), // subSource → bool (default true)
    epoch: 0,
  };

  const notify = () => {
    try {
      listener?.();
    } catch {
      /* row refresh must never break the layer */
    }
  };

  const subVisible = (item) =>
    state.subVisibility.get(item.subSource ?? 'default') !== false;

  function severityColor(severity) {
    return colors[severity] || colors.unknown;
  }

  function bandNow() {
    return bandForHeight(cameraHeightM(viewer));
  }

  function labelBudgetNow() {
    const band = bandNow() || 'B0';
    const base = labelBudget[band] ?? 0;
    return viewportClass(matchMedia) === 'narrow' ? Math.ceil(base / 2) : base;
  }

  function gateState() {
    if (!fetchGate) return { open: true };
    const heightM = cameraHeightM(viewer);
    if (gateOpen(heightM, fetchGate.maxHeightM)) return { open: true };
    return { open: false, message: fetchGate.message };
  }

  function clearEntities() {
    if (dataSource) dataSource.entities.removeAll();
  }

  function renderItems() {
    if (!dataSource || destroyed) return;
    clearEntities();
    const budget = labelBudgetNow();
    const visible = state.items.filter(subVisible);
    // Labels go to the highest-severity items first — the budget buys the
    // most important names, not the first N in feed order.
    const ranked = [...visible].sort(
      (a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0),
    );
    const labeled = new Set(ranked.slice(0, budget).map((i) => i.id));
    for (const item of visible) {
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
      const color = cesium.Color.fromCssColorString(severityColor(item.severity));
      const position = cesium.Cartesian3.fromDegrees(item.lon, item.lat);
      const entity = {
        id: `${id}:${item.id}`,
        name: item.title,
        description: item.sub || '',
      };
      if (render === 'zones') {
        entity.rectangle = {
          coordinates: cesium.Rectangle.fromDegrees(
            item.lon - 0.5,
            item.lat - 0.5,
            item.lon + 0.5,
            item.lat + 0.5,
          ),
          material: color.withAlpha(0.22),
          outline: true,
          outlineColor: color.withAlpha(0.9),
          outlineWidth: 1,
          height: 0,
        };
        entity.position = position;
        if (labeled.has(item.id)) {
          entity.label = {
            text: item.title,
            font: '12px sans-serif',
            fillColor: cesium.Color.WHITE,
            outlineColor: cesium.Color.BLACK,
            outlineWidth: 2,
            style: cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new cesium.Cartesian2(0, -14),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          };
        }
      } else {
        entity.position = position;
        entity.point = {
          pixelSize: pointPixelSize,
          color,
          outlineColor: cesium.Color.WHITE,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        };
        if (labeled.has(item.id)) {
          entity.label = {
            text: item.title,
            font: '12px sans-serif',
            fillColor: cesium.Color.WHITE,
            outlineColor: cesium.Color.BLACK,
            outlineWidth: 2,
            style: cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new cesium.Cartesian2(0, -12),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          };
        }
      }
      dataSource.entities.add(entity);
    }
  }

  async function refresh({ signal } = {}) {
    const gate = gateState();
    if (!gate.open) {
      // §L: gated means NO fetch — and the row says so plainly, through the
      // same error channel the flights gate uses (never silent emptiness).
      state.guidance = { status: 'gated', message: gate.message };
      state.error = gate.message;
      notify();
      return;
    }
    state.guidance = null;
    state.loading = true;
    state.error = null;
    notify();
    const epoch = ++state.epoch;
    try {
      const result = await fetchItems({ signal });
      if (epoch !== state.epoch || destroyed) return;
      const items = Array.isArray(result?.items) ? result.items : [];
      state.items = items;
      state.fetchedAt = result?.fetchedAt ?? Date.now();
      if (result?.sourceLabel) state.sourceLabel = result.sourceLabel;
      if (result?.keyRequired) {
        // The FIRMS precedent: a missing key is the row's headline via the
        // error channel ("KEY REQUIRED"), never an empty-but-on row.
        const msg = result.keyMessage || 'API key required — not configured';
        state.guidance = { status: 'key_needed', message: msg };
        state.error = msg;
      } else {
        state.guidance = null;
        state.error = null;
      }
      renderItems();
    } catch (error) {
      if (epoch !== state.epoch || destroyed) return;
      if (error?.name === 'AbortError') return;
      // Fail closed: keep last-good items off-screen is wrong — keep them,
      // but the error is the row's headline, never silent.
      state.error = error instanceof Error ? error.message : String(error);
      state.guidance = null;
    } finally {
      if (epoch === state.epoch && !destroyed) {
        state.loading = false;
        notify();
      }
    }
  }

  function flyTo(lat, lon) {
    if (!viewer || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    try {
      viewer.camera.flyTo({
        destination: cesium.Cartesian3.fromDegrees(lon, lat, 2_000_000),
        duration: 1.2,
      });
      return true;
    } catch {
      return false;
    }
  }

  const module = {
    id,
    name,
    icon,
    source,
    refreshInterval,
    showInTogglePanel: true,

    async init(v, { signal } = {}) {
      signal?.throwIfAborted();
      if (destroyed) throw new Error(`${id} destroyed`);
      viewer = v;
      dataSource = new cesium.CustomDataSource(id);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      // Re-evaluate label budgets when the camera settles (debounced).
      const onMoveEnd = () => {
        if (cameraTimer) clearTimeout(cameraTimer);
        cameraTimer = setTimeout(() => {
          cameraTimer = null;
          if (enabled && !destroyed) renderItems();
        }, 350);
      };
      try {
        cameraHandler = viewer.camera.moveEnd.addEventListener(onMoveEnd);
      } catch {
        cameraHandler = null;
      }
      return true;
    },

    async destroy() {
      destroyed = true;
      enabled = false;
      if (cameraTimer) clearTimeout(cameraTimer);
      try {
        cameraHandler?.();
      } catch {
        /* noop */
      }
      aborter?.abort();
      try {
        if (viewer && dataSource) viewer.dataSources.remove(dataSource, true);
      } catch {
        /* noop */
      }
      viewer = null;
      dataSource = null;
      listener = null;
      return true;
    },

    async enable(v) {
      if (v) viewer = v;
      enabled = true;
      if (dataSource) dataSource.show = true;
      await refresh();
      return true;
    },

    async disable() {
      enabled = false;
      state.epoch += 1;
      aborter?.abort();
      aborter = null;
      if (dataSource) dataSource.show = false;
      return true;
    },

    async update(v, { signal } = {}) {
      if (v) viewer = v;
      if (!enabled || destroyed) return false;
      aborter?.abort();
      aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const combined = signal && aborter
        ? AbortSignal.any([signal, aborter.signal])
        : signal || aborter?.signal || null;
      await refresh({ signal: combined });
      return true;
    },

    getStats() {
      const stats = {
        count: state.items.filter(subVisible).length,
        loading: state.loading,
        error: state.error,
        lastError: state.error,
        source: state.sourceLabel,
        lastUpdate: state.fetchedAt,
      };
      if (state.guidance) {
        stats.status = state.guidance.status;
        stats.statusMessage = state.guidance.message;
      }
      return stats;
    },

    getRowControls() {
      const extras = describeRowControls ? describeRowControls(state, api) : {};
      const items = state.items.filter(subVisible).slice(0, 20);
      const listItems = items.map((item) => ({
        id: String(item.id),
        lead: item.severity ? String(item.severity).toUpperCase() : '',
        text:
          Number.isFinite(item.lat) && Number.isFinite(item.lon)
            ? item.title
            : `${item.title} (no map position)`,
        params:
          Number.isFinite(item.lat) && Number.isFinite(item.lon)
            ? { flyTo: { lat: item.lat, lon: item.lon } }
            : item.url
              ? { openUrl: item.url }
              : null,
      }));
      const infoBits = [];
      if (permanentInfo) infoBits.push(permanentInfo);
      if (extras.info) infoBits.push(extras.info);
      return {
        chips: extras.chips || [],
        legend: extras.legend || [],
        info: infoBits.join(' · ') || undefined,
        infoTitle: extras.infoTitle,
        list:
          listItems.length > 0
            ? { ariaLabel: `${name} items`, items: listItems }
            : null,
      };
    },

    setRowControlsListener(fn) {
      listener = typeof fn === 'function' ? fn : null;
    },

    async setParams(params) {
      if (params?.flyTo) {
        const { lat, lon } = params.flyTo;
        return flyTo(lat, lon);
      }
      if (params?.openUrl && typeof params.openUrl === 'string') {
        openExternal(params.openUrl);
        return true;
      }
      if (params?.toggleSub && typeof params.toggleSub === 'string') {
        const key = params.toggleSub;
        state.subVisibility.set(key, !subVisible({ subSource: key }));
        renderItems();
        notify();
        return true;
      }
      return false;
    },

    getParams() {
      return {
        hidden: [...state.subVisibility.entries()]
          .filter(([, v]) => v === false)
          .map(([k]) => k),
      };
    },

    // Test seam: read-only view of internal state.
    _wave3State: () => state,
  };

  const api = {
    get state() {
      return state;
    },
    subVisible,
    toggleSub(key) {
      state.subVisibility.set(key, !subVisible({ subSource: key }));
      renderItems();
      notify();
    },
    refresh: () => refresh({}),
    flyTo,
  };

  return module;
}

/** Shared fetch helper: same-origin /api/events filtered by adapter name. */
export async function fetchBackendEvents({
  sources,
  fetchImpl = (...args) => globalThis.fetch(...args),
  signal,
} = {}) {
  const response = await fetchImpl('/api/events', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`events backend HTTP ${response.status}`);
  const payload = await response.json().catch(() => null);
  const events = Array.isArray(payload?.events) ? payload.events : null;
  if (!events) throw new Error('Malformed events response');
  const wanted = new Set(sources);
  return events.filter((e) => wanted.has(e.source));
}

/** Read the scheduler's per-source status (for honest key-needed states). */
export async function fetchSourceStatus({
  name,
  fetchImpl = (...args) => globalThis.fetch(...args),
  signal,
} = {}) {
  try {
    const response = await fetchImpl('/api/health', { signal, cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    return sources.find((s) => s?.name === name)?.status ?? null;
  } catch {
    return null;
  }
}
