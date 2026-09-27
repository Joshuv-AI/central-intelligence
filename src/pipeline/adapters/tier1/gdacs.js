// gdacs.js — Global Disaster Alert and Coordination System.
// Keyless GeoJSON feed: earthquakes, tsunamis, tropical cyclones, floods,
// volcanoes, droughts, wildfires. https://www.gdacs.org

const ENDPOINT = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const LOOKBACK_DAYS = 7;
const TIMEOUT_MS = 20_000;

const TYPE_NAMES = {
  EQ: 'Earthquake',
  TC: 'Tropical Cyclone',
  FL: 'Flood',
  VO: 'Volcano',
  DR: 'Drought',
  WF: 'Wildfire',
  TS: 'Tsunami',
};

function severityFromAlert(level) {
  switch (level) {
    case 'Red': return 'critical';
    case 'Orange': return 'high';
    case 'Green': return 'moderate';
    default: return 'low';
  }
}

function mapEvent(f) {
  const p = f.properties || {};
  const geom = f.geometry || {};
  const coords = Array.isArray(geom.coordinates) ? geom.coordinates : [];
  const typeName = TYPE_NAMES[p.eventtype] || p.eventtype || 'Disaster';
  const country = p.country || p.iso3 || 'Unknown region';
  const mag = p.severity != null ? ` M${p.severity}` : '';
  const title = `${typeName}${mag} — ${country}`;
  const pop = p.population != null ? p.population.toLocaleString('en-US') : null;
  const start = p.fromdate ? p.fromdate.slice(0, 10) : 'recent';
  const summary = `${typeName} alert (${p.alertlevel || 'unknown'} level) in ${country}.` +
    (pop ? ` Affected population estimate: ${pop}.` : '') +
    ` Start ${start}.`;
  return {
    id: `gdacs_${p.eventtype || 'UNK'}_${p.eventid}`,
    title,
    summary,
    lat: typeof coords[1] === 'number' ? coords[1] : null,
    lon: typeof coords[0] === 'number' ? coords[0] : null,
    region: country !== 'Unknown region' ? country : null,
    time: p.datemodified || p.fromdate || new Date().toISOString(),
    severity: severityFromAlert(p.alertlevel),
    url: `https://www.gdacs.org/event/${p.eventtype || ''}?eventid=${p.eventid}&episodeid=${p.episodeid || 1}`,
    attribution: 'GDACS',
  };
}

async function fetchJson(url) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
  try {
    const r = await Promise.race([fetch(url, {
      headers: { 'User-Agent': 'Central-Intelligence/1.0' },
    }, timer__dl)]);
    if (!r.ok) return null;
    return await r.json();
  } finally {
    clearTimeout(timer__t);
  }
}

module.exports = {
  name: 'gdacs',
  description: 'GDACS — global disaster alert and coordination system',
  async fetch() {
    try {
      const fromDate = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
      const toDate = new Date().toISOString().slice(0, 10);
      const url = `${ENDPOINT}?fromDate=${fromDate}&toDate=${toDate}&alertlevel=Green;Orange;Red`;
      const data = await fetchJson(url);
      const features = data && Array.isArray(data.features) ? data.features : [];
      return features.slice(0, 30).map(mapEvent);
    } catch {
      return [];
    }
  },
};
