// GDELT 2.0 DOC API — global conflict/crisis news events (keyless).
// Fetches recent articles on conflict, crisis, and geopolitics topics and
// maps them into raw intelligence event records.

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

const QUERIES = [
  'conflict OR war OR military OR airstrike OR missile',
  'crisis OR emergency OR disaster OR earthquake OR explosion',
  'sanctions OR cyberattack OR protest OR coup OR ceasefire',
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

async function fetchJSON(url) {
  try {
    const res = await withTimeout(globalThis.fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    }));
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// "20260927T143000Z" -> ISO 8601; falls back to now
function parseTime(seendate) {
  if (typeof seendate === 'string' && /^\d{8}T\d{6}Z$/.test(seendate)) {
    const iso = `${seendate.slice(0,4)}-${seendate.slice(4,6)}-${seendate.slice(6,8)}T${seendate.slice(9,11)}:${seendate.slice(11,13)}:${seendate.slice(13,15)}Z`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function severityOf(title) {
  const t = (title || '').toLowerCase();
  if (/\b(nuclear|nuke|chemical weapon|genocide|massacre)\b/.test(t)) return 'critical';
  if (/\b(war|airstrike|missile|bomb|attack|invasion|kill|dead|explosion|coup)\b/.test(t)) return 'high';
  if (/\b(military|troops|conflict|sanction|strike|protest|threat|warning|cyberattack)\b/.test(t)) return 'moderate';
  return 'low';
}

function hashId(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  }
  return 'gdelt-' + (h >>> 0).toString(36);
}

function mapArticle(a) {
  const title = (a.title || '').trim();
  if (!title || !a.url) return null;
  return {
    id: hashId(a.url),
    title: title.length > 140 ? title.slice(0, 137) + '...' : title,
    summary: null,
    lat: null,
    lon: null,
    region: a.sourcecountry || null,
    time: parseTime(a.seendate),
    severity: severityOf(title),
    url: a.url,
    attribution: 'GDELT',
  };
}

async function fetch() {
  // Sequential with 6s gaps: GDELT asks for ≤1 request per 5 seconds.
  const records = [];
  for (const q of QUERIES) {
    const params = new URLSearchParams({
      query: q,
      mode: 'ArtList',
      maxrecords: '40',
      timespan: '24h',
      format: 'json',
      sort: 'DateDesc',
    });
    const data = await fetchJSON(`${BASE}?${params}`);
    const articles = data && Array.isArray(data.articles) ? data.articles : [];
    for (const a of articles) {
      const rec = mapArticle(a);
      if (rec && !records.some((x) => x.id === rec.id)) records.push(rec);
    }
    if (QUERIES.indexOf(q) < QUERIES.length - 1) {
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
  return records;
}

module.exports = {
  name: 'gdelt',
  description: 'GDELT global news — conflict, crisis, and geopolitical events (24h)',
  fetch,
};
