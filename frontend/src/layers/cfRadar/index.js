/**
 * J4-21 · Cloudflare Radar disruption signals.
 *
 * Ships the SIGNAL only: "Cloudflare Radar reports an internet disruption in
 * <region>". The cable/datacenter attribution join was REJECTED in evaluation
 * (speculative attribution on scrubbed geometry) and is not built anywhere
 * in this module.
 *
 * The adapter needs a server-side Cloudflare API token. Without it the
 * scheduler marks the source `needs_key` and the layer fails closed to an
 * honest KEY-NEEDED state — never an empty-but-on row.
 */
import {
  createWave3MarkerLayer,
  fetchBackendEvents,
  fetchSourceStatus,
} from '../wave3/markerLayer.js';

export const CF_RADAR_KEY_MESSAGE =
  'Cloudflare Radar token not configured (server-side). Disruption signals unavailable — not "no disruptions".';

export function createCloudflareRadarLayer({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ...rest
} = {}) {
  return createWave3MarkerLayer({
    id: 'cf-radar',
    name: 'Internet disruptions',
    icon: '⌁',
    source: 'Cloudflare Radar',
    ...rest,
    async fetchItems({ signal } = {}) {
      const status = await fetchSourceStatus({
        name: 'cloudflare_radar',
        fetchImpl,
        signal,
      });
      if (status === 'needs_key') {
        return { items: [], fetchedAt: Date.now(), keyRequired: true, keyMessage: CF_RADAR_KEY_MESSAGE };
      }
      const events = await fetchBackendEvents({
        sources: ['cloudflare_radar'],
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
          subSource: 'cloudflare_radar',
        })),
      };
    },
    refreshInterval: 30 * 60 * 1000,
    labelBudget: { B0: 0, B1: 6, B2: 12, B3: 15, B4: 15, B5: 15 },
    permanentInfo: 'Outage signals only — no cable/datacenter attribution',
  });
}
