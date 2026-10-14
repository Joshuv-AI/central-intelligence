/** J4-10 · current-picture summary — mechanical, never narrative. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurrentPicture } from './summary.js';

const NOW = Date.parse('2026-10-13T19:00:00.000Z');
const EVENTS = [
  { title: 'Quake M6.2 hits coast', severity: 'high', time: '2026-10-13T18:30:00.000Z' },
  { title: 'Flood warning issued', severity: 'critical', time: '2026-10-13T18:00:00.000Z' },
  { title: 'Minor tremor', severity: 'low', time: '2026-10-13T12:00:00.000Z' },
  { title: 'Old drizzle', severity: 'low', time: '2026-10-12T12:00:00.000Z' },
];

test('summary counts and lists top items mechanically', () => {
  const s = buildCurrentPicture(EVENTS, { nowMs: NOW });
  assert.match(s, /Current picture: 4 developments, 2 high-severity or above\./);
  // Critical outranks high; coarse ages only.
  assert.match(s, /Flood warning issued — 1 h/);
  assert.match(s, /Quake M6\.2 hits coast — 30 m/);
  assert.match(s, /Minor tremor — 7 h/);
  assert.doesNotMatch(s, /Old drizzle/);
});

test('no high-severity path reads honestly', () => {
  const s = buildCurrentPicture(
    [{ title: 'Small rain cell', severity: 'low', time: '2026-10-13T18:00:00.000Z' }],
    { nowMs: NOW },
  );
  assert.match(s, /none high-severity/);
});

test('empty snapshot is an honest empty state', () => {
  assert.match(buildCurrentPicture([], { nowMs: NOW }), /no intelligence events/);
  assert.match(buildCurrentPicture(null, { nowMs: NOW }), /no intelligence events/);
});
