/* Wave 2 (J4-03) — Pinned places. The merged shape of "Areas of interest"
   and "Watch-a-place" (one shape, not two — the J.1 counter): save any
   place or region, see it as a digest section inside the Top and Changes
   tabs, and get an in-app alert while the app is open when something
   changes there.

   Pin shapes (v1):
   - { kind:'region', regionId } — one of the model's named regions
   - { kind:'point', lat, lon, radiusKm } — a place, default 200 km watch radius
   - { kind:'box', minLat, maxLat, minLon, maxLon } — a custom rectangle

   Persistence is localStorage v1 (no accounts). Alerts are in-app toasts
   driven by the store's 'data' event (the SSE update-ping → snapshot
   refetch path); optional desktop Notification API is explicit opt-in and
   is labeled honestly: it only works while this tab is open. No email, no
   SMS, no push pipeline — the evaluation's bloat guard #10.

   Pure helpers are unit-testable in Node; the watcher + toasts need DOM. */
import { regionMatches, REGIONS, isGeo } from './model.js';
import { haversineKm } from './proximity.js';

export const PINS_KEY = 'ci.pins.v1';
export const PIN_NOTIFY_KEY = 'ci.pins.notify.v1';
export const MAX_PINS = 20;
export const PIN_DIGEST_WINDOW_MS = 6 * 3600_000;

function uid() {
  return `pin-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Validate + normalize a pin candidate. Returns {pin} or {error}. */
export function makePin(input = {}) {
  const kind = input.kind;
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim().slice(0, 80)
    : null;
  if (kind === 'region') {
    const region = REGIONS.find((r) => r.id === input.regionId);
    if (!region || region.id === 'world') return { error: 'Pick a real region, not the whole world.' };
    return { pin: { id: uid(), kind, name: name || region.label, regionId: region.id, createdAt: Date.now(), lastSeenAt: 0 } };
  }
  if (kind === 'point') {
    const lat = Number(input.lat); const lon = Number(input.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return { error: 'That place needs a valid latitude and longitude.' };
    let radiusKm = Number(input.radiusKm);
    if (!Number.isFinite(radiusKm) || radiusKm <= 0) radiusKm = 200;
    radiusKm = Math.min(2000, Math.max(10, radiusKm));
    return { pin: { id: uid(), kind, name: name || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`, lat, lon, radiusKm, createdAt: Date.now(), lastSeenAt: 0 } };
  }
  if (kind === 'box') {
    const b = ['minLat', 'maxLat', 'minLon', 'maxLon'].map((k) => Number(input[k]));
    if (b.some((n) => !Number.isFinite(n)) || !(b[0] < b[1]) || !(b[2] < b[3]) ||
        b[0] < -90 || b[1] > 90 || b[2] < -180 || b[3] > 180)
      return { error: 'That box needs valid corners: south < north, west < east.' };
    return { pin: { id: uid(), kind, name: name || 'Custom area', minLat: b[0], maxLat: b[1], minLon: b[2], maxLon: b[3], createdAt: Date.now(), lastSeenAt: 0 } };
  }
  return { error: 'Unknown pin type.' };
}

/** Load pins from storage; always returns an array. */
export function loadPins(storage = null) {
  const ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!ls) return [];
  try {
    const raw = ls.getItem(PINS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((p) => p && typeof p.id === 'string' && ['region', 'point', 'box'].includes(p.kind));
  } catch {
    return [];
  }
}

export function savePins(pins, storage = null) {
  const ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!ls) return false;
  try {
    ls.setItem(PINS_KEY, JSON.stringify((Array.isArray(pins) ? pins : []).slice(0, MAX_PINS)));
    return true;
  } catch {
    return false;
  }
}

export function addPin(pins, input, storage = null) {
  const list = Array.isArray(pins) ? pins.slice() : [];
  if (list.length >= MAX_PINS) return { pins: list, error: `Pin limit reached (${MAX_PINS}). Remove one first.` };
  const { pin, error } = makePin(input);
  if (error) return { pins: list, error };
  list.push(pin);
  savePins(list, storage);
  return { pins: list, pin };
}

export function removePin(pins, id, storage = null) {
  const list = (Array.isArray(pins) ? pins : []).filter((p) => p.id !== id);
  savePins(list, storage);
  return list;
}

/** Human one-liner for a pin (type + scope). */
export function pinSubtitle(pin) {
  if (!pin) return '';
  if (pin.kind === 'region') {
    const r = REGIONS.find((x) => x.id === pin.regionId);
    return `Region · ${r ? r.label : pin.regionId}`;
  }
  if (pin.kind === 'point') return `Within ${Math.round(pin.radiusKm)} km of ${Number(pin.lat).toFixed(2)}°, ${Number(pin.lon).toFixed(2)}°`;
  return `Area ${Number(pin.minLat).toFixed(1)}°–${Number(pin.maxLat).toFixed(1)}° × ${Number(pin.minLon).toFixed(1)}°–${Number(pin.maxLon).toFixed(1)}°`;
}

