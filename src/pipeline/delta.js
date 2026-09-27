// Central Intelligence — delta engine.
// Diffs the current event set against the previous sweep:
// new / escalated / de-escalated / resolved. Pure function; the caller
// persists the returned `next` map for the following sweep.
const { sevRank } = require('./intel_tags');

/**
 * @param {Object} prevMap - { [eventId]: { severity, time } } from last sweep
 * @param {Array} events - current normalized events
 * @returns {{ changes: {new, escalated, deescalated, resolved}, next: Object }}
 */
function computeDelta(prevMap, events) {
  const prev = prevMap && typeof prevMap === 'object' ? prevMap : {};
  const changes = { new: [], escalated: [], deescalated: [], resolved: [] };
  const next = {};
  const seen = new Set();

  for (const e of events) {
    if (!e || !e.id) continue;
    seen.add(e.id);
    next[e.id] = { severity: e.severity, time: e.time };
    const p = prev[e.id];
    if (!p) {
      changes.new.push(e);
    } else {
      const d = sevRank(e.severity) - sevRank(p.severity);
      if (d > 0) changes.escalated.push(e);
      else if (d < 0) changes.deescalated.push(e);
    }
  }

  for (const id of Object.keys(prev)) {
    if (!seen.has(id)) {
      changes.resolved.push({ id, severity: prev[id].severity, time: prev[id].time });
    }
  }

  return { changes, next };
}

module.exports = { computeDelta };
