// Central Intelligence — pipeline brain (orchestrator).
// Runs after every tier sweep over the FULL event set:
//   delta -> intelligence (cascades, anomalies, clusters) -> fusion ->
//   feed items -> status. Then persists everything.
// Any stage failing must never break the sweep: each is individually guarded.
const { computeDelta } = require('./delta');
const { applyCascades, detectAnomalies, detectClusters } = require('./intelligence');
const { runFusion } = require('./fusion');
const { sevRank } = require('./intel_tags');

const FEED_PER_SWEEP = 30;
const DAY_MS = 86400_000;

function feedItem(id, time, severity, kind, text, extra) {
  return { id, time, severity, kind, text, ...(extra || {}) };
}

function buildFeedItems(store, changes, newConnections, anomalies) {
  const items = [];
  const feed = store.state.feed || [];
  const seenIds = new Set(feed.map((f) => f.id));
  // Normalized titles of recent feed items (last 24h) for similarity dedup.
  const dayAgo = Date.now() - 24 * 3600_000;
  const recentTitles = new Set();
  for (const f of feed) {
    const t = f && f.at ? new Date(f.at).getTime() : 0;
    if (t > dayAgo && f.title) recentTitles.add(normTitle(f.title));
  }

  for (const c of newConnections) {
    const id = `feed-conn-${c.id}`;
    if (seenIds.has(id)) continue;
    if (recentTitles.has(normTitle(c.title))) continue;
    recentTitles.add(normTitle(c.title));
    items.push(
      feedItem(id, c.createdAt, c.severity, 'connection', `CORRELATION · ${c.title}`, {
        connectionId: c.id,
        url: null,
      })
    );
  }
  for (const e of changes.escalated) {
    const id = `feed-esc-${e.id}`;
    if (seenIds.has(id)) continue;
    if (recentTitles.has(normTitle(e.title))) continue;
    recentTitles.add(normTitle(e.title));
    items.push(
      feedItem(id, e.time, e.severity, 'escalation', `ESCALATED · ${e.title}`, {
        eventId: e.id,
        url: e.url,
        source: e.source,
      })
    );
  }
  for (const e of changes.new) {
    // Higher threshold: only critical events make the feed (was high+critical).
    if (sevRank(e.severity) < 4) continue;
    const id = `feed-new-${e.id}`;
    if (seenIds.has(id)) continue;
    // Skip if a very similar headline already appeared in the last 24h
    // (same incident reported by multiple sources).
    if (recentTitles.has(normTitle(e.title))) continue;
    recentTitles.add(normTitle(e.title));
    items.push(
      feedItem(id, e.time, e.severity, 'event', e.title, {
        eventId: e.id,
        url: e.url,
        source: e.source,
      })
    );
  }
  for (const a of anomalies) {
    // Only alert once per source per 6h, not every hour, to avoid repeats
    // for the same ongoing anomaly.
    const id = `feed-anom-${a.source}-${Math.floor(Date.now() / (6 * 3600_000))}`;
    if (seenIds.has(id)) continue;
    items.push(
      feedItem(
        id,
        new Date().toISOString(),
        'moderate',
        'anomaly',
        `ANOMALY · unusual volume from ${a.source}: ${a.count} events (baseline ${a.mean})`,
        { source: a.source }
      )
    );
  }
  return items.slice(0, FEED_PER_SWEEP);
}

// Normalize a title for dedup: lowercase, strip punctuation/extra spaces.
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function computeStatus(events, anomalies) {
  const now = Date.now();
  const hot = events.filter(
    (e) => sevRank(e.severity) >= 3 && now - new Date(e.time).getTime() < DAY_MS
  );
  const critical = hot.filter((e) => e.severity === 'critical').length;
  let direction = 'MIXED';
  if (critical > 0 || anomalies.length >= 2) direction = 'RISK-ON';
  else if (hot.length === 0) direction = 'RISK-OFF';
  return {
    direction,
    hot24: hot.length,
    critical24: critical,
    anomalies: anomalies.map((a) => a.source),
    at: new Date().toISOString(),
  };
}

function runBrain(store) {
  const events = store.state.events || [];
  const meta = store.state.meta || {};
  const nowMs = Date.now();

  // 1. Delta vs previous sweep.
  let changes = { new: [], escalated: [], deescalated: [], resolved: [] };
  let deltaNext = {};
  try {
    const d = computeDelta(meta.deltaPrev, events);
    changes = d.changes;
    deltaNext = d.next;
  } catch (err) {
    console.error('[brain] delta failed:', err.message);
  }

  // 2. Intelligence: cascades -> anomalies -> clusters.
  let anomalies = [];
  let clusters = [];
  try {
    applyCascades(events);
  } catch (err) {
    console.error('[brain] cascades failed:', err.message);
  }
  let baselines = meta.baselines || {};
  try {
    const r = detectAnomalies(events, baselines, nowMs);
    anomalies = r.anomalies;
    baselines = r.baselines;
  } catch (err) {
    console.error('[brain] anomaly detection failed:', err.message);
  }
  try {
    clusters = detectClusters(events);
  } catch (err) {
    console.error('[brain] clustering failed:', err.message);
  }

  // 3. Fusion -> connections (recomputed deterministically each sweep).
  let connections = [];
  let newConnections = [];
  try {
    const prevIds = new Set((store.state.connections || []).map((c) => c.id));
    connections = runFusion(events);
    newConnections = connections.filter((c) => !prevIds.has(c.id));
    store.setConnections(connections);
  } catch (err) {
    console.error('[brain] fusion failed:', err.message);
  }

  // 4. Feed items from what's actually new.
  try {
    const items = buildFeedItems(store, changes, newConnections, anomalies);
    if (items.length) store.pushFeed(items);
  } catch (err) {
    console.error('[brain] feed build failed:', err.message);
  }

  // 5. Status for the pill.
  let status = meta.status || null;
  try {
    status = computeStatus(events, anomalies);
  } catch (err) {
    console.error('[brain] status failed:', err.message);
  }

  store.patchMeta({
    deltaPrev: deltaNext,
    baselines,
    clusters,
    status,
    lastBrain: new Date().toISOString(),
    deltaSummary: {
      new: changes.new.length,
      escalated: changes.escalated.length,
      deescalated: changes.deescalated.length,
      resolved: changes.resolved.length,
    },
  });

  // Persist the in-memory enrichments (impact tags etc.) to events.json.
  try {
    store.saveAll();
  } catch (err) {
    console.error('[brain] saveAll failed:', err.message);
  }

  return {
    delta: {
      new: changes.new.length,
      escalated: changes.escalated.length,
      deescalated: changes.deescalated.length,
      resolved: changes.resolved.length,
    },
    anomalies: anomalies.length,
    clusters: clusters.length,
    connections: connections.length,
    newConnections: newConnections.length,
  };
}

module.exports = { runBrain };
