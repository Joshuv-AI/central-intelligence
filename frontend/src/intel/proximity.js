/* Wave 2 (J4-13) — proximity awareness for INTEL events.
   "Nearest flights / vessels / bases / cameras to this event", computed
   from data the system already holds or can ask its own backend for:

   - flights:  GET /api/flights?lat&lon&dist=250 (keyless ADS-B upstream)
   - vessels:  GET /api/vessels (AIS hub; status 'no_key' when the key is
     pending — an honest unkeyed state, never an empty list)
   - cameras:  GET /api/cameras?bbox=&limit= (Windy; 503 when the key is
     pending, 502 when the upstream fails)
   - bases:    POST /api/overpass {template:'installations', bbox} (the same
     OSM-sourced mapped features the installations layer renders)

   All distance math is client-side haversine. Fetches happen only when an
   event card is opened (user-initiated), capped per class (≤8 desktop,
   ≤5 mobile per the §L row).

   The honesty predicate generalizes with the feature: "no cameras near here
   right now" must never read as "nothing is happening there". The empty
   state says exactly that, for every class. */

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Coarse, honest distance label. */
export function formatDistance(km) {
  if (!Number.isFinite(km) || km < 0) return '—';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

/**
 * Nearest-N of anything with lat/lon. Pure.
 * @returns {Array<{item, km}>} sorted nearest-first
 */
export function nearestN(items, lat, lon, n, pick) {
  const get = pick || ((x) => x);
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const p = get(raw);
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    out.push({ item: raw, km: haversineKm(lat, lon, p.lat, p.lon) });
  }
  out.sort((a, b) => a.km - b.km);
  return out.slice(0, Math.max(0, n));
}

/**
 * The generalized honesty predicate. Absence of data is never presented
 * as absence of activity.
 */
export function emptyStateText(label) {
  return `No ${label} near here right now — that is not evidence nothing is happening.`;
}

export const UNAVAILABLE_TEXT = {
  flights: 'Flight data unavailable right now — the feed did not answer.',
  vessels_key: 'Vessel data unavailable (key pending) — live ship tracking needs a key on the server.',
  vessels: 'Vessel data unavailable right now.',
  cameras_key: 'Camera data unavailable (key pending) — public cameras need a key on the server.',
  cameras: 'Camera data unavailable right now — the webcam feed did not answer.',
  bases: 'Base data unavailable right now — the map lookup did not answer.',
};

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body };
}

/** Flights near a point: /api/flights?lat&lon&dist (dist ≤ 250, keyless). */
export async function nearbyFlights(lat, lon, limit = 8) {
  try {
    const { status, body } = await fetchJson(
      `/api/flights?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&dist=250`,
    );
    if (status !== 200 || !body || !Array.isArray(body.aircraft)) return { ok: false, unavailable: UNAVAILABLE_TEXT.flights };
    return {
      ok: true,
      items: nearestN(body.aircraft, lat, lon, limit).map(({ item, km }) => ({
        name: item.callsign || item.registration || `ICAO ${item.icao24 || 'unknown'}`,
        km,
        detail: [
          item.altitudeFt != null ? `${Math.round(item.altitudeFt).toLocaleString('en-US')} ft` : null,
          item.groundSpeedKt != null ? `${Math.round(item.groundSpeedKt)} kt` : null,
          item.military ? 'military' : null,
        ].filter(Boolean).join(' · ') || null,
      })),
    };
  } catch {
    return { ok: false, unavailable: UNAVAILABLE_TEXT.flights };
  }
}

/** Vessels near a point: /api/vessels (AIS hub snapshot). */
export async function nearbyVessels(lat, lon, limit = 8) {
  try {
    const { status, body } = await fetchJson('/api/vessels');
    if (status !== 200 || !body) return { ok: false, unavailable: UNAVAILABLE_TEXT.vessels };
    if (body.status === 'no_key' || body.status === 'idle')
      return { ok: false, unavailable: UNAVAILABLE_TEXT.vessels_key };
    const vessels = Array.isArray(body.vessels) ? body.vessels : [];
    return {
      ok: true,
      items: nearestN(vessels, lat, lon, limit).map(({ item, km }) => ({
        name: item.name || `MMSI ${item.mmsi || 'unknown'}`,
        km,
        detail: item.mmsi ? `MMSI ${item.mmsi}` : null,
      })),
    };
  } catch {
    return { ok: false, unavailable: UNAVAILABLE_TEXT.vessels };
  }
}

