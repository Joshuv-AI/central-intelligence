/* Radio Browser data source — ported from bilawalsidhu/gods-eye-view (MIT),
   src/layers/radio/source.js (createRadioSource: directory queries, UUID
   validation, click counting).

   DATA SOURCE — Radio Browser (https://www.radio-browser.info),
   a free, community-run internet radio directory. Attribute "Radio Browser
   (radio-browser.info)" wherever stations are displayed.

   Endpoints used (base https://de1.api.radio-browser.info):
     GET /json/stations/search?{name,tag,country,order,reverse,limit,offset,
         hidebroken,geo_lat,geo_long,geo_distance}
       station directory search; geo_distance is in METERS.
     GET /json/stations/byuuid/{uuid}
       single station by stationuuid.
     GET /json/url/{uuid}
       Radio Browser's documented click-tracking call: returns the resolved
       stream URL and increments the station's click counter.

   Radio Browser terms of use (https://api.radio-browser.info/):
   - Do not hardcode one mirror: prefer the all.api.radio-browser.info DNS
     round-robin for production instead of de1.
   - Send a descriptive User-Agent naming the app (contact on misbehavior).
     NOTE: browser fetch() cannot override the User-Agent header — direct
     browser calls send the browser's own UA. For compliant traffic (custom
     UA + 5-15 min caching + ~1 req/sec), route these calls through a CI
     backend proxy instead of hitting Radio Browser from the client.
   - Cache results, keep request rate low. This module fans out one request
     per search tag (see CATEGORY_SEARCH_TAGS); keep tag lists short.

   Real data only: every station object returned here comes from a live
   Radio Browser response. Nothing is fabricated or hardcoded.
*/
import {
  RADIO_PREFIX,
  RADIO_UUID_RE,
  CATEGORY_SEARCH_TAGS,
  isRadioCategory,
} from './policy.js';

const RADIO_BROWSER_BASE = 'https://de1.api.radio-browser.info';

/** Strip the 'radio:' prefix; pass a validated stationuuid through. */
function bareUuid(id) {
  const raw = String(id || '');
  return raw.startsWith(RADIO_PREFIX) ? raw.slice(RADIO_PREFIX.length) : raw;
}

/**
 * Normalize one Radio Browser row into CI's station shape.
 * geo_lat/geo_long (numbers, may be 0/null when unknown) become lat/lon.
 * url_resolved is preferred over url (it is the working stream URL).
 */
function normalizeStation(row) {
  if (!row || typeof row !== 'object') return null;
  const uuid = String(row.stationuuid || '').trim();
  if (!uuid) return null;
  const streamUrl = String(row.url_resolved || row.url || '').trim();
  const lat = Number(row.geo_lat);
  const lon = Number(row.geo_long);
  return {
    id: RADIO_PREFIX + uuid,
    uuid,
    name: String(row.name || 'Unknown station').trim() || 'Unknown station',
    streamUrl,
    homepage: String(row.homepage || '').trim(),
    tags: String(row.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    country: String(row.country || '').trim(),
    countryCode: String(row.countrycode || '').trim().toUpperCase(),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    bitrate: Number(row.bitrate) || 0,
    codec: String(row.codec || '').trim().toUpperCase(),
    clicks: Number(row.clickcount) || 0,
  };
}

/**
 * Directory broker for Radio Browser. No DOM, no audio — pure-ish data layer.
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] injectable fetch (defaults to global fetch)
 */
export function createRadioSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function getJson(path, { signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(RADIO_BROWSER_BASE + path, { signal });
    if (!response.ok)
      throw new Error(`Radio Browser returned ${response.status}`);
    const body = await response.json();
    signal?.throwIfAborted();
    return body;
  }

  /**
   * Search the directory. One request per tag (Radio Browser's tag param is
   * singular); results merge and dedupe by uuid.
   * @param {object} [opts]
   * @param {string} [opts.query] name search
   * @param {string} [opts.category] one of the 4 intel categories (policy.js)
   * @param {string|string[]} [opts.tag] explicit Radio Browser tag(s)
   * @param {string} [opts.country] country name filter
   * @param {number} [opts.lat] geo anchor latitude
   * @param {number} [opts.lon] geo anchor longitude
   * @param {number} [opts.radiusKm] geo search radius, kilometers
   * @param {number} [opts.limit] per-tag page size (default 200)
   * @param {boolean} [opts.hidebroken] default true
   * @returns {Promise<object[]>} normalized stations
   */
  async function searchStations({
    query = '',
    category = null,
    tag = null,
    country = '',
    lat = null,
    lon = null,
    radiusKm = null,
    limit = 200,
    hidebroken = true,
    signal,
  } = {}) {
    let tags = [];
    if (tag) tags = Array.isArray(tag) ? tag : [tag];
    else if (category) {
      if (!isRadioCategory(category))
        throw new Error(`Unknown radio category: ${category}`);
      tags = CATEGORY_SEARCH_TAGS[category];
    }
    if (!tags.length) tags = [''];
    const seen = new Set();
    const out = [];
    for (const t of tags) {
      const params = new URLSearchParams();
      if (query) params.set('name', query);
      if (t) params.set('tag', t);
      if (country) params.set('country', country);
      const geoLat = Number(lat);
      const geoLon = Number(lon);
      const radiusM = Number(radiusKm) * 1000;
      if (Number.isFinite(geoLat) && Number.isFinite(geoLon) && radiusM > 0) {
        params.set('geo_lat', String(geoLat));
        params.set('geo_long', String(geoLon));
        params.set('geo_distance', String(Math.round(radiusM)));
      }
      params.set('order', 'clickcount');
      params.set('reverse', 'true');
      params.set('hidebroken', hidebroken ? 'true' : 'false');
      params.set('limit', String(Math.max(1, Math.min(500, limit | 0 || 200))));
      const rows = await getJson(`/json/stations/search?${params}`, { signal });
      for (const row of Array.isArray(rows) ? rows : []) {
        const station = normalizeStation(row);
        if (station && !seen.has(station.uuid)) {
          seen.add(station.uuid);
          out.push(station);
        }
      }
    }
    return out;
  }

  /**
   * Fetch one station by uuid (accepts 'radio:<uuid>' or the bare uuid).
   * @returns {Promise<object|null>} normalized station or null when missing
   */
  async function getStationByUuid(uuid, { signal } = {}) {
    const bare = bareUuid(uuid);
    if (!RADIO_UUID_RE.test(bare)) throw new Error('Invalid radio station id');
    const rows = await getJson(
      `/json/stations/byuuid/${encodeURIComponent(bare)}`,
      { signal },
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? normalizeStation(row) : null;
  }

  /**
   * Register a playback with Radio Browser's click counter. GET /json/url
   * increments clickcount server-side; the response URL is ignored here
   * (the audio element already streams url_resolved). Fire and forget —
   * failures must never break playback.
   */
  async function recordClick(uuid, { signal } = {}) {
    const bare = bareUuid(uuid);
    if (!RADIO_UUID_RE.test(bare)) throw new Error('Invalid radio station id');
    signal?.throwIfAborted();
    const response = await fetchImpl(
      `${RADIO_BROWSER_BASE}/json/url/${encodeURIComponent(bare)}`,
      { signal },
    );
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`Radio click returned ${response.status}`);
    // Drain the body so the counter request completes cleanly.
    try { await response.json(); } catch { /* counter still incremented */ }
  }

  return { searchStations, getStationByUuid, recordClick, normalizeStation };
}
