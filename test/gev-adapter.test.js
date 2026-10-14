// Central Intelligence — GEV adapter contract test (no keys, upstreams
// not required). Boots ONLY the adapter router on an ephemeral port with
// a stub AIS hub and asserts ARCH §4.2 shapes + honesty states:
// no_key 503s, raw-QL 400, unknown_feed 404, capabilities shape,
// staleness markers on every JSON response.
const assert = require('assert');
const express = require('express');
const { EventEmitter } = require('events');

// Honest unkeyed environment: make sure no provider keys leak in.
for (const k of ['FIRMS_MAP_KEY', 'TOMTOM_API_KEY', 'WINDY_API_KEY', 'AISSTREAM_KEY', 'MAPILLARY_CLIENT_TOKEN']) {
  delete process.env[k];
}

const { gevRoutes } = require('../src/api/gev');

const fakeHub = {
  statusJson: () => ({ state: 'no_key', keyConfigured: false, vessels: 0, viewers: 0, lastOk: 0, lastErr: 'AISSTREAM_KEY not configured on server' }),
  attachStream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': connected\n\n');
    res.write(`event: status\ndata: ${JSON.stringify(this.statusJson())}\n\n`);
    res.write('event: vessels\ndata: []\n\n');
    req.on('close', () => {});
  },
};

