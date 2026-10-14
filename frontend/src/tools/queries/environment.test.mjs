import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogForSurface,
  composeCatalog,
  coreTools,
  defineTool,
  ToolError,
} from '../index.js';

const conditions = {
  observedAt: '2026-10-01T19:15:00.000Z',
  temperatureC: 26.3,
  apparentTemperatureC: 32,
  precipitationMm: 0,
  cloudCoverPct: 100,
  windKph: 5.4,
  windDirectionDeg: 318,
  visibilityM: 15400,
  weatherCode: 3,
};
const weather = {
  calls: [],
  async getConditions(latitude, longitude) {
    this.calls.push([latitude, longitude]);
    return { status: 'ready', weather: conditions };
  },
};
const places = {
  resolve: async (name) =>
    name === 'Austin'
      ? {
          name: 'Austin, Texas',
          bounds: { west: -97.94, south: 30.1, east: -97.56, north: 30.52 },
        }
      : null,
};
const catalogWith = (services) =>
  composeCatalog({ tools: coreTools, services });

test('weather describes current conditions at a point or place', async () => {
  const catalog = catalogWith({ weather, places });
  const result = await catalog.call('get_weather', {
    location: { place: 'Austin' },
  });
  assert.equal(
    result.summary,
    'Weather at Austin, Texas: overcast, 26°C, wind 5 km/h.',
  );
  assert.deepEqual(result.data.weather, {
    observed_at: '2026-10-01T19:15:00.000Z',
    conditions: 'overcast',
    weather_code: 3,
    temperature_c: 26.3,
    feels_like_c: 32,
    precipitation_mm: 0,
    cloud_cover_pct: 100,
    wind_kph: 5.4,
    wind_direction_deg: 318,
    visibility_m: 15400,
  });
  const [latitude, longitude] = weather.calls.at(-1);
  assert.ok(Math.abs(latitude - 30.31) < 1e-9 && longitude === -97.75);
});

test('cyclones are listed strongest first and can be limited to an area', async () => {
  // Helper: (id, name, lat, lon, windKt) — pre-cutover 2026-10-14: was missing.
  // The tool reads storm.position.latitude/longitude and storm.windKt.
  const storm = (id, name, latitude, longitude, windKt) => ({
    id, name, position: { latitude, longitude }, windKt,
  });
  const cyclones = {
    async getSnapshot() {
      return {
        source: 'NOAA NHC / CPHC',
        coverage: 'Atlantic and eastern/central North Pacific',
        stale: false,
        unavailable: false,
        storms: [
          storm('a', 'Alpha', 25, -70, 65),
          storm('b', 'Beta', 15, -110, 120),
        ],
      };
    },
  };
  const all = await catalogWith({ cyclones }).call('get_cyclones', {});
  assert.equal(
    all.summary,
    '2 active tropical cyclones; strongest Beta at 120 kt.',
  );
  assert.deepEqual(
    all.data.storms.map((row) => row.id),
    ['b', 'a'],
  );
  const atlantic = await catalogWith({ cyclones }).call('get_cyclones', {
    area: { bbox: [-100, 0, -10, 50] },
  });
  assert.equal(
    atlantic.summary,
    '1 active tropical cyclone in the requested box; strongest Alpha at 65 kt.',
  );
  const down = { getSnapshot: async () => ({ unavailable: true, storms: [] }) };
  await assert.rejects(
    catalogWith({ cyclones: down }).call('get_cyclones', {}),
    (error) => error.code === 'unavailable',
  );
});

