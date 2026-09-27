// Reddit OSINT — hot posts from intel-relevant subreddits.
// Requires OAuth: set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.
// Without either, fetch() resolves to [] immediately (no keys needed for the rest).

const UA = 'Central-Intelligence/1.0';
// NOTE: the module exports its own `fetch`, so capture the real HTTP fetch
// explicitly — a bare `fetch(...)` inside this file would recurse into the export.
const httpFetch = globalThis.fetch.bind(globalThis);
const TIMEOUT = 20000;
const CAP = 15;

const SUBREDDITS = ['worldnews', 'geopolitics', 'economics', 'commodities', 'wallstreetbets'];

const INTEL_KEYWORDS = /\b(war|conflict|missile|airstrike|sanctions?|nuclear|cyberattack|coup|protest|terror|hostage|ceasefire|troops|military|embargo|election|parliament|earthquake|outbreak|pandemic|sanctions|oil|opec|fed|interest rate|inflation|default|trade deal|tariff)\b/i;

async function fetchWithTimeout(url, opts = {}) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([httpFetch(url, {
      method: opts.method || 'GET',
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      body: opts.body,
    }), t__dl]);
    if (!res.ok) return null;
    return opts.text ? await res.text() : await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

async function getToken(clientId, clientSecret) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const data = await fetchWithTimeout('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  return data?.access_token || null;
}

function severityOf(title) {
  const t = (title || '').toLowerCase();
  if (/\b(nuclear|war|missile|airstrike|terror|hostage|coup|earthquake|attack|killed|dead)\b/.test(t)) return 'high';
  if (/\b(military|troops|conflict|sanction|protest|threat|warning|cyberattack|outbreak|tariff|crash)\b/.test(t)) return 'moderate';
  return 'low';
}

function mapChild(child, subreddit) {
  const d = child?.data;
  if (!d || !d.title) return null;
  if (!INTEL_KEYWORDS.test(`${d.title} ${d.selftext || ''}`)) return null;
  const title = String(d.title).trim();
  const selftext = String(d.selftext || '').trim();
  let time = null;
  if (d.created_utc) {
    const dt = new Date(d.created_utc * 1000);
    if (!isNaN(dt.getTime())) time = dt.toISOString();
  }
  return {
    id: `reddit-${d.id || subreddit}-${Math.floor((d.created_utc || 0) / 60)}`,
    title: `[r/${subreddit}] ${title.length > 130 ? title.slice(0, 127) + '...' : title}`,
    summary: selftext ? selftext.slice(0, 200) + (selftext.length > 200 ? '...' : '') : null,
    lat: null,
    lon: null,
    region: null,
    time: time || new Date().toISOString(),
    severity: severityOf(title),
    url: d.permalink ? `https://www.reddit.com${d.permalink}` : (d.url || null),
    attribution: 'Reddit',
  };
}

async function fetch() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return []; // no keys -> degrade silently

  const records = [];
  const seen = new Set();
  try {
    const token = await getToken(clientId, clientSecret);
    if (!token) return [];
    for (const sub of SUBREDDITS) {
      const data = await fetchWithTimeout(
        `https://oauth.reddit.com/r/${sub}/hot?limit=10&raw_json=1`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const children = data?.data?.children || [];
      for (const c of children) {
        const rec = mapChild(c, sub);
        if (rec && !seen.has(rec.id)) {
          seen.add(rec.id);
          records.push(rec);
        }
        if (records.length >= CAP) break;
      }
      if (records.length >= CAP) break;
      await new Promise(r => setTimeout(r, 800));
    }
  } catch {
    return [];
  }
  return records;
}

module.exports = {
  name: 'reddit',
  description: 'Reddit hot posts — intel-relevant threads (OAuth required)',
  keyEnv: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  fetch,
};
