// Central Intelligence — GEV adapter (ARCH §4.2, Lane A).
//
// One new route family mounted under /api in src/index.js. It translates
// paths/shapes for the GEV-base frontend while CI's intel contract
// (/api/health|snapshot|events|stream, /api/cameras, /api/vessels/*,
// /proxy/*) stays sovereign and untouched (§4.0.1). Provider LOGIC is
// ported from GEV server/providers/* at pinned SHA 8b8ccc9a and rewritten
// to CommonJS (D2-14) — no GEV server code is required or copied.
//
// Honesty contract (§4.0.2/3): every JSON response carries
// {fetchedAt, stale, ttlMs}; binary/tile responses carry X-Data-Age +
// X-Data-Stale. Errors are {error:"…"}. Key-unset -> 503 {error:"no_key"}
// (or the route's documented variant). Upstream failure with cache ->
// 200 + stale:true; without cache -> 502 {error:"upstream_unavailable"}.
// Nothing fabricates data.
//
// Client build-stamp hook (§4.6 step-3): the frontend displays
// `build.sha` from GET /api/capabilities (sourced from DEPLOY_SHA, the
// same value /api/health reports as deploySha). Dockerfile stage 1 also
// receives GIT_SHA as VITE_DEPLOY_SHA so a baked-in stamp can be compared
// against this live value.
'use strict';

const express = require('express');
const {
  UpstreamError, TtlCache, cachedFetch, withMeta, sendBinary,
  fetchTextCapped, fetchJsonCapped, readBytesCapped, fetchWithTimeout,
  parsePublicUrl, isPrivateIpLiteral, makeRateLimiter, clientIp,
  decodeVehiclePositions, parseFirmsCsv, filterTrailing24h,
} = require('./gev/common');
const { TRANSIT_BY_ID, TRANSIT_FEEDS, isAllowedGbfsHost, isAllowedGbfsPath, loadBundledCctvCatalog } = require('./gev/feeds-data');
const { shapeCamera } = require('./cameras');
const { getNhcStorms } = require('./proxy');

const UA = 'central-intelligence/1.0 (gev-adapter)';
const ADSB = 'https://api.adsb.lol';
const TTL = {
  flights: 15 * 1000,
  cyclones: 5 * 60 * 1000,
  firms: 30 * 60 * 1000,
  tomtom: 120 * 1000,
  gbfs: 60 * 1000,
  transit: 15 * 1000,
  route: 5 * 60 * 1000,
  geocode: 24 * 60 * 60 * 1000,
  overpass: 10 * 60 * 1000,
  radio: 10 * 60 * 1000,
  windy: 5 * 60 * 1000,
  // Amendment (Lane A, Phase 3 — contract gaps G1/G2 from Lane C):
  celestrak: 6 * 60 * 60 * 1000, // GEV celestrak.js TLE_TTL_MS (6 h)
  launches: 15 * 60 * 1000, // GEV launch-library.js LL2_CACHE_TTL_MS (15 min)
  // Amendment #2 (live CCTV packs): GEV cctv/constants.js CCTV_SOURCE_CACHE_MS.
  cctvPacks: 15 * 60 * 1000,
};

// Module-level military ICAO registry (port of GEV classification.js
// registry semantics): the set of ICAO24 hexes seen in the mil feed,
// used to enrich civil records. Process-local, rebuilt from each mil fetch.
const militaryIcaos = new Set();

function envKey(name) { return String(process.env[name] || '').trim(); }

function errJson(res, status, error, extra) {
  res.status(status).json({ error, ...(extra || {}) });
}

function normalizeAircraft(ac, { military = false } = {}) {
  if (!ac || typeof ac !== 'object') return null;
  const hex = String(ac.hex || ac.icao24 || '').toLowerCase();
  const lat = Number(ac.lat); const lon = Number(ac.lon);
  if (!hex || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const alt = ac.alt_baro === 'ground' ? 0 : Number(ac.alt_baro);
  return {
    icao24: hex,
    callsign: String(ac.flight || '').trim() || null,
    lat, lon,
    altitudeFt: Number.isFinite(alt) ? alt : null,
    groundSpeedKt: Number.isFinite(Number(ac.gs)) ? Number(ac.gs) : null,
    heading: Number.isFinite(Number(ac.track)) ? Number(ac.track) : null,
    verticalRateFpm: Number.isFinite(Number(ac.baro_rate)) ? Number(ac.baro_rate) : null,
    squawk: ac.squawk != null ? String(ac.squawk) : null,
    registration: ac.r || null,
    typeCode: ac.t || null,
    typeDesc: ac.desc || null,
    military: military || militaryIcaos.has(hex),
    onGround: ac.alt_baro === 'ground',
  };
}

function normalizeAircraftList(payload, opts) {
  const list = payload && Array.isArray(payload.ac) ? payload.ac : [];
  const out = [];
  for (const ac of list) {
    const n = normalizeAircraft(ac, opts);
    if (n) out.push(n);
  }
  return out;
}

// Capture one Windy result set by invoking cameras.js's own registered
// handler with a mock req/res (cameras.js exports no fetch internals and
// is outside Lane A's sanctioned touches; this reuses its exact logic —
// key gate, cache, shaping — without editing it). Any failure -> null leg.
const { registerCamerasRoutes } = require('./cameras');
let windyHandler = null;
{
  const fakeRouter = { get(path, handler) { if (path === '/cameras') windyHandler = handler; } };
  registerCamerasRoutes(fakeRouter);
}
async function fetchWindyLeg(bbox, limit) {
  if (!windyHandler) return null;
  const res = {
    _status: 200, _body: null,
    status(code) { this._status = code; return this; },
    json(obj) { this._body = obj; return this; },
  };
  const req = { query: { bbox, limit: String(limit) } };
  await windyHandler(req, res);
  if (res._status !== 200 || !res._body || !Array.isArray(res._body.cameras)) return null;
  return res._body.cameras;
}

// Capture the AIS hub snapshot via its own SSE attach (hub.js is read-only
// for Lane A and exposes no snapshot getter): attach a mock viewer, read
// the initial `vessels` event synchronously, then close so the hub's idle
// lifecycle is unaffected beyond a normal viewer join/leave.
function hubSnapshot(hub) {
  if (!hub || typeof hub.attachStream !== 'function') return { vessels: [], status: hub ? hub.statusJson() : null };
  let vessels = [];
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.on = req.addListener.bind(req);
  const res = {
    writeHead() {}, write(str) {
      const m = /^event: vessels\ndata: (.*)$/m.exec(String(str));
      if (m) { try { const v = JSON.parse(m[1]); if (Array.isArray(v)) vessels = v; } catch { /* noop */ } }
    },
  };
  try {
    hub.attachStream(req, res);
  } catch { /* hub unavailable -> empty + status */ }
  try { req.emit('close'); } catch { /* noop */ }
  return { vessels, status: hub.statusJson() };
}

// =====================================================================
// AMENDMENT #2 — live CCTV packs (Phase 3; Joshua's 2026-10-13 00:58
// ruling: FULL CCTV must-include, "copy GEV's where possible").
//
// Ports of GEV server/providers/cctv/{sources,normalize,cap}.js,
// rewritten to CommonJS (D2-14) — provider LOGIC only, no server code
// copied. The bundled manifests (259 records) under-served the ruling:
// GEV's actually-served catalog is mostly LIVE PACKS built at runtime
// (see logs/lane-f-ground.md, "THE AUSTIN QUESTION").
//
// Pack admission — every pack in GEV's registry (catalog.js LIVE_PACKS)
// was evaluated against three tests (full table in
// logs/lane-a-amendment2.md): (a) keyless, (b) media client-direct
// (stills/direct streams; anything needing a server relay or an HLS
// pull FAILS — ARCH §6: no HLS relay ever), (c) public open data /
// public camera network with terms compatible with a catalog listing.
// PORTED (pass all three): austin, caltrans, tfl, ontario, fintraffic,
// drivebc, tarktee, nsw, calgary, vegvesen (stills leg only — its HLS
// video leg is dropped, the still is the catalogued media).
// REJECTED: txdot (fails (b) — its "snapshot" is a JSON envelope
// carrying a base64 JPEG that GEV's media.js decodes server-side; not
// client-direct), deldot (fails (b) — HLS-only, snapshotUrl is empty
// in GEV's own builder; no still exists to catalogue), tallinn +
// warendorf (not live packs at all — file catalogs whose records are
// already served verbatim via the bundled manifests; porting them
// would only duplicate bundled ids).
//
// HONEST-POSE RULE (deviation from GEV's builders, deliberate): GEV's
// loaders invent pose priors — an id-hash fallback heading plus fixed
// fov/range/pitch/mount personalities, and flat ground-elevation
// guesses. The adapter contract forbids invented pose/calibration, so
// here pose.hdg is set ONLY from a genuine upstream signal (a numeric
// heading field, a dedicated direction field, an orientation code, or
// an explicit travel token in the name, per GEV's own strict/bare
// direction rules); fov/range/pitch/mountHeight are null; and
// groundElevationM is set ONLY where upstream reports a real elevation
// (Caltrans feet->m, DriveBC metres, Fintraffic's reported third
// coordinate). Everything else is the shape's honest null.
// =====================================================================
const CCTV_CATALOG_CAP = 600; // §L catalog cap (client catalog.js cap, Lane F)
const CCTV_PACK_TIMEOUT_MS = 15 * 1000; // GEV CCTV_SOURCE_FETCH_TIMEOUT_MS

function packNum(v, fallback = NaN) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

// CJS port of GEV src/data/directionText.js directionToHeading:
// explicit travel forms ("WESTBOUND"/"WB") are safe anywhere; bare
// cardinals ("West") only for dedicated direction fields (allowBare).
function directionToHeading(value, allowBare = false) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return NaN;
  if (/\bNORTHBOUND\b|\bNB\b/.test(text)) return 0;
  if (/\bSOUTHBOUND\b|\bSB\b/.test(text)) return 180;
  if (/\bEASTBOUND\b|\bEB\b/.test(text)) return 90;
  if (/\bWESTBOUND\b|\bWB\b/.test(text)) return 270;
  if (/\bNORTHEAST\b|\bNE\b/.test(text)) return 45;
  if (/\bNORTHWEST\b|\bNW\b/.test(text)) return 315;
  if (/\bSOUTHEAST\b|\bSE\b/.test(text)) return 135;
  if (/\bSOUTHWEST\b|\bSW\b/.test(text)) return 225;
  if (allowBare) {
    if (/\bNORTH\b/.test(text)) return 0;
    if (/\bSOUTH\b/.test(text)) return 180;
    if (/\bEAST\b/.test(text)) return 90;
    if (/\bWEST\b/.test(text)) return 270;
  }
  return NaN;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad; const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Port of GEV prioritizeSources: order nearest-to-any-anchor first,
// then keep at most maxCount. (GEV also annotates available/region for
// its coverage reports; the adapter only needs the ordered list.)
function prioritizeSources(cameras, maxCount, anchors) {
  const list = Array.isArray(cameras) ? cameras : [];
  const anchorList = (anchors || []).filter((a) => Number.isFinite(a && a.lat) && Number.isFinite(a && a.lon));
  if (!anchorList.length) return list;
  const cap = Number.isFinite(maxCount) && maxCount > 0 ? Math.min(maxCount, list.length) : list.length;
  const scored = list.map((camera, idx) => {
    const lat = Number(camera && camera.lat); const lon = Number(camera && camera.lon);
    const distKm = Number.isFinite(lat) && Number.isFinite(lon)
      ? Math.min(...anchorList.map((a) => haversineKm(lat, lon, a.lat, a.lon)))
      : Number.POSITIVE_INFINITY;
    return { camera, idx, distKm };
  });
  scored.sort((a, b) => (a.distKm !== b.distKm ? a.distKm - b.distKm : a.idx - b.idx));
  return scored.slice(0, cap).map((e) => e.camera);
}

function dedupeById(cameras) {
  return Array.from(new Map(cameras.map((c) => [c.id, c])).values());
}

// Adapt one live-pack camera to the catalog's existing record shape
// (§4.2 #15, same shape loadBundledCctvCatalog emits). rec carries only
// genuine upstream values; see the HONEST-POSE RULE above.
function shapeLiveCamera(rec) {
  return {
    id: rec.id,
    name: rec.name,
    lat: rec.lat, lon: rec.lon,
    source: rec.provider,
    kind: 'still',
    media: { url: rec.url, snapshotUrl: rec.url, feedType: 'image' },
    pose: {
      hdg: Number.isFinite(rec.headingDeg) ? rec.headingDeg : null,
      fov: null,
      range: null,
    },
    calibration: {
      pitchDeg: null,
      mountHeightM: null,
      groundElevationM: Number.isFinite(rec.groundElevationM) ? rec.groundElevationM : null,
      headingConfidence: rec.headingConfidence || null,
    },
    city: rec.city || null,
    license: rec.license || null,
  };
}

async function fetchPackJson(url, { headers = {}, maxBytes = 16 * 1024 * 1024 } = {}) {
  const { status, text } = await fetchTextCapped(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    timeoutMs: CCTV_PACK_TIMEOUT_MS, maxBytes,
  });
  if (status !== 200) throw new UpstreamError(`http ${status}`);
  try { return JSON.parse(text); } catch { throw new UpstreamError('non-JSON upstream'); }
}