async function main() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', gevRoutes({ hub: fakeHub }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
  const post = async (p, obj) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  const hasMeta = (b) => b && Number.isFinite(b.fetchedAt) && typeof b.stale === 'boolean' && Number.isFinite(b.ttlMs);

  try {
    // 1 capabilities
    let r = await get('/api/capabilities');
    assert.strictEqual(r.status, 200, 'capabilities 200');
    assert.ok(r.body.features && r.body.keys && r.body.build, 'capabilities sections');
    for (const f of ['cctv', 'streetLevel', 'traffic', 'firms', 'radio', 'transit', 'bikeshare', 'directions']) assert.ok(f in r.body.features, `features.${f}`);
    for (const k of ['ais', 'windy', 'firms', 'tomtom', 'mapillary']) assert.ok(k in r.body.keys, `keys.${k}`);
    assert.strictEqual(typeof r.body.build.sha, 'string', 'build.sha string');
    assert.strictEqual(r.body.keys.firms, false, 'firms key false when unset');
    assert.strictEqual(r.body.keys.tomtom, false, 'tomtom key false when unset');
    assert.strictEqual(r.body.features.firms, false, 'firms feature false when unkeyed');
    assert.ok(hasMeta(r.body), 'capabilities staleness markers');

    // 7 firms honesty
    r = await get('/api/firms');
    assert.strictEqual(r.status, 503, 'firms 503 without key');
    assert.strictEqual(r.body.error, 'no_key', 'firms no_key');
    r = await get('/api/firms/status');
    assert.strictEqual(r.status, 200, 'firms/status 200');
    assert.strictEqual(r.body.hasKey, false, 'firms/status hasKey false');
    assert.ok(hasMeta(r.body), 'firms/status markers');

    // 8 tomtom honesty + validation
    r = await get('/api/tomtom/flow/10/163/395.pbf');
    assert.strictEqual(r.status, 503, 'tomtom 503 without key');
    assert.strictEqual(r.body.error, 'no_key', 'tomtom no_key');
    r = await get('/api/tomtom/flow/99/1/1.pbf');
    assert.strictEqual(r.status, 400, 'tomtom invalid tile 400');

    // 2/4 flights validation
    r = await get('/api/flights');
    assert.strictEqual(r.status, 400, 'flights missing lat/lon 400');
    r = await get('/api/flights/track?icao24=zzzzzz');
    assert.strictEqual(r.status, 400, 'track malformed icao 400');
    r = await get('/api/flights/track');
    assert.strictEqual(r.status, 400, 'track missing icao 400');

    // 5 vessels poll shim over hub state
    r = await get('/api/vessels');
    assert.strictEqual(r.status, 200, 'vessels shim 200');
    assert.ok(Array.isArray(r.body.vessels), 'vessels array');
    assert.strictEqual(r.body.status, 'no_key', 'vessels status mirrors hub');
    assert.ok(hasMeta(r.body), 'vessels markers');

    // 6 cyclones: 200 with meta (+seasonal note or storms) or honest 502
    r = await get('/api/cyclones');
    assert.ok([200, 502].includes(r.status), 'cyclones 200 or 502');
    if (r.status === 200) {
      assert.ok(Array.isArray(r.body.storms), 'cyclones storms array');
      assert.ok(hasMeta(r.body), 'cyclones markers');
      if (r.body.storms.length === 0) assert.strictEqual(r.body.note, 'no_active_storms', 'seasonal empty state is labelled');
    } else {
      assert.strictEqual(r.body.error, 'upstream_unavailable', 'cyclones 502 shape');
    }

    // 9 gbfs SSRF guards (deterministic, no network)
    r = await get(`/api/gbfs/${encodeURIComponent('https://127.0.0.1/station_status.json')}`);
    assert.strictEqual(r.status, 400, 'gbfs private IP refused');
    r = await get(`/api/gbfs/${encodeURIComponent('https://example.com/station_status.json')}`);
    assert.strictEqual(r.status, 403, 'gbfs unlisted host 403');
    r = await get(`/api/gbfs/${encodeURIComponent('https://gbfs.lyft.com/gbfs/en/discovery.json')}`);
    assert.strictEqual(r.status, 400, 'gbfs non-station path 400');
    r = await get('/api/gbfs/not-a-url');
    assert.strictEqual(r.status, 400, 'gbfs garbage 400');

    // 10 transit registry discipline
    r = await get('/api/transit/vehicles/does-not-exist');
    assert.strictEqual(r.status, 404, 'unknown feed 404');
    assert.strictEqual(r.body.error, 'unknown_feed', 'unknown_feed error');
    r = await get('/api/transit/feeds');
    assert.strictEqual(r.status, 200, 'transit feeds 200');
    assert.strictEqual(r.body.feeds.length, 7, 'seven registered feeds');
    assert.ok(hasMeta(r.body), 'transit feeds markers');

    // 11 route validation
    r = await get('/api/route?profile=car&coords=bad');
    assert.strictEqual(r.status, 400, 'route bad coords 400');
    r = await get('/api/route?profile=plane&coords=-81,28;-80,29');
    assert.strictEqual(r.status, 400, 'route bad profile 400');

    // 12 geocode validation
    r = await get('/api/geocode');
    assert.strictEqual(r.status, 400, 'geocode empty query 400');

    // 13 overpass: raw QL refused, templates allowlisted
    r = await post('/api/overpass', { ql: '[out:json];node(1);out;' });
    assert.strictEqual(r.status, 400, 'raw QL 400');
    assert.strictEqual(r.body.error, 'raw_ql_refused', 'raw_ql_refused');
    r = await post('/api/overpass', { data: '[out:json];node(1);out;' });
    assert.strictEqual(r.status, 400, 'raw data QL 400');
    r = await post('/api/overpass', { template: 'everything', bbox: { south: 28, west: -81, north: 29, east: -80 } });
    assert.strictEqual(r.status, 400, 'unknown template 400');
    r = await post('/api/overpass', { template: 'alpr', bbox: { south: 28, west: -81, north: 60, east: -80 } });
    assert.strictEqual(r.status, 400, 'oversized bbox 400');

    // 14 radio click validation
    r = await post('/api/radio/click/not-a-uuid', {});
    assert.strictEqual(r.status, 400, 'radio click bad uuid 400');

    // 15 cameras catalog: bundled municipal catalogs, GEV record shape
    r = await get('/api/cameras/catalog');
    assert.strictEqual(r.status, 200, 'cameras catalog 200');
    assert.ok(Array.isArray(r.body.cameras), 'catalog cameras array');
    assert.ok(r.body.bundledCount > 100, `bundled catalog merged (got ${r.body.bundledCount})`);
    assert.strictEqual(r.body.count, r.body.cameras.length, 'count matches');
    assert.ok(hasMeta(r.body), 'catalog markers');
    const kinds = new Set(['still', 'player', 'hls-direct', 'synthetic-capable']);
    for (const c of r.body.cameras.slice(0, 50)) {
      assert.ok(c.id && c.name && Number.isFinite(c.lat) && Number.isFinite(c.lon), 'camera record fields');
      assert.ok(kinds.has(c.kind), `camera kind valid: ${c.kind}`);
      assert.ok(c.pose && 'hdg' in c.pose && 'fov' in c.pose && 'range' in c.pose, 'camera pose shape');
      assert.ok(c.media && typeof c.media === 'object', 'camera media shape');
    }

    // 16/17 AMENDMENT (Lane C gaps G1/G2) — celestrak + launches.
    // Upstream is STUBBED (sandbox egress to provider upstreams is dead —
    // see lane-a logs): global.fetch is wrapped so only celestrak.org /
    // ll.thespacedevs.com calls are intercepted; everything else delegates
    // to the real fetch. Shape/validation/cache/error contracts are proven
    // against the stub; live-data proof is egress-blocked, not claimed.
    delete process.env.LL2_API_TOKEN;
    const realFetch = global.fetch;
    const getText = async (p) => {
      const r = await realFetch(base + p);
      return { status: r.status, text: await r.text(), headers: r.headers };
    };
    const TLE_BODY = 'ISS (ZARYA)\n1 25544U 98067A   26286.50000000  .00016717  00000-0  10270-3 0  9000\n2 25544  51.6400 208.9163 0006703  69.9862  25.2906 15.72147121    10\n';
    const LL2_BODY = JSON.stringify({
      count: 1,
      results: [{
        id: 'stub-launch-1', name: 'Stub Rocket | Stub Mission',
        net: '2026-10-12T00:00:00Z',
        pad: { name: 'Stub Pad', latitude: '28.561', longitude: '-80.577' },
        mission: { name: 'Stub Mission' },
      }],
    });
    let upstreamMode = 'ok';
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('celestrak.org') || u.includes('ll.thespacedevs.com')) {
        if (upstreamMode === 'fail') throw new Error('stub upstream down');
        if (u.includes('celestrak.org')) return new Response(TLE_BODY, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        return new Response(LL2_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(url, opts);
    };
    const realDateNow = Date.now;
    try {
      // 16a unknown group -> 400 {error:"unknown_group"} (no upstream call)
      r = await get('/api/celestrak/bogus-group');
      assert.strictEqual(r.status, 400, 'celestrak unknown group 400');
      assert.strictEqual(r.body.error, 'unknown_group', 'celestrak unknown_group error');

      // 16b error honesty: known group, upstream down, no cache -> 502
      upstreamMode = 'fail';
      r = await get('/api/celestrak/geo');
      assert.strictEqual(r.status, 502, 'celestrak upstream-down no-cache 502');
      assert.strictEqual(r.body.error, 'upstream_unavailable', 'celestrak 502 shape');

      // 17a error honesty: launches, upstream down, no cache -> 502
      r = await get('/api/launches');
      assert.strictEqual(r.status, 502, 'launches upstream-down no-cache 502');
      assert.strictEqual(r.body.error, 'upstream_unavailable', 'launches 502 shape');

      // 16c TLE served verbatim as text (client parses response.text()),
      // GEV x-tle-cache + adapter X-Data-* staleness headers present.
      upstreamMode = 'ok';
      let rt = await getText('/api/celestrak/stations');
      assert.strictEqual(rt.status, 200, 'celestrak stations 200');
      assert.ok(rt.headers.get('content-type').includes('text/plain'), 'celestrak content-type text/plain');
      assert.strictEqual(rt.text, TLE_BODY, 'celestrak body is verbatim upstream TLE text');
      assert.ok(/^1 /m.test(rt.text), 'celestrak body carries TLE line 1');
      assert.strictEqual(rt.headers.get('x-tle-cache'), 'MISS', 'celestrak first fetch MISS');
      assert.strictEqual(rt.headers.get('x-data-stale'), 'false', 'celestrak fresh X-Data-Stale false');
      assert.ok(rt.headers.get('x-data-age') !== null, 'celestrak X-Data-Age present');
      rt = await getText('/api/celestrak/stations');
      assert.strictEqual(rt.headers.get('x-tle-cache'), 'HIT', 'celestrak second fetch served from cache HIT');
      // 'active' is the group the launches client reads.
      rt = await getText('/api/celestrak/active');
      assert.strictEqual(rt.status, 200, 'celestrak active 200');
      assert.strictEqual(rt.text, TLE_BODY, 'celestrak active TLE text');

      // 17b launches shape: LL2 results passed through + adapter envelope.
      r = await get('/api/launches');
      assert.strictEqual(r.status, 200, 'launches 200');
      assert.ok(Array.isArray(r.body.results), 'launches results array (client model contract)');
      assert.strictEqual(r.body.results.length, 1, 'launches results length');
      assert.strictEqual(r.body.results[0].name, 'Stub Rocket | Stub Mission', 'launches result fields preserved verbatim');
      assert.strictEqual(r.body.count, 1, 'launches count');
      assert.ok(hasMeta(r.body), 'launches envelope fields present');
      assert.strictEqual(r.body.ttlMs, 15 * 60 * 1000, 'launches ttlMs 15 min');
      assert.strictEqual(r.body.stale, false, 'launches fresh stale false');
      assert.strictEqual(r.headers.get('x-gev-cache'), 'MISS', 'launches X-GEV-Cache MISS on first fetch');
      r = await get('/api/launches');
      assert.strictEqual(r.headers.get('x-gev-cache'), 'HIT', 'launches second fetch HIT');

      // 16d/17c stale-on-error: age both caches past TTL (same-process
      // clock), upstream down -> stale copy served, honestly marked.
      const t0 = realDateNow();
      Date.now = () => t0 + 6 * 3600 * 1000 + 60000;
      upstreamMode = 'fail';
      try {
        rt = await getText('/api/celestrak/stations');
        assert.strictEqual(rt.status, 200, 'celestrak stale-on-error 200');
        assert.strictEqual(rt.text, TLE_BODY, 'celestrak stale body is the cached TLE');
        assert.strictEqual(rt.headers.get('x-tle-cache'), 'STALE-ERROR', 'celestrak stale x-tle-cache STALE-ERROR (client contract)');
        assert.strictEqual(rt.headers.get('x-data-stale'), 'true', 'celestrak stale X-Data-Stale true');
        r = await get('/api/launches');
        assert.strictEqual(r.status, 200, 'launches stale-on-error 200');
        assert.strictEqual(r.body.stale, true, 'launches stale envelope true');
        assert.strictEqual(r.headers.get('x-gev-cache'), 'STALE-ERROR', 'launches stale X-GEV-Cache STALE-ERROR (client contract)');
        assert.ok(Array.isArray(r.body.results), 'launches stale results still served');
      } finally {
        Date.now = realDateNow;
        upstreamMode = 'ok';
      }
    } finally {
      global.fetch = realFetch;
      Date.now = realDateNow;
    }

    // 18/19 AMENDMENT #2 — live CCTV packs in /api/cameras/catalog +
    // forecastAdvisory passthrough in /api/cyclones.
    // Upstream is STUBBED at the fetch layer (sandbox egress to
    // data.austintexas.gov and the other pack hosts is dead — see
    // lane-a logs): global.fetch is wrapped so pack/NHC hosts are
    // intercepted; everything else delegates to the real fetch. The
    // live-data 200 path for the packs is therefore proven against the
    // stub, NOT against the real upstreams — egress-blocked, not
    // claimed. Fresh gevRoutes instances are used so the per-pack
    // caches start empty and the stub fully determines the outcome.
    {
      const { __test } = require('../src/api/gev');
      assert.deepStrictEqual(__test.packNames, ['austin', 'caltrans', 'tfl', 'ontario', 'fintraffic', 'drivebc', 'tarktee', 'nsw', 'calgary', 'vegvesen'], 'amendment2 pack registry (ported packs, registry order)');
      assert.strictEqual(__test.CCTV_CATALOG_CAP, 600, 'amendment2 catalog cap 600');

      // 18a cap rule (pure): bundled first in full, then packs
      // round-robin, windy fills the remainder; dup ids first-wins.
      const mk = (p, n) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}` }));
      const alloc = __test.allocateCatalogCap({ bundled: mk('b', 300), packs: [{ name: 'a', records: mk('a', 300) }, { name: 'c', records: mk('c', 300) }], windy: mk('w', 10) });
      assert.strictEqual(alloc.cameras.length, 600, 'cap: total is 600');
      assert.strictEqual(alloc.bundledCount, 300, 'cap: bundled served in full first');
      assert.deepStrictEqual(alloc.packCounts, { a: 150, c: 150 }, 'cap: packs share the remainder round-robin');
      assert.strictEqual(alloc.liveCount, 300, 'cap: liveCount sums packCounts');
      assert.strictEqual(alloc.windyCount, 0, 'cap: windy gets nothing when the cap is full');
      const allocDup = __test.allocateCatalogCap({ bundled: mk('b', 3), packs: [{ name: 'a', records: [{ id: 'b0' }, { id: 'a1' }] }], windy: [] });
      assert.deepStrictEqual(allocDup.cameras.map((c) => c.id), ['b0', 'b1', 'b2', 'a1'], 'cap: duplicate id resolves first-occurrence-wins');
      assert.strictEqual(allocDup.packCounts.a, 1, 'cap: dup does not count against the pack');

      // Stub plumbing.
      const realFetch2 = global.fetch;
      const realDateNow2 = Date.now;
      const PACK_HOSTS = ['data.austintexas.gov', 'cwwp2.dot.ca.gov', 'api.tfl.gov.uk', '511on.ca', 'tie.digitraffic.fi', 'www.drivebc.ca', 'tarktee.transpordiamet.ee', 'data.livetraffic.com', 'data.calgary.ca', 'ogckart-sn1.atlas.vegvesen.no'];
      const austinPayload = (rows) => JSON.stringify({
        meta: { view: { columns: [{ fieldName: 'sid' }, { fieldName: 'id' }, { fieldName: 'camera_id' }, { fieldName: 'camera_name' }, { fieldName: 'camera_status' }, { fieldName: 'location' }] } },
        data: rows,
      });
      const austinRow = (id, name, status, point) => ['1', 'x', String(id), name, status, point];
      let austinBody = austinPayload([
        austinRow(101, 'Congress Ave / 6th St', 'TURNED_ON', 'POINT(-97.7431 30.2672)'),
        austinRow(102, 'Lamar Blvd / 12th St', 'TURNED_ON', 'POINT(-97.7620 30.2760)'),
        austinRow(103, 'I-35 / Riverside Dr', 'TURNED_ON', 'POINT(-97.7350 30.2420)'),
        austinRow(104, 'Planned Cam', 'DESIRED', 'POINT(-97.7400 30.2600)'), // not TURNED_ON -> excluded
        austinRow(105, 'Far Away Cam', 'TURNED_ON', 'POINT(-100.0000 32.0000)'), // implausible Austin coord -> excluded
        austinRow(101, 'Duplicate Cam', 'TURNED_ON', 'POINT(-97.7431 30.2672)'), // dup id -> deduped
      ]);
      const NHC_BODY = JSON.stringify({
        activeStorms: [
          {
            id: 'al092026', name: 'Stubcane', classification: 'HU', intensity: '75', pressure: 985,
            latitudeNumeric: 25.1, longitudeNumeric: -80.2, movementDir: 315, movementSpeed: 9,
            lastUpdate: '2026-10-13T12:00:00.000Z', binNumber: 'AT2',
            forecastAdvisory: { advNum: '12', issuance: '202610131200', url: 'https://www.nhc.noaa.gov/text/refresh/MIALTCAT2+shtml/131200.shtml' },
          },
          {
            id: 'ep102026', name: 'NoAdvisory', classification: 'TS', intensity: '40', pressure: 1002,
            latitudeNumeric: 15.0, longitudeNumeric: -105.0, movementDir: 270, movementSpeed: 7,
            lastUpdate: '2026-10-13T12:00:00.000Z', binNumber: 'EP2',
          },
        ],
      });
      global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('data.austintexas.gov')) return new Response(austinBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (u.includes('www.nhc.noaa.gov')) return new Response(NHC_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (PACK_HOSTS.some((h) => u.includes(h))) throw new Error('stub pack upstream down');
        return realFetch2(url, opts);
      };
      const bootFresh = async () => {
        const app = express();
        app.use(express.json({ limit: '256kb' }));
        app.use('/api', gevRoutes({ hub: fakeHub }));
        const s = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
        return { server: s, base: `http://127.0.0.1:${s.address().port}` };
      };
      const getFrom = async (b, p) => { const r = await realFetch2(b + p); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
      try {
        // 18b merge: bundled 259 + stubbed Austin 3 (of 6 rows: status,
        // bbox and dup filters applied); every other pack is DOWN in
        // the stub and contributes 0 — which is simultaneously the
        // pack-failure isolation proof on this instance.
        const inst = await bootFresh();
        try {
          let rr = await getFrom(inst.base, '/api/cameras/catalog');
          assert.strictEqual(rr.status, 200, 'amendment2 catalog 200 with packs down');
          assert.strictEqual(rr.body.bundledCount, 259, 'amendment2 bundledCount 259');
          assert.strictEqual(rr.body.packCounts.austin, 3, 'amendment2 austin merged (3 valid of 6 stub rows)');
          for (const p of ['caltrans', 'tfl', 'ontario', 'fintraffic', 'drivebc', 'tarktee', 'nsw', 'calgary', 'vegvesen']) {
            assert.strictEqual(rr.body.packCounts[p], 0, `amendment2 failed pack ${p} contributes 0`);
          }
          assert.strictEqual(rr.body.liveCount, 3, 'amendment2 liveCount 3');
          assert.strictEqual(rr.body.count, 262, 'amendment2 count = bundled + live');
          assert.strictEqual(rr.body.count, rr.body.cameras.length, 'amendment2 count matches cameras');
          assert.strictEqual(rr.body.stale, true, 'amendment2 stale true when packs failed (honest degradation)');
          assert.ok(hasMeta(rr.body), 'amendment2 catalog markers');
          const ax = rr.body.cameras.find((c) => c.id === '101');
          assert.ok(ax, 'amendment2 austin record present');
          assert.strictEqual(ax.source, 'Austin Transportation & Public Works', 'amendment2 austin provider as source');
          assert.strictEqual(ax.kind, 'still', 'amendment2 austin kind still');
          assert.strictEqual(ax.media.url, 'https://cctv.austinmobility.io/image/101.jpg', 'amendment2 austin client-direct still URL');
          assert.strictEqual(ax.media.snapshotUrl, ax.media.url, 'amendment2 austin snapshotUrl');
          assert.strictEqual(ax.lat, 30.2672, 'amendment2 austin lat from WKT POINT (lon lat order)');
          assert.strictEqual(ax.lon, -97.7431, 'amendment2 austin lon from WKT POINT');
          assert.deepStrictEqual(ax.pose, { hdg: null, fov: null, range: null }, 'amendment2 no invented pose: headingless Austin record has null pose');
          assert.strictEqual(ax.calibration.groundElevationM, null, 'amendment2 no invented ground elevation');
          assert.strictEqual(ax.calibration.headingConfidence, null, 'amendment2 headingConfidence null without a heading');

          // 18c per-pack cap: age the pack cache past its 15-min TTL
          // (same-process clock, as in block 16/17), stub now returns
          // 300 valid Austin rows -> pack contributes its cap of 250.
          const t0 = realDateNow2();
          Date.now = () => t0 + 16 * 60 * 1000;
          austinBody = austinPayload(Array.from({ length: 300 }, (_, i) => austinRow(1000 + i, `Stub Cam ${i}`, 'TURNED_ON', `POINT(${(-97.90 + (i % 100) * 0.001).toFixed(4)} ${(30.10 + (i % 100) * 0.001).toFixed(4)})`)));
          try {
            rr = await getFrom(inst.base, '/api/cameras/catalog');
            assert.strictEqual(rr.status, 200, 'amendment2 catalog cap call 200');
            assert.strictEqual(rr.body.packCounts.austin, 250, 'amendment2 austin per-pack cap 250 applied');
            assert.strictEqual(rr.body.count, 259 + 250, 'amendment2 capped total 509 (under the 600 catalog cap)');
            assert.ok(rr.body.count <= 600, 'amendment2 catalog respects the 600 cap');
          } finally { Date.now = realDateNow2; }

          // 19 forecastAdvisory passthrough (present-in / present-out).
          // The shared proxy NHC cache may hold an entry from block 6;
          // advancing the clock past its 5-min TTL forces the stub.
          const t1 = realDateNow2();
          Date.now = () => t1 + 6 * 60 * 1000;
          try {
            rr = await getFrom(inst.base, '/api/cyclones');
          } finally { Date.now = realDateNow2; }
          assert.strictEqual(rr.status, 200, 'amendment2 cyclones 200 from stub');
          assert.strictEqual(rr.body.storms.length, 2, 'amendment2 cyclones storms');
          assert.deepStrictEqual(rr.body.storms[0].forecastAdvisory, { advNum: '12', issuance: '202610131200', url: 'https://www.nhc.noaa.gov/text/refresh/MIALTCAT2+shtml/131200.shtml' }, 'amendment2 forecastAdvisory carried through verbatim');
          assert.strictEqual(rr.body.storms[1].forecastAdvisory, null, 'amendment2 forecastAdvisory null when absent upstream (nothing fabricated)');
          assert.strictEqual(rr.body.storms[0].name, 'Stubcane', 'amendment2 existing cyclone fields unchanged');
        } finally { inst.server.close(); }

        // 18d total pack failure isolation (fresh instance, Austin
        // ALSO down): catalog still 200 with the bundled records only.
        global.fetch = async (url, opts) => {
          const u = String(url);
          if (PACK_HOSTS.some((h) => u.includes(h))) throw new Error('stub all packs down');
          return realFetch2(url, opts);
        };
        const inst2 = await bootFresh();
        try {
          const rr = await getFrom(inst2.base, '/api/cameras/catalog');
          assert.strictEqual(rr.status, 200, 'amendment2 catalog 200 when ALL packs down (never 502s over bundled)');
          assert.strictEqual(rr.body.count, rr.body.bundledCount, 'amendment2 all-down count is bundled only');
          assert.strictEqual(rr.body.bundledCount, 259, 'amendment2 all-down bundledCount 259');
          assert.strictEqual(rr.body.liveCount, 0, 'amendment2 all-down liveCount 0');
          assert.strictEqual(rr.body.stale, true, 'amendment2 all-down stale true');
        } finally { inst2.server.close(); }
      } finally {
        global.fetch = realFetch2;
        Date.now = realDateNow2;
      }
    }

    console.log('gev-adapter.test.js: all assertions passed');
  } finally {
    server.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
