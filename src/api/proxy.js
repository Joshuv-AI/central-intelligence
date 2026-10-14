// Central Intelligence — /proxy/* live-layer forwarder (Phase 2).
//
// Forwards keyless real-time feeds that browsers can't reach directly
// (no CORS on the upstream), with a short in-memory cache so a burst of
// clients doesn't hammer the upstream. It is NOT part of the intel sweep —
// those sources are polled server-side; these are proxied on demand.
//
// Upstream: api.adsb.lol (ODbL 1.0 — attribution shown in the Layers panel).
const express = require('express');

const ADSB_UPSTREAM = 'https://api.adsb.lol';
const NHC_UPSTREAM = 'https://www.nhc.noaa.gov';
const CACHE_MS = 15 * 1000;
const NHC_CACHE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12 * 1000;

// key -> { at, status, body, contentType }
const cache = new Map();

async function fetchUpstream(base, path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'central-intelligence/1.0 (live-layer proxy)' },
    });
    const body = await res.text();
    return {
      status: res.status,
      body,
      contentType: res.headers.get('content-type') || 'application/json',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ARCH §4.6 touch 3 (additive): staleness headers on every proxied
// response — X-Data-Age (seconds since the cached copy was fetched) and
// X-Data-Stale (true when the served copy is past its TTL or was served
// after an upstream failure). No body/shape change.
function setDataHeaders(res, at, stale, now = Date.now()) {
  res.set('X-Data-Age', String(Math.max(0, Math.floor((now - at) / 1000))));
  res.set('X-Data-Stale', stale ? 'true' : 'false');
}

function cachedProxy(base, path, cacheMs = CACHE_MS) {
  return async (req, res) => {
    const key = base + path;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < cacheMs) {
      setDataHeaders(res, hit.at, false, now);
      res.status(hit.status).type(hit.contentType).send(hit.body);
      return;
    }
    try {
      const up = await fetchUpstream(base, path);
      if (up.status === 200) cache.set(key, { at: now, ...up });
      setDataHeaders(res, now, false, now);
      res.status(up.status).type(up.contentType).send(up.body);
    } catch (err) {
      // Serve stale on upstream failure so the globe degrades gracefully.
      if (hit) {
        setDataHeaders(res, hit.at, true);
        res.status(hit.status).type(hit.contentType).send(hit.body);
        return;
      }
      res.status(502).json({ error: 'upstream_unavailable', detail: String(err && err.message || err) });
    }
  };
}

// ARCH §4.6 touch 3: ONE cached NHC fetch shared by /proxy/nhc/storms
// (raw shape, via cachedProxy above — same cache map + key) and
// /api/cyclones (normalized shape, via src/api/gev.js).
// Returns { data, fetchedAt, stale, ttlMs }; throws when upstream fails
// and nothing is cached.
async function getNhcStorms() {
  const key = NHC_UPSTREAM + '/CurrentStorms.json';
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < NHC_CACHE_MS) {
    return { data: JSON.parse(hit.body), fetchedAt: hit.at, stale: false, ttlMs: NHC_CACHE_MS };
  }
  try {
    const up = await fetchUpstream(NHC_UPSTREAM, '/CurrentStorms.json');
    if (up.status !== 200) throw new Error(`nhc http ${up.status}`);
    cache.set(key, { at: now, ...up });
    return { data: JSON.parse(up.body), fetchedAt: now, stale: false, ttlMs: NHC_CACHE_MS };
  } catch (err) {
    if (hit) return { data: JSON.parse(hit.body), fetchedAt: hit.at, stale: true, ttlMs: NHC_CACHE_MS };
    throw err;
  }
}

function proxyRoutes() {
  const router = express.Router();

  // Military aircraft snapshot.
  router.get('/adsblol/mil', cachedProxy(ADSB_UPSTREAM, '/v2/mil'));

  // Civil aircraft near a point: ?lat=..&lon=..&dist=.. (dist in NM, default 250).
  router.get('/adsblol/near', (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    let dist = Number(req.query.dist);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      res.status(400).json({ error: 'bad_request', message: 'lat and lon query params required' });
      return;
    }
    if (!Number.isFinite(dist) || dist <= 0) dist = 250;
    dist = Math.min(dist, 250);
    return cachedProxy(ADSB_UPSTREAM, `/v2/lat/${lat}/lon/${lon}/dist/${dist}`)(req, res);
  });

  // NHC active tropical cyclones (CurrentStorms.json has no CORS at source).
  router.get('/nhc/storms', cachedProxy(NHC_UPSTREAM, '/CurrentStorms.json', NHC_CACHE_MS));

  router.use((req, res) => {
    res.status(404).json({ error: 'proxy_not_found', path: req.originalUrl });
  });
  return router;
}

module.exports = { proxyRoutes, getNhcStorms };
