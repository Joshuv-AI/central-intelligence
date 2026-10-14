// NWS CAP — National Weather Service active hazard alerts (US only).
// Keyless JSON feed: https://api.weather.gov/alerts/active
// US scope is labeled at every surface (J4-12: "US-only sources labeled as
// US-only so they never present as global").
const ENDPOINT = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;
const MAX_EVENTS = 60;

// Alert types that read as "hazards" on an intelligence dashboard; routine
// advisories (dense fog, beach hazards) are filtered to keep the signal
// hazard-shaped rather than weather-noisy.
const HAZARD_EVENT_RE = /tornado|hurricane|typhoon|flood|flash flood|tsunami|wildfire|fire|extreme wind|severe thunderstorm|storm surge|ice storm|blizzard|dust storm|avalanche|volcano|earthquake/i;

async function fetchJson(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([
      fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } }),
      t__dl,
    ]);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

// Centroid of the first polygon ring; alerts without geometry are dropped
// (never plotted at a made-up point).
function centroid(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const ring = geometry.type === 'Polygon' ? geometry.coordinates[0]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates[0]?.[0]
    : null;
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let sx = 0, sy = 0;
  for (const [lon, lat] of ring) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    // Out-of-range coordinates are malformed, not plot-worthy.
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    sx += lon; sy += lat;
  }
  return { lat: sy / ring.length, lon: sx / ring.length };
}

function severityFromNws(severity) {
  switch (String(severity).toLowerCase()) {
    case 'extreme': return 'critical';
    case 'severe': return 'high';
    case 'moderate': return 'moderate';
    default: return 'low';
  }
}

function mapAlert(feature) {
  const p = feature.properties || {};
  const event = String(p.event || '').trim();
  if (!event || !HAZARD_EVENT_RE.test(event)) return null;
  const pos = centroid(feature.geometry);
  if (!pos) return null;
  const area = String(p.areaDesc || '').split(';')[0].trim();
  return {
    id: `nws_${String(p.id || '').replace(/[^a-zA-Z0-9-]/g, '').slice(-40) || Math.abs(hashStr(event + area))}`,
    title: `${event} — ${area || 'United States'}`,
    summary: `${event} (${p.severity || 'unknown'} severity) in ${area || 'the United States'}. US National Weather Service alert — US scope only.`,
    lat: pos.lat,
    lon: pos.lon,
    region: area || 'United States',
    time: p.effective || p.sent || new Date().toISOString(),
    severity: severityFromNws(p.severity),
    url: 'https://alerts.weather.gov/',
    attribution: 'NWS (US only)',
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

module.exports = {
  name: 'nws_cap',
  description: 'NWS active hazard alerts (US scope only — labeled)',
  async fetch() {
    try {
      const data = await fetchJson(ENDPOINT);
      const features = data && Array.isArray(data.features) ? data.features : [];
      return features
        .map(mapAlert)
        .filter(Boolean)
        .slice(0, MAX_EVENTS);
    } catch {
      return [];
    }
  },
  // Exported for tests (pure mapping, no network).
  _mapAlert: mapAlert,
  _centroid: centroid,
};
