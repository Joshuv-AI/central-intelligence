// Central Intelligence — intelligence layer (rule-based).
// Three jobs, run over the full event set after every sweep:
//   1. Cascades — attach watch-tags to trigger events (if A then watch B).
//   2. Anomaly detection — 2-sigma vs 7-day per-source baseline on event counts.
//   3. Geographic clustering — grid cells with >=3 events become region clusters.
// Pure functions except baseline bookkeeping, which the caller persists.
const { CASCADE_RULES, impactTags, sevRank } = require('./intel_tags');

// --- 1. Cascades -----------------------------------------------------------
function applyCascades(events) {
  for (const e of events) {
    const watches = new Set(e.cascadeWatches || []);
    for (const rule of CASCADE_RULES) {
      try {
        if (rule.match(e)) {
          for (const t of rule.tags) watches.add(t);
          e.cascadeNote = rule.note;
        }
      } catch {
        /* a bad rule never breaks the sweep */
      }
    }
    if (watches.size) e.cascadeWatches = [...watches];
    e.impactTags = impactTags(e);
  }
  return events;
}

// --- 2. Anomaly detection --------------------------------------------------
// Baselines: { [source]: { samples: [{ t, n }], mean, std } }
// A source is anomalous when its current count exceeds mean + 2*std.
const BASELINE_DAYS = 7;
const MIN_SAMPLES = 6;
const MIN_COUNT = 5;

function pruneSamples(samples, nowMs) {
  const cutoff = nowMs - BASELINE_DAYS * 86400_000;
  return samples.filter((s) => s.t >= cutoff);
}

function meanStd(samples) {
  const n = samples.length;
  if (!n) return { mean: 0, std: 0 };
  const mean = samples.reduce((s, x) => s + x.n, 0) / n;
  const variance = samples.reduce((s, x) => s + (x.n - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

function detectAnomalies(events, baselines, nowMs) {
  const counts = {};
  for (const e of events) counts[e.source] = (counts[e.source] || 0) + 1;

  const anomalies = [];
  const nextBaselines = {};
  for (const [source, n] of Object.entries(counts)) {
    const prev = baselines[source] || { samples: [] };
    const samples = pruneSamples(prev.samples || [], nowMs);
    const { mean, std } = meanStd(samples);
    const anomalous =
      samples.length >= MIN_SAMPLES && n >= MIN_COUNT && n > mean + 2 * std;
    if (anomalous) {
      anomalies.push({ source, count: n, mean: +mean.toFixed(1), std: +std.toFixed(1) });
      for (const e of events) {
        if (e.source === source) e.anomaly = true;
      }
    }
    nextBaselines[source] = {
      samples: [...samples, { t: nowMs, n }],
      mean: +mean.toFixed(2),
      std: +std.toFixed(2),
      anomalous,
    };
  }
  // Carry forward baselines for sources with no events this sweep.
  for (const [source, b] of Object.entries(baselines)) {
    if (!nextBaselines[source]) nextBaselines[source] = b;
  }
  return { anomalies, baselines: nextBaselines };
}

// --- 3. Geographic clustering ----------------------------------------------
const CELL_DEG = 2.5;
const MIN_CLUSTER = 3;

function detectClusters(events) {
  const cells = new Map();
  for (const e of events) {
    if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    const key = `${Math.floor(e.lat / CELL_DEG)}:${Math.floor(e.lon / CELL_DEG)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(e);
  }
  const clusters = [];
  for (const [key, members] of cells) {
    if (members.length < MIN_CLUSTER) continue;
    const lat = members.reduce((s, e) => s + e.lat, 0) / members.length;
    const lon = members.reduce((s, e) => s + e.lon, 0) / members.length;
    const severity = members
      .map((e) => e.severity)
      .sort((a, b) => sevRank(b) - sevRank(a))[0];
    clusters.push({
      id: `cluster-${key.replace(':', '_')}`,
      lat: +lat.toFixed(2),
      lon: +lon.toFixed(2),
      count: members.length,
      severity,
      eventIds: members.map((e) => e.id),
      region: members[0].region || null,
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}

module.exports = { applyCascades, detectAnomalies, detectClusters };
