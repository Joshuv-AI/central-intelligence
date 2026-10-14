/* Wave 1 (J4-05) — confidence & provenance, scoped.

   The adoption constraint binds this module:
   - source + age on every datum (cheap, always honest);
   - a confidence signal ONLY where a real one exists (multi-source
     corroboration count on fusion connections — never an invented %);
   - disagreements shown side-by-side, never averaged away.

   Pure helpers; the DOM surfaces compose them. */

import { formatAge } from './ageFormat.js';

/**
 * One-line provenance for a datum: "USGS · 12 m ago" / "USGS · 12 m ago · STALE".
 * @param {object} p
 * @param {string} [p.source]
 * @param {number|string|Date} [p.fetchedAtMs]
 * @param {boolean} [p.stale]
 * @param {number} [nowMs]
 */
export function provenanceLine({ source, fetchedAtMs, stale = false } = {}, nowMs = Date.now()) {
  const src = typeof source === 'string' && source.trim() ? source.trim() : 'Unknown source';
  const age = formatAge(fetchedAtMs, nowMs);
  // "just now" takes no "ago" — "just now ago" is not a sentence.
  const base = age === '—' ? `${src} · age unknown` : age === 'just now' ? `${src} · just now` : `${src} · ${age} ago`;
  return stale ? `${base} · STALE` : base;
}

/**
 * The only confidence signal the pipeline honestly carries: how many
 * independent sources corroborate this connection. Returns null when the
 * chain has no usable source signal — callers must render nothing rather
 * than invent a percentage.
 * @param {object} conn fusion connection (chain steps carry `source`)
 * @param {number} [nowMs]
 * @returns {string|null} e.g. "corroborated by 3 sources"
 */
export function confidenceLine(conn, nowMs = Date.now()) {
  const chain = Array.isArray(conn?.chain) ? conn.chain : [];
  const sources = new Set(
    chain.map((s) => (typeof s?.source === 'string' ? s.source.trim() : '')).filter(Boolean),
  );
  if (sources.size < 2) return null; // one source is not corroboration
  return `corroborated by ${sources.size} sources`;
}

/**
 * Render source disagreements side-by-side, never averaged.
 * @param {Array<{source:string, value:string}>} readings e.g. [{source:'USGS', value:'6.2'}, {source:'EMSC', value:'6.0'}]
 * @returns {string} "USGS says 6.2 · EMSC says 6.0" (mechanical, no averaging)
 */
export function disagreementLine(readings) {
  const rows = (Array.isArray(readings) ? readings : [])
    .filter((r) => r && typeof r.source === 'string' && r.source.trim() && r.value != null && String(r.value).trim())
    .map((r) => `${r.source.trim()} says ${String(r.value).trim()}`);
  if (rows.length < 2) return '';
  return rows.join(' · ');
}

/**
 * Pick the freshest honest timestamp for a datum from what the snapshot
 * actually carries. Preference: explicit fetchedAt, else sweep time, else
 * event time. Never fabricates "now".
 */
export function bestFetchedAt({ fetchedAtMs, sweepAtMs, eventTimeMs } = {}) {
  for (const t of [fetchedAtMs, sweepAtMs, eventTimeMs]) {
    const n = t instanceof Date ? t.getTime() : typeof t === 'string' ? Date.parse(t) : Number(t);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
