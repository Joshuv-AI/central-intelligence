// Central Intelligence — backend entry point.
// One process: Express API + tiered intel scheduler + SSE push.
// No alerting, no briefings, no bots, no LLM calls — by design.
const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { Store } = require('./pipeline/store');
const { startScheduler } = require('./pipeline/scheduler');
const { apiRoutes } = require('./api/routes');
const { proxyRoutes } = require('./api/proxy');
const { gevRoutes } = require('./api/gev');
const { aisRoutes } = require('./ais/routes');
const { createHub } = require('./ais/hub');
const sse = require('./lib/sse');

// ARCH §4.6 touch 1: document-header middleware for the static/SPA path.
// Header set ported from GEV build/vite.js BROWSER_HEADERS / BROWSER_CSP
// (pinned SHA 8b8ccc9a), MINUS the Bhote-Koshi embedded-media origins
// (youtube / facebook / twitter in script-src + frame-src) — that pack is
// scrubbed from the merged system, so its origins leave the policy too.
// Cesium requires 'unsafe-eval' (Knockout global resolution + WASM).
const BROWSER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' blob: data: https: wss: ws:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function documentHeaders(req, res, next) {
  res.set('Content-Security-Policy', BROWSER_CSP);
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
}

const store = new Store(config.dataDir, config.feedLimit);
store.load();
try {
  store.saveAll(); // ensure all four state files exist from first boot
} catch (err) {
  // A state dir that can't be written must never take the API down.
  console.error('[boot] FATAL: cannot write state dir', config.dataDir, err.message);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
// Step-3 (§4.6): gzip for /api/*, /proxy/* and static — SSE streams are
// excluded by compression's default no-transform handling of
// text/event-stream flushes via X-Accel-Buffering semantics; the filter
// below keeps event streams uncompressed explicitly.
app.use(compression({
  filter: (req, res) => {
    const type = res.getHeader('Content-Type');
    if (type && String(type).includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

const hub = createHub();
app.use('/api', apiRoutes(store));
app.use('/api', aisRoutes(hub));
// GEV adapter (ARCH §4.2) — additive family; never shadows the routes above.
app.use('/api', gevRoutes({ hub, store }));
app.use('/proxy', proxyRoutes());

// Serve the built frontend (Vite dist is copied to ./public in the Docker
// image). Absent during local backend-only dev — the API works without it.
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  app.use(documentHeaders, express.static(publicDir, { index: false, maxAge: '1h' }));
  // SPA fallback: every non-API route serves the frontend (it is now the root page).
  app.get(/^(?!\/(api|proxy)(\/|$)).*$/, documentHeaders, (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.json({
      name: 'central-intelligence-backend',
      version: '0.1.0',
      license: 'AGPL-3.0-only',
      endpoints: ['GET /api/health', 'GET /api/snapshot', 'GET /api/events', 'GET /api/stream', 'GET /api/vessels/status', 'GET /api/vessels/stream (SSE)', '/proxy/*'],
    });
  });
}

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