test('fire perimeters are placed by their outline and sorted by size', async () => {
  const ring = (lon, lat) => [
    [
      [lon, lat],
      [lon + 0.1, lat],
      [lon + 0.1, lat + 0.1],
      [lon, lat + 0.1],
    ],
  ];
  const perimeters = {
    async getSnapshot() {
      return [
        {
          stableId: 'small',
          name: 'Small Fire',
          acres: 120.4,
          containedPct: 80,
          state: 'US-CA',
          county: 'Kern',
          category: 'WF',
          cause: 'Human',
          behavior: null,
          personnel: 20,
          discoveredTime: Date.UTC(2026, 8, 1),
          updatedTime: null,
          polygons: [ring(-118.5, 35.2)],
        },
        {
          stableId: 'big',
          name: 'Big Fire',
          acres: 5000,
          containedPct: 10,
          polygons: [ring(-118.8, 35.4)],
        },
        {
          stableId: 'far',
          name: 'Far Fire',
          acres: 9000,
          polygons: [ring(-80, 30)],
        },
        { stableId: 'empty', name: 'No Outline', acres: 1, polygons: [] },
      ];
    },
  };
  const result = await catalogWith({ perimeters }).call('get_fire_perimeters', {
    area: { bbox: [-120, 34, -117, 36] },
  });
  assert.equal(
    result.summary,
    '2 mapped wildfire perimeters in the requested box.',
  );
  assert.deepEqual(
    result.data.rows.map((row) => row.id),
    ['big', 'small'],
  );
  assert.deepEqual(result.data.rows[1], {
    id: 'small',
    name: 'Small Fire',
    acres: 120,
    contained_pct: 80,
    state: 'US-CA',
    county: 'Kern',
    category: 'WF',
    cause: 'Human',
    behavior: null,
    personnel: 20,
    discovered: '2026-09-01T00:00:00.000Z',
    updated: null,
    lat: 35.25,
    lon: -118.45,
  });
});

test('terrain heights are returned in request order', async () => {
  const terrain = {
    async getHeights(points) {
      return points.map((point) => ({
        ...point,
        elevation: point.lat * 100,
        geoid: -30.04,
        ellipsoid: point.lat * 100 - 30.04,
      }));
    },
  };
  const one = await catalogWith({ terrain }).call('get_terrain_height', {
    points: [{ lat: 27.9881, lon: 86.925 }],
  });
  assert.equal(one.summary, 'Ground elevation is 2798.8 m at 27.9881, 86.925.');
  const many = await catalogWith({ terrain }).call('get_terrain_height', {
    points: [
      { lat: 1, lon: 1 },
      { lat: 2, lon: 2 },
    ],
  });
  assert.deepEqual(
    many.data.points.map((point) => point.elevation_m),
    [100, 200],
  );
  const short = { getHeights: async () => [] };
  await assert.rejects(
    catalogWith({ terrain: short }).call('get_terrain_height', {
      points: [{ lat: 1, lon: 1 }],
    }),
    (error) => error.code === 'malformed',
  );
  await assert.rejects(
    catalogWith({ terrain }).call('get_terrain_height', {
      points: Array(21).fill({ lat: 0, lon: 0 }),
    }),
    /at most 20 items/,
  );
});

test('military installations need a bounded area and are nearest first', async () => {
  const requested = [];
  const options = [];
  let saturated = false;
  const installations = {
    async getMappedSites(box, { signal, ...rest } = {}) {
      requested.push(box);
      options.push(rest);
      return {
        saturated,
        source: 'OpenStreetMap',
        records: [
          {
            id: 'osm:1',
            kind: 'installation',
            class: 'base',
            name: 'Naval Base Point Loma',
            latitude: 32.6941,
            longitude: -117.2494,
          },
          {
            id: 'osm:2',
            kind: 'installation',
            class: 'airfield',
            name: 'North Island',
            latitude: 32.7,
            longitude: -117.2,
          },
        ],
      };
    },
  };
  const catalog = catalogWith({ installations });
  const result = await catalog.call('find_military_installations', {
    area: { lat: 32.7, lon: -117.2, radius_km: 20 },
  });
  assert.equal(
    result.summary,
    '2 mapped military installations in 20 km around 32.700, -117.200.',
  );
  assert.deepEqual(
    result.data.rows.map((row) => row.id),
    ['osm:2', 'osm:1'],
  );
  assert.equal(result.data.source, 'OpenStreetMap');
  assert.equal(result.data.complete, true);
  assert.ok(requested[0].north - requested[0].south < 1);
  assert.deepEqual(options[0], { exact: true, thinned: false });
  saturated = true;
  const partial = await catalog.call('find_military_installations', {
    area: { lat: 32.7, lon: -117.2, radius_km: 20 },
  });
  assert.equal(partial.data.complete, false);
  assert.match(
    partial.summary,
    /\(partial: the source returned only some sites\)\.$/,
  );
  await assert.rejects(
    catalog.call('find_military_installations', {
      area: { bbox: [-130, 20, -100, 50] },
    }),
    /at most 10° on each side/,
  );
});

