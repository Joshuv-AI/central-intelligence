// NOTE (pre-cutover 2026-10-14): Integration tests for the pre-refactor
// fetch-based source API were removed. The vessel source is now SSE-based;
// the aircraft/military adapters use a new payload format. The normalize
// functions (the core data contracts) are tested below. New integration
// tests are needed for the current API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlightSource,
  createMilitarySource,
  createVesselSource,
  normalizeReadsbAircraft,
  normalizeVesselObservation,
  readsbSnapshot,
} from './index.js';

const now = 1800000000000;
// Pre-cutover 2026-10-14: adapter payload format (was OpenSky states array).
const aircraft = {
  icao24: 'abc123',
  callsign: 'TEST',
  lat: 30,
  lon: -97,
  altitudeFt: 3280,
  onGround: false,
  groundSpeedKt: 194,
  heading: 250,
  verticalRateFpm: -400,
};
const response = (payload, headers = {}, status = 200) =>
  Response.json(payload, { headers, status });

test('readsb units and position/contact ages are normalized once against the source epoch', () => {
  const row = normalizeReadsbAircraft(
    {
      hex: 'abc123',
      lat: '30',
      lon: '-97',
      alt_baro: 10000,
      alt_geom: 10100,
      gs: 120,
      baro_rate: -600,
      seen: 2,
      seen_pos: 12,
    },
    now,
  );
  assert.equal(row.baroAltitudeM, 3048);
  assert.equal(row.ellipsoidAltitudeM, 3078.48);
  assert.equal(row.speedMps, 120 * 0.514444);
  assert.equal(row.verticalRateMps, -600 * 0.00508);
  assert.equal(row.positionTimeMs, now - 12000);
  assert.equal(row.contactTimeMs, now - 2000);
  const ground = normalizeReadsbAircraft(
    { hex: 'abc123', lat: 30, lon: -97, alt_baro: 'ground' },
    null,
  );
  assert.equal(ground.onGround, true);
  assert.equal(ground.baroAltitudeM, null);
  assert.equal(ground.positionTimeMs, null);
  assert.equal(
    readsbSnapshot({ ac: [] }, { observedAtMs: null }).freshness,
    'unknown',
  );
});

test('vessel identity, opaque reference and heading/course remain distinct, unknowns stay null', () => {
  const row = normalizeVesselObservation(
    {
      mmsi: '123456789',
      lat: 30,
      lon: -97,
      speed: 10,
      heading: 45,
      course: 60,
      last_position_epoch: now / 1000,
      extra: 'discard',
    },
    'opaque-reference',
  );
  assert.equal(row.id, '123456789');
  assert.equal(row.reference, 'opaque-reference');
  assert.equal(row.headingDeg, 45);
  assert.equal(row.courseDeg, 60);
  assert.equal(row.speedMps, 10 * 0.514444);
  assert.equal(row.altitudeDatum, 'sea-surface');
  assert.equal(row.observedAtMs, now);
  assert.equal('extra' in row, false);
  assert.equal(
    normalizeVesselObservation({ mmsi: 'x', lat: null, lon: null }),
    null,
  );
});

test('cancellation after slow body parsing rejects even with a transport that ignores abort', async () => {
  let release;
  const controller = new AbortController();
  const source = createFlightSource({
    fetchImpl: async () => ({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
  });
  const pending = source.getSnapshot({}, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  release({ aircraft: [aircraft], fetchedAt: now });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('denials and outages never start another source and do not echo arbitrary response bodies', async () => {
  for (const status of [401, 403, 429, 502]) {
    let calls = 0;
    const source = createFlightSource({
      fetchImpl: async () => {
        calls++;
        return response({ error: 'sensitive upstream detail' }, {}, status);
      },
    });
    await assert.rejects(source.getSnapshot(), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.message.includes('sensitive'), false);
      assert.ok(error.retryAfterMs >= 20000);
      return true;
    });
    assert.equal(calls, 1);
  }
});

