/* Wave 2 (J4-01) — "What matters now": a mechanical, inspectable ranking
   over the EXISTING fusion/delta/feed outputs. No generated prose anywhere
   (the briefings cut is a hard line): each row carries a one-line reason
   built from measured inputs, and the ranking formula is inspectable
   in-app via the "Why this order?" affordance.

   Scoring (documented in RANKING_EXPLAINER, shown verbatim in the UI):
   - severity: severity step × 25 (Critical 75 · High 50 · Moderate 25 · Low 0)
   - freshness: event/connection age under 6 h → +15; under 24 h → +8;
     under 48 h → +3
   - link strength (connections only): up to +9 from the fusion score
     (round(score / 10), capped at 9)
   - corroboration: +5 when 2+ independent sources back the item

   Dedup rule: an event already shown as a member of a ranked connection is
   listed once, under the connection — never twice.

   Pure, no DOM, unit-testable in Node. */
import {
  SEV_RANK, SEV_LABEL, plainScore, passesSeverityFloor, cleanTitle,
} from '../intel/model.js';
import { formatAge } from '../ui/ageFormat.js';

export const TOP_N = 8;

export const RANKING_EXPLAINER =
  'Each development scores points, highest first. ' +
  'Severity: Critical 75 · High 50 · Moderate 25 · Low 0. ' +
  'Freshness: under 6 h +15 · under 24 h +8 · under 48 h +3. ' +
  'Linked events: up to +9 from the link strength. ' +
  'Corroboration: +5 when 2 or more independent sources back it. ' +
  'An event already shown inside a ranked link is listed once, under the link. ' +
  'No text is written by the system — every reason below is a measured fact.';

function ageMs(item, kind, nowMs) {
  const t = kind === 'connection' ? item.createdAt : item.time;
  const ms = t ? new Date(t).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function freshnessPts(ms, nowMs) {
  if (ms === null) return 0;
  const age = nowMs - ms;
  if (age < 0) return 15; // future-dated: treat as fresh, never negative
  if (age < 6 * 3600_000) return 15;
  if (age < 24 * 3600_000) return 8;
  if (age < 48 * 3600_000) return 3;
  return 0;
}

function corroborationSources(item, kind) {
  if (kind !== 'connection') return 0;
  const fromReasons = Array.isArray(item.reasons)
    ? item.reasons.find((r) => r && r.code === 'sources')
    : null;
  if (fromReasons && Number.isFinite(fromReasons.count)) return fromReasons.count;
  const chainSources = new Set(
    (Array.isArray(item.chain) ? item.chain : [])
      .map((s) => (typeof s?.source === 'string' ? s.source.trim() : ''))
      .filter(Boolean),
  );
  return chainSources.size;
}

function ageFragment(ms, nowMs) {
  if (ms === null) return null;
  const age = formatAge(ms, nowMs);
  if (age === '—') return null;
  return age === 'just now' ? 'updated just now' : `${age} old`;
}

/**
 * Rank the current picture. Inputs are the live snapshot shapes the intel
 * store already holds — nothing is fetched for this view.
 * @param {object} p
 * @param {Array} [p.markers] intel events
 * @param {Array} [p.connections] fusion connections
 * @param {string} [p.severityFloor] 'all' | 'notable' | 'high'
 * @param {number} [p.nowMs]
 * @returns {Array<{kind:'event'|'connection', id, item, score, parts, reasons:string[]}>}
 */
export function rankWhatMatters({ markers = [], connections = [], severityFloor = 'all', nowMs = Date.now() } = {}) {
  const rankedConns = (Array.isArray(connections) ? connections : [])
    .filter((c) => c && passesSeverityFloor(c, severityFloor))
    .map((c) => {
      const ms = ageMs(c, 'connection', nowMs);
      const sevPts = (SEV_RANK[c.severity] ?? 0) * 25;
      const freshPts = freshnessPts(ms, nowMs);
      const linkPts = Number.isFinite(c.score) ? Math.min(9, Math.round(c.score / 10)) : 0;
      const nSrc = corroborationSources(c, 'connection');
      const corrPts = nSrc >= 2 ? 5 : 0;
      const reasons = [
        `${SEV_LABEL[c.severity] || 'Low'} severity`,
        ageFragment(ms, nowMs),
        plainScore(c) || null,
        nSrc >= 2 ? `corroborated by ${nSrc} sources` : null,
      ].filter(Boolean);
      return {
        kind: 'connection',
        id: c.id,
        item: c,
        score: sevPts + freshPts + linkPts + corrPts,
        parts: { severity: sevPts, freshness: freshPts, link: linkPts, corroboration: corrPts },
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

  // Dedup: members of a ranked connection are shown under the connection.
  const connEventIds = new Set();
  for (const r of rankedConns)
    for (const id of r.item.eventIds || []) connEventIds.add(id);

  const rankedEvents = (Array.isArray(markers) ? markers : [])
    .filter((e) => e && e.id && e.title && passesSeverityFloor(e, severityFloor))
    .filter((e) => !connEventIds.has(e.id))
    .map((e) => {
      const ms = ageMs(e, 'event', nowMs);
      const sevPts = (SEV_RANK[e.severity] ?? 0) * 25;
      const freshPts = freshnessPts(ms, nowMs);
      const reasons = [
        `${SEV_LABEL[e.severity] || 'Low'} severity`,
        ageFragment(ms, nowMs),
        e.source ? `reported by ${e.source}` : null,
      ].filter(Boolean);
      return {
        kind: 'event',
        id: e.id,
        item: e,
        score: sevPts + freshPts,
        parts: { severity: sevPts, freshness: freshPts, link: 0, corroboration: 0 },
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

  const merged = [...rankedConns, ...rankedEvents]
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

  return merged.slice(0, TOP_N).map((r, i) => ({ ...r, rank: i + 1 }));
}

/** One-line headline for a ranked row. */
export function rankedHeadline(row) {
  const item = row?.item || {};
  return cleanTitle(item.title || '');
}
