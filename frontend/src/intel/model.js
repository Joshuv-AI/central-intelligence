/* Lane G — intel model: pure helpers (no DOM, no Cesium) so the plain-
   language, dedup, band and health logic is unit-testable in Node.
   Data shapes are the sovereign CI contract (see lane log header). */

export const SEVERITIES = ['low', 'moderate', 'high', 'critical'];
export const SEV_RANK = { low: 0, moderate: 1, high: 2, critical: 3 };
export const SEV_COLORS = {
  low: '#7FCEF0',
  moderate: '#FFD166',
  high: '#FFB020',
  critical: '#FF5A5A',
};
/** Severity in stakes language (kept from the old Guide — it was right). */
export const SEV_PLAIN = {
  low: 'Routine signal — background noise.',
  moderate: 'Worth a look.',
  high: 'Significant development.',
  critical: 'Demands attention now.',
};
export const SEV_LABEL = {
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  critical: 'Critical',
};

export const DOMAIN_LABELS = {
  conflict: 'Conflict',
  cyber: 'Cyber',
  economic: 'Economic',
  health: 'Health',
  environment: 'Environment',
  space: 'Space',
  sanctions: 'Sanctions',
  disasters: 'Disasters',
  signals: 'Signals',
  social: 'Social',
};

/* Regions: one filter drives camera AND markers AND feed (old CI B8). */
export const REGIONS = [
  { id: 'world', label: 'World', lon: 10, lat: 18, height: 26_000_000, keywords: [] },
  { id: 'americas', label: 'Americas', lon: -100, lat: 22, height: 17_000_000, keywords: ['america', 'united states', 'usa', 'canada', 'mexico', 'brazil', 'latin', 'caribbean', 'colombia', 'argentina', 'peru', 'chile', 'venezuela', 'panama', 'cuba', 'haiti'] },
  { id: 'europe', label: 'Europe', lon: 15, lat: 50, height: 9_000_000, keywords: ['europe', 'ukraine', 'russia', 'belarus', 'poland', 'germany', 'france', 'united kingdom', 'italy', 'spain', 'balkans'] },
  { id: 'middle-east', label: 'Middle East', lon: 45, lat: 25, height: 9_000_000, keywords: ['middle east', 'israel', 'gaza', 'palestin', 'iran', 'iraq', 'syria', 'yemen', 'saudi', 'lebanon', 'turkey', 'turkiye', 'qatar', 'jordan', 'red sea'] },
  { id: 'asia-pacific', label: 'Asia Pacific', lon: 130, lat: 14, height: 17_000_000, keywords: ['asia', 'china', 'taiwan', 'japan', 'korea', 'india', 'pakistan', 'pacific', 'australia', 'philippines', 'indonesia', 'myanmar', 'thailand', 'vietnam', 'south china sea'] },
  { id: 'africa', label: 'Africa', lon: 20, lat: 4, height: 13_000_000, keywords: ['africa', 'sudan', 'somalia', 'nigeria', 'egypt', 'libya', 'ethiopia', 'congo', 'sahel', 'mali', 'kenya', 'chad', 'niger'] },
];

export function regionMatches(regionId, event) {
  if (!regionId || regionId === 'world') return true;
  const region = REGIONS.find((r) => r.id === regionId);
  if (!region) return true;
  if (!event?.region) return true; // no regional signal: stays visible (old CI rule)
  const hay = `${event.region} ${event.title || ''}`.toLowerCase();
  return region.keywords.some((k) => hay.includes(k));
}

export function isGeo(e) {
  return !!e && Number.isFinite(e.lat) && Number.isFinite(e.lon);
}

/* ——— §L zoom bands (camera height in metres) ——— */
export function bandForHeight(heightM) {
  if (!Number.isFinite(heightM) || heightM > 12_000_000) return 'B0';
  if (heightM > 4_000_000) return 'B1';
  if (heightM > 650_000) return 'B2';
  if (heightM > 60_000) return 'B3';
  if (heightM > 8_000) return 'B4';
  return 'B5';
}
/** Which connection tiers may render rings/arcs in a band (§7 table). */
export function connectionTierVisible(conn, band) {
  if (band === 'B0') return false;
  const tier = conn?.tier || (SEV_RANK[conn?.severity] >= 3 ? 'critical' : SEV_RANK[conn?.severity] >= 2 ? 'high' : 'standard');
  if (band === 'B1') return tier === 'critical';
  if (band === 'B2') return tier === 'critical' || tier === 'high';
  return true;
}
export function clusterPixelRange(band) {
  return band === 'B0' ? 96 : band === 'B1' ? 72 : band === 'B2' ? 64 : 48;
}

