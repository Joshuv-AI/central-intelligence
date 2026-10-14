import test from 'node:test';
import assert from 'node:assert/strict';
import { rankWhatMatters, RANKING_EXPLAINER, TOP_N } from './whatMatters.js';

const NOW = 1_789_000_000_000;
const H = 3600_000;

function ev(id, over = {}) {
  return {
    id, title: `Event ${id}`, severity: 'high', source: 'USGS',
    time: new Date(NOW - 2 * H).toISOString(), lat: 10, lon: 20, ...over,
  };
}
function conn(id, over = {}) {
  return {
    id, title: 'A → B', severity: 'high', score: 82,
    createdAt: new Date(NOW - 3 * H).toISOString(),
    eventIds: ['e1', 'e2'],
    reasons: [{ code: 'sources', count: 3 }],
    chain: [{ source: 'USGS' }, { source: 'GDACS' }, { source: 'NWS' }],
    ...over,
  };
}

test('critical + fresh outranks low + old', () => {
  const rows = rankWhatMatters({
    markers: [ev('old-low', { severity: 'low', time: new Date(NOW - 30 * H).toISOString() }), ev('new-crit', { severity: 'critical', time: new Date(NOW - H).toISOString() })],
    nowMs: NOW,
  });
  assert.equal(rows[0].id, 'new-crit');
  assert.equal(rows[0].parts.severity, 75);
  assert.equal(rows[0].parts.freshness, 15);
});

test('connection gets link + corroboration points, reasons are mechanical', () => {
  const rows = rankWhatMatters({ markers: [], connections: [conn('c1')], nowMs: NOW });
  const r = rows[0];
  assert.equal(r.kind, 'connection');
  assert.equal(r.parts.link, 8); // round(82/10)
  assert.equal(r.parts.corroboration, 5);
  assert.ok(r.reasons.some((x) => x.includes('corroborated by 3 sources')));
  assert.ok(r.reasons.some((x) => /High severity/.test(x)));
  assert.ok(!r.reasons.join(' ').match(/[A-Z][a-z]+ (is|was|will|has) /), 'no generated prose');
});

test('connection members are listed once, under the connection', () => {
  const rows = rankWhatMatters({
    markers: [ev('e1', { severity: 'critical' }), ev('e3', { severity: 'critical' })],
    connections: [conn('c1')],
    nowMs: NOW,
  });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes('c1'));
  assert.ok(!ids.includes('e1'), 'member event deduped');
  assert.ok(ids.includes('e3'), 'non-member event kept');
});

test('top-N cap and severity floor apply', () => {
  const markers = Array.from({ length: 20 }, (_, i) => ev(`e${i}`, { severity: i % 2 ? 'low' : 'moderate' }));
  const rows = rankWhatMatters({ markers, severityFloor: 'high', nowMs: NOW });
  assert.equal(rows.length, 0);
  const rows2 = rankWhatMatters({ markers, nowMs: NOW });
  assert.ok(rows2.length <= TOP_N);
});

test('empty inputs rank to nothing (honest empty state)', () => {
  assert.deepEqual(rankWhatMatters({ nowMs: NOW }), []);
});

test('explainer states the formula in plain language', () => {
  assert.ok(RANKING_EXPLAINER.includes('Critical 75'));
  assert.ok(RANKING_EXPLAINER.includes('under 6 h +15'));
  assert.ok(RANKING_EXPLAINER.includes('No text is written by the system'));
});
