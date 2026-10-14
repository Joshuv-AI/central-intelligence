/**
 * Wave 3 shared marker-layer factory — contract, §L gating, honesty states.
 * Cesium + viewer are mocked; the factory takes both as injectables.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWave3MarkerLayer } from './markerLayer.js';

function mockCesium() {
  return {
    CustomDataSource: class {
      constructor(id) {
        this.id = id;
        this.show = true;
        this.entities = {
          _list: [],
          add(e) { this._list.push(e); return e; },
          removeAll() { this._list = []; },
        };
      }
    },
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Cartesian2: class { constructor(x, y) { this.x = x; this.y = y; } },
    Color: {
      fromCssColorString: (c) => ({ css: c, withAlpha: (a) => ({ css: c, alpha: a }) }),
      WHITE: { white: true },
      BLACK: { black: true },
    },
    Rectangle: { fromDegrees: (w, s, e, n) => ({ w, s, e, n }) },
    LabelStyle: { FILL_AND_OUTLINE: 1 },
  };
}

// Camera height in metres drives the §L band.
function mockViewer(heightM = 20_000_000) {
  const ds = {
    _added: null,
    add(d) { this._added = d; },
    remove() { this._added = null; },
  };
  return {
    _ds: ds,
    dataSources: ds,
    camera: {
      positionCartographic: { height: heightM },
      flyToArgs: null,
      flyTo(args) { this.flyToArgs = args; },
      moveEnd: { addEventListener() { return () => {}; } },
    },
    scene: {},
  };
}

const ITEMS = [
  { id: 'a', lat: 10, lon: 20, title: 'Alpha', severity: 'high', subSource: 's1' },
  { id: 'b', lat: -5, lon: 30, title: 'Beta', severity: 'low', subSource: 's2' },
  { id: 'c', lat: null, lon: null, title: 'No position', severity: 'low', subSource: 's1' },
];

function makeLayer(overrides = {}) {
  const C = mockCesium();
  let calls = 0;
  const layer = createWave3MarkerLayer({
    id: 'test-layer',
    name: 'Test',
    cesium: C,
    matchMedia: () => ({ matches: false }),
    fetchItems: async () => {
      calls += 1;
      return { items: ITEMS, fetchedAt: 1234 };
    },
    describeRowControls: (state, api) => ({
      chips: [
        {
          id: 'sub-s1',
          label: 'S1',
          active: api.subVisible({ subSource: 's1' }),
          onClick: () => api.toggleSub('s1'),
        },
      ],
    }),
    ...overrides,
  });
  return { layer, calls: () => calls, C };
}

test('enable fetches and renders positioned items only', async () => {
  const { layer } = makeLayer();
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  const ds = viewer._ds._added;
  assert.ok(ds, 'datasource added');
  assert.equal(ds.entities._list.length, 2, 'null-coord item skipped, not fabricated');
  assert.equal(layer.getStats().count, 3 - 1 + 1 - 1 + 1, 'count is sub-visible items (3), incl. list-only');
  assert.equal(layer.getStats().count, 3);
  await layer.destroy();
});

test('closed fetch gate means NO fetch + honest guidance', async () => {
  let fetched = 0;
  const { layer } = makeLayer({
    fetchGate: { maxHeightM: 650_000, message: 'Zoom in to load' },
    fetchItems: async () => { fetched += 1; return { items: [] }; },
  });
  const viewer = mockViewer(20_000_000); // B0 — gate closed
  await layer.init(viewer, {});
  await layer.enable(viewer);
  assert.equal(fetched, 0, 'gated: fetch must not run');
  const stats = layer.getStats();
  assert.equal(stats.status, 'gated');
  assert.equal(stats.statusMessage, 'Zoom in to load');
  assert.equal(stats.error, 'Zoom in to load', 'gate message is the row headline (flights precedent)');
  await layer.destroy();
});

test('open gate fetches', async () => {
  let fetched = 0;
  const { layer } = makeLayer({
    fetchGate: { maxHeightM: 650_000, message: 'Zoom in to load' },
    fetchItems: async () => { fetched += 1; return { items: [] }; },
  });
  const viewer = mockViewer(100_000); // B3 — gate open
  await layer.init(viewer, {});
  await layer.enable(viewer);
  assert.equal(fetched, 1);
  await layer.destroy();
});

test('fetch failure is an honest error, never silent', async () => {
  const { layer } = makeLayer({
    fetchItems: async () => { throw new Error('boom: ECONNREFUSED'); },
  });
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  const stats = layer.getStats();
  assert.match(stats.error, /boom/);
  assert.equal(stats.loading, false);
  await layer.destroy();
});

test('keyRequired result becomes a KEY-NEEDED guidance state', async () => {
  const { layer } = makeLayer({
    fetchItems: async () => ({
      items: [], fetchedAt: 1, keyRequired: true, keyMessage: 'Token missing',
    }),
  });
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  const stats = layer.getStats();
  assert.equal(stats.status, 'key_needed');
  assert.equal(stats.statusMessage, 'Token missing');
  await layer.destroy();
});

test('sub-source chip toggles visibility and count', async () => {
  const { layer } = makeLayer();
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  const chip = layer.getRowControls().chips.find((c) => c.id === 'sub-s1');
  assert.ok(chip && chip.active, 's1 visible initially');
  chip.onClick();
  assert.equal(layer.getStats().count, 1, 'only s2 item remains');
  const ds = viewer._ds._added;
  assert.equal(ds.entities._list.length, 1);
  await layer.destroy();
});

test('label budget: B0 renders points with zero labels', async () => {
  const { layer } = makeLayer({ labelBudget: { B0: 0, B3: 25 } });
  const viewer = mockViewer(20_000_000);
  await layer.init(viewer, {});
  await layer.enable(viewer);
  const ds = viewer._ds._added;
  assert.ok(ds.entities._list.length > 0);
  assert.ok(ds.entities._list.every((e) => !e.label), 'no labels at globe band');
  await layer.destroy();
});

test('setParams flyTo drives the camera', async () => {
  const { layer } = makeLayer();
  const viewer = mockViewer();
  await layer.init(viewer, {});
  const ok = await layer.setParams({ flyTo: { lat: 10, lon: 20 } });
  assert.equal(ok, true);
  assert.ok(viewer.camera.flyToArgs, 'camera.flyTo called');
  await layer.destroy();
});

test('zones render as rectangles', async () => {
  const { layer } = makeLayer({ render: 'zones' });
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  const ds = viewer._ds._added;
  assert.ok(ds.entities._list.every((e) => e.rectangle), 'every entity is a zone rectangle');
  const rect = ds.entities._list[0].rectangle.coordinates;
  assert.deepEqual([rect.w, rect.s, rect.e, rect.n], [19.5, 9.5, 20.5, 10.5]);
  await layer.destroy();
});

test('disable hides the datasource; destroy removes it', async () => {
  const { layer } = makeLayer();
  const viewer = mockViewer();
  await layer.init(viewer, {});
  await layer.enable(viewer);
  await layer.disable();
  assert.equal(viewer._ds._added.show, false);
  await layer.destroy();
  assert.equal(viewer._ds._added, null);
});
