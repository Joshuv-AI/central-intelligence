// usgs_earthquakes.js — USGS Earthquake Hazards Program, keyless GeoJSON.
// M4.5+ earthquakes, past 24h. https://earthquake.usgs.gov

const ENDPOINT = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const TIMEOUT_MS = 20_000;

function severityOf(mag) {
  if (mag >= 7) return 'critical';
  if (mag >= 6) return 'high';
  if (mag >= 5) return 'moderate';
  return 'low';
}

function mapFeature(f) {
  const p = f.properties || {};
  const coords = (f.geometry && f.geometry.coordinates) || [];
  const mag = typeof p.mag === 'number' ? p.mag : null;
  const place = p.place || 'Unknown location';
  return {
    id: `usgs_${f.id}`,
    title: mag != null ? `M${mag.toFixed(1)} earthquake — ${place}` : `Earthquake — ${place}`,
    summary: mag != null
      ? `Magnitude ${mag.toFixed(1)} earthquake, depth ${p.depth != null ? Math.round(p.depth) + ' km' : 'unknown'}. ${p.tsunami ? 'Tsunami flag set. ' : ''}Felt reports: ${p.felt != null ? p.felt : 'none'}.`
      : null,
    lat: typeof coords[1] === 'number' ? coords[1] : null,
    lon: typeof coords[0] === 'number' ? coords[0] : null,
    region: place,
    time: p.time ? new Date(p.time).toISOString() : new Date().toISOString(),
    severity: mag != null ? severityOf(mag) : 'low',
    url: p.url || 'https://earthquake.usgs.gov/earthquakes/map/',
    attribution: 'USGS',
  };
}

async function fetchJson(url) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
  timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const r = await Promise.race([fetch(url, {
      headers: { 'User-Agent': 'Central-Intelligence/1.0' },
    }), timer__dl]);
    if (!r.ok) return null;
    return await r.json();
  } finally {
    clearTimeout(timer__t);
  }
}

module.exports = {
  name: 'usgs_earthquakes',
  description: 'USGS M4.5+ earthquakes, past 24h (keyless)',
  async fetch() {
    try {
      const data = await fetchJson(ENDPOINT);
      const feats = data && Array.isArray(data.features) ? data.features : [];
      return feats.map(mapFeature).filter(e => e.lat != null && e.lon != null);
    } catch {
      return [];
    }
  },
};