/** Public cameras near a point: /api/cameras?bbox (Windy, keyed). */
export async function nearbyCameras(lat, lon, limit = 8) {
  const d = 1.5;
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  try {
    const { status, body } = await fetchJson(
      `/api/cameras?bbox=${encodeURIComponent(bbox)}&limit=${limit}`,
    );
    if (status === 503) return { ok: false, unavailable: UNAVAILABLE_TEXT.cameras_key };
    if (status !== 200 || !body || !Array.isArray(body.cameras))
      return { ok: false, unavailable: UNAVAILABLE_TEXT.cameras };
    return {
      ok: true,
      items: nearestN(body.cameras, lat, lon, limit).map(({ item, km }) => ({
        name: item.title || 'Unnamed camera',
        km,
        detail: [item.city, item.country].filter(Boolean).join(', ') || null,
      })),
    };
  } catch {
    return { ok: false, unavailable: UNAVAILABLE_TEXT.cameras };
  }
}

function overpassPoint(el) {
  if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon))
    return { lat: el.lat, lon: el.lon };
  const geom = Array.isArray(el.geometry) ? el.geometry : [];
  const pts = geom.filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon));
  if (!pts.length) return null;
  return {
    lat: pts.reduce((a, g) => a + g.lat, 0) / pts.length,
    lon: pts.reduce((a, g) => a + g.lon, 0) / pts.length,
  };
}

function baseLabel(el) {
  const tags = el.tags || {};
  if (typeof tags.name === 'string' && tags.name.trim()) return tags.name.trim();
  const klass = tags.military || tags.landuse;
  if (klass === 'airfield') return 'Military airfield (unnamed)';
  if (klass === 'naval_base') return 'Naval base (unnamed)';
  if (klass === 'range') return 'Firing range (unnamed)';
  return 'Military land (unnamed)';
}

/** Mapped military installations near a point: /api/overpass installations template. */
export async function nearbyBases(lat, lon, limit = 8) {
  const d = 1.0; // ±1° ≈ 111 km: enough for "nearby", cheap for Overpass
  try {
    const { status, body } = await fetchJson('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: 'installations',
        bbox: { s: lat - d, w: lon - d, n: lat + d, e: lon + d },
      }),
    });
    if (status !== 200 || !body || !Array.isArray(body.elements))
      return { ok: false, unavailable: UNAVAILABLE_TEXT.bases };
    const points = [];
    for (const el of body.elements) {
      const p = overpassPoint(el);
      if (p) points.push({ el, ...p });
    }
    return {
      ok: true,
      items: nearestN(points, lat, lon, limit).map(({ item, km }) => ({
        name: baseLabel(item.el),
        km,
        detail: 'mapped feature — not an assertion of capability or status',
      })),
    };
  } catch {
    return { ok: false, unavailable: UNAVAILABLE_TEXT.bases };
  }
}

/** All four classes in parallel, for the event card "Nearby" section.
 * Each provider races a client-side timeout: a hung upstream (dead egress
 * can take 12 s+ to fail) must not hold the section on "Checking…" forever.
 * A timed-out class renders its honest "unavailable right now" state. */
export async function nearbyAll(lat, lon, limit = 8, timeoutMs = 8000) {
  const [flights, vessels, bases, cameras] = await Promise.all([
    withTimeout(nearbyFlights(lat, lon, limit), timeoutMs, { ok: false, unavailable: UNAVAILABLE_TEXT.flights }),
    withTimeout(nearbyVessels(lat, lon, limit), timeoutMs, { ok: false, unavailable: UNAVAILABLE_TEXT.vessels }),
    withTimeout(nearbyBases(lat, lon, limit), timeoutMs, { ok: false, unavailable: UNAVAILABLE_TEXT.bases }),
    withTimeout(nearbyCameras(lat, lon, limit), timeoutMs, { ok: false, unavailable: UNAVAILABLE_TEXT.cameras }),
  ]);
  return { flights, vessels, bases, cameras };
}

/**
 * Race a provider against a timeout. Rejections become the fallback (no
 * unhandled rejections — a late failure after the timeout must never
 * surface as a console error).
 */
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  const guarded = promise.then(
    (v) => { clearTimeout(timer); return v; },
    () => { clearTimeout(timer); return fallback; },
  );
  return Promise.race([guarded, timeout]);
}

export const NEARBY_CLASSES = [
  { id: 'flights', label: 'flights' },
  { id: 'vessels', label: 'vessels' },
  { id: 'bases', label: 'bases' },
  { id: 'cameras', label: 'cameras' },
];
