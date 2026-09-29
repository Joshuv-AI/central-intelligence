// Central Intelligence — tiered sweep scheduler.
// Runs each tier on its own interval, staggered at startup so tiers never
// stampede at once. Within a tier, sources fetch in parallel with isolated
// timeouts: one dead source can never kill a sweep.
//
// Failure semantics (the important part):
// - fetch() throws / times out        -> 'error': last-good events are
//   PRESERVED, source backs off exponentially (capped at the tier interval).
// - fetch() returns [] but the source  -> 'stale': last-good events are
//   had data recently                   preserved until EMPTY_STRIKES
//                                       consecutive empty sweeps, then the
//                                       source is accepted as genuinely quiet.
// - adapter declares keyEnv and keys   -> 'needs_key': skipped, events
//   are missing                          untouched.
// - fetch() returns [] and the source  -> 'ok': empty is real, events
//   never had data / already empty       replaced (no-op).
const { normalizeEvent } = require('./normalize');
const { adaptersForTier, ADAPTERS } = require('./adapters/index');
const { runBrain } = require('./brain');

// Consecutive empty sweeps before a previously-productive source is
// accepted as genuinely quiet (vs. a failure disguised as []).
const EMPTY_STRIKES = 3;

// keyEnv shapes: 'ONE_KEY' | ['KEY_A','KEY_B'] (all required)
//   | [['TOKEN'], ['KEY','EMAIL']] (any group, all keys in the group required)
function hasRequiredKeys(keyEnv) {
  if (!keyEnv) return true;
  const groups = Array.isArray(keyEnv[0])
    ? keyEnv
    : [Array.isArray(keyEnv) ? keyEnv : [keyEnv]];
  return groups.some((g) => g.every((k) => !!process.env[k]));
}

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${name})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getSourceState(meta, name, tier) {
  meta.sources = meta.sources || {};
  if (!meta.sources[name]) {
    meta.sources[name] = {
      name,
      tier,
      status: 'pending',
      count: 0,
      ms: 0,
      error: null,
      lastRun: null,
      lastOk: null,
      consecutiveFailures: 0,
      consecutiveEmpty: 0,
      backoffUntil: null,
    };
  }
  return meta.sources[name];
}

async function fetchOne(adapter, timeoutMs, state) {
  const started = Date.now();
  const name = adapter.name;
  if (!hasRequiredKeys(adapter.mod.keyEnv)) {
    return { name, ok: false, needsKey: true, ms: Date.now() - started };
  }
  if (state.backoffUntil && Date.now() < new Date(state.backoffUntil).getTime()) {
    return { name, ok: false, backedOff: true, ms: Date.now() - started };
  }
  try {
    const raw = await withTimeout(adapter.mod.fetch(), timeoutMs, name);
    const events = (Array.isArray(raw) ? raw : [])
      .map((r) => normalizeEvent({ ...r, source: name, domain: r.domain || adapter.domain }))
      .filter(Boolean);
    // Dedupe on id within this source's batch.
    const seen = new Set();
    const deduped = events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
    return { name, ok: true, count: deduped.length, events: deduped, ms: Date.now() - started };
  } catch (err) {
    return {
      name,
      ok: false,
      count: 0,
      events: [],
      error: String((err && err.message) || err),
      ms: Date.now() - started,
    };
  }
}

// Age out 'ok' sources whose last success is older than 2x their interval.
function refreshAging(meta, intervalMsByTier) {
  const now = Date.now();
  for (const st of Object.values(meta.sources || {})) {
    if (st.status === 'ok' && st.lastOk) {
      const interval = intervalMsByTier[st.tier] || 15 * 60_000;
      if (now - new Date(st.lastOk).getTime() > 2 * interval) st.status = 'stale';
    }
  }
}

