/**
 * Geocoding helpers for place search: cache, Photon URL builder, best-hit
 * selection, and the searchPlace provider contract.
 * Ported/improved from God's Eye View (MIT) workflows; written fresh for CI.
 *
 * NOT a rewrite of ui/search.js — search.js adopts these with a few lines:
 *   1. Call searchPlace() instead of the inline fetch in searchPlaces().
 *   2. answered === false → render "PLACE SEARCH OFFLINE" (not an empty list).
 *   3. Use framingForType(hit.type) for the fly-to height.
 * Coordinate queries (e.g. "40.7, -74.0") resolve with zero requests via
 * ui/coordinateParser.js — try that first inside searchPlace().
 */

const PHOTON_URL = 'https://photon.komoot.io/api/';

/**
 * Tiny outcome cache: answered hits cached 5min, answered misses 30s,
 * network failures NEVER cached (retry immediately next query).
 * Evicts oldest past maxEntries.
 *
 * @param {object} [options]
 * @returns {{ get(query), set(query, outcome) }}
 */
export function createGeocodeCache({ maxEntries = 64, hitTtlMs = 300000, missTtlMs = 30000 } = {}) {
  const entries = new Map(); // query → { at, outcome }
  return {
    get(query) {
      const key = String(query || '').toLowerCase().trim();
      const entry = entries.get(key);
      if (!entry) return null;
      const ttl = entry.outcome?.answered ? hitTtlMs : missTtlMs;
      if (Date.now() - entry.at > ttl) {
        entries.delete(key);
        return null;
      }
      // Refresh LRU order on hit.
      entries.delete(key);
      entries.set(key, entry);
      return entry.outcome;
    },
    set(query, outcome) {
      const key = String(query || '').toLowerCase().trim();
      if (!key) return;
      entries.delete(key);
      entries.set(key, { at: Date.now(), outcome });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },
  };
}

/**
 * Build a Photon URL. `lat`/`lon` are a SOFT proximity hint — Photon biases
 * results toward them, not a hard bbox. Never add bbox params here.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.lat]
 * @param {number} [opts.lon]
 * @param {number} [opts.limit=5]
 * @returns {string}
 */
export function photonSearchUrl(query, { lat, lon, limit = 5 } = {}) {
  const params = new URLSearchParams({ q: String(query).trim(), limit: String(limit) });
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', String(lat));
    params.set('lon', String(lon));
  }
  return `${PHOTON_URL}?${params.toString()}`;
}

/** Accent-insensitive lowercase normalization for name comparison. */
function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Pick the best Photon hit: prefer hits whose normalized name LEADS with the
 * normalized query (leads-with-match); ties keep Photon order.
 *
 * @param {Array} hits - Photon feature array.
 * @param {string} query
 * @returns {object|null} The winning feature, or null.
 */
export function selectBestHit(hits, query) {
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return null;
  const q = normalizeName(query).trim();
  if (!q) return list[0];
  const scored = list.map((hit, i) => {
    const props = hit.properties || {};
    const name = normalizeName(
      props.name || props.street || props.locality || '',
    );
    return { hit, i, leads: name.startsWith(q) ? 0 : 1 };
  });
  scored.sort((a, b) => a.leads - b.leads || a.i - b.i);
  return scored[0].hit;
}

/**
 * Map a Photon/OSM result type to a camera framing.
 * Heights: country ~12Mm (whole-country view), locality/region ~2.5Mm,
 * precise POI ~400km.
 *
 * NOTE: Photon's `extent` property (when present) is [west, north, east,
 * south] — NOT the usual [minLon, minLat, maxLon, maxLat]. Read index 1 as
 * the north edge and index 3 as the south edge.
 *
 * @param {string} type - Photon properties.osm_value or properties.type.
 * @returns {{ height: number, kind: string }}
 */
export function framingForType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'country' || t === 'administrative') {
    return { height: 12_000_000, kind: 'country' };
  }
  if (
    t === 'state' ||
    t === 'county' ||
    t === 'locality' ||
    t === 'region' ||
    t === 'district' ||
    t === 'city' ||
    t === 'town' ||
    t === 'village' ||
    t === 'suburb'
  ) {
    return { height: 2_500_000, kind: 'locality' };
  }
  return { height: 400_000, kind: 'poi' };
}

/** Read the OSM type off a Photon feature. */
export function photonResultType(result) {
  const props = result?.properties || {};
  return String(props.osm_value || props.type || '');
}

/**
 * Provider contract for place search. Tries the coordinate parser first
 * (zero requests), then cache, then Photon.
 *
 * @param {string} query - Raw search text.
 * @param {object} [deps]
 * @param {Function} [deps.coordinateParser] - ui/coordinateParser parseCoordinateQuery.
 * @param {object} [deps.cache] - createGeocodeCache() instance.
 * @param {Function} [deps.photonFetch] - fetch-compatible fn, defaults to global fetch.
 * @param {object} [deps.viewport] - { lat, lon } soft proximity hint.
 * @returns {Promise<{ place, answered }>} place: { label, lat, lon, type } or null;
 *   answered false means the provider chain failed → render "PLACE SEARCH OFFLINE".
 */
export async function searchPlace(
  query,
  { coordinateParser, cache, photonFetch, viewport } = {},
) {
  const q = String(query || '').trim();

  // Zero-request path: strict coordinate queries never hit the network.
  if (coordinateParser && typeof coordinateParser === 'function') {
    const parsed = coordinateParser(q);
    if (parsed) {
      return {
        place: {
          label: parsed.label,
          lat: parsed.lat,
          lon: parsed.lon,
          type: 'coordinates',
        },
        answered: true,
      };
    }
  }

  if (q.length < 3) return { place: null, answered: true };

  const cached = cache?.get(q);
  if (cached) return cached;

  let fetchFn = photonFetch;
  if (!fetchFn && typeof fetch === 'function') fetchFn = fetch.bind(globalThis);
  if (!fetchFn) return { place: null, answered: false };

  try {
    const url = photonSearchUrl(q, {
      lat: viewport?.lat,
      lon: viewport?.lon,
    });
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`photon ${res.status}`);
    const geo = await res.json();
    const features = geo.features || [];
    const best = selectBestHit(features, q);
    const outcome = best
      ? {
          place: {
            label: [
              best.properties?.name || best.properties?.street,
              best.properties?.city,
              best.properties?.state,
              best.properties?.country,
            ]
              .filter(Boolean)
              .join(', '),
            lat: best.geometry?.coordinates?.[1],
            lon: best.geometry?.coordinates?.[0],
            type: photonResultType(best),
          },
          answered: true,
        }
      : { place: null, answered: true };
    cache?.set(q, outcome);
    return outcome;
  } catch {
    // Network failure: NEVER cached — the next query retries immediately.
    return { place: null, answered: false };
  }
}
