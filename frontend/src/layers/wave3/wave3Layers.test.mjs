/**
 * Wave 3 layer configs — ids, honesty labels, and /api/events mapping.
 * Cesium/viewer are mocked via the factory's injectables.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHazardsLayer, SUB_SOURCES } from '../hazards/index.js';
import { createGpsJammingLayer, DERIVED_NOT_MEASURED } from '../gpsJamming/index.js';
import { createCloudflareRadarLayer, CF_RADAR_KEY_MESSAGE } from '../cfRadar/index.js';

function mockCesium() {
  return {
    CustomDataSource: class {
      constructor(id) {
        this.id = id;
        this.entities = { _list: [], add(e) { this._list.push(e); return e; }, removeAll() { this._list = []; } };
      }
    },
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Cartesian2: class {},
    Color: {
      fromCssColorString: (c) => ({ css: c, withAlpha: () => ({}) }),
      WHITE: {}, BLACK: {},
    },
    Rectangle: { fromDegrees: () => ({}) },
    LabelStyle: { FILL_AND_OUTLINE: 1 },
  };
}
function mockViewer(heightM = 20_000_000) {
  const ds = { _added: null, add(d) { this._added = d; }, remove() {} };
  return {
    _ds: ds, dataSources: ds,
    camera: { positionCartographic: { height: heightM }, flyTo() {}, moveEnd: { addEventListener() { return () => {}; } } },
    scene: {},
  };
}
const baseOpts = () => ({ cesium: mockCesium(), matchMedia: () => ({ matches: false }) });

const EVENTS = {
  events: [
    { id: 'g1', source: 'gdacs', title: 'EQ — Japan', summary: 's', lat: 35, lon: 140, severity: 'high', time: '2026-10-13T18:00:00.000Z', region: 'Japan', url: 'https://gdacs.org/x', attribution: 'GDACS' },
    { id: 'd1', source: 'gdelt_disasters', title: 'STORM: Flood', summary: 's', lat: null, lon: null, severity: 'high', time: '2026-10-13T17:00:00.000Z', region: 'India', url: 'https://news.example/y', attribution: 'GDELT' },
    { id: 'n1', source: 'nws_cap', title: 'Tornado Warning — Dallas', summary: 's', lat: 32.7, lon: -96.8, severity: 'critical', time: '2026-10-13T19:00:00.000Z', region: 'Dallas', url: 'https://alerts.weather.gov/', attribution: 'NWS (US only)' },
    { id: 'j1', source: 'gps_jamming', title: 'Possible GPS interference — Baltic Sea', summary: 's', lat: 56.5, lon: 19.5, severity: 'moderate', time: '2026-10-13T19:00:00.000Z', region: 'Baltic Sea', url: 'https://adsb.lol/', attribution: 'adsb.lol / ADS-B' },
  ],
};
const HEALTH = (status) => ({ sources: [{ name: 'cloudflare_radar', status }] });

function fetchStub(eventsPayload, healthPayload) {
  return async (url) => {
    if (String(url).includes('/api/health'))
      return { ok: true, json: async () => healthPayload };
    return { ok: true, json: async () => eventsPayload };
  };
}

test('hazards: one family row, three sub-sources, US-only labeled', async () => {
  const layer = createHazardsLayer({ fetchImpl: fetchStub(EVENTS, HEALTH('ok')), ...baseOpts() });
  assert.equal(layer.id, 'hazards');
  assert.equal(layer.name, 'Hazards');
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  const controls = layer.getRowControls();
  const chips = controls.chips.map((c) => c.label);
  assert.ok(chips.some((c) => /GDACS/.test(c)));
  assert.ok(chips.some((c) => /GDELT/.test(c)));
  assert.ok(chips.some((c) => /NWS/.test(c) && /US ONLY/.test(c)), 'NWS chip carries the US-only label');
  assert.match(controls.info, /US scope only/);
  // GDELT item has no coordinates: list-only, never plotted.
  const stats = layer.getStats();
  assert.equal(stats.count, 3);
  const ds = viewer._ds._added;
  assert.equal(ds.entities._list.length, 2, 'coordinate-less GDELT item is not plotted');
  assert.equal(SUB_SOURCES.length, 3);
  await layer.destroy();
});

test('gps-jamming: derived-not-measured is permanent', async () => {
  const layer = createGpsJammingLayer({ fetchImpl: fetchStub(EVENTS, HEALTH('ok')), ...baseOpts() });
  assert.equal(layer.id, 'gps-jamming');
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  assert.match(layer.getRowControls().info, /Derived, not measured/);
  assert.equal(DERIVED_NOT_MEASURED.length > 20, true);
  await layer.destroy();
});

test('cf-radar: needs_key becomes an honest KEY-NEEDED state', async () => {
  const layer = createCloudflareRadarLayer({
    fetchImpl: fetchStub(EVENTS, HEALTH('needs_key')),
    ...baseOpts(),
  });
  assert.equal(layer.id, 'cf-radar');
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  const stats = layer.getStats();
  assert.equal(stats.status, 'key_needed');
  assert.match(stats.statusMessage, /not configured/);
  assert.match(stats.error, /not configured/, 'key state is the row headline (FIRMS precedent)');
  assert.match(CF_RADAR_KEY_MESSAGE, /not "no disruptions"/);
  await layer.destroy();
});

test('cf-radar: keyed state renders disruption markers', async () => {
  const events = { events: [{ id: 'c1', source: 'cloudflare_radar', title: 'Disruption in X', summary: 's', lat: 10, lon: 10, severity: 'high', time: '2026-10-13T19:00:00.000Z', region: 'X', url: null, attribution: 'Cloudflare Radar' }] };
  const layer = createCloudflareRadarLayer({ fetchImpl: fetchStub(events, HEALTH('ok')), ...baseOpts() });
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().status, undefined);
  await layer.destroy();
});

test('hazards: backend unreachable fails closed with an error', async () => {
  const layer = createHazardsLayer({
    fetchImpl: async () => { throw new Error('fetch failed'); },
    ...baseOpts(),
  });
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  assert.match(layer.getStats().error, /fetch failed/);
  await layer.destroy();
});
