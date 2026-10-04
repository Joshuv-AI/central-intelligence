// Central Intelligence — public webcams layer (Windy Webcams API v3).
//
// GET /api/cameras?bbox=minLon,minLat,maxLon,maxLat&limit=N
//
// Windy free-tier image URLs are tokenized and expire ~10 minutes after
// minting, so the in-memory cache TTL (5 min) is deliberately shorter.
//
// Env: WINDY_API_KEY (server-only, like AISSTREAM_KEY). Without it the
// route answers 503 cameras_unavailable instead of proxying.
const express = require('express');

const WINDY_BASE = 'https://api.windy.com/webcams/api/v3';
const WINDY_PAGE_SIZE = 50; // free tier refuses limit > 50
const WINDY_OFFSET_MAX = 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;
const CACHE_MS = 5 * 60 * 1000; // must stay under the ~10 min token expiry

// key -> { at, payload }
const cache = new Map();

function windyApiKey() {
  return (process.env.WINDY_API_KEY || '').trim();
}

// Our bbox order (minLon,minLat,maxLon,maxLat) -> Windy's north,east,south,west.
function toWindyBbox(minLon, minLat, maxLon, maxLat) {
  return {
    north: maxLat,
    east: maxLon,
    south: minLat,
    west: minLon,
  };
}

function shapeCamera(w) {
  const loc = w.location || {};
  // Check the raw values first: Number(null) === 0 would slip past a
  // finite check on the converted value.
  const rawLat = loc.latitude;
  const rawLon = loc.longitude;
  if (rawLat === null || rawLat === undefined || rawLat === '' ||
      rawLon === null || rawLon === undefined || rawLon === '') return null;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const images = w.images || {};
  const current = images.current || {};
  const player = w.player || {};
  const urls = w.urls || {};
  return {
    id: w.webcamId,
    title: w.title,
    lat,
    lon,
    city: loc.city || null,
    country: loc.country || null,
    status: w.status || null,
    thumbnailUrl: current.preview || current.url || null,
    playerEmbedUrl: player.live || player.day || null,
    windyUrl: urls.detail || null,
  };
}

function cacheKey(minLon, minLat, maxLon, maxLat, limit) {
  const r = (n) => Number(n).toFixed(2);
  return `${r(minLon)},${r(minLat)},${r(maxLon)},${r(maxLat)}|${limit}`;
}

async function fetchWindyPage(params) {
  const url = new URL(WINDY_BASE + '/webcams');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'x-windy-api-key': windyApiKey(),
        'User-Agent': 'central-intelligence/1.0 (cameras layer)',
        Accept: 'application/json',
      },
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`windy http ${res.status}: ${body.slice(0, 200)}`);
    }
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
}

function registerCamerasRoutes(router) {
  router.get('/cameras', async (req, res) => {
    // --- bbox validation ---
    const parts = String(req.query.bbox || '').split(',');
    const [minLon, minLat, maxLon, maxLat] = parts.map(Number);
    const validNumbers = parts.length === 4 &&
      [minLon, minLat, maxLon, maxLat].every(Number.isFinite);
    const validRanges = validNumbers &&
      Math.abs(minLon) <= 180 && Math.abs(maxLon) <= 180 &&
      Math.abs(minLat) <= 90 && Math.abs(maxLat) <= 90 &&
      minLon <= maxLon && minLat <= maxLat;
    if (!validRanges) {
      res.status(400).json({
        error: 'invalid_bbox',
        message: 'bbox=minLon,minLat,maxLon,maxLat with four valid numbers is required',
      });
      return;
    }

    // --- limit: default 50, clamp 1..300 ---
    let limit = Number(req.query.limit);
    if (!Number.isFinite(limit)) limit = 50;
    limit = Math.max(1, Math.min(300, Math.floor(limit)));

    // --- key gate ---
    if (!windyApiKey()) {
      res.status(503).json({
        error: 'cameras_unavailable',
        message: 'WINDY_API_KEY is not set on the server. Add it to the server environment (same flow as AISSTREAM_KEY) to enable the cameras layer.',
      });
      return;
    }

    // --- cache ---
    const key = cacheKey(minLon, minLat, maxLon, maxLat, limit);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) {
      res.json({ ...hit.payload, cached: true });
      return;
    }

    // --- fetch from Windy (sequential pages of 50) ---
    const wb = toWindyBbox(minLon, minLat, maxLon, maxLat);
    const bboxParam = `${wb.north},${wb.east},${wb.south},${wb.west}`;
    const baseParams = {
      bbox: bboxParam,
      limit: WINDY_PAGE_SIZE,
      include: 'location,images,player,urls',
      sort_key: 'popularity',
      sort_direction: 'desc',
      lang: 'en',
    };
    try {
      const cameras = [];
      let total = 0;
      const pages = Math.min(Math.ceil(limit / WINDY_PAGE_SIZE), 20);
      for (let page = 0; page < pages; page++) {
        const offset = page * WINDY_PAGE_SIZE;
        if (offset > WINDY_OFFSET_MAX) break;
        const data = await fetchWindyPage({ ...baseParams, offset });
        const webcams = Array.isArray(data.webcams) ? data.webcams : [];
        if (page === 0) total = Number.isFinite(Number(data.total)) ? Number(data.total) : webcams.length;
        for (const w of webcams) {
          if (w.status !== 'active') continue;
          const cam = shapeCamera(w);
          if (!cam) continue;
          cameras.push(cam);
          if (cameras.length >= limit) break;
        }
        if (cameras.length >= limit) break;
        if (webcams.length < WINDY_PAGE_SIZE) break; // last page
      }
      const payload = { cameras, total, cached: false };
      cache.set(key, { at: Date.now(), payload });
      res.json(payload);
    } catch (err) {
      // Real error stays server-side; the client gets a generic 502.
      console.error('[cameras] windy upstream failure:', err && err.message ? err.message : err);
      res.status(502).json({
        error: 'cameras_upstream',
        message: 'Windy webcams API unavailable',
      });
    }
  });
}

module.exports = { registerCamerasRoutes, toWindyBbox, shapeCamera };
