// Central Intelligence — /api/snapshot contract test (ARCH §4.1 / §D).
// Asserts the sovereign intel shape the GEV base consumes as-is:
// { markers, connections, feed, meta } with the normalize-contract field
// types, straight from the Store that backs GET /api/snapshot.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/pipeline/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-v2-snapshot-'));
try {
  const store = new Store(dir, 60);
  store.load();
  const snap = store.snapshot();

  assert.ok(snap && typeof snap === 'object', 'snapshot is an object');
  assert.ok(Array.isArray(snap.markers), 'markers is an array');
  assert.ok(Array.isArray(snap.connections), 'connections is an array');
  assert.ok(Array.isArray(snap.feed), 'feed is an array');
  assert.ok(snap.meta && typeof snap.meta === 'object' && !Array.isArray(snap.meta), 'meta is an object');

  // meta must tolerate the /api/health derivations (sources object map).
  const sources = snap.meta.sources || {};
  assert.ok(sources && typeof sources === 'object' && !Array.isArray(sources), 'meta.sources is an object map');
  for (const s of Object.values(sources)) {
    assert.ok(typeof s.status === 'string', 'source status is a string');
  }
  if ('lastSweep' in snap.meta) {
    assert.ok(snap.meta.lastSweep === null || typeof snap.meta.lastSweep === 'string' || typeof snap.meta.lastSweep === 'number', 'meta.lastSweep type');
  }

  // Marker (event) normalize-contract field types, when present.
  for (const e of snap.markers) {
    assert.strictEqual(typeof e.id, 'string', 'marker id string');
    assert.strictEqual(typeof e.title, 'string', 'marker title string');
    assert.ok(['low', 'moderate', 'high', 'critical'].includes(e.severity), `marker severity enum: ${e.severity}`);
    assert.ok(!Number.isNaN(new Date(e.time).getTime()), 'marker time parses');
    if (e.lat != null) assert.ok(typeof e.lat === 'number' && e.lat >= -90 && e.lat <= 90, 'marker lat range');
    if (e.lon != null) assert.ok(typeof e.lon === 'number' && e.lon >= -180 && e.lon <= 180, 'marker lon range');
  }
  for (const c of snap.connections) {
    assert.ok(c && typeof c === 'object', 'connection is an object');
    assert.strictEqual(typeof c.id, 'string', 'connection id string');
  }
  for (const f of snap.feed) {
    assert.ok(f && typeof f === 'object', 'feed item is an object');
  }

  // JSON round-trip must be lossless in shape (the wire format).
  const wire = JSON.parse(JSON.stringify(snap));
  assert.deepStrictEqual(Object.keys(wire).sort(), ['connections', 'feed', 'markers', 'meta'], 'snapshot keys exact');

  console.log('snapshot-contract.test.js: all assertions passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