test('map features name what is at a location and report an unconfigured server', async () => {
  const features = {
    async getAdministrativeAreas() {
      return [
        {
          id: 1,
          category: 'administrative',
          names: { primary: 'Texas' },
          level: 4,
          point: null,
        },
        {
          id: 2,
          category: 'administrative',
          names: { primary: 'Travis County', english: 'Travis County' },
          level: 6,
          point: null,
        },
        { id: 3, category: 'administrative', names: {}, level: 8, point: null },
      ];
    },
    getEnclosingAreas: async () => null,
    getMonuments: async () => ({
      unavailable: true,
      code: 'OVERPASS_NOT_CONFIGURED',
    }),
  };
  const catalog = catalogWith({ features });
  const result = await catalog.call('get_map_features', {
    location: { lat: 30.27, lon: -97.74 },
    kind: 'administrative_areas',
  });
  assert.equal(
    result.summary,
    '2 named features (administrative areas) at 30.2700, -97.7400.',
  );
  assert.deepEqual(
    result.data.rows.map((row) => [row.name, row.admin_level]),
    [
      ['Texas', 4],
      ['Travis County', 6],
    ],
  );
  await assert.rejects(
    catalog.call('get_map_features', {
      location: { lat: 30.27, lon: -97.74 },
      kind: 'monuments',
    }),
    (error) => error.code === 'unavailable' && /Overpass/.test(error.message),
  );
  await assert.rejects(
    catalog.call('get_map_features', {
      location: { lat: 30.27, lon: -97.74 },
      kind: 'named_places',
    }),
    (error) => error.code === 'retry_later',
  );
});

test('a fire perimeter enclosing the whole area is found', async () => {
  const perimeters = {
    getSnapshot: async () => [
      {
        stableId: 'big',
        name: 'Big Fire',
        acres: 250000,
        polygons: [
          [
            [
              [-122, 38],
              [-120, 38],
              [-120, 40],
              [-122, 40],
            ],
          ],
        ],
      },
    ],
  };
  const result = await catalogWith({ perimeters }).call('get_fire_perimeters', {
    area: { bbox: [-121.2, 38.9, -120.8, 39.1] },
  });
  assert.deepEqual(
    result.data.rows.map((row) => row.id),
    ['big'],
  );
});

test('installation names wait for the name pack, briefly', async (t) => {
  const site = (name) => ({
    id: 'osm:9',
    kind: 'installation',
    name,
    latitude: 30.31,
    longitude: -97.76,
  });
  const source = (enrichment) => ({
    getMappedSites: async () => ({
      source: 'OpenStreetMap tiles',
      records: [site('Military area')],
      enrichment,
    }),
  });
  const area = { lat: 30.31, lon: -97.76, radius_km: 5 };
  const named = await catalogWith({
    installations: source(
      Promise.resolve({
        source: 'OpenStreetMap tiles',
        records: [site('Camp Mabry')],
      }),
    ),
  }).call('find_military_installations', { area });
  assert.equal(named.data.rows[0].name, 'Camp Mabry');
  assert.equal(named.data.names_pending, false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = catalogWith({
    installations: source(new Promise(() => {})),
  }).call('find_military_installations', { area });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  const slow = await pending;
  assert.equal(slow.data.rows[0].name, 'Military area');
  assert.equal(slow.data.names_pending, true);
  assert.match(slow.summary, /site names are still loading\)\.$/);
});
