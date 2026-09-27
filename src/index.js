// Central Intelligence — backend entry point.
// One process: Express API + tiered intel scheduler + SSE push.
// No alerting, no briefings, no bots, no LLM calls — by design.
const express = require('express');
const config = require('./config');
const { Store } = require('./pipeline/store');
const { startScheduler } = require('./pipeline/scheduler');
const { apiRoutes } = require('./api/routes');
const { proxyRoutes } = require('./api/proxy');
const sse = require('./lib/sse');

const store = new Store(config.dataDir, config.feedLimit);
store.load();
store.saveAll(); // ensure all four state files exist from first boot

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use('/api', apiRoutes(store));
app.use('/proxy', proxyRoutes());

app.get('/', (req, res) => {
  res.json({
    name: 'central-intelligence-backend',
    version: '0.1.0',
    license: 'AGPL-3.0-only',
    endpoints: ['GET /api/health', 'GET /api/snapshot', 'GET /api/events', 'GET /api/stream', '/proxy/*'],
  });
});

app.use((req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api] error:', err);
  res.status(500).json({ error: 'internal_error' });
});

startScheduler(store, config, (summary) => {
  console.log(
    `[sweep] tier ${summary.tier}: ${summary.ok}/${summary.ok + summary.failed} sources ok, ` +
    `${summary.newEvents} events`
  );
  sse.broadcast('update', { tier: summary.tier, at: summary.finished, newEvents: summary.newEvents });
});

app.listen(config.port, () => {
  console.log(`[boot] central-intelligence-backend listening on :${config.port}`);
  console.log(`[boot] state dir: ${config.dataDir}`);
});