/** Does an intel event fall inside the pin? */
export function pinMatchesEvent(pin, event) {
  if (!pin || !event) return false;
  if (pin.kind === 'region') return regionMatches(pin.regionId, event);
  if (pin.kind === 'box') {
    if (!isGeo(event)) return false;
    return event.lat >= pin.minLat && event.lat <= pin.maxLat &&
      event.lon >= pin.minLon && event.lon <= pin.maxLon;
  }
  if (pin.kind === 'point') {
    if (!isGeo(event)) return false;
    return haversineKm(pin.lat, pin.lon, event.lat, event.lon) <= pin.radiusKm;
  }
  return false;
}

function feedItemEventLike(f) {
  // Feed items carry eventId/connectionId; the underlying event may be in
  // the markers list. Build a matchable pseudo-event from the item itself.
  if (!f) return null;
  return {
    id: f.eventId || f.id,
    title: f.headline || f.text || '',
    region: f.region || null,
    lat: Number.isFinite(f.lat) ? f.lat : null,
    lon: Number.isFinite(f.lon) ? f.lon : null,
    time: f.time,
    severity: f.severity,
  };
}

/**
 * Digest for one pin: feed items inside the window that match the pin,
 * newest first, capped. Pure.
 */
export function pinDigest(pin, { feed = [] } = {}, windowMs = PIN_DIGEST_WINDOW_MS, nowMs = Date.now()) {
  const items = [];
  for (const f of Array.isArray(feed) ? feed : []) {
    const t = f && f.time ? new Date(f.time).getTime() : NaN;
    if (!Number.isFinite(t) || nowMs - t > windowMs) continue;
    if (!pinMatchesEvent(pin, feedItemEventLike(f))) continue;
    items.push({
      id: f.id,
      headline: f.headline || f.text || 'Untitled update',
      time: f.time,
      severity: f.severity,
      kind: f.kind,
      eventId: f.eventId || null,
      connectionId: f.connectionId || null,
    });
  }
  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  return { count: items.length, items: items.slice(0, 5) };
}

/**
 * Pin watcher: on each data pulse, find feed items newer than each pin's
 * lastSeenAt that match the pin, and fire onAlert once per pin. Callers
 * render the toast / desktop notification.
 *
 * @param {object} deps
 * @param {() => Array} deps.getPins
 * @param {() => Array} deps.getFeed
 * @param {(alert:{pin, items}) => void} deps.onAlert
 * @param {(pins) => void} [deps.onPinsChanged] called when lastSeenAt advances
 */
export function createPinWatcher({ getPins, getFeed, onAlert, onPinsChanged } = {}) {
  const seenInPulse = new Set(); // feed-item ids already alerted this pulse
  function check() {
    const pins = getPins?.() || [];
    if (!pins.length) return;
    const feed = getFeed?.() || [];
    const now = Date.now();
    let changed = false;
    for (const pin of pins) {
      const fresh = [];
      for (const f of feed) {
        if (!f || typeof f.id !== 'string' || seenInPulse.has(`${pin.id}:${f.id}`)) continue;
        const t = f.time ? new Date(f.time).getTime() : NaN;
        if (!Number.isFinite(t) || t <= (pin.lastSeenAt || 0)) continue;
        if (!pinMatchesEvent(pin, feedItemEventLike(f))) continue;
        seenInPulse.add(`${pin.id}:${f.id}`);
        fresh.push({
          id: f.id,
          headline: f.headline || f.text || 'Untitled update',
          time: f.time,
          severity: f.severity,
          eventId: f.eventId || null,
          connectionId: f.connectionId || null,
        });
      }
      if (fresh.length) {
        fresh.sort((a, b) => new Date(b.time) - new Date(a.time));
        try { onAlert?.({ pin, items: fresh }); } catch { /* alert render must never break the pulse */ }
      }
      if (pin.lastSeenAt !== now) { pin.lastSeenAt = now; changed = true; }
    }
    if (changed) { savePins(pins); try { onPinsChanged?.(pins); } catch { /* noop */ } }
    if (seenInPulse.size > 2000) seenInPulse.clear(); // bounded, not forever
  }
  return { check };
}

/* ——— desktop notification opt-in (explicit, honestly labeled) ——— */
export function notifyEnabled(storage = null) {
  const ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try { return ls?.getItem(PIN_NOTIFY_KEY) === '1'; } catch { return false; }
}
export function setNotifyEnabled(on, storage = null) {
  const ls = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try {
    if (on) ls?.setItem(PIN_NOTIFY_KEY, '1'); else ls?.removeItem(PIN_NOTIFY_KEY);
  } catch { /* best-effort */ }
}
export async function requestNotifyPermission() {
  try {
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}
export function sendDesktopNotification(pin, items) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    const n = items.length;
    new Notification(`Pinned place: ${pin.name}`, {
      body: n === 1
        ? items[0].headline
        : `${n} new developments — latest: ${items[0].headline}`,
      tag: `ci-pin-${pin.id}`,
    });
    return true;
  } catch {
    return false;
  }
}
