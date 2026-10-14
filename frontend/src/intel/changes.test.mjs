import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_WINDOWS, fetchChanges, timelineTicks, maxTick, pastLabel, CHANGE_KIND_PLAIN } from './changes.js';

const NOW = 1_789_000_000_000;

test('window ids are the evaluated 1h/6h/24h set', () => {
  assert.deepEqual(CHANGE_WINDOWS.map((w) => w.id), ['1h', '6h', '24h']);
  assert.deepEqual(Object.keys(CHANGE_KIND_PLAIN).sort(), ['deescalated', 'escalated', 'new', 'resolved']);
});

test('timelineTicks buckets density oldest-first', () => {
  const changes = [
    { at: new Date(NOW - 30 * 60_000).toISOString() },
    { at: new Date(NOW - 20 * 60_000).toISOString() },
    { at: new Date(NOW - 20 * 60_000).toISOString() },
    { at: new Date(NOW - 25 * 3600_000).toISOString() }, // outside the 6h window
  ];
  const ticks = timelineTicks(changes, 6 * 3600_000, NOW, 6);
  assert.equal(ticks.length, 6);
  const total = ticks.reduce((a, t) => a + t.n, 0);
  assert.equal(total, 3, 'out-of-window change excluded');
  assert.equal(ticks[5].n, 3, 'recent changes land in the newest bucket');
  assert.equal(maxTick(ticks), 3);
});

test('pastLabel is a persistent, honest past marker', () => {
  const l = pastLabel(NOW - 3600_000);
  assert.ok(l.startsWith('THIS IS THE PAST — '));
  assert.equal(pastLabel(NaN), 'THIS IS THE PAST');
});

test('fetchChanges degrades to coldStart on failure, never throws', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('down'); };
  try {
    const r = await fetchChanges('6h');
    assert.equal(r.coldStart, true);
    assert.deepEqual(r.changes, []);
    assert.equal(r.error, true);
    const r2 = await fetchChanges('bogus');
    assert.equal(r2.window, '6h', 'unknown window falls back to 6h');
  } finally {
    globalThis.fetch = realFetch;
  }
});