// ---- Austin (MANDATORY, first) — port of loadAustinSourcesFromOpenData.
// City of Austin open data (Socrata view b4k4-adkb, rows.json format):
// TURNED_ON rows only, plausible Austin coords, deduped, prioritized
// nearest downtown, cap 250 (DEFAULT_AUSTIN_MAX_SOURCES). Media is the
// client-direct still https://cctv.austinmobility.io/image/<id>.jpg.
const AUSTIN_DOWNTOWN = { lat: 30.2672, lon: -97.7431 };
function normalizeKey(text) {
  return String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function rowArrayToObject(row, columns) {
  const record = {};
  for (let idx = 0; idx < columns.length; idx++) {
    const col = columns[idx];
    const key = normalizeKey(col.fieldName || col.name || `col_${idx}`);
    if (key) record[key] = row[idx];
  }
  return record;
}
function parsePointString(value) {
  const m = String(value || '').match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!m) return { lat: NaN, lon: NaN };
  return { lon: packNum(m[1]), lat: packNum(m[2]) };
}
function coerceLatLon(value) {
  if (!value) return { lat: NaN, lon: NaN };
  if (typeof value === 'string') return parsePointString(value);
  if (typeof value !== 'object') return { lat: NaN, lon: NaN };
  return {
    lat: packNum(value.latitude ?? value.lat ?? value.y ?? value.Latitude ?? value.Lat),
    lon: packNum(value.longitude ?? value.lon ?? value.lng ?? value.x ?? value.Longitude ?? value.Lon),
  };
}
function extractAustinCoords(record) {
  for (const cand of [record.location, record.coordinates, record.the_geom, record.point, record.geocoded_column]) {
    const parsed = coerceLatLon(cand);
    if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lon)) return parsed;
  }
  return {
    lat: packNum(record.latitude ?? record.lat ?? record.camera_latitude ?? record.location_latitude),
    lon: packNum(record.longitude ?? record.lon ?? record.lng ?? record.camera_longitude ?? record.location_longitude),
  };
}
function extractAustinCameraId(record) {
  for (const key of ['camera_id', 'cameraid', 'cam_id', 'device_id', 'intersection_id', 'id']) {
    const v = record[key];
    if (v == null) continue;
    const t = String(v).trim();
    if (t && /^\d+$/.test(t)) return t;
  }
  for (const [key, value] of Object.entries(record)) {
    if (!/camera|cam|device/.test(key) || !/id/.test(key)) continue;
    const t = String(value || '').trim();
    if (t && /^\d+$/.test(t)) return t;
  }
  return '';
}
function extractAustinName(record, cameraId) {
  for (const key of ['camera_name', 'location_name', 'intersection_name', 'location', 'cross_street', 'description', 'name']) {
    const v = record[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return `Austin Camera ${cameraId}`;
}
function extractAustinHeading(record) {
  const direct = packNum(record.heading_deg ?? record.heading ?? record.bearing);
  if (Number.isFinite(direct)) return ((direct % 360) + 360) % 360;
  for (const key of ['direction', 'travel_direction', 'facing', 'facing_direction']) {
    const h = directionToHeading(record[key], true); // dedicated field: bare cardinals are real facings
    if (Number.isFinite(h)) return h;
  }
  const nameProbe = [record.camera_name, record.location_name, record.intersection_name, record.location, record.cross_street, record.description, record.name].filter(Boolean).join(' ');
  return directionToHeading(nameProbe); // strict: explicit travel tokens only
}
async function loadAustinPack() {
  const endpoint = process.env.CCTV_AUSTIN_ROWS_URL || 'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD';
  const payload = await fetchPackJson(endpoint, { maxBytes: 32 * 1024 * 1024 });
  const columns = Array.isArray(payload && payload.meta && payload.meta.view && payload.meta.view.columns) ? payload.meta.view.columns : [];
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  if (!columns.length || !rows.length) throw new UpstreamError('austin payload empty');
  const cameras = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const record = rowArrayToObject(row, columns);
    const cameraId = extractAustinCameraId(record);
    if (!cameraId) continue;
    const status = String(record.camera_status || '').trim().toUpperCase();
    if (status && status !== 'TURNED_ON') continue; // tolerate a missing column, per GEV
    const { lat, lon } = extractAustinCoords(record);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!(lat >= 30.02 && lat <= 30.58 && lon >= -98.12 && lon <= -97.4)) continue; // isLikelyAustinCoordinate
    const heading = extractAustinHeading(record);
    const url = `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`;
    cameras.push(shapeLiveCamera({
      id: cameraId,
      name: extractAustinName(record, cameraId),
      city: 'Austin',
      provider: 'Austin Transportation & Public Works',
      lat, lon,
      headingDeg: heading,
      headingConfidence: Number.isFinite(heading) ? 'high' : null,
      url,
      license: 'Public city traffic camera frame',
    }));
  }
  return prioritizeSources(dedupeById(cameras), 250, [AUSTIN_DOWNTOWN]);
}

