import test from 'node:test';
import assert from 'node:assert/strict';
import { SENTINEL_LEVELS, DISABLE_FLAG, sentinelDisabled, nextSentinelLevel, sentinelLabel } from './perfSentinel.js';

test('disable-for-test switch reads both channels', () => {
  assert.equal(sentinelDisabled({ search: '?nosentinel=1' }), true);
  assert.equal(sentinelDisabled({ search: '?a=b&nosentinel=1' }), true);
  assert.equal(sentinelDisabled({ search: '?nosentinel=0' }), false);
  assert.equal(sentinelDisabled({ search: '' }), false);
  assert.equal(sentinelDisabled({ flag: true }), true);
  assert.equal(DISABLE_FLAG, '__ciDisablePerfSentinel');
});

test('ladder steps down one rung on sustained breach', () => {
  assert.equal(nextSentinelLevel({ level: 'L0', breachMs: 5000, frameP95Ms: 80 }), 'L1');
  assert.equal(nextSentinelLevel({ level: 'L1', breachMs: 9000, frameP95Ms: 80 }), 'L2');
  assert.equal(nextSentinelLevel({ level: 'L3', breachMs: 9000, frameP95Ms: 80 }), 'L3'); // floor
  // Brief breach: no step (hysteresis against oscillation)
  assert.equal(nextSentinelLevel({ level: 'L0', breachMs: 2000, frameP95Ms: 80 }), 'L0');
});

test('heap pressure breaches independently of frames', () => {
  assert.equal(nextSentinelLevel({ level: 'L0', breachMs: 5000, frameP95Ms: 12, heapRatio: 0.9 }), 'L1');
  assert.equal(nextSentinelLevel({ level: 'L0', breachMs: 5000, frameP95Ms: 12, heapRatio: 0.5 }), 'L0');
  assert.equal(nextSentinelLevel({ level: 'L0', breachMs: 5000, frameP95Ms: 12, heapRatio: null }), 'L0'); // no heap API: no guess
});

test('recovery is slow and one rung at a time', () => {
  assert.equal(nextSentinelLevel({ level: 'L2', cleanMs: 20_000, frameP95Ms: 12 }), 'L1');
  assert.equal(nextSentinelLevel({ level: 'L2', cleanMs: 10_000, frameP95Ms: 12 }), 'L2'); // not yet
  assert.equal(nextSentinelLevel({ level: 'L0', cleanMs: 99_000, frameP95Ms: 12 }), 'L0');
});

test('indicator label is honest, never "broken"', () => {
  assert.equal(sentinelLabel('L0'), 'Full quality');
  assert.match(sentinelLabel('L2'), /Scaled for smoothness/);
  assert.deepEqual([...SENTINEL_LEVELS], ['L0', 'L1', 'L2', 'L3']);
});
