import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFLINE_CACHE_KEY,
  saveOfflineSnapshot,
  loadOfflineSnapshot,
  isOfflineEpisode,
} from './offline.js';

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('snapshot cache round-trips a slim snapshot', () => {
  const ls = memStorage();
  const snap = {
    markers: [{ id: 'a', title: 'x' }],
    connections: [{ id: 'c' }],
    feed: [{ id: 'f' }],
    meta: { status: 'ok' },
  };
  assert.equal(saveOfflineSnapshot(snap, ls), true);
  const back = loadOfflineSnapshot(ls);
  assert.ok(back);
  assert.equal(back.v, 1);
  assert.deepEqual(back.markers, snap.markers);
  assert.deepEqual(back.connections, snap.connections);
  assert.ok(Number.isFinite(back.savedAt));
});

test('cache refuses bad shapes and corrupt payloads', () => {
  const ls = memStorage();
  assert.equal(saveOfflineSnapshot(null, ls), false);
  assert.equal(saveOfflineSnapshot({ markers: 'nope' }, ls), false);
  assert.equal(loadOfflineSnapshot(ls), null);
  ls.setItem(OFFLINE_CACHE_KEY, '{corrupt');
  assert.equal(loadOfflineSnapshot(ls), null);
  ls.setItem(OFFLINE_CACHE_KEY, JSON.stringify({ v: 999, markers: [], savedAt: 1 }));
  assert.equal(loadOfflineSnapshot(ls), null); // wrong version
});

test('cache refuses oversized snapshots instead of blowing quota', () => {
  const ls = memStorage();
  const big = { markers: [{ id: 'a', blob: 'x'.repeat(600 * 1024) }], connections: [], feed: [] };
  assert.equal(saveOfflineSnapshot(big, ls), false);
  assert.equal(loadOfflineSnapshot(ls), null);
});

test('isOfflineEpisode matches the client diag contract', () => {
  assert.equal(isOfflineEpisode({ state: 'down' }), true);
  assert.equal(isOfflineEpisode({ state: 'reconnecting' }), true);
  assert.equal(isOfflineEpisode({ state: 'live' }), false);
  assert.equal(isOfflineEpisode({ state: 'stale' }), false);
  assert.equal(isOfflineEpisode(null), false);
});
