// GDELT 2.0 DOC API — natural disaster news (floods, wildfires, quakes, storms).
// Articles are clustered by (category, country, location, day) so N articles
// about one flood become a single event record.

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

const CATEGORIES = [
  { id: 'flood',     query: '(flood OR flooding OR flooded OR flashflood)',                                  severity: 'moderate' },
  { id: 'wildfire',  query: '(wildfire OR bushfire OR "forest fire")',                                      severity: 'moderate' },
  { id: 'storm',     query: '(tornado OR hurricane OR typhoon OR cyclone OR blizzard OR "ice storm")',       severity: 'high' },
  { id: 'earthquake',query: '(earthquake OR tsunami OR landslide OR mudslide OR volcano)',                  severity: 'high' },
  { id: 'heatwave',  query: '("heat wave" OR heatwave OR "extreme heat" OR drought OR famine)',              severity: 'moderate' },
];

// Timeout via race, not AbortController: aborting an in-flight fetch through
// this environment's egress proxy can wedge the event loop (Node 24
// RangeError loop in PromiseRejectCallback). The socket is left to settle.
function withTimeout(promise, ms = TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function fetchArticles(query) {
  try {
    const params = new URLSearchParams({
      query, mode: 'ArtList', maxrecords: '20',
      timespan: '48h', format: 'json', sort: 'DateDesc',
    });
    const res = await withTimeout(globalThis.fetch(`${BASE}?${params}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    }));
    if (!res || !res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.articles)
      ? data.articles.filter(a => a.url && a.title && a.seenCountries?.length)
      : [];
  } catch {
    return [];
  }
}

// Cluster key: category + first seen country + rough location + day
function clusterKey(a, catId) {
  const title = (a.title || '').toLowerCase();
  const country = (a.seenCountries && a.seenCountries[0]) || 'XX';
  const m = title.match(/(?:in|near|at|across|off the coast of)\s+([a-z][a-z\s-]{2,40})/);
  const location = (m ? m[1] : (a.domain || '').split('.')[0]).trim();
  const day = (a.seendate || '').slice(0, 8) || 'unknown';
  return `${catId}::${country}::${location}::${day}`;
}

function countryName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

async function fetch() {
  const records = [];
  const seen = new Set();
  // Sequential with 6s gaps: GDELT asks for ≤1 request per 5 seconds.
  for (const cat of CATEGORIES) {
    const articles = await fetchArticles(cat.query);
    for (const a of articles) {
      const key = clusterKey(a, cat.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const country = (a.seenCountries && a.seenCountries[0]) || 'XX';
      const title = a.title.trim();
      records.push({
        id: 'gdelt-disaster-' + key.replace(/[^a-z0-9]+/gi, '-'),
        title: `${cat.id.toUpperCase()}: ${title.length > 120 ? title.slice(0, 117) + '...' : title}`,
        summary: `${cat.id} reported in ${countryName(country)}. Source: ${a.domain || 'GDELT'}.`,
        lat: null,
        lon: null,
        region: countryName(country),
        time: new Date().toISOString(),
        severity: cat.severity,
        url: a.url,
        attribution: 'GDELT',
      });
    }
    if (CATEGORIES.indexOf(cat) < CATEGORIES.length - 1) {
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
  return records;
}

module.exports = {
  name: 'gdelt_disasters',
  description: 'GDELT disaster news — floods, fires, storms, quakes (clustered events)',
  fetch,
};
