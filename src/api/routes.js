// Central Intelligence — public API routes.
const express = require('express');
const sse = require('../lib/sse');

function apiRoutes(store) {
  const router = express.Router();

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

  return router;
}

module.exports = { apiRoutes };
