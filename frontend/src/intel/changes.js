/* Wave 2 (J4-02) — Change view helpers (frontend half).
   The list reads GET /api/changes?window= (the capped delta-retention log:
   delta-only, ≤8 MB / 72 h, server-side). The event-position timeline is a
   panel-scoped scrub over those stored change records — it never
   re-animates object state on the globe, and the scrub state carries
   persistent "THIS IS THE PAST — <time>" chrome.

   Pure helpers here; the DOM scrub lives in intel/ui.js. */
export const CHANGE_WINDOWS = [
  { id: '1h', label: '1 hour', ms: 3600_000 },
  { id: '6h', label: '6 hours', ms: 6 * 3600_000 },
  { id: '24h', label: '24 hours', ms: 24 * 3600_000 },
];

export const CHANGE_KIND_PLAIN = {
  new: 'New',
  escalated: 'Escalated',
  deescalated: 'De-escalated',
  resolved: 'Resolved',
};

export const CHANGE_KIND_COLOR = {
  new: '#7FCEF0',
  escalated: '#FF5A5A',
  deescalated: '#FFD166',
  resolved: '#9fc3da',
};

/** Fetch the change list for a window. Never throws — the UI degrades. */
export async function fetchChanges(windowId = '6h') {
  const w = CHANGE_WINDOWS.some((x) => x.id === windowId) ? windowId : '6h';
  try {
    const res = await fetch(`/api/changes?window=${encodeURIComponent(w)}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { window: w, changes: [], coldStart: true, counts: null, error: true };
    const body = await res.json();
    return {
      window: w,
      changes: Array.isArray(body.changes) ? body.changes : [],
      coldStart: !!body.coldStart,
      counts: body.counts || null,
      total: Number.isFinite(body.total) ? body.total : 0,
      error: false,
    };
  } catch {
    return { window: w, changes: [], coldStart: true, counts: null, error: true };
  }
}

/**
 * Timeline ticks: change density across the window for the scrub strip.
 * @returns {Array<{t:number, n:number}>} bucketCount buckets, oldest first
 */
export function timelineTicks(changes, windowMs, nowMs = Date.now(), bucketCount = 48) {
  const buckets = new Array(bucketCount).fill(0);
  const start = nowMs - windowMs;
  for (const c of Array.isArray(changes) ? changes : []) {
    const t = c && c.at ? new Date(c.at).getTime() : NaN;
    if (!Number.isFinite(t) || t < start || t > nowMs) continue;
    const i = Math.min(bucketCount - 1, Math.floor(((t - start) / windowMs) * bucketCount));
    buckets[i]++;
  }
  return buckets.map((n, i) => ({ t: start + (i / bucketCount) * windowMs, n }));
}

/** Max tick count (for scaling the strip bars). */
export function maxTick(ticks) {
  return ticks.reduce((m, t) => Math.max(m, t.n), 0) || 1;
}

/** "THIS IS THE PAST" label for a scrub position. */
export function pastLabel(atMs) {
  const d = new Date(atMs);
  if (Number.isNaN(d.getTime())) return 'THIS IS THE PAST';
  return `THIS IS THE PAST — ${d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}
