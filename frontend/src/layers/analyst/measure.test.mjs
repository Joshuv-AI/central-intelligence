/** J4-09 · measure math — distance, area, formatting, the B2+ gate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatArea,
  formatDistance,
  haversineKm,
  measureAllowed,
  MEASURE_GATED_HINT,
  pathLengthKm,
  polygonAreaKm2,
} from './measure.js';

test('haversine: San Francisco to Los Angeles ≈ 559 km', () => {
  const d = haversineKm(37.7749, -122.4194, 34.0522, -118.2437);
  assert.ok(Math.abs(d - 559) < 8, `got ${d}`);
});

test('path length sums segments', () => {
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
  ];
  const d = pathLengthKm(pts);
  // Two 1° legs at the equator ≈ 222.4 km.
  assert.ok(Math.abs(d - 222.4) < 2, `got ${d}`);
  assert.equal(pathLengthKm([]), 0);
  assert.equal(pathLengthKm([pts[0]]), 0);
});

test('polygon area: 1° square at equator ≈ 12,390 km²', () => {
  const square = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 0 },
  ];
  const a = polygonAreaKm2(square);
  assert.ok(Math.abs(a - 12390) < 120, `got ${a}`);
  assert.equal(polygonAreaKm2([{ lat: 0, lon: 0 }]), 0);
});

test('formatters stay coarse and honest', () => {
  assert.equal(formatDistance(0.4), '≈400 m');
  assert.equal(formatDistance(12.34), '≈12.3 km');
  assert.match(formatArea(45.2), /45\.2 km²/);
  assert.equal(formatDistance(NaN), '—');
});

test('measure gate: B2 and below only', () => {
  assert.equal(measureAllowed('B0'), false);
  assert.equal(measureAllowed('B1'), false);
  assert.equal(measureAllowed('B2'), true);
  assert.equal(measureAllowed('B5'), true);
  assert.ok(MEASURE_GATED_HINT.length > 10);
});
