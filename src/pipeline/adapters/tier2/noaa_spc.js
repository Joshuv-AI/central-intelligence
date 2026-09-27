// NOAA Storm Prediction Center — severe weather intelligence (keyless).
// Uses the official api.weather.gov feed: the latest Day 1 Convective
// Outlook (SWO) product text for categorical risk areas, plus active
// Tornado / Severe Thunderstorm watches and Tornado warnings.

const UA = 'Central-Intelligence/1.0';
const TIMEOUT = 20000;
// NOTE: the module exports its own `fetch`, so capture the real HTTP fetch
// explicitly — a bare `fetch(...)` inside this file would recurse into the export.
const httpFetch = globalThis.fetch.bind(globalThis);

const SWO_LISTING = 'https://api.weather.gov/products/types/SWO/locations/DY1';
const ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual&event=Tornado%20Watch&event=Severe%20Thunderstorm%20Watch&event=Tornado%20Warning';

function getJSON(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  return Promise.race([httpFetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/geo+json, application/json' },
  }), t__dl])
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .finally(() => clearTimeout(t__t));
}

function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function outlookSeverity(level) {
  const l = level.toUpperCase();
  if (/HIGH|MODERATE/.test(l)) return 'high';
  if (/ENHANCED|SLIGHT/.test(l)) return 'moderate';
  return 'low';
}

// Parse "...THERE IS A <LEVEL> RISK OF <HAZARD> FOR <AREA>..." lines from SWO text
function parseRiskLines(text) {
  const out = [];
  const re = /\.\.\.THERE IS (?:A|AN) ([A-Z0-9% ]+?) RISK OF ([A-Z ]+?) FOR ([^.]+?)\.\.\./gs;
  let m;
  while ((m = re.exec(text)) && out.length < 12) {
    const level = m[1].trim();
    if (/TSTM|GENERAL/.test(level)) continue; // general thunderstorms only — skip
    out.push({
      level,
      hazard: m[2].trim().toLowerCase(),
      area: m[3].replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

function parseSummary(text) {
  const m = text.match(/\.\.\.SUMMARY\.\.\.\s*([\s\S]*?)(?=\n\.\.\.[A-Z ]+\.\.\.)/);
  if (!m) return null;
  const s = m[1].replace(/\s+/g, ' ').trim();
  return s.length > 280 ? s.slice(0, 277) + '...' : s;
}

function centroid(geom) {
  try {
    let ring = null;
    if (geom?.type === 'Polygon') ring = geom.coordinates[0];
    else if (geom?.type === 'MultiPolygon') ring = geom.coordinates[0][0];
    if (!ring || !ring.length) return [null, null];
    let x = 0, y = 0;
    for (const [lon, lat] of ring) { x += lon; y += lat; }
    return [y / ring.length, x / ring.length];
  } catch {
    return [null, null];
  }
}

function alertSeverity(event) {
  if (/tornado/i.test(event)) return 'high';
  return 'moderate';
}

function mapAlert(f) {
  const p = f?.properties || {};
  if (!p.id || !p.event) return null;
  const [lat, lon] = centroid(f.geometry);
  const area = String(p.areaDesc || '').replace(/\s+/g, ' ').trim();
  return {
    id: `spc-alert-${hashId(p.id)}`,
    title: `${p.event} — ${area.length > 90 ? area.slice(0, 87) + '...' : area}`,
    summary: p.headline || null,
    lat,
    lon,
    region: area.length > 120 ? area.slice(0, 117) + '...' : area || null,
    time: p.onset || p.sent || new Date().toISOString(),
    severity: alertSeverity(p.event),
    url: p.id,
    attribution: 'NOAA SPC',
  };
}

async function fetch() {
  const records = [];

  // 1) Day 1 convective outlook risk areas
  try {
    const listing = await getJSON(SWO_LISTING);
    const latest = listing?.['@graph']?.[0];
    if (latest?.['@id']) {
      const product = await getJSON(latest['@id']);
      const text = product?.productText;
      if (typeof text === 'string' && text.length > 100) {
        const summary = parseSummary(text);
        const issued = product?.issuanceTime || new Date().toISOString();
        for (const r of parseRiskLines(text)) {
          records.push({
            id: `spc-swo-${hashId(r.level + r.area + issued)}`,
            title: `SPC ${r.level} risk of ${r.hazard} — ${r.area.length > 80 ? r.area.slice(0, 77) + '...' : r.area}`,
            summary: summary || `NOAA SPC Day 1 convective outlook issued ${issued}.`,
            lat: null,
            lon: null,
            region: r.area,
            time: issued,
            severity: outlookSeverity(r.level),
            url: 'https://www.spc.noaa.gov/products/outlook/day1otlk.html',
            attribution: 'NOAA SPC',
          });
        }
      }
    }
  } catch { /* fall through to alerts */ }

  // 2) Active watches + tornado warnings
  try {
    const alerts = await getJSON(ALERTS_URL);
    const features = Array.isArray(alerts?.features) ? alerts.features : [];
    for (const f of features.slice(0, 20)) {
      const rec = mapAlert(f);
      if (rec) records.push(rec);
    }
  } catch { /* fall through */ }

  return records;
}

module.exports = {
  name: 'noaa_spc',
  description: 'NOAA SPC convective outlook risk areas, watches, and tornado warnings',
  fetch,
};
