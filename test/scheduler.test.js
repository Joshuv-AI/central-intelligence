// Central Intelligence — scheduler failure-semantics test (no network).
// Verifies: throw/timeout preserves last-good events + marks error + backs
// off; suspect-empty preserves until 3 strikes; missing keys -> needs_key.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/pipeline/store');
const { runTierSweep } = require('../src/pipeline/scheduler');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-sched-'));
  const s = new Store(dir, 200);
  s.load();
  return s;
}

const goodEvent = {
  id: 'evt-1',
  title: 'Test event',
  summary: 's',
  lat: null,
  lon: null,
  region: 'Test',
  time: new Date().toISOString(),
  severity: 'high',
  url: null,
  attribution: 'Test',
};

function adapter(name, behavior, keyEnv) {
  return {
    name,
    tier: 1,
    domain: 'test',
    mod: {
      name,
      description: 'test adapter',
      ...(keyEnv ? { keyEnv } : {}),
      fetch: async () => {
        if (behavior === 'throw') throw new Error('boom');
        if (behavior === 'empty') return [];
        return [{ ...goodEvent }];
      },
    },
  };
}

(async () => {
  // 1. Throwing adapter preserves last-good events, marks error, backs off.
  {
    const store = makeStore();
    const a = adapter('src-a', 'ok');
    await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    assert.strictEqual(store.state.events.length, 1, 'first sweep stores the event');
    assert.strictEqual(store.state.meta.sources['src-a'].status, 'ok');

    a.mod.fetch = async () => { throw new Error('network down'); };
    const s2 = await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    assert.strictEqual(store.state.events.length, 1, 'last-good event preserved on failure');
    assert.strictEqual(store.state.meta.sources['src-a'].status, 'error');
    assert.ok(store.state.meta.sources['src-a'].backoffUntil, 'backoff scheduled');
    assert.strictEqual(s2.sources[0].status, 'error');

    // While backed off, fetch is skipped entirely (no throw, no replace).
    let called = false;
    a.mod.fetch = async () => { called = true; return []; };
    await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    assert.strictEqual(called, false, 'backed-off source is not fetched');
    assert.strictEqual(store.state.events.length, 1, 'events still preserved during backoff');
    console.log('  [1] throw -> preserve + error + backoff: PASS');
  }

  // 2. Suspect-empty: 2 strikes preserve, 3rd strike accepts empty.
  {
    const store = makeStore();
    const a = adapter('src-b', 'ok');
    await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    assert.strictEqual(store.state.events.length, 1);
    a.mod.fetch = async () => [];

    await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    assert.strictEqual(store.state.events.length, 1, 'strike 1: preserved');
    assert.strictEqual(store.state.meta.sources['src-b'].status, 'stale');

    // Clear backoff interference: suspect-empty path sets no backoff, fine.
    await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    assert.strictEqual(store.state.events.length, 1, 'strike 2: preserved');
    assert.strictEqual(store.state.meta.sources['src-b'].status, 'stale');

    await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    assert.strictEqual(store.state.events.length, 0, 'strike 3: accepted as genuinely empty');
    assert.strictEqual(store.state.meta.sources['src-b'].status, 'ok');
    console.log('  [2] suspect-empty 3-strike rule: PASS');
  }

  // 3. Missing keys -> needs_key, fetch skipped.
  {
    const store = makeStore();
    let called = false;
    const a = adapter('src-c', 'ok', 'SOME_MISSING_KEY_XYZ');
    a.mod.fetch = async () => { called = true; return [{ ...goodEvent }]; };
    await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    assert.strictEqual(called, false, 'fetch skipped when keys missing');
    assert.strictEqual(store.state.meta.sources['src-c'].status, 'needs_key');
    assert.strictEqual(store.state.events.length, 0);
    console.log('  [3] missing keys -> needs_key: PASS');
  }

  // 4. Recovery: error -> success clears backoff and replaces.
  {
    const store = makeStore();
    const a = adapter('src-d', 'throw');
    await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    assert.strictEqual(store.state.meta.sources['src-d'].status, 'error');
    // Force backoff to expire.
    store.state.meta.sources['src-d'].backoffUntil = new Date(Date.now() - 1000).toISOString();
    a.mod.fetch = async () => [{ ...goodEvent, id: 'evt-2' }];
    await runTierSweep(1, store, { timeoutMs: 5000, intervalMs: 60000, adapters: [a] });
    const st = store.state.meta.sources['src-d'];
    assert.strictEqual(st.status, 'ok');
    assert.strictEqual(st.backoffUntil, null);
    assert.strictEqual(st.consecutiveFailures, 0);
    assert.strictEqual(store.state.events.length, 1);
    assert.strictEqual(store.state.events[0].id, 'evt-2');
    console.log('  [4] recovery clears error state: PASS');
  }

  console.log('scheduler failure-semantics test: ALL PASS');
})().catch((err) => {
  console.error('FAIL:', err);
  process.exitCode = 1;
});