// ---- Caltrans — port of loadCaltransSourcesFromOpenData. Keyless JSON
// per district (default districts 4,7,11,3 per GEV), inService only,
// still pinned to the official cwwp2.dot.ca.gov host. Districts fail
// independently inside the pack. Cap 300, metro anchors per GEV.
async function loadCaltransPack() {
  const districts = [4, 7, 11, 3];
  const settled = await Promise.allSettled(districts.map(async (district) => {
    const url = `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
    const payload = await fetchPackJson(url);
    return { district, rows: Array.isArray(payload && payload.data) ? payload.data : [] };
  }));
  const cameras = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const { district, rows } = result.value;
    for (const row of rows) {
      const cctv = row && row.cctv;
      if (!cctv || String(cctv.inService).toLowerCase() !== 'true') continue;
      const loc = cctv.location || {};
      const lat = packNum(loc.latitude); const lon = packNum(loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const imageUrl = String((cctv.imageData && cctv.imageData.static && cctv.imageData.static.currentImageURL) || '');
      if (!imageUrl.startsWith('https://cwwp2.dot.ca.gov/')) continue;
      const locationName = String(loc.locationName || '').trim();
      const codeMatch = /^([A-Za-z0-9_-]+)\s*--/.exec(locationName);
      const code = (codeMatch ? codeMatch[1] : `x${cameras.length}`).toLowerCase();
      const cameraId = `ca-d${district}-${code}`;
      const heading = directionToHeading(loc.direction, true);
      const label = locationName.replace(/^([A-Za-z0-9_-]+)\s*--\s*/, '') || `Caltrans D${district} ${code}`;
      const elevFt = packNum(loc.elevation);
      cameras.push(shapeLiveCamera({
        id: cameraId,
        name: loc.nearbyPlace ? `${label} (${loc.nearbyPlace})` : label,
        city: String(loc.nearbyPlace || `Caltrans D${district}`),
        provider: 'Caltrans',
        lat, lon,
        headingDeg: heading,
        headingConfidence: Number.isFinite(heading) ? 'high' : null,
        groundElevationM: Number.isFinite(elevFt) ? Math.max(-100, Math.min(4000, elevFt * 0.3048)) : NaN, // GEV: elevation is FEET upstream
        url: imageUrl,
        license: 'Public Caltrans highway camera frame',
      }));
    }
  }
  if (!cameras.length) throw new UpstreamError('caltrans: all districts empty/failed');
  return prioritizeSources(dedupeById(cameras), 300, [
    { lat: 37.7793, lon: -122.4193 }, { lat: 34.0537, lon: -118.2428 },
    { lat: 32.7157, lon: -117.1611 }, { lat: 38.5816, lon: -121.4944 },
  ]);
}

// ---- TfL JamCams — port of loadTflSourcesFromOpenData. Keyless list
// endpoint (GEV's optional TFL_APP_KEY only raises a rate limit; it is
// NOT used here — the pack is keyless by construction). available only,
// still pinned to TfL's public S3 bucket. No heading exists upstream.
// Cap 250, London anchor.
async function loadTflPack() {
  const places = await fetchPackJson('https://api.tfl.gov.uk/Place/Type/JamCam');
  if (!Array.isArray(places)) throw new UpstreamError('tfl payload not an array');
  const cameras = [];
  for (const place of places) {
    const props = {};
    for (const p of (place && place.additionalProperties) || []) { if (p && p.key) props[p.key] = p.value; }
    if (String(props.available).toLowerCase() !== 'true') continue;
    const lat = packNum(place && place.lat); const lon = packNum(place && place.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const imageUrl = String(props.imageUrl || '');
    if (!imageUrl.startsWith('https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/')) continue;
    const rawId = String((place && place.id) || '').replace(/^JamCams_/, '');
    if (!rawId) continue;
    cameras.push(shapeLiveCamera({
      id: `tfl-${rawId}`,
      name: String(place.commonName || `JamCam ${rawId}`),
      city: 'London',
      provider: 'Transport for London',
      lat, lon,
      url: imageUrl,
      license: 'Powered by TfL Open Data',
    }));
  }
  if (!cameras.length) throw new UpstreamError('tfl payload empty');
  return prioritizeSources(cameras, 250, [{ lat: 51.5074, lon: -0.1278 }]);
}

// ---- Ontario 511 — port of loadOntarioSourcesFromOpenData. Keyless
// catalog; still views canonicalized onto https://511on.ca/map/Cctv/.
// Cap 1000 (GEV per-pack default; the shared catalog cap trims fairly).
async function loadOntarioPack() {
  const rows = await fetchPackJson('https://511on.ca/api/v2/get/cameras?format=json&lang=en');
  if (!Array.isArray(rows)) throw new UpstreamError('ontario payload not an array');
  const normalizeViewUrl = (value) => {
    try {
      const parsed = new URL(String(value || '').trim());
      const m = /^\/map\/Cctv\/([^/?#]+)$/.exec(parsed.pathname);
      if (!m) return '';
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:' || (host !== '511on.ca' && !host.endsWith('.traveliq.co'))) return '';
      const viewId = decodeURIComponent(m[1]);
      if (!/^[A-Za-z0-9_.-]+$/.test(viewId)) return '';
      return `https://511on.ca/map/Cctv/${encodeURIComponent(viewId)}`;
    } catch { return ''; }
  };
  const cameras = [];
  for (const row of rows) {
    const rawId = String((row && (row.Id ?? row.id)) ?? '').trim();
    if (!rawId) continue;
    const lat = packNum(row.Latitude ?? row.latitude); const lon = packNum(row.Longitude ?? row.longitude);
    if (!(lat >= 41.0 && lat <= 57.5 && lon >= -95.6 && lon <= -74.0)) continue; // isLikelyOntarioCoordinate (also rejects NaN)
    const views = (Array.isArray(row.Views || row.views) ? (row.Views || row.views) : [])
      .filter((v) => String((v && (v.Status || v.status)) || '').trim().toLowerCase() === 'enabled')
      .map((v) => ({ url: normalizeViewUrl(v.Url || v.url), description: String(v.Description || v.description || '').trim() }))
      .filter((v) => v.url);
    if (!views.length) continue;
    const view = views.find((v) => !/\bdown\b/i.test(v.description)) || views[0];
    const location = String(row.Location || row.location || '').trim();
    const roadway = String(row.Roadway || row.roadway || '').trim();
    const viewLabel = view.description && !/\bdown\b/i.test(view.description) ? view.description : '';
    let heading = directionToHeading(row.Direction ?? row.direction, true);
    if (!Number.isFinite(heading)) heading = directionToHeading(view.description, true);
    cameras.push(shapeLiveCamera({
      id: `on-${rawId}`,
      name: [location || roadway || `Ontario 511 Camera ${rawId}`, viewLabel].filter(Boolean).join(' - '),
      city: location || roadway || 'Ontario',
      provider: 'Ontario 511',
      lat, lon,
      headingDeg: heading,
      headingConfidence: Number.isFinite(heading) ? 'high' : null,
      url: view.url,
      license: 'Open Government Licence - Ontario',
    }));
  }
  if (!cameras.length) throw new UpstreamError('ontario payload empty');
  return prioritizeSources(dedupeById(cameras), 1000, [
    { lat: 43.4516, lon: -80.4925 }, { lat: 43.6532, lon: -79.3832 }, { lat: 45.4215, lon: -75.6972 },
    { lat: 43.2557, lon: -79.8711 }, { lat: 42.9849, lon: -81.2453 }, { lat: 42.3149, lon: -83.0364 },
  ]);
}

// ---- Fintraffic — port of loadFintrafficSourcesFromOpenData.
// Keyless Digitraffic GeoJSON; one PRESET (fixed view) = one camera.
// GATHERING stations + inCollection presets only; frame URLs are BUILT
// from the official origin + a strictly validated preset id, never
// read from the payload. No compass heading exists in this dataset.
// Cap 300, Finland anchors.
async function loadFintrafficPack() {
  const payload = await fetchPackJson('https://tie.digitraffic.fi/api/weathercam/v1/stations', {
    headers: { 'Digitraffic-User': 'central-intelligence', 'Accept-Encoding': 'gzip' },
    maxBytes: 8 * 1024 * 1024,
  });
  const features = Array.isArray(payload && payload.features) ? payload.features : [];
  if (!features.length) throw new UpstreamError('fintraffic payload empty');
  const cameras = [];
  for (const feature of features) {
    const props = (feature && feature.properties) || {};
    const stationId = String(props.id || '').trim();
    if (!stationId) continue;
    if (String(props.collectionStatus || '').toUpperCase() !== 'GATHERING') continue;
    const coords = feature.geometry && feature.geometry.coordinates;
    const lon = packNum(Array.isArray(coords) ? coords[0] : NaN);
    const lat = packNum(Array.isArray(coords) ? coords[1] : NaN);
    if (!(lat >= 59.5 && lat <= 70.5 && lon >= 19 && lon <= 32)) continue; // isLikelyFinlandCoordinate
    const reportedElevation = packNum(Array.isArray(coords) ? coords[2] : NaN, 0);
    const groundElevationM = reportedElevation > 0 ? Math.min(1400, reportedElevation) : NaN; // 0 upstream means "not reported"
    for (const preset of props.presets || []) {
      if (!preset || preset.inCollection !== true) continue;
      const presetId = String(preset.id || '').trim();
      if (!/^C\d{7}$/.test(presetId) || !presetId.startsWith(stationId)) continue;
      const cameraId = `fi-${presetId.toLowerCase()}`;
      const base = String(props.name || '').replace(/_/g, ' ').trim() || `Fintraffic ${stationId}`;
      const viewSuffix = presetId.slice(stationId.length);
      cameras.push(shapeLiveCamera({
        id: cameraId,
        name: viewSuffix ? `${base} (view ${viewSuffix})` : base,
        city: 'Finland',
        provider: 'Fintraffic',
        lat, lon,
        groundElevationM,
        url: `https://weathercam.digitraffic.fi/${presetId}.jpg`,
        license: 'Fintraffic / digitraffic.fi (CC BY 4.0)',
      }));
    }
  }
  if (!cameras.length) throw new UpstreamError('fintraffic: no live presets');
  return prioritizeSources(cameras, 300, [
    { lat: 60.1699, lon: 24.9384 }, { lat: 60.4518, lon: 22.2666 }, { lat: 61.4978, lon: 23.761 },
    { lat: 62.2426, lon: 25.7473 }, { lat: 62.8924, lon: 27.677 }, { lat: 65.0121, lon: 25.4651 },
    { lat: 66.5039, lon: 25.7294 },
  ]);
}

// ---- DriveBC — port of loadDriveBcSourcesFromOpenData. Keyless list;
// is_on + should_appear only; frame URLs built from the numeric id on
// the official host. Orientation codes are genuine headings. Cap 250.
const DRIVEBC_ORIENTATION = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
async function loadDriveBcPack() {
  const rows = await fetchPackJson('https://www.drivebc.ca/api/webcams/');
  if (!Array.isArray(rows)) throw new UpstreamError('drivebc payload not an array');
  const cameras = [];
  for (const row of rows) {
    if (!row || row.is_on !== true || row.should_appear !== true) continue;
    if (!Number.isSafeInteger(row.id) || row.id <= 0) continue;
    const coords = row.location && row.location.coordinates;
    const lon = Array.isArray(coords) ? coords[0] : NaN;
    const lat = Array.isArray(coords) ? coords[1] : NaN;
    if (!(Number.isFinite(lat) && Number.isFinite(lon) && lat >= 48 && lat <= 60.5 && lon >= -139.5 && lon <= -114)) continue;
    const cameraId = `drivebc-${row.id}`;
    const heading = DRIVEBC_ORIENTATION[String(row.orientation || '').trim().toUpperCase()];
    const region = String(row.region_name || '').trim();
    cameras.push(shapeLiveCamera({
      id: cameraId,
      name: String(row.name || '').trim() || `DriveBC camera ${row.id}`,
      city: region === 'Border Cams' ? 'BC Border' : (region || 'British Columbia'),
      provider: 'DriveBC',
      lat, lon,
      headingDeg: heading,
      headingConfidence: Number.isFinite(heading) ? 'high' : null,
      groundElevationM: Number.isFinite(row.elevation) ? Math.max(-100, Math.min(4000, row.elevation)) : NaN,
      url: `https://www.drivebc.ca/images/${row.id}.jpg`,
      license: 'DriveBC, Open Government Licence - British Columbia',
    }));
  }
  if (!cameras.length) throw new UpstreamError('drivebc payload empty');
  return prioritizeSources(cameras, 250, [{ lat: 49.2827, lon: -123.1207 }, { lat: 48.4284, lon: -123.3656 }]);
}

// ---- Tarktee — port of loadTarkteeSourcesFromDatex (+ its two DATEX
// parsers). Keyless DATEX2 XML location + image feeds; only stills on
// the official tarktee.transpordiamet.ee/images/ origin are kept. No
// heading exists upstream. Cap 179, Estonian anchors.
function parseTarkteeLocations(xml) {
  const out = new Map();
  const blockRe = /<predefinedLocation\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/predefinedLocation>/g;
  let m;
  while ((m = blockRe.exec(String(xml || ''))) !== null) {
    const body = m[2];
    const latM = /<latitude>\s*(-?\d+(?:\.\d+)?)\s*<\/latitude>/i.exec(body);
    const lonM = /<longitude>\s*(-?\d+(?:\.\d+)?)\s*<\/longitude>/i.exec(body);
    if (!latM || !lonM) continue;
    const lat = packNum(latM[1]); const lon = packNum(lonM[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const nameM = /<value\b[^>]*>\s*([^<]+?)\s*<\/value>/i.exec(body);
    out.set(m[1], { name: nameM ? nameM[1].trim() : m[1], lat, lon });
  }
  return out;
}
function parseTarkteeImages(xml) {
  const out = new Map();
  const blockRe = /<trafficView\b[^>]*>([\s\S]*?)<\/trafficView>/g;
  let m;
  while ((m = blockRe.exec(String(xml || ''))) !== null) {
    const body = m[1];
    const refM = /<linearPredefinedLocationReference\b[^>]*\bid="([^"]+)"/i.exec(body);
    const urlM = /<urlLinkAddress>\s*([^<\s]+)\s*<\/urlLinkAddress>/i.exec(body);
    if (!refM || !urlM) continue;
    const url = urlM[1].trim();
    if (!url.startsWith('https://tarktee.transpordiamet.ee/images/')) continue;
    out.set(refM[1], url);
  }
  return out;
}
async function loadTarkteePack() {
  const [loc, img] = await Promise.all([
    fetchTextCapped('https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraLocations', { headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' }, timeoutMs: CCTV_PACK_TIMEOUT_MS, maxBytes: 16 * 1024 * 1024 }),
    fetchTextCapped('https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraImages', { headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' }, timeoutMs: CCTV_PACK_TIMEOUT_MS, maxBytes: 16 * 1024 * 1024 }),
  ]);
  if (loc.status !== 200 || img.status !== 200) throw new UpstreamError('tarktee http error');
  const locations = parseTarkteeLocations(loc.text);
  const images = parseTarkteeImages(img.text);
  if (!locations.size || !images.size) throw new UpstreamError('tarktee DATEX parse empty');
  const cameras = [];
  for (const [locationId, l] of locations.entries()) {
    const imageUrl = images.get(locationId);
    if (!imageUrl) continue;
    if (l.lat < 57.4 || l.lat > 59.9 || l.lon < 21.5 || l.lon > 28.4) continue;
    const numM = /\/images\/(\d+)\//.exec(imageUrl);
    cameras.push(shapeLiveCamera({
      id: numM ? `ee-tarktee-${numM[1]}` : `ee-tarktee-${locationId}`,
      name: l.name,
      city: l.name,
      provider: 'Transpordiamet (Tarktee)',
      lat: l.lat, lon: l.lon,
      url: imageUrl,
      license: 'Public Transpordiamet / Tarktee road weather camera data',
    }));
  }
  if (!cameras.length) throw new UpstreamError('tarktee: no cameras with images');
  return prioritizeSources(cameras, 179, [
    { lat: 59.437, lon: 24.753 }, { lat: 58.378, lon: 26.729 },
    { lat: 58.3859, lon: 24.4971 }, { lat: 59.3797, lon: 28.1791 },
  ]);
}

// ---- NSW — port of loadNswSourcesFromOpenData / nswCameraToSource.
// Keyless Live Traffic NSW GeoJSON; stills pinned to the official
// webcams.transport.nsw.gov.au origin. `direction` is a genuine
// compass signal. Cap 250, Sydney anchor.
async function loadNswPack() {
  const payload = await fetchPackJson('https://data.livetraffic.com/cameras/traffic-cam.json', { headers: { 'User-Agent': 'central-intelligence/1.0 (gev-adapter)' } });
  const features = Array.isArray(payload && payload.features) ? payload.features : [];
  if (!features.length) throw new UpstreamError('nsw payload empty');
  const cameras = [];
  for (const feature of features) {
    const rawId = String((feature && feature.id) || '').trim();
    if (!rawId) continue;
    const coords = feature.geometry && feature.geometry.coordinates;
    const lon = Array.isArray(coords) && typeof coords[0] === 'number' ? coords[0] : NaN;
    const lat = Array.isArray(coords) && typeof coords[1] === 'number' ? coords[1] : NaN;
    if (!(lat >= -38 && lat <= -28 && lon >= 140.9 && lon <= 159.2)) continue; // isLikelyNswCoordinate (also rejects NaN)
    const props = feature.properties || {};
    const url = String(props.href || '').trim();
    if (!url.startsWith('https://webcams.transport.nsw.gov.au/')) continue;
    const direction = String(props.direction || '').trim().toUpperCase().replace(/-/g, '');
    const heading = directionToHeading(direction, true);
    const view = String(props.view || '').trim();
    const title = String(props.title || '').trim();
    const label = (view && view.length <= 140 && !/[\r\n]/.test(view)) ? view : title;
    cameras.push(shapeLiveCamera({
      id: `nsw-${rawId}`,
      name: label || `NSW ${rawId}`,
      city: String(props.region || 'New South Wales').replace(/_/g, ' '),
      provider: 'Live Traffic NSW',
      lat, lon,
      headingDeg: heading,
      headingConfidence: Number.isFinite(heading) ? 'high' : null,
      url,
      license: 'Live Traffic NSW - Transport for NSW, CC BY 4.0',
    }));
  }
  if (!cameras.length) throw new UpstreamError('nsw: no valid cameras');
  return prioritizeSources(cameras, 250, [{ lat: -33.8688, lon: 151.2093 }]);
}

// ---- Calgary — port of loadCalgarySourcesFromOpenData /
// calgaryCameraToSource. Keyless Open Calgary (Socrata); frames pinned
// to trafficcam.calgary.ca (http upgraded to https, per GEV). NO
// heading is derived: the dataset's `quadrant` field and the location
// suffix are Calgary's ADDRESS GRID, not a camera facing (GEV's own
// warning) — pose.hdg stays null. Cap 220, downtown anchor.
async function loadCalgaryPack() {
  const rows = await fetchPackJson('https://data.calgary.ca/resource/k7p9-kppz.json?$limit=500', { maxBytes: 4 * 1024 * 1024 });
  if (!Array.isArray(rows)) throw new UpstreamError('calgary payload not an array');
  const cameras = [];
  for (const record of rows) {
    if (!record || typeof record !== 'object') continue;
    const coordinates = record.point && record.point.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const lon = packNum(coordinates[0]); const lat = packNum(coordinates[1]);
    if (!(lat >= 50.8 && lat <= 51.25 && lon >= -114.4 && lon <= -113.8)) continue; // isLikelyCalgaryCoordinate
    let imageUrl = null;
    try {
      const parsed = new URL(String((record.camera_url && record.camera_url.url) ?? '').trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        parsed.protocol = 'https:';
        if (parsed.toString().startsWith('https://trafficcam.calgary.ca/')) imageUrl = parsed.toString();
      }
    } catch { imageUrl = null; }
    if (!imageUrl) continue;
    let cameraId = null;
    try {
      const pathname = new URL(imageUrl).pathname;
      const numbered = /loc(\d+)\.jpg$/i.exec(pathname);
      if (numbered) cameraId = `calgary-${numbered[1]}`;
      else {
        const slug = pathname.replace(/^\/+|\.[a-z0-9]+$/gi, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
        if (slug) cameraId = `calgary-${slug}`;
      }
    } catch { cameraId = null; }
    if (!cameraId) continue;
    const location = String(record.camera_location ?? '').trim();
    const described = String((record.camera_url && record.camera_url.description) ?? '').trim();
    cameras.push(shapeLiveCamera({
      id: cameraId,
      name: location || described || `Calgary Camera ${cameraId.replace(/^calgary-/, '')}`,
      city: 'Calgary',
      provider: 'The City of Calgary',
      lat, lon,
      url: imageUrl,
      license: 'Contains information licensed under the Open Government Licence - City of Calgary',
    }));
  }
  if (!cameras.length) throw new UpstreamError('calgary payload empty');
  return prioritizeSources(dedupeById(cameras), 220, [{ lat: 51.0461, lon: -114.0626 }]);
}

// ---- Vegvesen (Norway) — port of loadVegvesenSourcesFromOpenData /
// vegvesenCameraToSource, STILLS LEG ONLY: GEV registers HLS video for
// cameras that publish it; that leg fails admission test (b), so it is
// dropped here and the still (which GEV keeps as the snapshot fallback
// for every camera) is the catalogued media. Keyless OGC API Features
// view of the DATEX 3.1 CCTV table; stills pinned to the exact
// per-camera URL on kamera.atlas.vegvesen.no. orientationDescription
// names a PLACE looked towards, not a bearing — pose.hdg stays null.
// Cap 900 (GEV per-pack default; the shared catalog cap trims fairly).
async function loadVegvesenPack() {
  const payload = await fetchPackJson('https://ogckart-sn1.atlas.vegvesen.no/ogc/features/v1/collections/datex_3_1:CctvSimple/items?f=application/geo%2Bjson&limit=5000', {
    headers: { Accept: 'application/geo+json,application/json' }, maxBytes: 8 * 1024 * 1024,
  });
  const features = Array.isArray(payload && payload.features) ? payload.features : [];
  if (!features.length) throw new UpstreamError('vegvesen payload empty');
  const cameras = [];
  for (const feature of features) {
    if (!feature || typeof feature !== 'object') continue;
    const props = feature.properties;
    if (!props || typeof props !== 'object') continue;
    const availability = String(props['status.stillImageAvailability'] ?? '').trim();
    if (availability && availability !== 'videoOrImagesAvailable') continue;
    const coordinates = feature.geometry && feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const lon = packNum(coordinates[0]); const lat = packNum(coordinates[1]);
    if (!(lat >= 57.9 && lat <= 71.3 && lon >= 4.4 && lon <= 31.3)) continue; // isLikelyNorwayCoordinate
    const rawId = String(props.cameraId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(rawId)) continue;
    let imageUrl = '';
    try {
      const image = new URL(String(props.stillImageUrl ?? ''));
      if (image.username || image.password) continue;
      imageUrl = image.href;
    } catch { continue; }
    if (imageUrl !== `https://kamera.atlas.vegvesen.no/api/images/${rawId}`) continue;
    const place = String(props.description ?? '').trim() || `Kamera ${rawId}`;
    const towards = String(props.orientationDescription ?? '').trim();
    const road = String(props.roadNumber ?? '').trim();
    const name = towards && towards !== place ? `${place} → ${towards}` : place;
    cameras.push(shapeLiveCamera({
      id: `no-vegvesen-${rawId.toLowerCase()}`,
      name: road ? `${road} ${name}` : name,
      city: 'Norway',
      provider: 'Statens vegvesen',
      lat, lon,
      url: imageUrl,
      license: 'Contains data under the Norwegian licence for Open Government data (NLOD) distributed by Statens vegvesen',
    }));
  }
  if (!cameras.length) throw new UpstreamError('vegvesen: no valid cameras');
  return prioritizeSources(dedupeById(cameras), 900, [
    { lat: 59.9139, lon: 10.7522 }, { lat: 60.3913, lon: 5.3221 }, { lat: 58.97, lon: 5.7331 },
    { lat: 63.4305, lon: 10.3951 }, { lat: 58.1467, lon: 7.9956 }, { lat: 67.2804, lon: 14.4049 },
    { lat: 69.6492, lon: 18.9553 },
  ]);
}

// Live-pack registry, in GEV catalog.js LIVE_PACKS order (tallinn +
// warendorf omitted — file catalogs already served as bundled records;
// see the admission note above).
const LIVE_PACKS = [
  { name: 'austin', load: loadAustinPack },
  { name: 'caltrans', load: loadCaltransPack },
  { name: 'tfl', load: loadTflPack },
  { name: 'ontario', load: loadOntarioPack },
  { name: 'fintraffic', load: loadFintrafficPack },
  { name: 'drivebc', load: loadDriveBcPack },
  { name: 'tarktee', load: loadTarkteePack },
  { name: 'nsw', load: loadNswPack },
  { name: 'calgary', load: loadCalgaryPack },
  { name: 'vegvesen', load: loadVegvesenPack },
];

// Catalog merge + truncation rule (documented choice): the bundled
// manifests are served FIRST and in full (259 records — curated,
// already in the client's shape; they never exceed the cap alone).
// Live packs then fill the remaining space ROUND-ROBIN in registry
// order (Austin first), one record per pack per turn, each pack in
// its own nearest-to-anchor priority order — GEV cap.js's fairness
// rule — so hitting the 600 cap thins every region a little instead
// of deleting whichever pack was appended last. The bbox-scoped Windy
// leg fills whatever space remains. Duplicate ids resolve
// first-occurrence-wins (bundled > earlier pack > later pack > windy),
// so a live record can never silently replace a bundled one.
function allocateCatalogCap({ bundled = [], packs = [], windy = [], cap = CCTV_CATALOG_CAP } = {}) {
  const out = [];
  const seen = new Set();
  const push = (cam) => {
    if (!cam || !cam.id || seen.has(cam.id) || out.length >= cap) return false;
    seen.add(cam.id); out.push(cam); return true;
  };
  let bundledCount = 0;
  for (const cam of bundled) { if (push(cam)) bundledCount += 1; }
  const lanes = packs.map((p) => ({ name: p.name, queue: Array.isArray(p.records) ? p.records : [], i: 0, kept: 0 }));
  while (out.length < cap) {
    let progressed = false;
    for (const lane of lanes) {
      if (out.length >= cap) break;
      while (lane.i < lane.queue.length && seen.has(lane.queue[lane.i].id)) lane.i += 1; // dup: skip without spending a slot
      if (lane.i >= lane.queue.length) continue;
      if (push(lane.queue[lane.i])) { lane.kept += 1; lane.i += 1; progressed = true; }
    }
    if (!progressed) break;
  }
  let windyCount = 0;
  for (const cam of windy) { if (push(cam)) windyCount += 1; }
  const packCounts = {};
  let liveCount = 0;
  for (const lane of lanes) { packCounts[lane.name] = lane.kept; liveCount += lane.kept; }
  return { cameras: out, bundledCount, packCounts, liveCount, windyCount };
}

function gevRoutes(options = {}) {
  const hub = options.hub || null;
  const router = express.Router();

  const flightsCache = new TtlCache(256);
  const firmsCache = new TtlCache(8);
  const gbfsCache = new TtlCache(256);
  const transitCache = new TtlCache(64);
  const routeCache = new TtlCache(512);
  const geocodeCache = new TtlCache(512);
  const overpassCache = new TtlCache(256);
  const radioCache = new TtlCache(8);
  const tomtomCache = new TtlCache(256);
  const celestrakCache = new TtlCache(32);
  const launchesCache = new TtlCache(8);
  const cctvPackCache = new TtlCache(32); // Amendment #2: one entry per live CCTV pack

  const perIp = {
    tomtom: makeRateLimiter({ windowMs: 60000, max: 120 }),
    route: makeRateLimiter({ windowMs: 60000, max: 30 }),
    geocode: makeRateLimiter({ windowMs: 60000, max: 30 }),
    overpass: makeRateLimiter({ windowMs: 60000, max: 10 }),
  };

  // ---- 1. capabilities -------------------------------------------------
  router.get('/capabilities', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const hubStatus = hub && typeof hub.statusJson === 'function' ? hub.statusJson() : null;
    res.json({
      features: {
        cctv: true,
        streetLevel: !!envKey('MAPILLARY_CLIENT_TOKEN'),
        traffic: !!envKey('TOMTOM_API_KEY'),
        firms: !!envKey('FIRMS_MAP_KEY'),
        radio: true,
        transit: true,
        bikeshare: true,
        directions: true,
      },
      keys: {
        ais: !!(hubStatus ? hubStatus.keyConfigured : envKey('AISSTREAM_KEY')),
        windy: !!envKey('WINDY_API_KEY'),
        firms: !!envKey('FIRMS_MAP_KEY'),
        tomtom: !!envKey('TOMTOM_API_KEY'),
        mapillary: !!envKey('MAPILLARY_CLIENT_TOKEN'),
      },
      build: { sha: process.env.DEPLOY_SHA || 'unknown', at: null },
      fetchedAt: Date.now(), stale: false, ttlMs: 0,
    });
  });

  // ---- 2. flights (viewport, adsb.lol via shared cache) -----------------
  router.get('/flights', async (req, res) => {
    const lat = Number(req.query.lat); const lon = Number(req.query.lon);
    let dist = Number(req.query.dist);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return errJson(res, 400, 'bad_request');
    }
    if (!Number.isFinite(dist) || dist <= 0) dist = 250;
    dist = Math.min(dist, 250);
    const path = `/v2/lat/${lat}/lon/${lon}/dist/${dist}`;
    try {
      const r = await cachedFetch(flightsCache, `flights:${path}`, TTL.flights, async () => {
        const { data } = await fetchJsonCapped(ADSB + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        return data;
      });
      const aircraft = normalizeAircraftList(r.value, {});
      res.json(withMeta({ aircraft, count: aircraft.length }, r.fetchedAt, r.stale, TTL.flights));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 3. flights/mil (+ registry enrichment) ---------------------------
  router.get('/flights/mil', async (req, res) => {
    try {
      const r = await cachedFetch(flightsCache, 'flights:mil', TTL.flights, async () => {
        const { data } = await fetchJsonCapped(`${ADSB}/v2/mil`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        return data;
      });
      const aircraft = normalizeAircraftList(r.value, { military: true });
      for (const a of aircraft) militaryIcaos.add(a.icao24);
      res.json(withMeta({ aircraft, count: aircraft.length, registrySize: militaryIcaos.size }, r.fetchedAt, r.stale, TTL.flights));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 4. flights/track ---------------------------------------------------
  router.get('/flights/track', async (req, res) => {
    const icao24 = String(req.query.icao24 || '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(icao24)) return errJson(res, 400, 'bad_request');
    try {
      const r = await cachedFetch(flightsCache, `track:${icao24}`, TTL.flights, async () => {
        const { data } = await fetchJsonCapped(`${ADSB}/v2/icao/${icao24}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        return data;
      });
      const payload = r.value || {};
      const acList = Array.isArray(payload.ac) ? payload.ac : (payload.icao ? [payload] : []);
      const aircraft = acList.length ? normalizeAircraft(acList[0], {}) : null;
      // readsb-style trace rows: [offsetSec, lat, lon, alt, gs, track, ...]
      let trace = [];
      if (Array.isArray(payload.trace)) {
        const base = Number(payload.timestamp) * 1000;
        trace = payload.trace.filter(Array.isArray).map((row) => ({
          at: Number.isFinite(base) ? base + Number(row[0] || 0) * 1000 : null,
          lat: Number(row[1]), lon: Number(row[2]),
          altitudeFt: Number.isFinite(Number(row[3])) ? Number(row[3]) : null,
          groundSpeedKt: Number.isFinite(Number(row[4])) ? Number(row[4]) : null,
          heading: Number.isFinite(Number(row[5])) ? Number(row[5]) : null,
        })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      } else if (aircraft) {
        trace = [{ at: Date.now(), lat: aircraft.lat, lon: aircraft.lon, altitudeFt: aircraft.altitudeFt, groundSpeedKt: aircraft.groundSpeedKt, heading: aircraft.heading }];
      }
      res.json(withMeta({ icao24, aircraft, trace, complete: false }, r.fetchedAt, r.stale, TTL.flights));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 5. vessels poll shim ---------------------------------------------
  router.get('/vessels', (req, res) => {
    // Registered BEFORE any /vessels/* conflict risk: ais routes own
    // /vessels/status and /vessels/stream; this bare path is unclaimed.
    const { vessels, status } = hubSnapshot(hub);
    res.json({
      vessels,
      status: status ? status.state : 'no_key',
      at: Date.now(),
      fetchedAt: Date.now(), stale: false, ttlMs: 0,
    });
  });

  // ---- 6. cyclones (shared NHC fetch with /proxy/nhc/storms) -------------
  router.get('/cyclones', async (req, res) => {
    try {
      const r = await getNhcStorms();
      const raw = r.data && Array.isArray(r.data.activeStorms) ? r.data.activeStorms : [];
      const storms = raw.map((s) => ({
        id: s.id || null,
        name: s.name || null,
        classification: s.classification || null,
        intensity: s.intensity != null ? String(s.intensity) : null,
        pressure: Number.isFinite(Number(s.pressure)) ? Number(s.pressure) : null,
        latitude: Number.isFinite(Number(s.latitudeNumeric)) ? Number(s.latitudeNumeric) : null,
        longitude: Number.isFinite(Number(s.longitudeNumeric)) ? Number(s.longitudeNumeric) : null,
        movementDir: Number.isFinite(Number(s.movementDir)) ? Number(s.movementDir) : null,
        movementSpeed: Number.isFinite(Number(s.movementSpeed)) ? Number(s.movementSpeed) : null,
        lastUpdate: s.lastUpdate || null,
        // Amendment #2 (Lane D GAP-D1): NHC's forecastAdvisory
        // (advNum/issuance/url) was dropped by this normalization, so
        // advisory number, issue time and the official link were
        // unavailable to any consumer. Carried through additively:
        // the upstream subfields verbatim (strings or null), or null
        // when the storm carries no forecastAdvisory. No existing
        // field changes.
        forecastAdvisory: (s.forecastAdvisory && typeof s.forecastAdvisory === 'object')
          ? {
            advNum: s.forecastAdvisory.advNum != null ? String(s.forecastAdvisory.advNum) : null,
            issuance: s.forecastAdvisory.issuance || null,
            url: s.forecastAdvisory.url || null,
          }
          : null,
        forecastTrack: s.forecastTrack || null,
        forecastCone: s.forecastCone || null,
        binNumber: s.binNumber || null,
      }));
      const payload = storms.length
        ? { storms }
        : { storms: [], note: 'no_active_storms' };
      res.json(withMeta(payload, r.fetchedAt, r.stale, TTL.cyclones));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 7. firms + firms/status -------------------------------------------
  const FIRMS_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'];
  router.get('/firms/status', (req, res) => {
    const hasKey = !!envKey('FIRMS_MAP_KEY');
    const entry = firmsCache.get('firms:all');
    res.json({
      hasKey,
      lastFetch: entry ? entry.at : null,
      count: entry ? entry.value.fires.length : null,
      fetchedAt: Date.now(), stale: false, ttlMs: TTL.firms,
    });
  });
  router.get('/firms', async (req, res) => {
    const key = envKey('FIRMS_MAP_KEY');
    if (!key) return errJson(res, 503, 'no_key');
    try {
      const r = await cachedFetch(firmsCache, 'firms:all', TTL.firms, async () => {
        const sources = []; const fires = [];
        for (const source of FIRMS_SOURCES) {
          try {
            const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
            const { status, text } = await fetchTextCapped(url, { headers: { 'User-Agent': UA }, timeoutMs: 60000, maxBytes: 64 * 1024 * 1024 });
            if (status !== 200) throw new Error(`http ${status}`);
            const records = parseFirmsCsv(text);
            if (records === null) throw new Error('non-CSV upstream response');
            const clamped = filterTrailing24h(records, Date.now());
            for (const rec of clamped) fires.push(rec);
            sources.push({ source, count: clamped.length, ok: true });
          } catch (e) {
            sources.push({ source, count: 0, ok: false });
          }
        }
        if (!sources.some((s) => s.ok)) throw new UpstreamError('all FIRMS sources failed');
        return { sources, fires };
      });
      const fires = filterTrailing24h(r.value.fires, Date.now());
      res.json(withMeta({ sources: r.value.sources, count: fires.length, fires }, r.fetchedAt, r.stale, TTL.firms));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 8. tomtom flow tiles (120 s cache, 4,500/day governor) -------------
  const tomtomBudget = { date: '', count: 0 };
  function tomtomToday() {
    const day = new Date().toISOString().slice(0, 10);
    if (tomtomBudget.date !== day) { tomtomBudget.date = day; tomtomBudget.count = 0; }
    return tomtomBudget;
  }
  function tomtomResetsAt() {
    const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.toISOString();
  }
  router.get('/tomtom/flow/:z/:x/:y', async (req, res) => {
    const file = String(req.params.y || '');
    const yRaw = file.endsWith('.pbf') ? file.slice(0, -4) : file;
    const z = Number(req.params.z); const x = Number(req.params.x); const y = Number(yRaw);
    const valid = Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) &&
      z >= 0 && z <= 22 && x >= 0 && x < 2 ** z && y >= 0 && y < 2 ** z;
    if (!valid) return errJson(res, 400, 'bad_request');
    const key = envKey('TOMTOM_API_KEY');
    if (!key) return errJson(res, 503, 'no_key');
    if (!perIp.tomtom(clientIp(req))) return errJson(res, 429, 'rate_limited');
    const tileKey = `tomtom:${z}/${x}/${y}`;
    const fresh = tomtomCache.fresh(tileKey, TTL.tomtom);
    if (fresh) return sendBinary(res, { at: fresh.at, value: fresh.value, stale: false }, 'application/x-protobuf');
    const budget = tomtomToday();
    if (budget.count >= 4500) {
      const hit = tomtomCache.get(tileKey);
      if (hit) return sendBinary(res, { at: hit.at, value: hit.value, stale: true }, 'application/x-protobuf');
      return errJson(res, 503, 'traffic_budget_exhausted', { resetsAt: tomtomResetsAt() });
    }
    try {
      budget.count += 1;
      const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf?key=${encodeURIComponent(key)}`;
      const upstream = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 15000);
      if (upstream.status >= 300 && upstream.status < 400) { try { await upstream.body.cancel(); } catch { /* noop */ } throw new UpstreamError('redirect'); }
      if (upstream.status !== 200) throw new UpstreamError(`http ${upstream.status}`);
      const buf = await readBytesCapped(upstream, 8 * 1024 * 1024);
      tomtomCache.set(tileKey, buf);
      return sendBinary(res, { at: Date.now(), value: buf, stale: false }, upstream.headers.get('content-type') || 'application/x-protobuf');
    } catch {
      const hit = tomtomCache.get(tileKey);
      if (hit) return sendBinary(res, { at: hit.at, value: hit.value, stale: true }, 'application/x-protobuf');
      return errJson(res, 502, 'upstream_unavailable');
    }
  });

  // ---- 9. gbfs proxy (SSRF-guarded, allowlist) ----------------------------
  router.get('/gbfs/:encodedUrl', async (req, res) => {
    let decoded = '';
    try { decoded = decodeURIComponent(String(req.params.encodedUrl || '')); }
    catch { return errJson(res, 400, 'bad_request'); }
    const url = parsePublicUrl(decoded, { httpsOnly: true });
    if (!url) return errJson(res, 400, 'bad_request');
    if (!isAllowedGbfsHost(url.hostname)) return errJson(res, 403, 'gbfs_host_not_allowed');
    if (!isAllowedGbfsPath(url.pathname)) return errJson(res, 400, 'gbfs_path_not_allowed');
    try {
      const r = await cachedFetch(gbfsCache, `gbfs:${url.toString()}`, TTL.gbfs, async () => {
        const { status, text } = await fetchTextCapped(url.toString(), {
          headers: { 'User-Agent': UA, Accept: 'application/json' }, maxBytes: 5 * 1024 * 1024,
        });
        if (status !== 200) { const e = new UpstreamError(`http ${status}`); e.upstreamStatus = status; throw e; }
        try { return JSON.parse(text); } catch { throw new UpstreamError('non-JSON upstream'); }
      });
      res.json(withMeta({ data: r.value }, r.fetchedAt, r.stale, TTL.gbfs));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 10. transit vehicles (registered feeds only) ------------------------
  router.get('/transit/feeds', (req, res) => {
    res.json(withMeta({
      feeds: TRANSIT_FEEDS.map((f) => ({ id: f.id, name: f.name, operator: f.operator, region: f.region, center: f.center, attribution: f.attribution })),
    }, Date.now(), false, TTL.transit));
  });
  router.get('/transit/vehicles/:feedId', async (req, res) => {
    const feed = TRANSIT_BY_ID.get(String(req.params.feedId || ''));
    if (!feed) return errJson(res, 404, 'unknown_feed');
    try {
      const r = await cachedFetch(transitCache, `transit:${feed.id}`, TTL.transit, async () => {
        const upstream = await fetchWithTimeout(feed.url, {
          headers: { 'User-Agent': UA, Accept: 'application/x-protobuf, application/octet-stream', ...(feed.headers || {}) },
        }, 15000);
        if (upstream.status >= 300 && upstream.status < 400) { try { await upstream.body.cancel(); } catch { /* noop */ } throw new UpstreamError('redirect_refused'); }
        if (upstream.status !== 200) throw new UpstreamError(`http ${upstream.status}`);
        const buf = await readBytesCapped(upstream, 8 * 1024 * 1024);
        const decoded = decodeVehiclePositions(buf);
        if (decoded.incrementality !== 0) {
          const e = new Error('differential_feed_refused'); e.code = 'differential'; throw e;
        }
        const fetchedAtS = Math.floor(Date.now() / 1000);
        const vehicles = [];
        for (const v of decoded.vehicles) {
          if (!v.position || !Number.isFinite(v.position.latitude) || !Number.isFinite(v.position.longitude)) continue;
          const ts = v.timestamp || decoded.headerTimestamp || fetchedAtS;
          vehicles.push({
            id: (v.vehicle && v.vehicle.id) || v.entityId || null,
            label: (v.vehicle && v.vehicle.label) || null,
            lat: v.position.latitude, lon: v.position.longitude,
            bearing: Number.isFinite(v.position.bearing) ? v.position.bearing : null,
            speed: Number.isFinite(v.position.speed) ? v.position.speed : null,
            routeId: (v.trip && v.trip.routeId) || null,
            tripId: (v.trip && v.trip.tripId) || null,
            stopId: v.stopId || null,
            timestamp: ts,
            timestampSource: v.timestamp ? 'vehicle' : (decoded.headerTimestamp ? 'header' : 'fetch'),
          });
          if (vehicles.length >= 10000) break;
        }
        return {
          feedId: feed.id, name: feed.name, attribution: feed.attribution,
          feedTimestamp: decoded.headerTimestamp, entityCount: decoded.entityCount,
          truncated: decoded.truncated, vehicles,
        };
      });
      res.json(withMeta({ ...r.value, count: r.value.vehicles.length }, r.fetchedAt, r.stale, TTL.transit));
    } catch (e) {
      if (e && e.code === 'differential') return errJson(res, 502, 'differential_feed_refused');
      return errJson(res, 502, 'upstream_unavailable');
    }
  });

  // ---- 11. route (OSRM FOSSGIS, quantized cache) ----------------------------
  router.get('/route', async (req, res) => {
    if (!perIp.route(clientIp(req))) return errJson(res, 429, 'rate_limited');
    const profileRaw = String(req.query.profile || 'car').toLowerCase();
    const profileMap = { car: 'routed-car', driving: 'routed-car', bike: 'routed-bike', bicycle: 'routed-bike', foot: 'routed-foot', walk: 'routed-foot', walking: 'routed-foot' };
    const profile = profileMap[profileRaw];
    if (!profile) return errJson(res, 400, 'bad_request');
    const parts = String(req.query.coords || '').split(';').map((p) => p.split(',').map(Number));
    if (parts.length < 2 || parts.some((p) => p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) {
      return errJson(res, 400, 'bad_request');
    }
    const steps = String(req.query.steps || '') === 'true';
    // Quantize to ~100 m (3 decimal places ≈ 111 m) for cache key + upstream.
    const q = parts.map(([lon, lat]) => [Math.round(lon * 1000) / 1000, Math.round(lat * 1000) / 1000]);
    const coordStr = q.map(([lon, lat]) => `${lon},${lat}`).join(';');
    const cacheKey = `route:${profile}:${coordStr}:${steps ? 1 : 0}`;
    try {
      const r = await cachedFetch(routeCache, cacheKey, TTL.route, async () => {
        const url = `https://routing.openstreetmap.de/${profile}/route/v1/driving/${coordStr}?overview=full&geometries=geojson&steps=${steps}`;
        const { data } = await fetchJsonCapped(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, maxBytes: 8 * 1024 * 1024 });
        if (!data || data.code !== 'Ok') throw new UpstreamError(`osrm ${data && data.code}`);
        return data;
      });
      const routes = Array.isArray(r.value.routes) ? r.value.routes : [];
      res.json(withMeta({ code: 'Ok', routes, waypoints: r.value.waypoints || [] }, r.fetchedAt, r.stale, TTL.route));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 12. geocode (Photon -> Nominatim, <=1 rps Nominatim) ----------------
  let nominatimLastAt = 0;
  async function nominatimFetch(url) {
    const wait = Math.max(0, 1000 - (Date.now() - nominatimLastAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    nominatimLastAt = Date.now();
    return fetchJsonCapped(url, { headers: { 'User-Agent': 'central-intelligence/1.0 (geocode; contact via antarctic-labs.com)', Accept: 'application/json' } });
  }
  router.get('/geocode', async (req, res) => {
    if (!perIp.geocode(clientIp(req))) return errJson(res, 429, 'rate_limited');
    const q = String(req.query.q || '').trim();
    if (!q || q.length > 200) return errJson(res, 400, 'bad_request');
    const cacheKey = `geocode:${q.toLowerCase()}`;
    try {
      const r = await cachedFetch(geocodeCache, cacheKey, TTL.geocode, async () => {
        // Photon first.
        try {
          const { data } = await fetchJsonCapped(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`, {
            headers: { 'User-Agent': UA, Accept: 'application/json' },
          });
          const features = data && Array.isArray(data.features) ? data.features : [];
          if (features.length) {
            return {
              source: 'photon',
              results: features.map((f) => ({
                name: (f.properties && (f.properties.name || f.properties.street)) || null,
                label: [f.properties && f.properties.name, f.properties && f.properties.city, f.properties && f.properties.country].filter(Boolean).join(', ') || null,
                lat: f.geometry && f.geometry.coordinates ? Number(f.geometry.coordinates[1]) : null,
                lon: f.geometry && f.geometry.coordinates ? Number(f.geometry.coordinates[0]) : null,
                type: (f.properties && f.properties.osm_type) || null,
              })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon)),
            };
          }
        } catch { /* fall through to Nominatim */ }
        const { data } = await nominatimFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`);
        const rows = Array.isArray(data) ? data : [];
        return {
          source: 'nominatim',
          results: rows.map((row) => ({
            name: row.name || null, label: row.display_name || null,
            lat: Number(row.lat), lon: Number(row.lon), type: row.type || null,
          })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon)),
        };
      });
      res.json(withMeta({ query: q, ...r.value }, r.fetchedAt, r.stale, TTL.geocode));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 13. overpass (templated only) ---------------------------------------
  function validBbox(b) {
    if (!b || typeof b !== 'object') return null;
    const s = Number(b.south != null ? b.south : b.s); const w = Number(b.west != null ? b.west : b.w);
    const n = Number(b.north != null ? b.north : b.n); const e = Number(b.east != null ? b.east : b.e);
    if (![s, w, n, e].every(Number.isFinite)) return null;
    if (s < -90 || n > 90 || w < -180 || e > 180 || s >= n || w >= e) return null;
    if (n - s > 12 || e - w > 12) return null;
    return { s, w, n, e };
  }
  function overpassQuery(template, b) {
    const bb = `(${b.s},${b.w},${b.n},${b.e})`;
    if (template === 'alpr') {
      return `[out:json][timeout:25];(node["highway"="speed_camera"]${bb};node["man_made"="surveillance"]["surveillance:type"~"ALPR|ANPR",i]${bb};node["surveillance:type"~"ALPR|ANPR",i]${bb};);out body 500;`;
    }
    if (template === 'installations') {
      return `[out:json][timeout:25];(nwr["military"]${bb};nwr["landuse"="military"]${bb};);out geom 700;`;
    }
    // features
    return `[out:json][timeout:25];(node["amenity"]${bb};node["power"="generator"]${bb};node["man_made"]${bb};);out body 500;`;
  }
  router.post('/overpass', async (req, res) => {
    if (!perIp.overpass(clientIp(req))) return errJson(res, 429, 'rate_limited');
    const body = req.body || {};
    // Raw QL is refused: anything carrying a `ql`/`data`/`query` field, or a
    // template outside the allowlist, is a 400 (ARCH §4.2 #13).
    if (body.ql || body.data || body.query) return errJson(res, 400, 'raw_ql_refused');
    const template = String(body.template || '');
    if (!['alpr', 'installations', 'features'].includes(template)) return errJson(res, 400, 'unknown_template');
    const bbox = validBbox(body.bbox);
    if (!bbox) return errJson(res, 400, 'bad_request');
    const ql = overpassQuery(template, bbox);
    const cellKey = `overpass:${template}:${bbox.s.toFixed(2)},${bbox.w.toFixed(2)},${bbox.n.toFixed(2)},${bbox.e.toFixed(2)}`;
    try {
      const r = await cachedFetch(overpassCache, cellKey, TTL.overpass, async () => {
        const upstream = await fetchWithTimeout('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: `data=${encodeURIComponent(ql)}`,
        }, 30000);
        if (upstream.status >= 300 && upstream.status < 400) { try { await upstream.body.cancel(); } catch { /* noop */ } throw new UpstreamError('redirect'); }
        if (upstream.status !== 200) throw new UpstreamError(`http ${upstream.status}`);
        const buf = await readBytesCapped(upstream, 32 * 1024 * 1024);
        return JSON.parse(buf.toString('utf8'));
      });
      const elements = r.value && Array.isArray(r.value.elements) ? r.value.elements : [];
      res.json(withMeta({ template, elements, count: elements.length }, r.fetchedAt, r.stale, TTL.overpass));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 14. radio stations + click -------------------------------------------
  // Guards ported from GEV radio transport/stations: allowlisted Radio
  // Browser mirror hosts only (*.api.radio-browser.info), redirect refusal,
  // private-IP rejection on resolved stream/homepage URLs (URL-level),
  // station normalization (checked, non-HLS, MP3/AAC, valid coords).
  // Audio is NEVER proxied — responses carry direct stream URLs.
  const RADIO_MIRRORS = ['https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info', 'https://nl1.api.radio-browser.info'];
  const RADIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function publicHttpsUrl(value) {
    const u = parsePublicUrl(value, { httpsOnly: true });
    return u ? u.toString() : null;
  }
  function normalizeStation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.stationuuid || '').toLowerCase();
    const lat = raw.geo_lat === null || raw.geo_lat === '' ? NaN : Number(raw.geo_lat);
    const lon = raw.geo_long === null || raw.geo_long === '' ? NaN : Number(raw.geo_long);
    const codec = String(raw.codec || '').toUpperCase();
    const streamUrl = publicHttpsUrl(raw.url_resolved || raw.url);
    if (!RADIO_UUID_RE.test(id)) return null;
    if (Number(raw.lastcheckok) !== 1 || Number(raw.hls) === 1) return null;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    if (!/^(MP3|AAC|AAC\+|AAC-LC|AAC-HE|HE-AAC)$/.test(codec)) return null;
    if (!streamUrl) return null;
    const name = String(raw.name || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!name) return null;
    return {
      id, name, lat, lon, streamUrl,
      homepage: publicHttpsUrl(raw.homepage),
      tags: String(raw.tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 24),
      country: String(raw.country || '').slice(0, 80),
      countryCode: String(raw.countrycode || '').toUpperCase().slice(0, 2),
      codec,
      bitrate: Number.isInteger(Number(raw.bitrate)) && Number(raw.bitrate) >= 8 && Number(raw.bitrate) <= 1024 ? Number(raw.bitrate) : null,
    };
  }
  async function radioFetchJson(pathname) {
    let lastErr = null;
    for (const origin of RADIO_MIRRORS) {
      const host = new URL(origin).hostname;
      if (!/^[a-z0-9-]+\.api\.radio-browser\.info$/.test(host) || isPrivateIpLiteral(host)) continue;
      try {
        const { status, text } = await fetchTextCapped(`${origin}${pathname}`, {
          headers: { 'User-Agent': 'central-intelligence/1.0 (radio directory client)', Accept: 'application/json' },
          timeoutMs: 12000, maxBytes: 4 * 1024 * 1024,
        });
        if (status !== 200) throw new Error(`http ${status}`);
        return JSON.parse(text);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new UpstreamError('no radio mirror available');
  }
  router.get('/radio/stations', async (req, res) => {
    try {
      const r = await cachedFetch(radioCache, 'radio:stations', TTL.radio, async () => {
        const rows = await radioFetchJson('/json/stations/search?has_geo_info=true&hidebroken=true&order=clickcount&reverse=true&limit=750');
        const stations = (Array.isArray(rows) ? rows : []).map(normalizeStation).filter(Boolean);
        return { stations };
      });
      res.json(withMeta({ stations: r.value.stations, count: r.value.stations.length }, r.fetchedAt, r.stale, TTL.radio));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });
  router.post('/radio/click/:uuid', async (req, res) => {
    const uuid = String(req.params.uuid || '').toLowerCase();
    if (!RADIO_UUID_RE.test(uuid)) return errJson(res, 400, 'bad_request');
    try {
      // Registers the click upstream and returns the station's direct URL;
      // the audio stream itself is never proxied through this server.
      const data = await radioFetchJson(`/json/url/${encodeURIComponent(uuid)}`);
      res.json(withMeta({ uuid, url: data && data.url ? publicHttpsUrl(data.url) : null, name: data && data.name ? String(data.name).slice(0, 140) : null }, Date.now(), false, 0));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 15. cameras/catalog ---------------------------------------------------
  // Amendment #2: the catalog now merges (a) the bundled manifests
  // (259), (b) the live open-data packs ported above (Austin first;
  // each fetched through the shared cachedFetch at TTL.cctvPacks =
  // 15 min, GEV's CCTV_SOURCE_CACHE_MS), and (c) the bbox-scoped Windy
  // leg as before — under the §L cap of 600 via allocateCatalogCap
  // (bundled first in full, packs round-robin, windy fills the rest).
  // Pack-failure isolation: a pack whose fetch fails contributes 0
  // records (or its stale cached copy, marked as such) and flips the
  // response's stale flag; it never 502s the catalog while the bundled
  // records are servable. Envelope/count fields are the existing ones,
  // extended additively with liveCount + packCounts (per-source counts
  // in the same style as bundledCount/windyCount). Envelope ttlMs
  // remains TTL.windy (the route's pre-amendment value); the pack
  // freshness cadence is TTL.cctvPacks, documented in the log.
  router.get('/cameras/catalog', async (req, res) => {
    const bundled = loadBundledCctvCatalog();
    const packResults = await Promise.all(LIVE_PACKS.map(async (pack) => {
      try {
        const r = await cachedFetch(cctvPackCache, `cctvpack:${pack.name}`, TTL.cctvPacks, pack.load);
        return { name: pack.name, records: r.value, fetchedAt: r.fetchedAt, stale: r.stale, ok: true };
      } catch {
        return { name: pack.name, records: [], fetchedAt: Date.now(), stale: true, ok: false };
      }
    }));
    let windy = [];
    let windyMeta = { fetchedAt: Date.now(), stale: false };
    const bboxParam = String(req.query.bbox || '').trim();
    if (bboxParam) {
      let limit = Number(req.query.limit);
      if (!Number.isFinite(limit)) limit = 50;
      limit = Math.max(1, Math.min(300, Math.floor(limit)));
      try {
        const leg = await fetchWindyLeg(bboxParam, limit);
        if (Array.isArray(leg)) {
          windy = leg.map((c) => ({
            id: `windy:${c.id}`,
            name: c.title || String(c.id),
            lat: c.lat, lon: c.lon,
            source: 'Windy Webcams',
            kind: c.playerEmbedUrl ? 'player' : 'still',
            media: { url: c.thumbnailUrl || null, snapshotUrl: c.thumbnailUrl || null, playerEmbedUrl: c.playerEmbedUrl || null, detailUrl: c.windyUrl || null },
            pose: { hdg: null, fov: null, range: null },
            calibration: { city: c.city || null, country: c.country || null, status: c.status || null },
          }));
        }
      } catch { windy = []; windyMeta = { fetchedAt: Date.now(), stale: true }; }
    }
    const alloc = allocateCatalogCap({ bundled, packs: packResults, windy });
    // Honest degradation: any pack failure or stale-served pack marks
    // the whole response stale (the bundled records themselves are
    // static and never stale). fetchedAt is the oldest contributing
    // fetch, as the envelope's age claim must cover the packs now too.
    const packsStale = packResults.some((p) => !p.ok || p.stale);
    let fetchedAt = windyMeta.fetchedAt;
    for (const p of packResults) { if (p.ok) fetchedAt = Math.min(fetchedAt, p.fetchedAt); }
    res.json(withMeta(
      {
        cameras: alloc.cameras, count: alloc.cameras.length,
        bundledCount: alloc.bundledCount, windyCount: alloc.windyCount,
        liveCount: alloc.liveCount, packCounts: alloc.packCounts,
      },
      fetchedAt, windyMeta.stale || packsStale, TTL.windy,
    ));
  });

  // ---- 16. celestrak TLE proxy (AMENDMENT — Lane C gap G1) ------------------
  // Port of GEV server/providers/space/celestrak.js (rewritten CJS, D2-14).
  // CelesTrak sends no CORS headers, so TLE text is fetched server-side and
  // served VERBATIM as text/plain — the satellites client
  // (frontend/src/layers/satellites/source.js) parses raw TLE text from
  // response.text() and detects staleness via the `x-tle-cache` header
  // (STALE-ERROR), and the launches client reads /api/celestrak/active the
  // same way. Because the payload is text, not the adapter JSON envelope,
  // staleness follows the adapter's text/binary convention instead:
  // X-Data-Age + X-Data-Stale (sendBinary) PLUS GEV's x-tle-cache header
  // (HIT / MISS / STALE-ERROR) the client actually checks. Errors stay the
  // adapter JSON shape: unknown group -> 400 {error:"unknown_group"};
  // upstream failure with cache -> 200 stale text; without cache ->
  // 502 {error:"upstream_unavailable"}. Allowlist = exactly the groups the
  // merged client requests: satellites source GROUPS (stations, visual,
  // gps-ops, glo-ops, galileo, geo, starlink) + active (launches source).
  const CELESTRAK_GROUPS = new Set([
    'stations', 'visual', 'gps-ops', 'glo-ops', 'galileo', 'geo', 'starlink',
    'active',
  ]);
  router.get('/celestrak/:group', async (req, res) => {
    const group = String(req.params.group || '').toLowerCase();
    if (!CELESTRAK_GROUPS.has(group)) return errJson(res, 400, 'unknown_group');
    const cacheKey = `celestrak:${group}`;
    const wasFresh = !!celestrakCache.fresh(cacheKey, TTL.celestrak);
    try {
      const r = await cachedFetch(celestrakCache, cacheKey, TTL.celestrak, async () => {
        const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
        const { status, text } = await fetchTextCapped(url, {
          // CelesTrak 403s bulk groups without a descriptive UA + contact.
          headers: { 'User-Agent': 'central-intelligence/1.0 (celestrak-proxy; contact via antarctic-labs.com)' },
          timeoutMs: 20000, maxBytes: 32 * 1024 * 1024,
        });
        if (status !== 200) throw new UpstreamError(`http ${status}`);
        // An upstream error page parses to zero TLEs — treat as failure.
        if (!/^1 /m.test(text)) throw new UpstreamError('no TLE lines in response');
        return text;
      });
      res.set('x-tle-cache', r.stale ? 'STALE-ERROR' : (wasFresh ? 'HIT' : 'MISS'));
      return sendBinary(res, { at: r.fetchedAt, value: r.value, stale: r.stale }, 'text/plain; charset=utf-8');
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  // ---- 17. launches (AMENDMENT — Lane C gap G2) ------------------------------
  // Port of GEV server/providers/space/launch-library.js (rewritten CJS).
  // Endpoint choice: GEV provider's exact endpoint — LL2 2.3.0
  // /launches/ recent window (net in [now-30d, now], limit 100,
  // mode=detailed) — NOT 2.2.0 /launch/upcoming/: the merged client's
  // model (frontend/src/layers/launches/model.js normalizeRocketLaunches)
  // keeps only launches with net <= now inside the rolling window, so an
  // upcoming-only feed would normalize to an empty roster. Results are
  // passed through verbatim (the client normalizes); the adapter envelope
  // {fetchedAt, stale, ttlMs} is added per §4.0.2, and GEV's X-GEV-Cache
  // header is mirrored because the launches client reads staleness from it
  // (HIT / MISS / STALE-ERROR). Optional LL2_API_TOKEN is sent server-side
  // only (GEV launchLibraryRequestHeaders pattern); the feed is public and
  // the route is NOT key-gated. Malformed upstream (no results array) ->
  // honest 502; upstream failure with cache -> 200 + stale:true.
  router.get('/launches', async (req, res) => {
    const wasFresh = !!launchesCache.fresh('launches:recent', TTL.launches);
    try {
      const r = await cachedFetch(launchesCache, 'launches:recent', TTL.launches, async () => {
        const end = new Date();
        const start = new Date(end.getTime() - 30 * 86400000);
        const url = `https://ll.thespacedevs.com/2.3.0/launches/?net__gte=${encodeURIComponent(start.toISOString())}&net__lte=${encodeURIComponent(end.toISOString())}&limit=100&mode=detailed`;
        const token = envKey('LL2_API_TOKEN');
        const { data } = await fetchJsonCapped(url, {
          headers: {
            'User-Agent': UA, Accept: 'application/json',
            ...(token ? { Authorization: `Token ${token}` } : {}),
          },
          timeoutMs: 20000, maxBytes: 12 * 1024 * 1024,
        });
        if (!data || !Array.isArray(data.results)) throw new UpstreamError('malformed upstream response');
        return { results: data.results };
      });
      res.set('X-GEV-Cache', r.stale ? 'STALE-ERROR' : (wasFresh ? 'HIT' : 'MISS'));
      res.json(withMeta({ results: r.value.results, count: r.value.results.length }, r.fetchedAt, r.stale, TTL.launches));
    } catch { return errJson(res, 502, 'upstream_unavailable'); }
  });

  return router;
}

module.exports = {
  gevRoutes,
  __test: {
    normalizeAircraft, militaryIcaos,
    // Amendment #2 (additive): catalog merge/cap rule + pack registry,
    // exposed for the contract tests.
    allocateCatalogCap, CCTV_CATALOG_CAP, packNames: LIVE_PACKS.map((p) => p.name),
  },
};
