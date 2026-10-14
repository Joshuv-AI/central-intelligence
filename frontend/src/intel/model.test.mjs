/* Lane G — model unit checks (pure logic). Run: node src/intel/model.test.mjs */
import assert from 'node:assert';
import {
  bandForHeight, connectionTierVisible, dedupeFeed, plainDirection,
  plainScore, plainConnectionSummary, summarizeSources, regionMatches,
} from './model.js';

assert.equal(bandForHeight(26_000_000), 'B0');
assert.equal(bandForHeight(5_000_000), 'B1');
assert.equal(bandForHeight(1_000_000), 'B2');
assert.equal(bandForHeight(100_000), 'B3');
assert.equal(bandForHeight(10_000), 'B4');
assert.equal(bandForHeight(1_000), 'B5');

assert.equal(connectionTierVisible({ tier: 'standard' }, 'B0'), false);
assert.equal(connectionTierVisible({ tier: 'critical' }, 'B1'), true);
assert.equal(connectionTierVisible({ tier: 'high' }, 'B1'), false);
assert.equal(connectionTierVisible({ tier: 'high' }, 'B2'), true);
assert.equal(connectionTierVisible({ tier: 'standard' }, 'B3'), true);
assert.equal(connectionTierVisible({ severity: 'critical' }, 'B1'), true);

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const feed = [
  { id: 'a', time: iso(now - 1000), severity: 'high', kind: 'event', headline: 'Big Thing Happens!' },
  { id: 'b', time: iso(now - 2000), severity: 'high', kind: 'event', headline: 'big thing happens' }, // dup title
  { id: 'c', time: iso(now - 3000), severity: 'low', kind: 'event', headline: 'Minor thing' }, // below threshold
  { id: 'd', time: iso(now - 49 * 3600_000), severity: 'critical', kind: 'event', headline: 'Old' }, // stale
  { id: 'e', time: iso(now - 4000), severity: 'moderate', kind: 'anomaly', headline: 'Unusual volume', source: 'x' },
  { id: 'f', time: iso(now - 5000), severity: 'moderate', kind: 'anomaly', headline: 'Unusual volume again', source: 'x' }, // same-source anomaly
  { id: 'g', time: iso(now - 6000), severity: 'critical', kind: 'connection', headline: 'Story', connectionId: 'c1' },
];
const deduped = dedupeFeed(feed, now);
assert.deepEqual(deduped.map((f) => f.id), ['a', 'e', 'g']);

assert.equal(plainDirection({ direction: 'RISK-OFF', hot24: 0, critical24: 0 }).word, 'Calm');
assert.equal(plainDirection({ direction: 'RISK-ON', hot24: 3, critical24: 1 }).word, 'Needs attention');
assert.equal(plainDirection(null).word, 'Waiting for data');

assert.match(plainScore({ score: 82 }), /Strong link · strength 82 of 90/);
const summary = plainConnectionSummary({
  chain: [{}, {}], tags: ['health', 'population'], scoreParts: { cascade: 15, proximity: 12 },
});
assert.match(summary, /both affect health, population/);
assert.match(summary, /one may have caused the other/);
assert.doesNotMatch(summary, /Spanning/);

const health = summarizeSources({ sources: { a: { status: 'ok', count: 3 }, b: { status: 'error' }, c: { status: 'pending' } } });
assert.equal(health.total, 3);
assert.equal(health.live, 1);
assert.equal(health.rows[0].name, 'b'); // errors sort first

assert.equal(regionMatches('europe', { region: 'Ukraine', title: 'x' }), true);
assert.equal(regionMatches('europe', { region: 'Brazil', title: 'x' }), false);
assert.equal(regionMatches('europe', { region: null, title: 'x' }), true);

/* Wave 1 (J4-04): mechanical reason rendering — fixed templates, no prose. */
import {
  formatReasons, whyLinkedLine, SEV_FLOORS, normalizeSeverityFloor,
  severityFloorFor, passesSeverityFloor,
} from './model.js';

const reasons = [
  { code: 'shared_tags', tags: ['population', 'infrastructure'] },
  { code: 'time_window', windowHours: 6 },
  { code: 'proximity_km', withinKm: 100 },
  { code: 'sources', count: 2 },
  { code: 'causal_link' },
  { code: 'bogus_future_code' },
];
const fragments = formatReasons(reasons);
assert.deepEqual(fragments, [
  'shared effects: population, infrastructure',
  'within the same 6 h window',
  'within 100 km of each other',
  '2 independent sources',
  'one may have caused the other',
]); // unknown code dropped, never guessed
assert.equal(formatReasons(null).length, 0);
assert.equal(formatReasons([{ code: 'time_window' }]).length, 0); // malformed param: dropped, never "undefined"
assert.match(whyLinkedLine({ reasons }), /^Why linked: shared effects: population, infrastructure · /);
assert.equal(whyLinkedLine({ reasons: [] }), '');
assert.equal(whyLinkedLine({}), '');

/* Wave 1 (J4-15): severity floor dial. */
assert.equal(SEV_FLOORS.length, 3);
assert.deepEqual(SEV_FLOORS.map((f) => f.id), ['all', 'notable', 'high']);
assert.equal(normalizeSeverityFloor('high'), 'high');
assert.equal(normalizeSeverityFloor('bogus'), 'all'); // fail-visible to All
assert.equal(severityFloorFor('notable').minRank, 1);
assert.equal(passesSeverityFloor({ severity: 'low' }, 'all'), true);
assert.equal(passesSeverityFloor({ severity: 'low' }, 'notable'), false);
assert.equal(passesSeverityFloor({ severity: 'moderate' }, 'notable'), true);
assert.equal(passesSeverityFloor({ severity: 'high' }, 'high'), true);
assert.equal(passesSeverityFloor({ severity: 'moderate' }, 'high'), false);
assert.equal(passesSeverityFloor({ severity: 'critical' }, 'high'), true);
assert.equal(passesSeverityFloor({ severity: 'mystery' }, 'high'), true); // unknown severity never hidden
assert.equal(passesSeverityFloor({}, 'high'), true);

console.log('intel/model.test.mjs: all assertions passed');
