import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindSource } from './source.js';

// Imagery-only build (ARCH D2-08 / spike R1): the source never touches the
// network and always answers with the designed unavailable manifest.
test('wind source answers locally with the unavailable manifest', async () => {
  const source = createWindSource();
  const gfs = await source.getSnapshot();
  assert.equal(gfs.model, 'gfs');
  assert.equal(gfs.schemaVersion, 1);
  assert.equal(gfs.unavailable, true);
  assert.equal(gfs.stale, true);
  assert.match(gfs.reason, /not available in this version/);
  assert.equal('overlay' in gfs, false);
  const ifs = await source.getSnapshot({ model: 'ifs', overlay: 'temperature' });
  assert.equal(ifs.model, 'ifs');
  assert.equal(ifs.overlay, 'temperature');
  assert.equal(ifs.unavailable, true);
});

test('wind source still rejects unknown models and overlays', async () => {
  const source = createWindSource();
  await assert.rejects(source.getSnapshot({ model: 'bogus' }), /Unknown wind model/);
  await assert.rejects(
    source.getSnapshot({ overlay: 'bogus' }),
    /Unknown weather overlay/,
  );
});

test('wind source honours an already-aborted signal', async () => {
  const source = createWindSource();
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(source.getSnapshot({ signal: controller.signal }), /stop/);
});
