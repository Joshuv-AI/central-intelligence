// Central Intelligence — public API routes.
const express = require('express');
const sse = require('../lib/sse');
const { registerCamerasRoutes } = require('./cameras');

function apiRoutes(store) {
  const router = express.Router();

  registerCamerasRoutes(router);

  // Per-source health for the status pill.
  router.get('/health', (req, res) => {
    const sources = Object.values(store.state.meta.sources || {});
    const healthy = sources.filter((s) => s.status === 'ok').length;
    const stale = sources.filter((s) => s.status === 'error').length;
    res.json({
      status: 'ok',
      uptimeSec: Math.floor(process.uptime()),
      deploySha: process.env.DEPLOY_SHA || 'unknown',
      sourcesTotal: sources.length,
      sourcesHealthy: healthy,
      sourcesStale: stale,
      lastSweep: store.state.meta.lastSweep || null,
      sources,
    });
  });

  // First-load bundle: markers + connections + feed + meta in one call.
  router.get('/snapshot', (req, res) => {
    res.json(store.snapshot());
  });

  // Filtered queries: ?domain=conflict&severity=high&region=middle%20east&since=2026-09-27T00:00:00Z
  router.get('/events', (req, res) => {
    const { domain, region, since, severity } = req.query;
    res.json({ events: store.getEvents({ domain, region, since, severity }) });
  });

  // Server-sent events: 'snapshot' on connect, 'update' after every sweep.
  router.get('/stream', (req, res) => {
    sse.addClient(res);
    // Push a full snapshot immediately so the client never waits for a sweep.
    try {
      res.write(`event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
    } catch {
      /* client already gone */
    }
  });

  // J4-02 (Wave 2): what changed in the window, from the capped delta
  // retention log (delta-only, ≤8 MB / 72 h). ?window=1h|6h|24h.
  router.get('/changes', (req, res) => {
    const w = String(req.query.window || '6h');
    const windowMs = w === '1h' ? 3600_000 : w === '24h' ? 24 * 3600_000 : 6 * 3600_000;
    const canonical = w === '1h' ? '1h' : w === '24h' ? '24h' : '6h';
    try {
      const { readChanges } = require('../pipeline/changeLog');
      res.json({ window: canonical, ...readChanges(store.dir, windowMs) });
    } catch (err) {
      console.error('[api] /changes failed:', err && err.message);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}

module.exports = { apiRoutes };
