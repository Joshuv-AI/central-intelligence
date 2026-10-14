import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvSource, createCctvLayer } from './index.js';

const camera = {
  id: 'pack/camera ?x',
  name: 'Camera & road',
  city: 'Austin',
  lat: 30.267,
  lon: -97.744,
  headingDeg: 45,
  fovDeg: 60,
  pitchDeg: -12,
};

test('camera catalog uses the adapter route; health is derived from it (Lane E)', async () => {
  const calls = [];
  const source = createCctvSource({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(JSON.stringify({ cameras: [] }));
    },
  });
  const controller = new AbortController();
  await source.getCatalog({ signal: controller.signal });
  const health = await source.getHealth({ signal: controller.signal });
  assert.deepEqual(health, { cameras: [] });
  // One adapter call only: no /api/cctv/* server route exists any more.
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/cameras/catalog'],
  );
  for (const { options } of calls) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.cache, 'no-store');
  }
});

test('adapter records map to direct-media source records', async () => {
  const source = createCctvSource({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          cameras: [
            {
              id: 'tln-1',
              name: 'Tallinn Cam',
              lat: 59.43,
              lon: 24.75,
              source: 'City of Tallinn',
              kind: 'still',
              media: {
                url: 'https://example.test/cam1.jpg',
                snapshotUrl: 'https://example.test/cam1.jpg',
                feedType: 'image',
              },
              pose: { hdg: 60, fov: 44, range: 145 },
              calibration: { pitchDeg: -18, mountHeightM: 8 },
              city: 'Tallinn',
            },
          ],
        }),
      ),
  });
  const { sources } = await source.getCatalog();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://example.test/cam1.jpg');
  assert.equal(sources[0].headingDeg, 60);
  assert.equal(sources[0].mediaKind, 'still');
  const health = await source.getHealth();
  assert.equal(health.cameras[0].status, 'client-direct');
});

test('camera sources reject malformed snapshots and failures', async () => {
  for (const method of ['getCatalog', 'getHealth']) {
    const malformed = createCctvSource({
      fetchImpl: async () => new Response('{}'),
    });
    await assert.rejects(malformed[method](), /Malformed camera/);
    const denied = createCctvSource({
      fetchImpl: async () => new Response('', { status: 403 }),
    });
    await assert.rejects(denied[method](), /HTTP 403/);
  }
});

test('cancellation while reading a camera response body prevents publication', async () => {
  const controller = new AbortController();
  const source = createCctvSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { cameras: [] };
      },
    }),
  });
  await assert.rejects(source.getCatalog({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('frame and media URLs are client-direct, or the labelled synthetic state', () => {
  const source = createCctvSource();
  // No direct URL on this camera: both URLs are the triple-labelled
  // synthetic data URI — never a server relay URL, never blank.
  const frame = source.getFrameUrl(camera);
  const media = source.getMediaUrl(camera);
  assert.ok(frame.startsWith('data:image/svg+xml'));
  assert.ok(media.startsWith('data:image/svg+xml'));
  const svg = decodeURIComponent(frame.split(',')[1]);
  assert.match(svg, /SYNTHETIC · DEGRADED · NOT A LIVE IMAGE/);
  assert.match(svg, /Camera &amp; road/);
  // A still camera with a direct URL frames from that URL, cache-busted.
  const still = {
    ...camera,
    feedType: 'image',
    url: 'https://example.test/cam.jpg',
    snapshotUrl: 'https://example.test/cam.jpg',
  };
  const direct = new URL(source.getFrameUrl(still));
  assert.equal(direct.origin + direct.pathname, 'https://example.test/cam.jpg');
  assert.ok(direct.searchParams.has('ci_ts'));
  assert.equal(source.getMediaUrl(still), 'https://example.test/cam.jpg');
});

test('camera construction is inert and destruction cancels a pending catalog and its visibility listener', async (t) => {
  const original = globalThis.document;
  const listeners = new Set();
  globalThis.document = {
    addEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type === 'visibilitychange') listeners.delete(handler);
    },
  };
  t.after(() => {
    globalThis.document = original;
  });
  const noop = () => {};
  const services = {
    overlays: {
      clearOverlaySource: noop,
      hitTestWorldOverlay: noop,
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
    },
    sprites: { registerSpriteCollection: noop },
    activation: {},
    locations: {},
    picking: { unregisterPickOwner: noop },
    terrain: {},
    ground: {},
    mesh: {},
    focus: {},
    render: { releaseContinuousRender: noop },
  };
  let resolveCatalog;
  let signal;
  const source = {
    ...createCctvSource(),
    getCatalog(options) {
      signal = options.signal;
      return new Promise((resolve) => {
        resolveCatalog = resolve;
      });
    },
  };
  const a = createCctvLayer({ services, source });
  const b = createCctvLayer({ services, source });
  assert.equal(listeners.size, 0);
  const viewer = {
    scene: { primitives: { add: (value) => value, remove: () => true } },
  };
  const initializing = a.init(viewer);
  assert.equal(listeners.size, 1);
  assert.equal(signal.aborted, false);
  a.destroy(viewer);
  assert.equal(listeners.size, 0);
  assert.equal(signal.aborted, true);
  resolveCatalog({ sources: [] });
  await assert.rejects(initializing, { name: 'AbortError' });
  assert.equal(a.getStats().count, 0);
  assert.equal(b.getStats().count, 0);
});

test('frames are read client-direct from the camera URL', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const requested = [];
  const source = createCctvSource({
    fetchImpl: async (url, init) => {
      requested.push({ url, cache: init.cache });
      return new Response(png, {
        headers: { 'Content-Type': 'Image/PNG; charset=binary' },
      });
    },
  });
  const still = {
    ...camera,
    feedType: 'image',
    url: 'https://example.test/cam.jpg',
    snapshotUrl: 'https://example.test/cam.jpg',
  };
  const frame = await source.getFrame(still);
  assert.equal(frame.contentType, 'image/png');
  assert.deepEqual([...frame.bytes], [...png]);
  assert.equal(requested[0].url.split('?')[0], 'https://example.test/cam.jpg');
  assert.equal(requested[0].cache, 'no-store');
  const failing = createCctvSource({
    fetchImpl: async () => new Response(null, { status: 502 }),
  });
  await assert.rejects(failing.getFrame(still), /Camera frame HTTP 502/);
  // No direct URL: the frame is synthetic SVG bytes, labelled as such.
  const synthetic = await source.getFrame(camera);
  assert.equal(synthetic.contentType, 'image/svg+xml');
  assert.match(new TextDecoder().decode(synthetic.bytes), /SYNTHETIC/);
});
