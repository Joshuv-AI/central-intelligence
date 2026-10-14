/**
 * J4-23 · Maritime chokepoints — named strategic waterways as a
 * named-places layer.
 *
 * Data: the J4-30 PD pack `local_data/maritime_chokepoints.json` (12 named
 * waterways, curated coordinates — facts, public domain). Static: no fetch,
 * no upstream to fail. Selecting a place flies the camera there; the row
 * list carries all twelve.
 *
 * Live vessel context around each place is NOT drawn here: AIS is key-pending
 * and drawing traffic without it would be fabrication. The row info says so.
 * (Carrier-group position markers were REJECTED in evaluation — journalistic
 * approximations on a precision globe are false precision — and are not
 * built anywhere in this module.)
 */
import { loadBundledJson } from '../../data/bundledJson.js';
import { createWave3MarkerLayer } from '../wave3/markerLayer.js';

const PACK_URL = new URL(
  '../../data/local_data/maritime_chokepoints.json',
  import.meta.url,
);

let packPromise = null;
function loadPack({ signal } = {}) {
  if (!packPromise) {
    packPromise = loadBundledJson(PACK_URL, { signal }).then((pack) => {
      const rows = Array.isArray(pack?.chokepoints) ? pack.chokepoints : [];
      return rows.filter(
        (r) =>
          r &&
          typeof r.id === 'string' &&
          typeof r.name === 'string' &&
          Number.isFinite(r.lat) &&
          Number.isFinite(r.lon) &&
          Math.abs(r.lat) <= 90 &&
          Math.abs(r.lon) <= 180,
      );
    });
    // A failed load retries on the next lookup rather than caching the failure.
    packPromise.catch(() => {
      packPromise = null;
    });
  }
  return packPromise;
}

export function createChokepointsLayer(layerOptions = {}) {
  return createWave3MarkerLayer({
    id: 'chokepoints',
    name: 'Maritime chokepoints',
    icon: '⚓',
    source: 'Curated named waterways (PD)',
    ...layerOptions,
    async fetchItems({ signal } = {}) {
      const rows = await loadPack({ signal });
      if (rows.length === 0) throw new Error('Chokepoints pack empty');
      return {
        fetchedAt: Date.now(),
        items: rows.map((r) => ({
          id: r.id,
          lat: r.lat,
          lon: r.lon,
          title: r.name,
          sub: r.context || '',
          severity: 'moderate',
          subSource: 'chokepoints',
        })),
      };
    },
    // Static pack — no periodic refresh.
    refreshInterval: 0,
    labelBudget: { B0: 0, B1: 6, B2: 12, B3: 12, B4: 12, B5: 12 },
    describeRowControls: () => ({
      info:
        'Named strategic waterways (public-domain pack). Live vessel traffic ' +
        'is unavailable (AIS key pending) — the places and their context show ' +
        'without it; nothing here is simulated.',
    }),
    permanentInfo: 'Named waterways — coordinates approximate (~0.5°)',
  });
}

export { loadPack as loadChokepointsPack };
