/* Wave 1 (J4-05 / J4-19 / J4-11) — coarse age formatter, the one
   formatter for "how old is this datum" everywhere.

   Contract (binds J4-19's counter):
   - Coarse buckets only: "just now" · "2 m" · "3 h" · "4 d". Never seconds
     beyond the "just now" window, never tick-every-second precision.
   - Rendered on data change only; callers must not re-render on a timer to
     advance the age. The age is a render-time label, not a clock.
   - Pure, no DOM, unit-testable in Node. */

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Coarse age for a timestamp.
 * @param {number|string|Date|null|undefined} ts epoch ms (or ISO string/Date)
 * @param {number} [nowMs] injectable clock for tests
 * @returns {string} "just now" | "2 m" | "3 h" | "4 d" | "—"
 */
export function formatAge(ts, nowMs = Date.now()) {
  const t = ts instanceof Date ? ts.getTime() : typeof ts === 'string' ? Date.parse(ts) : Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const diff = nowMs - t;
  if (diff < 0) return 'just now'; // future timestamps: never show negative age
  if (diff < MIN_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MIN_MS)} m`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} h`;
  return `${Math.floor(diff / DAY_MS)} d`;
}

/**
 * "source · age" provenance chip text (J4-05 / J4-19).
 * @param {object} p
 * @param {string} [p.source] source name
 * @param {number|string|Date} [p.fetchedAtMs] when the datum was fetched
 * @param {boolean} [p.stale] stale data keeps its age visible — staleness IS the display
 * @param {number} [nowMs]
 * @returns {string} e.g. "USGS · 12 m", "FIRMS · key needed", "AIS · —"
 */
export function sourceAgeText({ source, fetchedAtMs, stale = false } = {}, nowMs = Date.now()) {
  const src = typeof source === 'string' && source.trim() ? source.trim() : 'Unknown source';
  const age = formatAge(fetchedAtMs, nowMs);
  // "just now" takes no "ago" — "just now ago" is not a sentence.
  const base = age === '—' ? `${src} · age unknown` : age === 'just now' ? `${src} · just now` : `${src} · ${age} ago`;
  return stale ? `${base} · STALE` : base;
}
