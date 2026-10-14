import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAge, sourceAgeText } from './ageFormat.js';

const NOW = 1_789_000_000_000;

test('formatAge buckets are coarse', () => {
  assert.equal(formatAge(NOW - 10_000, NOW), 'just now');
  assert.equal(formatAge(NOW - 59_000, NOW), 'just now');
  assert.equal(formatAge(NOW - 60_000, NOW), '1 m');
  assert.equal(formatAge(NOW - 12 * 60_000, NOW), '12 m');
  assert.equal(formatAge(NOW - 59 * 60_000, NOW), '59 m');
  assert.equal(formatAge(NOW - 3_600_000, NOW), '1 h');
  assert.equal(formatAge(NOW - 23 * 3_600_000, NOW), '23 h');
  assert.equal(formatAge(NOW - 86_400_000, NOW), '1 d');
  assert.equal(formatAge(NOW - 4 * 86_400_000, NOW), '4 d');
});

test('formatAge never shows seconds or negative ages', () => {
  assert.equal(formatAge(NOW - 45_000, NOW), 'just now'); // not "45 s"
  assert.equal(formatAge(NOW + 60_000, NOW), 'just now'); // future: never negative
});

test('formatAge handles bad input honestly', () => {
  assert.equal(formatAge(null, NOW), '—');
  assert.equal(formatAge(undefined, NOW), '—');
  assert.equal(formatAge(NaN, NOW), '—');
  assert.equal(formatAge('not-a-date', NOW), '—');
  assert.equal(formatAge(new Date(NOW - 120_000).toISOString(), NOW), '2 m');
});

test('sourceAgeText renders source · age', () => {
  assert.equal(
    sourceAgeText({ source: 'USGS', fetchedAtMs: NOW - 12 * 60_000 }, NOW),
    'USGS · 12 m ago',
  );
  assert.equal(
    sourceAgeText({ source: 'FIRMS' }, NOW),
    'FIRMS · age unknown',
  );
  assert.equal(
    sourceAgeText({ source: 'NWS', fetchedAtMs: NOW - 3_600_000, stale: true }, NOW),
    'NWS · 1 h ago · STALE',
  );
  assert.equal(sourceAgeText({}, NOW), 'Unknown source · age unknown');
});

test('"just now" never takes "ago" (glitch fix)', () => {
  assert.equal(sourceAgeText({ source: 'USGS', fetchedAtMs: NOW - 5_000 }, NOW), 'USGS · just now');
  assert.equal(
    sourceAgeText({ source: 'USGS', fetchedAtMs: NOW - 5_000, stale: true }, NOW),
    'USGS · just now · STALE',
  );
  assert.equal(sourceAgeText({ source: 'USGS', fetchedAtMs: NOW - 90_000 }, NOW), 'USGS · 1 m ago');
});
