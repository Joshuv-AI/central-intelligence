/**
 * J4-20 · GPS-jamming zone layer.
 *
 * Zones the pipeline already computes (adapter tier1/gps_jamming: ADS-B
 * NAC-P degradation aggregated into 1° cells) rendered as zone polygons.
 * The geometry is INFERRED from aircraft reports — "derived, not measured"
 * is baked into the layer meta, every card, and the row info (J.1(2)).
 */
import {
  createWave3MarkerLayer,
  fetchBackendEvents,
} from '../wave3/markerLayer.js';

export const DERIVED_NOT_MEASURED =
  'Derived, not measured — zones are inferred from aircraft position-accuracy reports, not direct detection.';

export function createGpsJammingLayer({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ...rest
} = {}) {
  return createWave3MarkerLayer({
    id: 'gps-jamming',
    name: 'GPS interference zones',
    icon: '◍',
    source: 'ADS-B NAC-P analysis · derived',
    ...rest,
    async fetchItems({ signal } = {}) {
      const events = await fetchBackendEvents({
        sources: ['gps_jamming'],
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
          subSource: 'gps_jamming',
        })),
      };
    },
    render: 'zones',
    refreshInterval: 15 * 60 * 1000,
    labelBudget: { B0: 0, B1: 8, B2: 12, B3: 15, B4: 15, B5: 15 },
    permanentInfo: DERIVED_NOT_MEASURED,
  });
}
