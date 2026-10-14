import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineKm, formatDistance, nearestN, emptyStateText, NEARBY_CLASSES,
} from './proximity.js';

test('haversineKm is sane', () => {
  assert.ok(Math.abs(haversineKm(0, 0, 0, 0)) < 1e-9);
  // ~111 km per degree of latitude
  assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 111.2) < 1);
  // Orlando to Miami ≈ 330 km
  assert.ok(Math.abs(haversineKm(28.54, -81.38, 25.76, -80.19) - 330) < 15);
});

test('formatDistance stays coarse and honest', () => {
  assert.equal(formatDistance(0.4), '400 m');
  assert.equal(formatDistance(4.25), '4.3 km');
  assert.equal(formatDistance(42), '42 km');
  assert.equal(formatDistance(1234), '1,234 km');
  assert.equal(formatDistance(NaN), '—');
});

test('nearestN sorts nearest-first, skips bad coords', () => {
  const items = [
    { id: 'a', lat: 10, lon: 10 },
    { id: 'b', lat: null, lon: 10 },
    { id: 'c', lat: 0.1, lon: 0.1 },
  ];
  const out = nearestN(items, 0, 0, 8);
  assert.deepEqual(out.map((o) => o.item.id), ['c', 'a']);
  assert.ok(out[0].km < out[1].km);
  assert.deepEqual(nearestN(items, 0, 0, 1).map((o) => o.item.id), ['c']);
  assert.deepEqual(nearestN(null, 0, 0, 8), []);
});

test('honesty predicate: absence of data is never absence of activity', () => {
  for (const c of NEARBY_CLASSES) {
    const t = emptyStateText(c.label);
    assert.ok(t.includes(`No ${c.label} near here right now`));
    assert.ok(t.includes('that is not evidence nothing is happening'));
  }
});

test('nearbyAll never hangs: a hung provider resolves to its honest fallback', async () => {
  const { nearbyAll } = await import('./proximity.js');
  // Monkey-patch fetch to hang forever for flights; others resolve fast.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/flights')) return new Promise(() => {});
    return { status: 200, text: async () => JSON.stringify({ vessels: [], status: 'ok', cameras: [], elements: [] }) };
  };
  try {
    const t0 = Date.now();
    const res = await nearbyAll(28.5, -81.3, 5, 100);
    const dt = Date.now() - t0;
    assert.ok(dt < 2000, `resolved in ${dt}ms despite hung flights provider`);
    assert.equal(res.flights.ok, false);
    assert.ok(res.flights.unavailable.includes('unavailable right now'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
