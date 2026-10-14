// Central Intelligence — GEV adapter shared helpers (CommonJS port of the
// GEV provider pattern: fixed upstreams, bounded bodies, in-memory cache,
// stale-on-error, sanitized CI-shaped errors).
//
// ARCH §4.0 binding rules implemented here:
//  - every JSON payload built via `withMeta()` carries {fetchedAt, stale, ttlMs}
//  - binary responses carry X-Data-Age / X-Data-Stale (see sendBinary)
//  - upstream failure with cache -> stale copy; without cache -> throw
//    UpstreamError so the route answers 502 {error:"upstream_unavailable"}
'use strict';

class UpstreamError extends Error {
  constructor(message) {
    super(message || 'upstream_unavailable');
    this.code = 'upstream_unavailable';
  }
}

// ---------------------------------------------------------------- cache ----
/** key -> { at, value } ; entries are kept past TTL for stale-on-error. */
class TtlCache {
  constructor(maxEntries = 512) {
    this.map = new Map();
    this.maxEntries = maxEntries;
  }
  get(key) { return this.map.get(key) || null; }
  set(key, value, at = Date.now()) {
    if (this.map.size >= this.maxEntries && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { at, value });
  }
  /** Fresh entry or null. */
  fresh(key, ttlMs, now = Date.now()) {
    const hit = this.map.get(key);
    return hit && now - hit.at < ttlMs ? hit : null;
  }
}

/**
 * Cache-or-fetch with single-flight + stale-on-error.
 * Returns { value, fetchedAt, stale }.
 * Throws UpstreamError when the fetch fails and nothing is cached.
 */
async function cachedFetch(cache, key, ttlMs, fetcher) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return { value: hit.value, fetchedAt: hit.at, stale: false };
  if (cache._inflight && cache._inflight.has(key)) {
    try {
      const value = await cache._inflight.get(key);
      const e = cache.get(key);
      return { value, fetchedAt: e ? e.at : Date.now(), stale: false };
    } catch (err) {
      if (hit) return { value: hit.value, fetchedAt: hit.at, stale: true };
      throw err;
    }
  }
  if (!cache._inflight) cache._inflight = new Map();
  const p = (async () => {
    const value = await fetcher();
    cache.set(key, value);
    return value;
  })();
  cache._inflight.set(key, p);
  try {
    const value = await p;
    const e = cache.get(key);
    return { value, fetchedAt: e ? e.at : Date.now(), stale: false };
  } catch (err) {
    if (hit) return { value: hit.value, fetchedAt: hit.at, stale: true };
    throw err instanceof UpstreamError ? err : new UpstreamError(String(err && err.message || err));
  } finally {
    cache._inflight.delete(key);
  }
}

function withMeta(payload, fetchedAt, stale, ttlMs) {
  return { ...payload, fetchedAt, stale: !!stale, ttlMs };
}

function sendBinary(res, entry, contentType) {
  const ageMs = Date.now() - entry.at;
  res.set('X-Data-Age', String(Math.max(0, Math.floor(ageMs / 1000))));
  res.set('X-Data-Stale', entry.stale ? 'true' : 'false');
  res.set('Content-Type', contentType);
  res.status(200).send(entry.value);
}

// ------------------------------------------------------------ fetch core ----
const DEFAULT_TIMEOUT_MS = 12000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: opts.redirect || 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body as bytes with a hard cap enforced during the read. */
async function readBytesCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body.cancel(); } catch { /* noop */ }
    const err = new Error('response_too_large');
    err.code = 'RESPONSE_TOO_LARGE';
    throw err;
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) { const e = new Error('response_too_large'); e.code = 'RESPONSE_TOO_LARGE'; throw e; }
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* noop */ }
      const err = new Error('response_too_large');
      err.code = 'RESPONSE_TOO_LARGE';
      throw err;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchTextCapped(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 5 * 1024 * 1024 } = {}) {
  const res = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (res.status >= 300 && res.status < 400) {
    try { await res.body.cancel(); } catch { /* noop */ }
    const err = new Error('redirect_refused');
    err.code = 'REDIRECT_REFUSED';
    err.status = res.status;
    throw err;
  }
  const buf = await readBytesCapped(res, maxBytes);
  return { status: res.status, text: buf.toString('utf8'), headers: res.headers };
}

async function fetchJsonCapped(url, opts = {}) {
  const { status, text, headers } = await fetchTextCapped(url, opts);
  if (status < 200 || status >= 300) {
    const err = new Error(`upstream http ${status}`);
    err.upstreamStatus = status;
    throw err;
  }
  try { return { data: JSON.parse(text), headers }; }
  catch { throw new Error('upstream returned non-JSON'); }
}

// ------------------------------------------------------- SSRF discipline ----
// Ported from GEV common/ guards + radio transport: refuse non-http(s),
// credentials in URL, and any literal private/loopback/link-local host.
// (DNS-resolution pinning is GEV's radio-specific hardening; the adapter's
// fixed/allowlisted upstreams make literal + allowlist checks the control.)

