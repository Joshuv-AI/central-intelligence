/* Richer aircraft card content.
   Inspired by God's Eye View src/layers/localAdsb/card.js (MIT).
   The honesty pattern from GEV's routePlausible.js is the point:
   route enrichment is shown ONLY when plausibility-gated, never a
   confidently-wrong route.

   This module does NOT render the card chrome — ui/cards.js owns that.
   It exports:
   - flightCardFieldsHtml(a): card-field rows for a CI aircraft record.
   - airlineNameFor(callsign): static ICAO-designator → airline lookup
     (major carriers; coverage is honest — unknown → null, never guessed).
   - fetchRouteFor(callsign): keyless adsbdb route enrichment with
     in-memory cache + 500ms throttle (adsbdb rate-limits aggressively).

   Expected CI record fields (see integration doc): hex, lat, lon, alt (m),
   gs (kt), track, label, military, lastUpdate, plus optional:
   typeCode (adsb.lol `t`), vertRateFpm (adsb.lol `baro_rate`), seenSec
   (adsb.lol `seen`), squawk, emergency, stale. */

import { classifyAircraft, AIRCRAFT_CLASS_LABELS } from './aircraftClass.js';
import { routePlausible } from './routePlausible.js';

/** ICAO airline designator (first 3 letters of callsign) → airline name.
 *  Major carriers only — unknown designators return null (never guessed). */
const AIRLINES = {
  AAL: 'American Airlines', ACA: 'Air Canada', AFR: 'Air France',
  AUA: 'Austrian Airlines', AZA: 'ITA Airways', BAW: 'British Airways',
  BER: 'Air Berlin', BTI: 'airBaltic', CFG: 'Condor', CLX: 'Cargolux',
  DAL: 'Delta Air Lines', DLH: 'Lufthansa', EIN: 'Aer Lingus',
  ETD: 'Etihad Airways', EZY: 'easyJet', FDH: 'Air Europa',
  FIN: 'Finnair', GIA: 'Garuda Indonesia', GTI: 'Atlas Air',
  IBE: 'Iberia', JAL: 'Japan Airlines', JBU: 'JetBlue',
  JSA: 'Jetstar', KLM: 'KLM', KQA: 'Kenya Airways',
  LOT: 'LOT Polish', MAS: 'Malaysia Airlines', NAX: 'Norwegian',
  NKS: 'Spirit Airlines', QFA: 'Qantas', QTR: 'Qatar Airways',
  RYR: 'Ryanair', SAS: 'SAS', SIA: 'Singapore Airlines',
  SWA: 'Southwest Airlines', THA: 'Thai Airways', THY: 'Turkish Airlines',
  UAE: 'Emirates', UAL: 'United Airlines', UPS: 'UPS Airlines',
  VIR: 'Virgin Atlantic', VLG: 'Vueling', VOZ: 'Virgin Australia',
  WJA: 'WestJet', ASA: 'Alaska Airlines', FFT: 'Frontier Airlines',
  HAL: 'Hawaiian Airlines', JZA: 'Jazz Aviation', WEN: 'WestJet Encore',
  CPA: 'Cathay Pacific', ANA: 'All Nippon Airways', EVA: 'EVA Air',
  CES: 'China Eastern', CCA: 'Air China', CSN: 'China Southern',
  AIC: 'Air India', PIA: 'Pakistan Intl', SVA: 'Saudia',
  MSR: 'EgyptAir', ETH: 'Ethiopian Airlines', SAA: 'South African Airways',
  AMX: 'Aeromexico', ARG: 'Aerolineas Argentinas', LAN: 'LATAM',
  TAM: 'LATAM Brasil', AEE: 'Aegean Airlines', TAP: 'TAP Air Portugal',
  SWR: 'Swiss Intl', BEL: 'Brussels Airlines', KLC: 'KLM Cityhopper',
  EWG: 'Eurowings', TUI: 'TUI Airways', TOM: 'TUI Airways',
  BEE: 'flybe', LOG: 'Loganair', AUR: 'Aurigny',
  RBA: 'Royal Brunei', RAM: 'Royal Air Maroc', TUA: 'Turkmenistan Airlines',
  AXY: 'AirExplore', BCS: 'European Air Transport', FDX: 'FedEx Express',
  ABW: 'AirBridgeCargo',
};

/** Airline name from callsign prefix, or null when unknown. */
export function airlineNameFor(callsign) {
  const cs = String(callsign || '').trim().toUpperCase();
  if (cs.length < 3) return null;
  return AIRLINES[cs.slice(0, 3)] || null;
}

/** Vertical-rate display: "▲ 1,800 fpm" / "▼ 900 fpm" / "— level". */
export function verticalRateText(vertRateFpm) {
  if (!Number.isFinite(vertRateFpm)) return null;
  const v = Math.round(vertRateFpm);
  if (Math.abs(v) < 100) return 'Level';
  const arrow = v > 0 ? '▲' : '▼';
  return `${arrow} ${Math.abs(v).toLocaleString('en-US')} fpm`;
}

/** Position age: "12s ago" / "3m ago" / "live". */
export function positionAgeText(seenSec, lastUpdateMs) {
  let ageSec = Number.isFinite(seenSec) ? seenSec : null;
  if (ageSec === null && Number.isFinite(lastUpdateMs)) {
    ageSec = (performance.now() - lastUpdateMs) / 1000;
  }
  if (ageSec === null || ageSec < 0) return null;
  if (ageSec < 5) return 'live';
  if (ageSec < 90) return `${Math.round(ageSec)}s ago`;
  return `${Math.round(ageSec / 60)}m ago`;
}