/* ——— plain language ——— */
/** Translate the brain's direction token; never show it unexplained. */
export function plainDirection(status) {
  const dir = status?.direction;
  const hot = status?.hot24 ?? 0;
  const crit = status?.critical24 ?? 0;
  if (dir === 'RISK-ON')
    return { word: 'Needs attention', detail: `${crit} critical and ${hot} serious events in the last 24 hours.` };
  if (dir === 'RISK-OFF')
    return { word: 'Calm', detail: 'Nothing serious in the last 24 hours.' };
  if (dir === 'MIXED')
    return { word: 'Mixed', detail: `${hot} serious events in the last 24 hours, none critical.` };
  return { word: 'Waiting for data', detail: 'The first sweep has not finished yet.' };
}

/** What a connection score means, in one line (§F gloss for SCORE). */
export function plainScore(conn) {
  const s = conn?.score;
  if (!Number.isFinite(s)) return '';
  const word = s >= 90 ? 'Very strong link' : s >= 75 ? 'Strong link' : s >= 50 ? 'Possible link' : 'Weak link';
  return `${word} · strength ${s} of 90`;
}

/** Structured plain summary for a connection — replaces the backend's
    fragment summary ("…impacts. Spanning disasters."). */
export function plainConnectionSummary(conn) {
  const chain = conn?.chain || [];
  if (chain.length < 2) return conn?.title || '';
  const tags = (conn?.tags || []).slice(0, 3);
  const parts = [];
  if (tags.length) parts.push(`both affect ${tags.join(', ')}`);
  const p = conn?.scoreParts || {};
  if ((p.cascade || 0) >= 7) parts.push('one may have caused the other');
  if ((p.proximity || 0) >= 10) parts.push('they happened close together in time and place');
  else if ((p.proximity || 0) >= 5) parts.push('they happened near each other in time or place');
  const why = parts.length ? ` Why linked: ${parts.join('; ')}.` : '';
  return `${chain.length} events from different sources look connected.${why}`;
}

export function cleanTitle(t) {
  return String(t || '').replace(/^[A-Z]+\/[A-Z]+\/[A-Z]+>\s*/, '').trim();
}

/* ——— feed: dedupe + threshold (B4) ——— */
export function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const FEED_TTL_MS = 48 * 3600_000;
/**
 * Client-side second gate on top of the backend's story gate:
 * collapse duplicate/near-duplicate headlines, drop stale items, drop
 * low-signal raw events, cap anomalies at one per source.
 */
export function dedupeFeed(feed, now = Date.now()) {
  const out = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  const anomalySources = new Set();
  for (const f of Array.isArray(feed) ? feed : []) {
    if (!f || typeof f.id !== 'string' || seenIds.has(f.id)) continue;
    const t = f.time ? new Date(f.time).getTime() : 0;
    if (!Number.isFinite(t) || now - t > FEED_TTL_MS) continue;
    const headline = f.headline || f.text || '';
    const key = normTitle(headline);
    if (key && seenTitles.has(key)) continue;
    if (f.kind === 'event' && (SEV_RANK[f.severity] ?? 0) < 2) continue;
    if (f.kind === 'anomaly') {
      const src = f.source || 'unknown';
      if (anomalySources.has(src)) continue;
      anomalySources.add(src);
    }
    seenIds.add(f.id);
    if (key) seenTitles.add(key);
    out.push(f);
  }
  return out.slice(0, 30);
}

export const FEED_KIND_PLAIN = {
  connection: 'Linked events',
  escalation: 'Getting worse',
  event: 'New event',
  anomaly: 'Unusual volume',
};