function isPrivateIpLiteral(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b, c] = h.split('.').map(Number);
    if (h.split('.').some((p) => Number(p) > 255)) return true;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (h.includes(':')) {
    // IPv6 literal: only global unicast 2000::/3 is public, minus doc/special.
    if (!/^[0-9a-f:]+$/.test(h)) return true;
    const first = parseInt(h.split(':')[0] || '0', 16);
    if (!(first >= 0x2000 && first <= 0x3fff)) return true;
    if (h.startsWith('2001:db8') || h.startsWith('2001:0') || h.startsWith('2002:') || h.startsWith('3fff:')) return true;
    return false;
  }
  return false; // ordinary hostname; allowlist checks apply at call sites
}

/** Parse + validate a client-influenced URL. Returns URL or null. */
function parsePublicUrl(raw, { httpsOnly = true } = {}) {
  let url;
  try { url = new URL(String(raw)); } catch { return null; }
  if (httpsOnly ? url.protocol !== 'https:' : !['https:', 'http:'].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  if (isPrivateIpLiteral(url.hostname)) return null;
  return url;
}

// ------------------------------------------------------------ rate limit ----
/** Fixed-window per-IP limiter (GEV rate-limit defaults pattern). */
function makeRateLimiter({ windowMs = 60000, max = 60 } = {}) {
  const buckets = new Map();
  return function allow(ip) {
    const now = Date.now();
    const key = String(ip || 'unknown');
    let b = buckets.get(key);
    if (!b || now - b.at >= windowMs) { b = { at: now, count: 0 }; buckets.set(key, b); }
    b.count += 1;
    if (buckets.size > 5000) { for (const [k, v] of buckets) if (now - v.at >= windowMs) buckets.delete(k); }
    return b.count <= max;
  };
}

function clientIp(req) {
  return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
}

// ----------------------------------------------------- GTFS-RT decoding -----
// Minimal protobuf wire reader + VehiclePositions decoder, rewritten in CJS
// from GEV src/data/gtfsRealtime.js logic (field numbers are the contract).
// Bounded: entity + string ceilings; differential feeds are refused by the
// caller via header.incrementality !== 0 (FULL_DATASET).

const GTFS_MAX_ENTITIES = 20000;
const GTFS_MAX_STRING = 512;

function varintReader(buf) {
  let pos = 0;
  function varint() {
    let result = 0n; let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) throw new Error('truncated varint');
      const byte = buf[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
    throw new Error('varint too long');
  }
  function tag() {
    const v = varint();
    return { field: Number(v >> 3n), wire: Number(v & 7n) };
  }
  function bytes() {
    const len = Number(varint());
    if (len < 0 || pos + len > buf.length) throw new Error('truncated bytes');
    const out = buf.subarray(pos, pos + len); pos += len; return out;
  }
  function skip(wire) {
    if (wire === 0) { varint(); return; }
    if (wire === 1) { pos += 8; return; }
    if (wire === 2) { bytes(); return; }
    if (wire === 5) { pos += 4; return; }
    throw new Error(`unsupported wire type ${wire}`);
  }
  function fixed32() { const v = buf.readFloatLE(pos); pos += 4; return v; }
  function fixed64() { const v = buf.readDoubleLE(pos); pos += 8; return v; }
  return {
    get pos() { return pos; }, get end() { return buf.length; },
    tag, varint, bytes, skip, fixed32, fixed64,
    string() { const b = bytes(); const s = b.toString('utf8'); if (s.length > GTFS_MAX_STRING) throw new Error('string too long'); return s; },
  };
}

function eachField(buf, fn) {
  const r = varintReader(buf);
  while (r.pos < r.end) {
    const { field, wire } = r.tag();
    fn(field, wire, r);
  }
}

function decodePosition(buf) {
  const p = {};
  eachField(buf, (field, wire, r) => {
    if (field === 1 && wire === 5) p.latitude = r.fixed32();
    else if (field === 2 && wire === 5) p.longitude = r.fixed32();
    else if (field === 3 && wire === 5) p.bearing = r.fixed32();
    else if (field === 5 && wire === 5) p.speed = r.fixed32();
    else r.skip(wire);
  });
  return p;
}

function decodeTrip(buf) {
  const t = {};
  eachField(buf, (field, wire, r) => {
    if (field === 1 && wire === 2) t.tripId = r.string();
    else if (field === 5 && wire === 2) t.routeId = r.string();
    else if (field === 6 && wire === 0) t.directionId = Number(r.varint());
    else r.skip(wire);
  });
  return t;
}

function decodeVehicleDescriptor(buf) {
  const v = {};
  eachField(buf, (field, wire, r) => {
    if (field === 1 && wire === 2) v.id = r.string();
    else if (field === 2 && wire === 2) v.label = r.string();
    else r.skip(wire);
  });
  return v;
}

function decodeVehiclePosition(buf) {
  const vp = {};
  eachField(buf, (field, wire, r) => {
    if (field === 1 && wire === 2) vp.trip = decodeTrip(r.bytes());
    else if (field === 2 && wire === 2) vp.position = decodePosition(r.bytes());
    else if (field === 5 && wire === 0) vp.timestamp = Number(r.varint());
    else if (field === 7 && wire === 2) vp.stopId = r.string();
    else if (field === 8 && wire === 2) vp.vehicle = decodeVehicleDescriptor(r.bytes());
    else r.skip(wire);
  });
  return vp;
}

/** Decode a GTFS-RT FeedMessage buffer -> { incrementality, headerTimestamp, entities:[VehiclePosition-ish] } */
function decodeVehiclePositions(buf) {
  let incrementality = 0;
  let headerTimestamp = null;
  const vehicles = [];
  let truncated = false;
  let entityCount = 0;
  eachField(buf, (field, wire, r) => {
    if (field === 1 && wire === 2) {
      const header = r.bytes();
      eachField(header, (hf, hw, hr) => {
        if (hf === 2 && hw === 0) incrementality = Number(hr.varint());
        else if (hf === 3 && hw === 0) headerTimestamp = Number(hr.varint());
        else hr.skip(hw);
      });
    } else if (field === 2 && wire === 2) {
      const entity = r.bytes();
      entityCount += 1;
      if (entityCount > GTFS_MAX_ENTITIES) { truncated = true; return; }
      let id = null; let vp = null;
      eachField(entity, (ef, ew, er) => {
        if (ef === 1 && ew === 2) id = er.string();
        else if (ef === 4 && ew === 2) vp = decodeVehiclePosition(er.bytes());
        else er.skip(ew);
      });
      if (vp) vehicles.push({ entityId: id, ...vp });
    } else {
      r.skip(wire);
    }
  });
  return { incrementality, headerTimestamp, vehicles, entityCount, truncated };
}

// ------------------------------------------------------------ FIRMS CSV -----
// CJS port of GEV src/data/firmsCsv.js (parse + trailing-24h clamp).

const FIRMS_REQUIRED = ['latitude', 'longitude', 'acq_date', 'acq_time', 'confidence', 'frp'];

function isLikelyFirmsCsv(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trimStart();
  if (!trimmed || trimmed[0] === '<') return false;
  const nl = trimmed.indexOf('\n');
  const headerLine = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim().toLowerCase();
  const fields = headerLine.split(',').map((f) => f.trim());
  return FIRMS_REQUIRED.every((req) => fields.includes(req));
}

function firmsFiniteOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function parseFirmsCsv(text) {
  if (!isLikelyFirmsCsv(text)) return null;
  const lines = text.split('\n');
  let hi = 0;
  while (hi < lines.length && !lines[hi].trim()) hi += 1;
  const header = lines[hi].trim().toLowerCase().split(',').map((f) => f.trim());
  const col = new Map(header.map((name, i) => [name, i]));
  const get = (parts, name, alt) => {
    const idx = col.get(name) !== undefined ? col.get(name) : (alt ? col.get(alt) : undefined);
    return idx === undefined || parts[idx] === undefined ? '' : parts[idx].trim();
  };
  const records = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < header.length) continue;
    const lat = Number(get(parts, 'latitude'));
    const lon = Number(get(parts, 'longitude'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      lat, lon,
      frp: firmsFiniteOrZero(get(parts, 'frp')),
      confidence: get(parts, 'confidence'),
      brightness: firmsFiniteOrZero(get(parts, 'bright_ti4', 'brightness')),
      brightnessTi5: firmsFiniteOrZero(get(parts, 'bright_ti5', 'bright_t31')),
      daynight: get(parts, 'daynight'),
      acqDate: get(parts, 'acq_date'),
      acqTime: get(parts, 'acq_time'),
      satellite: get(parts, 'satellite'),
      instrument: get(parts, 'instrument'),
    });
  }
  return records;
}

