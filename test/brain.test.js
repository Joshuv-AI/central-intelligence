// Central Intelligence — brain smoke test (no network).
// Exercises delta -> intelligence -> fusion -> feed -> status with
// synthetic cross-domain events and asserts the four public outputs.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/pipeline/store');
const { runBrain } = require('../src/pipeline/brain');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-brain-'));
const store = new Store(dir, 200);
store.load();

const now = new Date().toISOString();
store.state.events = [
  { id: 't1', source: 'solar', domain: 'space', title: 'X2.1 solar flare detected', summary: 's', lat: null, lon: null, region: 'Global', time: now, severity: 'critical', url: null, attribution: 'NOAA SWPC' },
  { id: 't2', source: 'noaa_swpc', domain: 'space', title: 'G3 geomagnetic storm watch', summary: 's', lat: null, lon: null, region: 'Global', time: now, severity: 'high', url: null, attribution: 'NOAA SWPC' },
  { id: 't3', source: 'gps_jamming', domain: 'signals', title: 'GPS interference over Eastern Med', summary: 's', lat: 34.5, lon: 33.2, region: 'Eastern Mediterranean', time: now, severity: 'high', url: null, attribution: 'GPSJam' },
  { id: 't4', source: 'noaa_hurricanes', domain: 'disasters', title: 'Hurricane Polo Cat 3', summary: 's', lat: 21.3, lon: -113.9, region: 'Eastern Pacific', time: now, severity: 'high', url: null, attribution: 'NOAA NHC' },
  { id: 't5', source: 'gdacs', domain: 'disasters', title: 'Tropical Cyclone near Mexico', summary: 's', lat: 21.0, lon: -114.0, region: 'Eastern Pacific', time: now, severity: 'critical', url: null, attribution: 'GDACS' },
];

const r = runBrain(store);

// Delta
assert.strictEqual(r.delta.new, 5, 'first run: all 5 events new');
assert.strictEqual(r.delta.escalated, 0);
// Fusion
assert.ok(r.connections >= 2, 'expected >=2 cross-domain connections');
assert.ok(
  store.state.connections.every((c) => c.score >= 50),
  'all connections meet threshold'
);
assert.ok(
  store.state.connections[0].chain.length >= 2 && store.state.connections[0].title.includes('→'),
  'connections are readable causal chains'
);
// Feed
assert.ok(store.state.feed.length > 0, 'feed has items');
assert.ok(
  store.state.feed.some((f) => f.kind === 'connection'),
  'feed includes correlation items'
);
// Status
assert.strictEqual(store.state.meta.status.direction, 'RISK-ON', 'two criticals -> RISK-ON');
// Intelligence enrichments
assert.ok(
  store.state.events[0].impactTags.includes('GPS'),
  'solar event carries impact tags'
);
assert.ok(store.state.events[0].cascadeNote, 'solar event carries cascade note');

// Second run: nothing new, no feed spam.
const r2 = runBrain(store);
assert.strictEqual(r2.delta.new, 0, 'second run: no new events');
assert.strictEqual(r2.newConnections, 0, 'second run: no new connections');
const feedLen = store.state.feed.length;
runBrain(store);
assert.strictEqual(store.state.feed.length, feedLen, 'feed does not grow on no-change sweeps');

// Escalation path.
store.state.events = store.state.events.map((e) =>
  e.id === 't4' ? { ...e, severity: 'critical' } : e
);
const r3 = runBrain(store);
assert.strictEqual(r3.delta.escalated, 1, 'severity bump detected as escalation');
assert.ok(
  store.state.feed.some((f) => f.kind === 'escalation' && f.eventId === 't4'),
  'escalation pushed to feed'
);

// Persistence round-trip.
const store2 = new Store(dir, 200);
store2.load();
assert.ok(store2.state.connections.length > 0, 'connections survive restart');
assert.ok(store2.state.meta.status, 'status survives restart');

console.log('brain smoke test: ALL PASS');
console.log(
  `  connections=${r.connections} feed=${store.state.feed.length} status=${store.state.meta.status.direction}`
);