async function runTierSweep(tier, store, { timeoutMs, intervalMs, adapters }) {
  const list = adapters || adaptersForTier(tier);
  const started = new Date().toISOString();
  const interval = intervalMs || 15 * 60_000;
  const states = list.map((a) => getSourceState(store.state.meta, a.name, a.tier));
  const results = await Promise.all(list.map((a, i) => fetchOne(a, timeoutMs, states[i])));

  let newEvents = 0;
  for (const r of results) {
    const st = getSourceState(store.state.meta, r.name, tier);
    const now = new Date().toISOString();
    if (r.needsKey) {
      st.status = 'needs_key';
      st.lastRun = started;
      st.error = null;
      // Events untouched: nothing was ever fetched.
    } else if (r.backedOff) {
      st.lastRun = started;
      // Status stays 'error'; events untouched.
    } else if (!r.ok) {
      st.consecutiveFailures += 1;
      st.consecutiveEmpty = 0;
      st.error = r.error;
      st.status = 'error';
      st.lastRun = started;
      st.ms = r.ms;
      const backoffMs = Math.min(
        interval,
        60_000 * Math.pow(2, Math.min(st.consecutiveFailures, 6))
      );
      st.backoffUntil = new Date(Date.now() + backoffMs).toISOString();
      // PRESERVE last-good events: no replaceSourceEvents call.
    } else if (r.count === 0 && st.count > 0 && st.consecutiveEmpty < EMPTY_STRIKES - 1) {
      // Suspect empty: this source had data, now reports none. Could be a
      // failure disguised as [] — preserve last-good until it stays empty.
      st.consecutiveEmpty += 1;
      st.status = 'stale';
      st.lastRun = started;
      st.ms = r.ms;
      st.error = null;
    } else {
      if (r.count === 0) st.consecutiveEmpty += 1;
      else st.consecutiveEmpty = 0;
      store.replaceSourceEvents(r.name, r.events);
      newEvents += r.count;
      st.count = r.count;
      st.status = 'ok';
      st.lastOk = now;
      st.lastRun = started;
      st.ms = r.ms;
      st.error = null;
      st.consecutiveFailures = 0;
      st.backoffUntil = null;
    }
  }

  const meta = store.state.meta;
  refreshAging(meta, { 1: interval });
  const ok = results.filter((r) => r.ok && !r.needsKey && !r.backedOff).length;
  const summary = {
    tier,
    started,
    finished: new Date().toISOString(),
    sources: results.map((r) => {
      const st = meta.sources[r.name] || {};
      return {
        name: r.name,
        status: st.status || (r.ok ? 'ok' : 'error'),
        count: st.count || 0,
        ms: r.ms,
        error: st.error || r.error || null,
        lastRun: started,
        lastOk: st.lastOk || null,
      };
    }),
    ok,
    failed: results.length - ok,
    newEvents,
  };

  meta.lastSweep = { tier, at: summary.finished, ok, failed: summary.failed };
  store.patchMeta(meta);

  // Intelligence pipeline over the full event set: delta -> cascades /
  // anomalies / clusters -> fusion -> feed -> status. Guarded so a brain
  // failure can never break the sweep or lose the fetched events.
  try {
    summary.brain = runBrain(store);
  } catch (err) {
    console.error('[scheduler] brain crashed:', err && err.message);
    summary.brain = null;
  }

  return summary;
}

function startScheduler(store, config, onSweep) {
  const tiers = [
    { tier: 1, interval: config.intervals.tier1, stagger: 5_000 },
    { tier: 2, interval: config.intervals.tier2, stagger: 60_000 },
    { tier: 3, interval: config.intervals.tier3, stagger: 120_000 },
  ];
  const intervalMsByTier = { 1: config.intervals.tier1, 2: config.intervals.tier2, 3: config.intervals.tier3 };
  const timers = [];
  for (const { tier, interval, stagger } of tiers) {
    const run = async () => {
      try {
        const summary = await runTierSweep(tier, store, {
          timeoutMs: config.fetchTimeoutMs,
          intervalMs: interval,
        });
        if (onSweep) onSweep(summary);
      } catch (err) {
        console.error(`[scheduler] tier ${tier} sweep crashed:`, err);
      }
    };
    // First run staggered, then on interval. Unref so tests can exit.
    const t0 = setTimeout(() => { run(); timers.push(setInterval(run, interval).unref()); }, stagger).unref();
    timers.push(t0);
  }
  // Seed source metadata so /api/health is meaningful before the first sweep.
  const meta = store.state.meta;
  meta.sources = meta.sources || {};
  const validNames = new Set(ADAPTERS.map((a) => a.name));
  for (const name of Object.keys(meta.sources)) {
    if (!validNames.has(name)) delete meta.sources[name];
  }
  for (const a of ADAPTERS) {
    getSourceState(meta, a.name, a.tier);
  }
  refreshAging(meta, intervalMsByTier);
  store.patchMeta(meta);
  return () => timers.forEach(clearTimeout);
}

module.exports = { runTierSweep, startScheduler, hasRequiredKeys };
