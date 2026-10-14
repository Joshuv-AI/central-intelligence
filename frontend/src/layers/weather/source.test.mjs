import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWeatherSource,
  parseWeatherCapabilities,
  validateWeatherSnapshot,
  weatherImageUrl,
  weatherTileBounds,
  wmsTileUrl,
  WEATHER_DETAIL_SIZE,
  WEATHER_IMAGE_SIZES,
} from './source.js';
const time = '2026-09-16T02:00:00.000Z';
const earlier = '2026-09-16T01:00:00.000Z';
const now = () => Date.parse('2026-09-16T03:00:00.000Z');
const snapshot = () => ({
  schemaVersion: 1,
  product: 'radar',
  bounds: { west: -130, south: 20, east: -60, north: 55 },
  times: [time],
  latest: time,
  tileSize: 256,
  maxLevel: 6,
  tilingScheme: 'geographic',
});
const capabilities = (layer, { west = -130, south = 20, east = -60, north = 55 } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0"><Capability><Layer><Title>root</Title><Layer>
<Name>${layer}</Name>
<EX_GeographicBoundingBox><westBoundLongitude>${west}</westBoundLongitude><southBoundLatitude>${south}</southBoundLatitude><eastBoundLongitude>${east}</eastBoundLongitude><northBoundLatitude>${north}</northBoundLatitude></EX_GeographicBoundingBox>
<Dimension name="time" units="ISO8601" default="${time}">${earlier},${time}</Dimension>
</Layer></Layer></Capability></WMS_Capabilities>`;

test('observed source accepts bounded exact times and refuses malformed or unsorted frames', () => {
  assert.equal(validateWeatherSnapshot(snapshot(), 'radar').latest, time);
  for (const bad of [
    { times: [time, time] },
    { product: 'other' },
    { times: Array(14).fill(time) },
    { latest: 'tomorrow' },
    { maxLevel: 20 },
    { bounds: { west: -999, south: 0, east: 1, north: 1 } },
  ])
    assert.throws(
      () => validateWeatherSnapshot({ ...snapshot(), ...bad }, 'radar'),
      /Malformed/,
    );
});

test('capabilities parsing extracts the leaf layer bounds and recent times only', () => {
  const parsed = parseWeatherCapabilities(
    capabilities('conus_base_reflectivity_mosaic'),
    'radar',
    now(),
  );
  assert.deepEqual(parsed.bounds, { west: -130, south: 20, east: -60, north: 55 });
  assert.deepEqual(parsed.times, [earlier, time]);
  assert.throws(
    () => parseWeatherCapabilities(capabilities('other_layer'), 'radar', now()),
    /Invalid weather metadata/,
  );
  assert.throws(
    () =>
      parseWeatherCapabilities(
        capabilities('conus_base_reflectivity_mosaic'),
        'radar',
        Date.parse('2026-09-20T03:00:00.000Z'),
      ),
    /expired/,
  );
});

test('source fetches GetCapabilities client-direct and builds the manifest', async () => {
  const calls = [];
  const source = createWeatherSource({
    now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(capabilities('conus_base_reflectivity_mosaic'), {
        headers: { 'Content-Type': 'application/xml' },
      });
    },
  });
  const result = await source.getSnapshot({ product: 'radar' });
  assert.equal(result.unavailable, false);
  assert.equal(result.latest, time);
  assert.deepEqual(result.times, [earlier, time]);
  assert.deepEqual(result.bounds, { west: -130, south: 20, east: -60, north: 55 });
  assert.equal(result.source, 'NOAA nowCOAST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(
    calls[0].url,
    /^https:\/\/nowcoast\.noaa\.gov\/geoserver\/observations\/weather_radar\/ows\?service=WMS&version=1\.3\.0&request=GetCapabilities$/,
  );
});

test('source answers metadata failure with the designed unavailable manifest', async () => {
  const failing = createWeatherSource({
    now,
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  const result = await failing.getSnapshot({ product: 'radar' });
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'Weather imagery unavailable');
  assert.deepEqual(result.times, []);
  const oversized = createWeatherSource({
    now,
    fetchImpl: async () => new Response(' '.repeat(600_000)),
  });
  assert.equal((await oversized.getSnapshot({ product: 'radar' })).unavailable, true);
});

test('source aborts before acquisition without fetching', async () => {
  let calls = 0;
  const source = createWeatherSource({
    now,
    fetchImpl: async () => {
      calls++;
      return new Response(capabilities('conus_base_reflectivity_mosaic'));
    },
  });
  await assert.rejects(source.getSnapshot({ signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  assert.equal(calls, 0);
});

test('tile bounds follow the geographic scheme and tile URLs are direct WMS GetMap', () => {
  assert.deepEqual(weatherTileBounds(0, 0, 0), [-180, -90, 0, 90]);
  assert.deepEqual(weatherTileBounds(1, 1, 0), [-90, 0, 0, 90]);
  assert.throws(() => weatherTileBounds(7, 0, 0), /tile/);
  const url = new URL(wmsTileUrl('radar', time, 1, 1, 0));
  assert.equal(url.hostname, 'nowcoast.noaa.gov');
  assert.equal(url.searchParams.get('request'), 'GetMap');
  assert.equal(url.searchParams.get('layers'), 'conus_base_reflectivity_mosaic');
  assert.equal(url.searchParams.get('bbox'), '-90,0,0,90');
  assert.equal(url.searchParams.get('width'), '256');
  assert.equal(url.searchParams.get('time'), time);
  const sized = new URL(wmsTileUrl('lightning', time, 0, 0, 0, { size: 512 }));
  assert.equal(sized.searchParams.get('width'), '512');
  for (const size of [0, 257, 2048, '1024', null])
    assert.throws(() => wmsTileUrl('radar', time, 0, 0, 0, { size }), /tile size/);
});

test('whole-extent image URLs are direct WMS GetMap at the advertised extent', () => {
  for (const [product, width] of [
    ['radar', 4096],
    ['clouds-regional', 4096],
    ['clouds', 2048],
    ['lightning', 4096],
  ]) {
    assert.deepEqual(WEATHER_IMAGE_SIZES[product], {
      width,
      height: width / 2,
    });
    const url = new URL(weatherImageUrl(product, time));
    assert.equal(url.hostname, 'nowcoast.noaa.gov');
    assert.equal(url.searchParams.get('request'), 'GetMap');
    assert.equal(url.searchParams.get('width'), String(width));
    assert.equal(url.searchParams.get('height'), String(width / 2));
    assert.equal(url.searchParams.get('time'), time);
    assert.equal(
      weatherImageUrl(product, time, { width, height: width / 2 }),
      weatherImageUrl(product, time),
    );
    assert.equal(
      new URL(weatherImageUrl(product, time, { width: 1024, height: 512 }))
        .searchParams.get('width'),
      '1024',
    );
  }
  for (const size of [
    { width: 8192, height: 4096 },
    { width: 2048, height: 2048 },
    { width: 512, height: 256 },
    { width: '1024', height: 512 },
  ])
    assert.throws(() => weatherImageUrl('lightning', time, size), /size/);
  assert.throws(
    () => weatherImageUrl('clouds', time, { width: 4096, height: 2048 }),
    /size/,
  );
  assert.throws(() => weatherImageUrl('other', time), /frame/);
  assert.throws(() => weatherImageUrl('radar', 'latest'), /frame/);
});

test('detail-window image URLs carry the bbox to GetMap', () => {
  const box = { west: -102, south: 34, east: -96, north: 37 };
  assert.deepEqual(WEATHER_DETAIL_SIZE, { width: 4096, height: 2048 });
  for (const product of ['radar', 'clouds-regional', 'lightning', 'clouds']) {
    const url = new URL(weatherImageUrl(product, time, {}, box));
    assert.equal(url.searchParams.get('bbox'), '-102,34,-96,37');
    assert.equal(url.searchParams.get('width'), '4096');
    assert.equal(
      new URL(weatherImageUrl(product, time, { width: 2048, height: 1024 }, box))
        .searchParams.get('width'),
      '2048',
    );
  }
  for (const bad of [
    { ...box, west: -96 },
    { ...box, north: 34 },
    { ...box, east: Number.NaN },
    { west: -102, south: 34, east: -96 },
  ])
    assert.throws(() => weatherImageUrl('radar', time, {}, bad), /window/);
  assert.throws(
    () => weatherImageUrl('radar', time, { width: 8192, height: 4096 }, box),
    /size/,
  );
});

test('image frames are read through the direct WMS image URL', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const requested = [];
  const source = createWeatherSource({
    now,
    fetchImpl: async (url, init) => {
      requested.push({ url, redirect: init.redirect });
      return new Response(png, { headers: { 'Content-Type': 'image/PNG' } });
    },
  });
  const frame = await source.getImage({
    product: 'radar',
    time,
    size: { width: 1024, height: 512 },
    bbox: { west: -100, south: 30, east: -96, north: 32 },
  });
  assert.equal(frame.contentType, 'image/png');
  assert.deepEqual([...frame.bytes], [...png]);
  assert.deepEqual(requested, [
    {
      url: weatherImageUrl(
        'radar',
        time,
        { width: 1024, height: 512 },
        { west: -100, south: 30, east: -96, north: 32 },
      ),
      redirect: 'error',
    },
  ]);
  const failing = createWeatherSource({
    now,
    fetchImpl: async () => new Response(null, { status: 409 }),
  });
  await assert.rejects(
    failing.getImage({ product: 'radar', time }),
    /Weather image HTTP 409/,
  );
});
