/**
 * J4-12 · Hazards family — ONE catalog row for the hazard sub-sources.
 *
 * Sub-sources (sub-toggle chips in the row; no separate catalog rows — the
 * "one family or nothing" rule):
 *  - GDACS disaster alerts (global, keyless)
 *  - GDELT disaster news (citation + link only — titles and URLs, never
 *    article bodies; items carry no coordinates so they are list-only, never
 *    plotted at a made-up point)
 *  - NWS CAP hazard alerts (US scope only — labeled as US-only everywhere)
 *
 * Related existing rows (earthquakes, FIRMS Active Fires, Fire Perimeters,
 * Hurricanes) keep their own rows from parity; the family info line names
 * them so the family reads as one.
 *
 * Data: the backend pipeline's /api/events (adapters gdacs, gdelt_disasters,
 * nws_cap already flow through the scheduler). Fail-closed: an unreachable
 * backend is an error row, never silent emptiness.
 */
import {
  createWave3MarkerLayer,
  fetchBackendEvents,
} from '../wave3/markerLayer.js';

const SUB_SOURCES = [
  {
    key: 'gdacs',
    label: 'GDACS',
    hint: 'GDACS disaster alerts (global)',
    legend: 'GDACS alerts',
  },
  {
    key: 'gdelt_disasters',
    label: 'GDELT NEWS',
    hint: 'GDELT disaster news — headlines + links only (no map position)',
    legend: 'GDELT headlines',
  },
  {
    key: 'nws_cap',
    label: 'NWS CAP · US ONLY',
    hint: 'NWS active hazard alerts — United States scope only',
    legend: 'NWS alerts (US)',
  },
];

const SEVERITY_LABEL = { critical: 'CRIT', high: 'HIGH', moderate: 'MOD', low: 'LOW' };

export function createHazardsLayer({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ...rest
} = {}) {
  return createWave3MarkerLayer({
    id: 'hazards',
    name: 'Hazards',
    icon: '▲',
    source: 'GDACS · GDELT · NWS (US)',
    ...rest,
    async fetchItems({ signal } = {}) {
      const events = await fetchBackendEvents({
        sources: SUB_SOURCES.map((s) => s.key),
        fetchImpl,
        signal,
      });
      return {
        fetchedAt: Date.now(),
        items: events.map((e) => ({
          id: e.id,
          lat: e.lat,
          lon: e.lon,
          title: e.title,
          sub: e.summary,
          severity: e.severity,
          url: e.url,
          subSource: e.source,
        })),
      };
    },
    refreshInterval: 15 * 60 * 1000,
    labelBudget: { B0: 0, B1: 6, B2: 12, B3: 20, B4: 25, B5: 25 },
    describeRowControls: (state, api) => {
      const chips = SUB_SOURCES.map((s) => ({
        id: `sub-${s.key}`,
        label: s.label,
        title: s.hint,
        active: api.subVisible({ subSource: s.key }),
        onClick: () => api.toggleSub(s.key),
      }));
      const legend = SUB_SOURCES.filter((s) =>
        api.subVisible({ subSource: s.key }),
      ).map((s) => ({ label: s.legend, color: '#ff9e40' }));
      return {
        chips,
        legend,
        info:
          'Family — related rows: Earthquakes · FIRMS Active Fires · Fire Perimeters · Hurricanes. ' +
          'NWS CAP is US scope only. GDELT items are headlines + links (no map position).',
        list: null, // the factory's default event list applies
      };
    },
    permanentInfo: 'Hazards family',
  });
}

/** Pure helper: human severity tag for the row list. */
export function severityTag(severity) {
  return SEVERITY_LABEL[severity] || '';
}

export { SUB_SOURCES };
