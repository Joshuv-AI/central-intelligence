// NWS CAP adapter — pure mapping tests (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { _mapAlert, _centroid } = require('../src/pipeline/adapters/tier1/nws_cap.js');

const tornadoAlert = {
  properties: {
    id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.abc123',
    event: 'Tornado Warning',
    severity: 'Severe',
    areaDesc: 'Dallas County; Tarrant County',
    effective: '2026-10-13T19:00:00-05:00',
    sent: '2026-10-13T19:00:00-05:00',
  },
  geometry: {
    type: 'Polygon',
    coordinates: [[[-97.0, 32.5], [-96.5, 32.5], [-96.5, 33.0], [-97.0, 33.0], [-97.0, 32.5]]],
  },
};

test('hazard alert maps to an event with a real centroid', () => {
  const e = _mapAlert(tornadoAlert);
  assert.ok(e);
  assert.equal(e.lat, 32.7);
  assert.ok(Math.abs(e.lon - (-96.8)) < 0.01);
  assert.equal(e.severity, 'high');
  assert.match(e.summary, /US scope only/);
  assert.match(e.attribution, /US only/);
  assert.equal(e.url, 'https://alerts.weather.gov/');
});

test('non-hazard advisory is filtered out', () => {
  const fog = {
    properties: { id: 'x1', event: 'Dense Fog Advisory', severity: 'Moderate', areaDesc: 'Bay' },
    geometry: tornadoAlert.geometry,
  };
  assert.equal(_mapAlert(fog), null);
});

test('alert without geometry is dropped, never fabricated', () => {
  const noGeom = {
    properties: { id: 'x2', event: 'Tornado Warning', severity: 'Extreme', areaDesc: 'OK' },
    geometry: null,
  };
  assert.equal(_mapAlert(noGeom), null);
});

test('extreme severity maps to critical', () => {
  const e = _mapAlert({
    properties: { id: 'x3', event: 'Flash Flood Warning', severity: 'Extreme', areaDesc: 'TX' },
    geometry: tornadoAlert.geometry,
  });
  assert.equal(e.severity, 'critical');
});

test('centroid rejects malformed rings', () => {
  assert.equal(_centroid(null), null);
  assert.equal(_centroid({ type: 'Polygon', coordinates: [] }), null);
  assert.equal(
    _centroid({ type: 'Polygon', coordinates: [[[0, 91], [1, 91], [1, 92]]] }),
    null,
  );
});
