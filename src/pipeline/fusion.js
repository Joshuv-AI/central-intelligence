// Central Intelligence — fusion engine (rule-based).
// Finds cross-domain correlations and emits "connections": plain-language
// causal chains, severity-ordered. No LLM — deterministic rules only.
//
// Score = severity 40 + confidence 20 + cascade 15 + proximity 15 (max 90).
//   >= 80  -> critical   >= 65 -> high   >= 50 -> standard   < 50 -> dropped
const { createHash } = require('crypto');
const { impactTags, causesTag, sevRank } = require('./intel_tags');

const TIME_WINDOW_MS = 72 * 3600_000;
const MAX_PAIRS = 2000;
const MAX_CONNECTIONS = 20;
const MIN_SCORE = 50;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function withinTime(a, b) {
  const ta = new Date(a.time).getTime();
  const tb = new Date(b.time).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return true; // unknown time: don't exclude
  return Math.abs(ta - tb) <= TIME_WINDOW_MS;
}

function sharedTags(a, b) {
  const ta = new Set(impactTags(a));
  const tb = new Set(impactTags(b));
  return [...ta].filter((t) => tb.has(t));
}

// Order a pair as [cause, effect]: causality first, then time, then severity.
function orderPair(a, b) {
  if (causesTag(a, b) && !causesTag(b, a)) return [a, b];
  if (causesTag(b, a) && !causesTag(a, b)) return [b, a];
  const ta = new Date(a.time).getTime();
  const tb = new Date(b.time).getTime();
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta < tb ? [a, b] : [b, a];
  return sevRank(a.severity) >= sevRank(b.severity) ? [a, b] : [b, a];
}

function jaccard(a, b) {
  const ta = new Set(impactTags(a));
  const tb = new Set(impactTags(b));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union ? inter / union : 0;
}

function geoScore(chain) {
  const geo = chain.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
  if (geo.length < 2) return 4; // non-geo chains get partial credit, not punished
  let maxD = 0;
  for (let i = 0; i < geo.length; i++) {
    for (let j = i + 1; j < geo.length; j++) {
      maxD = Math.max(maxD, haversineKm(geo[i], geo[j]));
    }
  }
  if (maxD < 500) return 8;
  if (maxD < 1500) return 5;
  if (maxD < 4000) return 2;
  return 0;
}

function timeScore(chain) {
  const ts = chain.map((e) => new Date(e.time).getTime()).filter((t) => !Number.isNaN(t));
  if (ts.length < 2) return 4;
  const gap = Math.max(...ts) - Math.min(...ts);
  if (gap < 6 * 3600_000) return 7;
  if (gap < 24 * 3600_000) return 5;
  if (gap <= TIME_WINDOW_MS) return 2;
  return 0;
}

function scoreChain(chain) {
  const maxSev = Math.max(...chain.map((e) => sevRank(e.severity)));
  const severityPts = maxSev * 10; // 10..40

  let jac = 0;
  let pairs = 0;
  for (let i = 0; i < chain.length; i++) {
    for (let j = i + 1; j < chain.length; j++) {
      jac += jaccard(chain[i], chain[j]);
      pairs++;
    }
  }
  const confidencePts = pairs ? Math.round((jac / pairs) * 20) : 0; // 0..20

  let causalLinks = 0;
  for (let i = 0; i < chain.length - 1; i++) {
    if (causesTag(chain[i], chain[i + 1])) causalLinks++;
  }
  const cascadePts =
    causalLinks === chain.length - 1 ? 15 : causalLinks > 0 ? 7 : 0; // 0..15

  const proximityPts = Math.min(15, geoScore(chain) + timeScore(chain)); // 0..15

  return {
    score: severityPts + confidencePts + cascadePts + proximityPts,
    parts: { severity: severityPts, confidence: confidencePts, cascade: cascadePts, proximity: proximityPts },
  };
}

function chainId(chain) {
  const ids = chain.map((e) => e.id).sort().join('|');
  return 'fusion-' + createHash('sha1').update(ids).digest('hex').slice(0, 12);
}

