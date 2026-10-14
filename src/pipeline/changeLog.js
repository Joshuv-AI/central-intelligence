// Central Intelligence — capped delta retention (J4-02, Wave 2).
//
// The brain computes a delta every sweep and discards it; the Change view
// needs "what changed in 1h/6h/24h". Naive history (~29 MB/day) was
// rejected at the J.1 gate. This module stores DELTA-ONLY records:
// one slim line per new/escalated/de-escalated/resolved event per sweep.
//
// Caps (the only viable form per the evaluation):
// - 72 h retention window (a few-day window, not history)
// - 8 MB file cap, 30,000 entry cap — whichever binds first
// - append-only JSONL, atomic prune (tmp + rename)
//
// Cold start is honest: the first-ever run writes a single `baseline`
// marker and logs nothing (otherwise every known event would flood the
// view as "new"). The API reports `coldStart: true` until real changes
// land.
const fs = require('fs');
const path = require('path');

const FILE = 'changes.jsonl';
const RETENTION_MS = 72 * 3600_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 30000;

const KINDS = new Set(['new', 'escalated', 'deescalated', 'resolved', 'baseline']);

function slimRecord(kind, at, e) {
  return {
    at,
    kind,
    eventId: e && e.id != null ? String(e.id) : null,
    title: e && e.title ? String(e.title).slice(0, 160) : null,
    severity: e && e.severity ? String(e.severity) : null,
    source: e && e.source ? String(e.source) : null,
    region: e && e.region ? String(e.region).slice(0, 80) : null,
    lat: e && Number.isFinite(e.lat) ? e.lat : null,
    lon: e && Number.isFinite(e.lon) ? e.lon : null,
  };
}

function filePath(dataDir) {
  return path.join(dataDir, FILE);
}

/** Read all retained records (already pruned on write). */
function readAll(dataDir) {
  let raw;
  try {
    raw = fs.readFileSync(filePath(dataDir), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && KINDS.has(r.kind) && typeof r.at === 'string') out.push(r);
    } catch {
      // corrupt line: skip, never crash the reader
    }
  }
  return out;
}

function prune(records, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  let kept = records.filter((r) => {
    const t = new Date(r.at).getTime();
    return Number.isFinite(t) && t > cutoff;
  });
  if (kept.length > MAX_ENTRIES) kept = kept.slice(kept.length - MAX_ENTRIES);
  // Byte cap: drop oldest lines until under the cap.
  let lines = kept.map((r) => JSON.stringify(r));
  let bytes = lines.reduce((a, l) => a + l.length + 1, 0);
  while (bytes > MAX_BYTES && lines.length > 1) {
    const dropped = lines.shift();
    bytes -= dropped.length + 1;
  }
  return lines;
}

function writeAtomic(dataDir, lines) {
  const file = filePath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
  fs.renameSync(tmp, file);
}

/**
 * Record one sweep's delta. On `baseline` (first run ever) only the marker
 * is written — the flood of "everything is new" never enters the log.
 * @returns {number} records appended
 */
function recordChanges(dataDir, changes, { baseline = false, now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const records = readAll(dataDir);
  if (baseline) {
    const hasMarker = records.some((r) => r.kind === 'baseline');
    if (!hasMarker) {
      writeAtomic(dataDir, prune([...records, { at, kind: 'baseline' }], now));
    }
    return 0;
  }
  const fresh = [];
  for (const kind of ['new', 'escalated', 'deescalated', 'resolved']) {
    const list = changes && Array.isArray(changes[kind]) ? changes[kind] : [];
    for (const e of list) fresh.push(slimRecord(kind, at, e));
  }
  writeAtomic(dataDir, prune([...records, ...fresh], now));
  return fresh.length;
}

/**
 * Changes inside the window, newest first. Deduplicated to the latest
 * change per event (a list view, not a replay).
 */
function readChanges(dataDir, windowMs, { now = Date.now() } = {}) {
  const records = readAll(dataDir);
  const real = records.filter((r) => r.kind !== 'baseline');
  const coldStart = real.length === 0;
  const cutoff = now - windowMs;
  const inWindow = real.filter((r) => {
    const t = new Date(r.at).getTime();
    return Number.isFinite(t) && t > cutoff && t <= now + 60_000;
  });
  // Latest change per event wins.
  const latest = new Map();
  for (const r of inWindow) {
    const key = r.eventId || `${r.kind}:${r.title}`;
    const prev = latest.get(key);
    if (!prev || r.at > prev.at) latest.set(key, r);
  }
  const changes = [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
  const counts = { new: 0, escalated: 0, deescalated: 0, resolved: 0 };
  for (const r of changes) if (counts[r.kind] !== undefined) counts[r.kind]++;
  return { changes, coldStart, counts, total: changes.length };
}

module.exports = {
  recordChanges,
  readChanges,
  RETENTION_MS,
  MAX_BYTES,
  MAX_ENTRIES,
};
