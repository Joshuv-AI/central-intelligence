import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShareSeverityFloor, describeShareLink, shareLinkSummary } from './sharelink.js';

test('normalizeShareSeverityFloor fails visible to all', () => {
  assert.equal(normalizeShareSeverityFloor('high'), 'high');
  assert.equal(normalizeShareSeverityFloor('notable'), 'notable');
  assert.equal(normalizeShareSeverityFloor('all'), 'all');
  assert.equal(normalizeShareSeverityFloor('bogus'), 'all');
  assert.equal(normalizeShareSeverityFloor(null), 'all');
  assert.equal(normalizeShareSeverityFloor(undefined), 'all');
});

test('describeShareLink decodes the link itself, never app state', () => {
  const href = 'http://x/#v=2&lat=37.7749&lon=-122.4194&alt=800&sev=high&l=flights.ais-live-vessels&at=1789000000';
  const d = describeShareLink(href);
  assert.equal(d.ok, true);
  assert.deepEqual(d.camera, { lat: 37.7749, lon: -122.4194, alt: 800 });
  assert.equal(d.layerCount, 2);
  assert.equal(d.layersLabeled, true);
  assert.equal(d.severityFloor, 'high');
  assert.equal(d.sharedAtMs, 1789000000 * 1000);
  const s = shareLinkSummary(d);
  assert.match(s, /This link carries:/);
  assert.match(s, /camera 37\.77°N 122\.42°W · 800 m/);
  assert.match(s, /2 layers on/);
  assert.match(s, /severity floor: High\+/);
});

test('shareLinkSummary formats globe-scale altitudes as km', () => {
  const d = describeShareLink('http://x/#v=2&lat=18&lon=10&alt=26000000&sev=all');
  assert.match(shareLinkSummary(d), /camera 18\.00°N 10\.00°E · 26,000 km/);
});

test('describeShareLink is honest about missing/malformed links', () => {
  const d = describeShareLink('http://x/#v=2&sev=bogus');
  assert.equal(d.ok, false);
  assert.equal(d.camera, null);
  assert.equal(d.layerCount, null);
  assert.equal(d.severityFloor, 'all'); // fail-visible
  assert.match(shareLinkSummary(d), /camera: not set/);
  assert.match(shareLinkSummary(d), /severity floor: All/);
  const emptyLayers = describeShareLink('http://x/#v=2&lat=1&lon=2&l=&sev=notable');
  assert.equal(emptyLayers.layerCount, 0);
  assert.match(shareLinkSummary(emptyLayers), /no layers on/);
  assert.match(shareLinkSummary(emptyLayers), /severity floor: Notable\+/);
  assert.deepEqual(describeShareLink('').ok, false);
  assert.deepEqual(describeShareLink(null).ok, false);
});
