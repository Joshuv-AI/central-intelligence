// Central Intelligence — /proxy/* live-layer forwarder (Phase 2).
//
// Forwards keyless real-time feeds that browsers can't reach directly
// (no CORS on the upstream), with a short in-memory cache so a burst of
// clients doesn't hammer the upstream. It is NOT part of the intel sweep —
// those sources are polled server-side; these are proxied on demand.
//
// Upstream: api.adsb.lol (ODbL 1.0 — attribution shown in the Layers panel).
const express = require('express');

const UPSTREAM = 'https://api.adsb.lol';
const CACHE_MS = 15 * 1000;
const FETCH_TIMEOUT_MS = 12 * 1000;

// key -> { at, status, body, contentType }
const cache = new Map();

async function fetchUpstream(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(UPSTREAM + path, {
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

function cachedProxy(path) {
  return async (req, res) => {
    const key = path;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) {
      res.status(hit.status).type(hit.contentType).send(hit.body);
      return;
    }
    try {
      const up = await fetchUpstream(path);
      if (up.status === 200) cache.set(key, { at: now, ...up });
      res.status(up.status).type(up.contentType).send(up.body);
    } catch (err) {
      // Serve stale on upstream failure so the globe degrades gracefully.
      if (hit) {
        res.status(hit.status).type(hit.contentType).send(hit.body);
        return;
      }
      res.status(502).json({ error: 'upstream_unavailable', detail: String(err && err.message || err) });
    }
  };
}

function proxyRoutes() {
  const router = express.Router();

  // Military aircraft snapshot.
  router.get('/adsblol/mil', cachedProxy('/v2/mil'));

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
    return cachedProxy(`/v2/lat/${lat}/lon/${lon}/dist/${dist}`)(req, res);
  });

  router.use((req, res) => {
    res.status(404).json({ error: 'proxy_not_found', path: req.originalUrl });
  });
  return router;
}

module.exports = { proxyRoutes };
