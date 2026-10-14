const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recordChanges, readChanges, RETENTION_MS, MAX_BYTES } = require('../src/pipeline/changeLog');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ci-changes-'));
}
const NOW = 1_789_000_000_000;
function ev(id, over = {}) {
  return { id, title: `Event ${id}`, severity: 'high', source: 'USGS', region: 'Europe', lat: 10, lon: 20, ...over };
}

test('baseline run writes only the marker, never the flood', () => {
  const dir = tmpDir();
  const n = recordChanges(dir, { new: [ev('a'), ev('b')], escalated: [], deescalated: [], resolved: [] }, { baseline: true, now: NOW });
  assert.equal(n, 0);
  const { changes, coldStart } = readChanges(dir, 24 * 3600_000, { now: NOW });
  assert.equal(changes.length, 0);
  assert.equal(coldStart, true);
  const raw = fs.readFileSync(path.join(dir, 'changes.jsonl'), 'utf8');
  assert.equal(raw.trim().split('\n').length, 1);
  assert.ok(raw.includes('baseline'));
});

test('changes record slim and read back in window', () => {
  const dir = tmpDir();
  recordChanges(dir, { new: [ev('a')], escalated: [ev('b')], deescalated: [], resolved: [{ id: 'gone', severity: 'low', time: '2026-01-01' }] }, { now: NOW });
  const { changes, coldStart, counts } = readChanges(dir, 6 * 3600_000, { now: NOW + 1000 });
  assert.equal(coldStart, false);
  assert.equal(changes.length, 3);
  assert.deepEqual(counts, { new: 1, escalated: 1, deescalated: 0, resolved: 1 });
  const rec = changes.find((c) => c.eventId === 'a');
  assert.equal(rec.title, 'Event a');
  assert.equal(rec.lat, 10);
  // slim: no summary, no chain, no url
  assert.ok(!('summary' in rec) && !('chain' in rec) && !('url' in rec));
});

test('latest change per event wins; old windows fall out', () => {
  const dir = tmpDir();
  recordChanges(dir, { new: [ev('a', { severity: 'moderate' })], escalated: [], deescalated: [], resolved: [] }, { now: NOW });
  recordChanges(dir, { new: [], escalated: [ev('a', { severity: 'critical' })], deescalated: [], resolved: [] }, { now: NOW + 3600_000 });
  const wide = readChanges(dir, 24 * 3600_000, { now: NOW + 2 * 3600_000 });
  assert.equal(wide.changes.length, 1);
  assert.equal(wide.changes[0].kind, 'escalated');
  const narrow = readChanges(dir, 90 * 60_000, { now: NOW + 2 * 3600_000 });
  assert.equal(narrow.changes.length, 1, 'latest (escalation) still in the 90m window');
  const empty = readChanges(dir, 30 * 60_000, { now: NOW + 3 * 3600_000 });
  assert.equal(empty.changes.length, 0);
});

test('retention prunes beyond 72h', () => {
  const dir = tmpDir();
  recordChanges(dir, { new: [ev('old')], escalated: [], deescalated: [], resolved: [] }, { now: NOW });
  recordChanges(dir, { new: [ev('fresh')], escalated: [], deescalated: [], resolved: [] }, { now: NOW + RETENTION_MS + 1000 });
  const { changes } = readChanges(dir, 24 * 3600_000, { now: NOW + RETENTION_MS + 2000 });
  assert.deepEqual(changes.map((c) => c.eventId), ['fresh']);
});

test('missing file reads as cold start, never crashes', () => {
  const dir = tmpDir();
  const { changes, coldStart } = readChanges(dir, 3600_000, { now: NOW });
  assert.deepEqual(changes, []);
  assert.equal(coldStart, true);
});

test('byte cap is respected', () => {
  assert.ok(MAX_BYTES <= 8 * 1024 * 1024);
});