function shortTitle(t, n = 64) {
  const s = String(t || '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function cleanTitle(t) {
  // Remove source prefixes like "PRO/AH/EDR>" for readability
  return String(t || '').replace(/^[A-Z]+\/[A-Z]+\/[A-Z]+>\s*/, '').trim();
}

function buildConnection(chain, scoreInfo) {
  const [cause, ...rest] = chain;
  const effect = rest[rest.length - 1];
  const tags = [...new Set(chain.flatMap((e) => impactTags(e)))].map((t) => t.replace(/_/g, ' '));
  const severity = chain
    .map((e) => e.severity)
    .sort((a, b) => sevRank(b) - sevRank(a))[0];
  const { score } = scoreInfo;
  const domains = [...new Set(chain.map((e) => e.domain))];
  return {
    id: chainId(chain),
    title: `${shortTitle(cleanTitle(cause.title))} → ${shortTitle(cleanTitle(effect.title))}`,
    summary:
      `These ${chain.length} events may be connected through shared ${tags.slice(0, 3).join(', ')} impacts` +
      (cause.cascadeNote ? `. ${cause.cascadeNote}` : '') +
      `. Spanning ${domains.join(', ')}.`,
    severity,
    score,
    scoreParts: scoreInfo.parts,
    tier: score >= 90 ? 'critical' : score >= 75 ? 'high' : 'standard',
    tags,
    chain: chain.map((e, i) => ({
      eventId: e.id,
      role: i === 0 ? 'cause' : i === chain.length - 1 ? 'effect' : 'link',
      title: cleanTitle(e.title),
      severity: e.severity,
      time: e.time,
      lat: e.lat,
      lon: e.lon,
      region: e.region,
      source: e.source,
      url: e.url,
    })),
    eventIds: chain.map((e) => e.id),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Run fusion over the full event set. Returns top connections (score >= 50).
 */
function runFusion(events) {
  const pool = (events || []).filter((e) => e && e.id && e.title);
  if (pool.length < 2) return [];

  // Group by impact tag so pairing stays cheap.
  const byTag = new Map();
  for (const e of pool) {
    for (const t of impactTags(e)) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(e);
    }
  }

  const seenPairs = new Set();
  const candidates = [];
  for (const group of byTag.values()) {
    // Keep the most significant events when a tag group is huge.
    const sorted = group
      .slice()
      .sort(
        (a, b) =>
          sevRank(b.severity) - sevRank(a.severity) ||
          new Date(b.time) - new Date(a.time)
      )
      .slice(0, 40);
    for (let i = 0; i < sorted.length && candidates.length < MAX_PAIRS; i++) {
      for (let j = i + 1; j < sorted.length && candidates.length < MAX_PAIRS; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (a.id === b.id || a.source === b.source) continue; // cross-source only
        if (!withinTime(a, b)) continue;
        if (sharedTags(a, b).length === 0) continue;
        const key = [a.id, b.id].sort().join('|');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        candidates.push(orderPair(a, b));
      }
    }
  }

  // Extend pairs into 3-chains where a causal link continues.
  const chains = [];
  const seenChains = new Set();
  for (const [a, b] of candidates) {
    let extended = false;
    for (const c of pool) {
      if (c.id === a.id || c.id === b.id || c.source === b.source) continue;
      if (!withinTime(b, c) || sharedTags(b, c).length === 0) continue;
      if (!causesTag(b, c)) continue;
      const chain = [a, b, c];
      const id = chainId(chain);
      if (seenChains.has(id)) continue;
      seenChains.add(id);
      chains.push(chain);
      extended = true;
      break; // one extension per pair keeps output readable
    }
    if (!extended) {
      const id = chainId([a, b]);
      if (!seenChains.has(id)) {
        seenChains.add(id);
        chains.push([a, b]);
      }
    }
  }

  const scored = [];
  for (const chain of chains) {
    const info = scoreChain(chain);
    if (info.score >= MIN_SCORE) scored.push(buildConnection(chain, info));
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_CONNECTIONS);
}

module.exports = { runFusion, scoreChain, MIN_SCORE };
