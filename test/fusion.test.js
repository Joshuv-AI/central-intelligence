// Central Intelligence — fusion reason-code test (J4-04, Wave 1).
// Asserts connections carry mechanical reason codes (no generated prose)
// that are fully derived from the scored chain.
const assert = require('assert');
const { runFusion } = require('../src/pipeline/fusion');

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const events = [
  { id: 't4', source: 'noaa_hurricanes', domain: 'disasters', title: 'Hurricane Polo Cat 3', summary: 's', lat: 21.3, lon: -113.9, region: 'Eastern Pacific', time: iso(now - 2 * 3600_000), severity: 'high', url: null, attribution: 'NOAA NHC' },
  { id: 't5', source: 'gdacs', domain: 'disasters', title: 'Tropical Cyclone near Mexico', summary: 's', lat: 21.0, lon: -114.0, region: 'Eastern Pacific', time: iso(now - 1 * 3600_000), severity: 'critical', url: null, attribution: 'GDACS' },
];

const conns = runFusion(events);
assert.ok(conns.length >= 1, 'expected at least one connection');
const c = conns[0];

assert.ok(Array.isArray(c.reasons) && c.reasons.length > 0, 'reasons must be a non-empty array');
for (const r of c.reasons) {
  assert.ok(typeof r.code === 'string' && r.code.length > 0, 'every reason has a code');
  // No prose fields on reasons — codes + measured params only.
  assert.ok(r.text === undefined && r.sentence === undefined, 'reasons carry no prose');
}

const byCode = Object.fromEntries(c.reasons.map((r) => [r.code, r]));
assert.ok(byCode.shared_tags, 'shared_tags reason present');
assert.ok(Array.isArray(byCode.shared_tags.tags) && byCode.shared_tags.tags.length > 0, 'shared_tags lists the tags');
assert.ok(byCode.time_window && byCode.time_window.windowHours === 6, `time_window honest bucket, got ${JSON.stringify(byCode.time_window)}`);
assert.ok(byCode.proximity_km && byCode.proximity_km.withinKm <= 100, `proximity bucket honest, got ${JSON.stringify(byCode.proximity_km)}`);
assert.ok(byCode.sources && byCode.sources.count === 2, 'sources count is the real corroboration signal');

// A chain with unknown times must not fabricate a time_window reason.
const noTime = runFusion([
  { id: 'a', source: 'noaa_hurricanes', domain: 'disasters', title: 'Hurricane X', summary: 's', lat: 1, lon: 1, region: 'R', time: 'not-a-date', severity: 'high' },
  { id: 'b', source: 'gdacs', domain: 'disasters', title: 'Disaster Y', summary: 's', lat: 1.1, lon: 1.1, region: 'R', time: 'not-a-date', severity: 'high' },
]);
if (noTime.length) {
  const codes = noTime[0].reasons.map((r) => r.code);
  assert.ok(!codes.includes('time_window'), 'no time signal → no time_window reason (never fabricated)');
}

console.log(`fusion reasons OK (${conns.length} connection(s), codes: ${c.reasons.map((r) => r.code).join(', ')})`);
