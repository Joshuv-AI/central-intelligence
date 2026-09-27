// Central Intelligence — tiered sweep scheduler.
// Runs each tier on its own interval, staggered at startup so tiers never
// stampede at once. Within a tier, sources fetch in parallel with isolated
// timeouts: one dead source can never kill a sweep.
//
// Phase 1: adapters are stubs returning [], so sweeps exercise the whole
// path (fetch -> normalize -> store -> SSE) with empty results.
const { normalizeEvent } = require('./normalize');
const { adaptersForTier, ADAPTERS } = require('./adapters/index');

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${name})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchOne(adapter, timeoutMs) {
  const started = Date.now();
  try {
    const raw = await withTimeout(adapter.mod.fetch(), timeoutMs, adapter.name);
    const events = (Array.isArray(raw) ? raw : [])
      .map((r) => normalizeEvent({ ...r, source: adapter.name, domain: r.domain || adapter.domain }))
      .filter(Boolean);
    // Dedupe on id within this source's batch.
    const seen = new Set();
    const deduped = events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
    return { name: adapter.name, ok: true, count: deduped.length, events: deduped, ms: Date.now() - started };
  } catch (err) {
    return { name: adapter.name, ok: false, count: 0, events: [], error: String(err && err.message || err), ms: Date.now() - started };
  }
}

async function runTierSweep(tier, store, { timeoutMs }) {
  const adapters = adaptersForTier(tier);
  const started = new Date().toISOString();
  const results = await Promise.all(adapters.map((a) => fetchOne(a, timeoutMs)));

  let newEvents = 0;
  for (const r of results) {
    store.replaceSourceEvents(r.name, r.events);
    newEvents += r.count;
  }

  const ok = results.filter((r) => r.ok).length;
  const summary = {
    tier,
    started,
    finished: new Date().toISOString(),
    sources: results.map((r) => ({
      name: r.name,
      status: r.ok ? 'ok' : 'error',
      count: r.count,
      ms: r.ms,
      error: r.error || null,
      lastRun: started,
    })),
    ok,
    failed: results.length - ok,
    newEvents,
  };

  // Per-source freshness for the status pill.
  const meta = store.state.meta;
  meta.sources = meta.sources || {};
  for (const s of summary.sources) meta.sources[s.name] = s;
  meta.lastSweep = { tier, at: summary.finished, ok, failed: summary.failed };
  store.patchMeta(meta);

  return summary;
}

function startScheduler(store, config, onSweep) {
  const tiers = [
    { tier: 1, interval: config.intervals.tier1, stagger: 5_000 },
    { tier: 2, interval: config.intervals.tier2, stagger: 60_000 },
    { tier: 3, interval: config.intervals.tier3, stagger: 120_000 },
  ];
  const timers = [];
  for (const { tier, interval, stagger } of tiers) {
    const run = async () => {
      try {
        const summary = await runTierSweep(tier, store, { timeoutMs: config.fetchTimeoutMs });
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
  for (const a of ADAPTERS) {
    if (!meta.sources[a.name]) {
      meta.sources[a.name] = { name: a.name, tier: a.tier, status: 'pending', count: 0, ms: 0, error: null, lastRun: null };
    }
  }
  store.patchMeta(meta);
  return () => timers.forEach(clearTimeout);
}

module.exports = { runTierSweep, startScheduler };