function firmsAcquisitionMs(acqDate, acqTime) {
  if (typeof acqDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(acqDate)) return NaN;
  const t = String(acqTime == null ? '' : acqTime).trim();
  if (!/^\d{1,4}$/.test(t)) return NaN;
  const hhmm = t.padStart(4, '0');
  const y = Number(acqDate.slice(0, 4)); const mo = Number(acqDate.slice(5, 7)); const d = Number(acqDate.slice(8, 10));
  const hh = Number(hhmm.slice(0, 2)); const mm = Number(hhmm.slice(2, 4));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return NaN;
  return Date.UTC(y, mo - 1, d, hh, mm);
}

function filterTrailing24h(records, nowMs) {
  if (!Array.isArray(records) || !Number.isFinite(nowMs)) return [];
  const oldest = nowMs - 24 * 3600 * 1000;
  const newest = nowMs + 2 * 3600 * 1000;
  return records.filter((rec) => {
    const ms = firmsAcquisitionMs(rec.acqDate, rec.acqTime);
    return Number.isFinite(ms) && ms >= oldest && ms <= newest;
  });
}

module.exports = {
  UpstreamError, TtlCache, cachedFetch, withMeta, sendBinary,
  fetchWithTimeout, readBytesCapped, fetchTextCapped, fetchJsonCapped,
  isPrivateIpLiteral, parsePublicUrl, makeRateLimiter, clientIp,
  decodeVehiclePositions, GTFS_MAX_ENTITIES,
  isLikelyFirmsCsv, parseFirmsCsv, filterTrailing24h,
};
