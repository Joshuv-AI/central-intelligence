// Central Intelligence — /proxy/* stub.
//
// Phase 2 turns this into the live-layer forwarder for God's Eye View's
// real-time data (flights, ships, satellites, weather visuals): forward the
// request upstream, keep API keys server-side, cache 30-60s. It is NOT part
// of the intel sweep — those sources are polled, this is proxied on demand.
//
// Until then it answers 501 so misconfiguration is loud, not silent.
const express = require('express');

function proxyRoutes() {
  const router = express.Router();
  router.use((req, res) => {
    res.status(501).json({
      error: 'proxy_not_configured',
      message: 'Live-layer forwarding is not wired yet (Phase 2).',
      path: req.originalUrl,
    });
  });
  return router;
}

module.exports = { proxyRoutes };
