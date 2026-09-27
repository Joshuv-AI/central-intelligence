// Central Intelligence — adapter validation harness.
// Loads every registered adapter, runs fetch() with a timeout, and checks
// the raw-event contract. Usage: node test/validate_adapters.js
const { ADAPTERS } = require('../src/pipeline/adapters/index');

const SEVS = new Set(['low', 'moderate', 'high', 'critical']);
const TIMEOUT_MS = 30000;

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${name})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function checkEvent(e) {
  const errs = [];
  if (!e || typeof e !== 'object') return ['not an object'];
  if (!e.id || typeof e.id !== 'string') errs.push('bad id');
  if (!e.title || typeof e.title !== 'string') errs.push('bad title');
  if (!SEVS.has(e.severity)) errs.push(`bad severity: ${e.severity}`);
  if (!e.time || Number.isNaN(new Date(e.time).getTime())) errs.push(`bad time: ${e.time}`);
  if ('source' in e) errs.push('has forbidden `source` field');
  if ('domain' in e) errs.push('has forbidden `domain` field');
  if (e.lat != null && (typeof e.lat !== 'number' || e.lat < -90 || e.lat > 90))
    errs.push(`bad lat: ${e.lat}`);
  if (e.lon != null && (typeof e.lon !== 'number' || e.lon < -180 || e.lon > 180))
    errs.push(`bad lon: ${e.lon}`);
  if (!e.attribution || typeof e.attribution !== 'string') errs.push('missing attribution');
  return errs;
}

(async () => {
  console.log(`Validating ${ADAPTERS.length} adapters...\n`);
  const rows = [];
  for (const a of ADAPTERS) {
    const t0 = Date.now();
    let events = null;
    let error = null;
    let mod = null;
    try {
      mod = require(`../src/pipeline/adapters/${a.file.replace('./', '')}`);
    } catch (err) {
      error = `require failed: ${err.message}`;
    }
    try {
      if (!error) events = await withTimeout(mod.fetch(), TIMEOUT_MS, a.name);
    } catch (err) {
      error = err.message;
    }
    const ms = Date.now() - t0;
    let issues = [];
    if (error) {
      issues.push(`FETCH ERROR: ${error}`);
    } else if (!Array.isArray(events)) {
      issues.push('fetch() did not return an array');
    } else {
      const seen = new Set();
      events.forEach((e, i) => {
        const es = checkEvent(e);
        if (es.length) issues.push(`event[${i}] ${e && e.id}: ${es.join('; ')}`);
        if (e && e.id) {
          if (seen.has(e.id)) issues.push(`duplicate id: ${e.id}`);
          seen.add(e.id);
        }
      });
    }
    const n = Array.isArray(events) ? events.length : 0;
    rows.push({ name: a.name, tier: a.tier, n, ms, ok: issues.length === 0, issues });
    const flag = issues.length ? 'FAIL' : n === 0 ? 'EMPTY' : 'ok';
    console.log(
      `${flag.padEnd(5)} ${a.name.padEnd(16)} t${a.tier}  ${String(n).padStart(3)} ev  ${String(ms).padStart(5)}ms` +
        (issues.length ? `  !! ${issues[0].slice(0, 100)}` : '')
    );
  }
  const fails = rows.filter((r) => !r.ok);
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log(`\n${rows.length - fails.length}/${rows.length} adapters clean, ${total} total events.`);
  if (fails.length) {
    console.log('\nFailures:');
    for (const f of fails) {
      console.log(`- ${f.name}:`);
      f.issues.slice(0, 5).forEach((i) => console.log(`    ${i.slice(0, 160)}`));
    }
    process.exitCode = 1;
  }
})();
