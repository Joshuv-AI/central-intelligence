// Bluesky social signal — public AT Protocol search (keyless).
// Queries app.bsky.feed.searchPosts for intel-topic chatter and maps the
// top recent posts to event records.

const UA = 'Central-Intelligence/1.0';
const BASE = 'https://public.api.bsky.app/xrpc';
// NOTE: the module exports its own `fetch`, so capture the real HTTP fetch
// explicitly — a bare `fetch(...)` inside this file would recurse into the export.
const httpFetch = globalThis.fetch.bind(globalThis);
const TIMEOUT = 20000;
const CAP = 15;

const QUERIES = [
  { topic: 'conflict', q: 'missile strike OR airstrike OR war OR sanctions' },
  { topic: 'markets', q: 'market crash OR oil prices OR gold OR recession' },
  { topic: 'health', q: 'pandemic OR outbreak OR epidemic' },
];

async function fetchJSON(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT); });
  try {
    const res = await Promise.race([httpFetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    }, t__dl)]);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

function postUrl(post) {
  const handle = post?.author?.handle;
  const uri = post?.uri || '';
  const rkey = uri.split('/').pop();
  if (handle && rkey) return `https://bsky.app/profile/${handle}/post/${rkey}`;
  return null;
}

function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function mapPost(post, topic) {
  const record = post?.record || {};
  const text = String(record?.text || '').trim();
  if (!text) return null;
  const handle = post?.author?.handle || post?.author?.displayName || 'unknown';
  const firstLine = text.split('\n')[0];
  const title = firstLine.length > 130 ? firstLine.slice(0, 127) + '...' : firstLine;
  let time = null;
  if (record?.createdAt) {
    const d = new Date(record.createdAt);
    if (!isNaN(d.getTime())) time = d.toISOString();
  }
  return {
    id: `bsky-${hashId(post?.uri || text.slice(0, 80))}`,
    title: `[${topic}] ${title}`,
    summary: `@${handle}: ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`,
    lat: null,
    lon: null,
    region: null,
    time: time || new Date().toISOString(),
    severity: topic === 'conflict' || topic === 'health' ? 'moderate' : 'low',
    url: postUrl(post),
    attribution: 'Bluesky',
  };
}

async function fetch() {
  const records = [];
  const seen = new Set();
  try {
    for (const { topic, q } of QUERIES) {
      const params = new URLSearchParams({ q, limit: '10', sort: 'latest' });
      const data = await fetchJSON(`${BASE}/app.bsky.feed.searchPosts?${params}`);
      const posts = Array.isArray(data?.posts) ? data.posts : [];
      for (const p of posts) {
        const rec = mapPost(p, topic);
        if (rec && !seen.has(rec.id)) {
          seen.add(rec.id);
          records.push(rec);
        }
        if (records.length >= CAP) break;
      }
      if (records.length >= CAP) break;
      // small delay between queries to stay polite
      await new Promise(r => setTimeout(r, 800));
    }
  } catch {
    return [];
  }
  return records;
}

module.exports = {
  name: 'bluesky',
  description: 'Bluesky public search — intel-topic social signal',
  fetch,
};