// ── adsbdb route enrichment (keyless, throttled, cached) ─────────────
// Verified: https://api.adsbdb.com/v0/callsign/{callsign} →
// { response: { flightroute: { origin: {icao_code, iata_code, name,
//   municipality, latitude, longitude}, destination: {...}, airline: {name} } } }
// 404 → { response: "unknown callsign" }. Rate-limited: keep ≤2 req/s,
// send a descriptive User-Agent.

const routeCache = new Map(); // callsign → { at, route|null }
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000;
let lastRouteFetchAt = 0;
const ROUTE_MIN_GAP_MS = 600;

function normalizeRoute(fr) {
  if (!fr || !fr.origin || !fr.destination) return null;
  const pt = (p) => ({
    code: p.iata_code || p.icao_code || '',
    name: p.name || p.municipality || '',
    lat: Number(p.latitude),
    lon: Number(p.longitude),
  });
  const origin = pt(fr.origin);
  const destination = pt(fr.destination);
  if (!origin.code && !destination.code) return null;
  return {
    origin, destination,
    airline: fr.airline && fr.airline.name ? fr.airline.name : null,
  };
}

/**
 * Fetch a plausibility-checked route for a callsign.
 * Returns null when unknown, rate-limited, or failing — the card simply
 * omits the route line (honest omission, never a wrong route).
 */
export async function fetchRouteFor(callsign) {
  const cs = String(callsign || '').trim().toUpperCase();
  if (!cs) return null;
  const cached = routeCache.get(cs);
  if (cached && Date.now() - cached.at < ROUTE_TTL_MS) return cached.route;

  const gap = Date.now() - lastRouteFetchAt;
  if (gap < ROUTE_MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, ROUTE_MIN_GAP_MS - gap));
  }
  lastRouteFetchAt = Date.now();
  try {
    const res = await fetch(
      `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`,
      { headers: { 'User-Agent': 'CentralIntelligence/1.0 (flight-card enrichment)' } },
    );
    if (!res.ok) {
      routeCache.set(cs, { at: Date.now(), route: null });
      return null;
    }
    const data = await res.json();
    const route = normalizeRoute(data && data.response && data.response.flightroute);
    routeCache.set(cs, { at: Date.now(), route });
    return route;
  } catch {
    return null; // network failure → omit route, keep card
  }
}

/**
 * Plausibility-gated route: returns the "ORIG → DEST" string only when
 * routePlausible() passes for the aircraft's CURRENT position/altitude/
 * vertical rate. Otherwise null.
 */
export function plausibleRouteText(a, route) {
  if (!route || !a) return null;
  const ok = routePlausible({
    latDeg: a.lat,
    lonDeg: a.lon,
    altitudeM: Number.isFinite(a.alt) ? a.alt : null,
    verticalRateMps: Number.isFinite(a.vertRateFpm) ? a.vertRateFpm / 196.85 : null,
    origin: route.origin,
    destination: route.destination,
  });
  if (!ok) return null;
  const o = route.origin.code || '?';
  const d = route.destination.code || '?';
  return `${o} → ${d}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/**
 * Build the card-field rows HTML for a CI aircraft record.
 * @param {object} a - CI aircraft record (see header for fields).
 * @param {object} [extra]
 * @param {{origin:{code,lat,lon},destination:{code,lat,lon},airline}|null} [extra.route]
 * @returns {string} HTML rows for inside .card-fields.
 */
export function flightCardFieldsHtml(a, extra = {}) {
  const altFt = a.alt > 0 ? Math.round(a.alt * 3.28084) : 0;
  const spdKt = Number.isFinite(a.gs) ? Math.round(a.gs) : null;
  const hdg = Number.isFinite(a.track) ? Math.round(a.track) : null;
  const where = `${a.lat.toFixed(3)}°, ${a.lon.toFixed(3)}°`;
  const klass = classifyAircraft({ typeCode: a.typeCode, category: a.category });
  const classLabel = AIRCRAFT_CLASS_LABELS[klass];
  const airline = extra.route?.airline || airlineNameFor(a.label);
  const vr = verticalRateText(a.vertRateFpm);
  const age = positionAgeText(a.seenSec, a.lastUpdate);
  const routeText = plausibleRouteText(a, extra.route);
  const squawk = a.squawk && a.squawk !== '1200' ? String(a.squawk) : null;
  const emergency = a.emergency && a.emergency !== 'none';

  const row = (k, v) =>
    `<div class="card-field"><span class="k">${k}</span><span class="v">${v}</span></div>`;

  let html = '';
  html += row('Hex', `<span class="mono">${esc(a.hex)}</span>`);
  if (classLabel) html += row('Type', `${esc(classLabel)}${a.typeCode ? ` <span class="mono">(${esc(a.typeCode)})</span>` : ''}`);
  if (airline) html += row('Airline', esc(airline));
  if (routeText) html += row('Route', esc(routeText));
  html += row('Position', esc(where));
  if (altFt) {
    const fl = altFt >= 18000 ? `FL${Math.round(altFt / 100)}` : `${altFt.toLocaleString('en-US')} ft`;
    html += row('Altitude', esc(fl));
  }
  if (spdKt !== null) html += row('Speed', `${spdKt} kt`);
  if (hdg !== null) html += row('Heading', `${hdg}°`);
  if (vr) html += row('Vert. rate', esc(vr));
  if (squawk) html += row('Squawk', `<span class="mono">${esc(squawk)}</span>`);
  if (emergency) html += row('Emergency', `<span class="emergency">${esc(a.emergency)}</span>`);
  if (age) html += row('Position age', esc(age) + (a.stale ? ' <span class="stale">· STALE</span>' : ''));
  return html;
}
