/* Wave 1 (J4-14) — degraded-mode honesty standard, codified as a ship rule.

   GEV's bar: a degraded layer is triple-labeled — the layer ROW, the PANEL
   (card/panel surface), and the IN-GLOBE rendering — so degraded data is
   never mistakable for real. Synthetic substitution is always opt-visible
   and labeled in all three places; silent substitution is a §I.1 failure
   by definition. Unkeyed states (key pending) are instances of this rule,
   not exceptions to it.

   This module is the vocabulary + the per-layer audit record. Every layer
   defines its degraded mode + label before it ships; the audit below is the
   Wave 1 baseline and is enforced in review. */

export const DEGRADED_VOCABULARY = Object.freeze({
  SYNTHETIC: 'SYNTHETIC', // rendered stand-in, not observed data — always opt-visible
  DEGRADED: 'DEGRADED', // partially working: fewer records / lower cadence / stale cache
  STALE: 'STALE', // last good data, age shown — staleness IS the display
  NO_KEY: 'KEY NEEDED', // keyed source, key not yet configured — honest unkeyed state
  UNAVAILABLE: 'UNAVAILABLE', // no data and no cache — says so, not empty
  LOADING: 'LOADING', // first fetch in flight — never presented as empty
});

/** The three surfaces a degraded label must appear on. */
export const DEGRADED_SURFACES = Object.freeze(['row', 'panel', 'globe']);

/**
 * Build a degraded-mode descriptor for a layer. `labels` maps surface →
 * the exact label shown there; every surface must be covered, or the layer
 * is not shippable under this rule.
 * @param {object} d
 * @param {string} d.layerId
 * @param {string} d.mode one of DEGRADED_VOCABULARY values
 * @param {Record<string,string>} d.labels per-surface labels
 * @param {string} [d.note] what the degradation means in plain language
 */
export function describeDegradedMode({ layerId, mode, labels, note = '' } = {}) {
  if (typeof layerId !== 'string' || !layerId) throw new Error('describeDegradedMode: layerId required');
  if (!Object.values(DEGRADED_VOCABULARY).includes(mode))
    throw new Error(`describeDegradedMode: unknown mode ${mode}`);
  const missing = DEGRADED_SURFACES.filter((s) => typeof labels?.[s] !== 'string' || !labels[s].trim());
  if (missing.length)
    throw new Error(`describeDegradedMode(${layerId}): unlabeled surfaces: ${missing.join(', ')}`);
  return Object.freeze({ layerId, mode, labels: Object.freeze({ ...labels }), note });
}

/**
 * Wave 1 audit baseline: the degraded mode each shipped layer actually
 * implements. Review gate: any layer not listed here has not defined its
 * degraded mode and does not ship.
 *
 * Sources of truth: ui/layerPanel.js (row), per-layer panels/cards (panel),
 * globe renderers (globe). Labels verified against the tree 2026-10-13.
 */
export const DEGRADED_AUDIT = Object.freeze([
  {
    layerId: 'cctv',
    mode: DEGRADED_VOCABULARY.DEGRADED,
    surfaces: {
      row: 'Layers row: state chip (DEGRADED) + meta line with provider status',
      panel: 'CCTV feed card: per-state hint overlay (Stage-2 F7) — "SOURCE · UNKNOWN" never bare',
      globe: 'CCTV markers carry state; gated feeds never render as live',
    },
    note: 'Client-direct media; synthetic stills would need SYNTHETIC on all three.',
  },
  {
    layerId: 'intel-events',
    mode: DEGRADED_VOCABULARY.STALE,
    surfaces: {
      row: 'INTEL pill: "Reconnecting — showing last update" / "Data is out of date"',
      panel: 'Banner: "Connection interrupted — showing the last update from X"',
      globe: 'Markers freeze with stale data; J4-11 clock freeze stops motion',
    },
    note: 'Staleness is the display: age always shown, never hidden.',
  },
  {
    layerId: 'ais-live-vessels',
    mode: DEGRADED_VOCABULARY.NO_KEY,
    surfaces: {
      row: 'Layers row: "KEY NEEDED" guidance state (keySetupRequirement)',
      panel: 'Vessel panel: unkeyed guidance, no fake vessels',
      globe: 'Nothing rendered — absence is labeled, not empty',
    },
    note: 'AISStream key pending (Joshua host-side). Unkeyed state is honest by design.',
  },
  {
    layerId: 'local-firms',
    mode: DEGRADED_VOCABULARY.NO_KEY,
    surfaces: {
      row: 'Layers row: "KEY NEEDED" guidance state',
      panel: 'Fires panel: unkeyed guidance',
      globe: 'No detections rendered',
    },
    note: 'FIRMS MAP_KEY pending (free). Ships with the 503 no_key honest state.',
  },
  {
    layerId: 'flights',
    mode: DEGRADED_VOCABULARY.DEGRADED,
    surfaces: {
      row: 'Layers row: DEGRADED/PARTIAL chip via layerFeedState',
      panel: 'Flights panel: provider status line',
      globe: 'Gated states shown as gated ("Zoom in to load civil traffic"), never empty',
    },
    note: 'Zoom-gate honesty is the §L pattern: gated ≠ broken.',
  },
  {
    layerId: 'map-stack',
    mode: DEGRADED_VOCABULARY.DEGRADED,
    surfaces: {
      row: 'n/a (basemap, not a layer row)',
      panel: 'DISPLAY panel map-stack chips (Stage-2 F6) — persistent surface',
      globe: 'Terminal OSM fallback + one toast per distinct message per session',
    },
    note: 'All tile hosts dead → terminal fallback, never a silent white void.',
  },
]);

/** Layers known to the audit. */
export function auditedLayerIds() {
  return DEGRADED_AUDIT.map((e) => e.layerId);
}
