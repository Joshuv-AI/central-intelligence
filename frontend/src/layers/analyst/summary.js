/**
 * J4-10 · Screen-reader "current picture" summary — pure text builder.
 *
 * Mechanical, never narrative: counts by severity band plus the top items
 * as one-liners with coarse ages. Feeds the aria-live region the analyst
 * layer installs; the "READ SUMMARY" chip announces it on demand.
 */
import { formatAge } from '../../ui/ageFormat.js';

const SEV_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };

export function buildCurrentPicture(events, { nowMs = Date.now(), maxItems = 3 } = {}) {
  const rows = (Array.isArray(events) ? events : []).filter(
    (e) => e && typeof e.title === 'string',
  );
  if (rows.length === 0)
    return 'Current picture: no intelligence events in the current snapshot.';
  const crit = rows.filter((e) => e.severity === 'critical').length;
  const high = rows.filter((e) => e.severity === 'high').length;
  const notable = crit + high;
  const top = [...rows]
    .sort(
      (a, b) =>
        (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0) ||
        Date.parse(b.time || 0) - Date.parse(a.time || 0),
    )
    .slice(0, maxItems);
  const head =
    notable > 0
      ? `Current picture: ${rows.length} developments, ${notable} high-severity or above.`
      : `Current picture: ${rows.length} developments, none high-severity.`;
  const items = top.map(
    (e) => `${e.title} — ${formatAge(e.time, nowMs)}`,
  );
  return `${head} Top: ${items.join('; ')}.`;
}