/* ——— source health (B7) ——— */
export const SOURCE_STATUS_PLAIN = {
  ok: 'Live',
  pending: 'Waiting for first check',
  stale: 'Out of date',
  error: 'Failing — will retry',
  needs_key: 'Needs a key on the server',
};
export function summarizeSources(meta) {
  const sources = meta?.sources && typeof meta.sources === 'object' ? meta.sources : {};
  const rows = Object.entries(sources).map(([name, s]) => ({
    name,
    status: typeof s?.status === 'string' ? s.status : 'pending',
    plain: SOURCE_STATUS_PLAIN[s?.status] || 'Unknown',
    count: Number.isFinite(s?.count) ? s.count : 0,
    ms: Number.isFinite(s?.ms) ? s.ms : null,
    lastOk: s?.lastOk || null,
    tier: s?.tier ?? null,
  }));
  rows.sort((a, b) => {
    const order = { error: 0, stale: 1, needs_key: 2, pending: 3, ok: 4 };
    return (order[a.status] ?? 5) - (order[b.status] ?? 5) || a.name.localeCompare(b.name);
  });
  return {
    rows,
    total: rows.length,
    live: rows.filter((r) => r.status === 'ok').length,
    stale: rows.filter((r) => r.status === 'stale').length,
    failing: rows.filter((r) => r.status === 'error').length,
  };
}

export function lastSweepAt(meta) {
  const ls = meta?.lastSweep;
  if (!ls) return null;
  const at = typeof ls === 'object' ? ls.at : ls;
  const t = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/* ——— formatting ——— */
export function timeAgo(iso, now = Date.now()) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return 'unknown time';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/* ——— Wave 1 (J4-04): mechanical reason rendering ——— */
/* Reason codes come from the backend fusion engine (src/pipeline/fusion.js,
   buildReasons). Each code has ONE fixed template here — wording discipline
   IS the feature: mechanical phrasing only, never generated prose. Unknown
   codes are dropped, never guessed at. */
const REASON_TEMPLATES = {
  shared_tags: (r) => (Array.isArray(r.tags) && r.tags.length ? `shared effects: ${r.tags.join(', ')}` : null),
  time_window: (r) => (Number.isFinite(r.windowHours) ? `within the same ${r.windowHours} h window` : null),
  proximity_km: (r) => (Number.isFinite(r.withinKm) ? `within ${r.withinKm} km of each other` : null),
  sources: (r) => (Number.isFinite(r.count) && r.count >= 2 ? `${r.count} independent sources` : null),
  causal_link: () => 'one may have caused the other',
};

/**
 * Render backend reason codes as mechanical, inspectable reason strings.
 * @param {Array<{code:string}>} reasons
 * @returns {string[]} one plain fragment per known reason code
 */
export function formatReasons(reasons) {
  return (Array.isArray(reasons) ? reasons : [])
    .map((r) => {
      const tpl = r && REASON_TEMPLATES[r.code];
      if (!tpl) return null; // unknown code: dropped, never guessed
      try { return tpl(r) || null; } catch { return null; } // malformed param: dropped, never "undefined"
    })
    .filter(Boolean);
}

/**
 * One-line "why linked" for a connection card, from reason codes.
 * Falls back to the score-part summary when no codes exist (older snapshot).
 */
export function whyLinkedLine(conn) {
  const parts = formatReasons(conn?.reasons);
  if (parts.length) return `Why linked: ${parts.join(' · ')}.`;
  return ''; // caller falls back to plainConnectionSummary
}

/* ——— Wave 1 (J4-15): severity floor dial ——— */
/* One global filter: "Show me: All / Notable+ / High+". Ranks follow
   SEV_RANK: low 0, moderate 1, high 2, critical 3. */
export const SEV_FLOORS = Object.freeze([
  { id: 'all', label: 'All', minRank: 0, hint: 'Show everything' },
  { id: 'notable', label: 'Notable+', minRank: 1, hint: 'Notable and up — worth a look or more' },
  { id: 'high', label: 'High+', minRank: 2, hint: 'High and up — significant or critical only' },
]);

export function normalizeSeverityFloor(id) {
  const hit = SEV_FLOORS.find((f) => f.id === id);
  return hit ? hit.id : 'all';
}

export function severityFloorFor(id) {
  return SEV_FLOORS.find((f) => f.id === normalizeSeverityFloor(id));
}

/**
 * Does an item with a `severity` field survive the floor?
 * Unknown severity never hides an item (fail-visible, not fail-hidden).
 */
export function passesSeverityFloor(item, floorId) {
  const floor = severityFloorFor(floorId);
  if (floor.minRank <= 0) return true;
  const rank = SEV_RANK[item?.severity];
  if (rank === undefined) return true;
  return rank >= floor.minRank;
}

export function fmtTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'No coordinates — listed in the feed only';
  return `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
}
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
export function approxBytes(text) {
  return typeof text === 'string' ? new TextEncoder().encode(text).length : 0;
}
