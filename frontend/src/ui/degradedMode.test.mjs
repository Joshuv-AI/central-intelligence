import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEGRADED_VOCABULARY,
  DEGRADED_SURFACES,
  describeDegradedMode,
  DEGRADED_AUDIT,
  auditedLayerIds,
} from './degradedMode.js';

test('vocabulary is frozen and complete', () => {
  assert.ok(Object.isFrozen(DEGRADED_VOCABULARY));
  for (const k of ['SYNTHETIC', 'DEGRADED', 'STALE', 'NO_KEY', 'UNAVAILABLE', 'LOADING'])
    assert.ok(DEGRADED_VOCABULARY[k], k);
  assert.deepEqual([...DEGRADED_SURFACES], ['row', 'panel', 'globe']);
});

test('describeDegradedMode requires all three surfaces labeled', () => {
  const ok = describeDegradedMode({
    layerId: 'x',
    mode: DEGRADED_VOCABULARY.STALE,
    labels: { row: 'r', panel: 'p', globe: 'g' },
    note: 'n',
  });
  assert.equal(ok.layerId, 'x');
  assert.throws(
    () => describeDegradedMode({ layerId: 'x', mode: 'STALE', labels: { row: 'r', panel: 'p' } }),
    /unlabeled surfaces: globe/,
  );
  assert.throws(
    () => describeDegradedMode({ layerId: 'x', mode: 'BOGUS', labels: { row: 'r', panel: 'p', globe: 'g' } }),
    /unknown mode/,
  );
  assert.throws(() => describeDegradedMode({ mode: 'STALE', labels: { row: 'r', panel: 'p', globe: 'g' } }), /layerId/);
});

test('audit baseline covers the key degraded layers', () => {
  const ids = auditedLayerIds();
  for (const id of ['cctv', 'intel-events', 'ais-live-vessels', 'local-firms', 'flights', 'map-stack'])
    assert.ok(ids.includes(id), `audit missing ${id}`);
  for (const entry of DEGRADED_AUDIT) {
    assert.ok(entry.note && entry.note.length > 10, `${entry.layerId}: note must explain the degradation`);
    for (const s of DEGRADED_SURFACES) assert.ok(entry.surfaces[s], `${entry.layerId}: surface ${s}`);
  }
});
