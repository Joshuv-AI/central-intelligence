// Central Intelligence — vessel API routes (server-side AIS hub).
//
// GET /api/vessels/status — honest hub state (never includes the key).
// GET /api/vessels/stream — SSE: 'status' + 'vessels' (snapshot, then
//   live batches every ~2 s while the upstream is hot).
const express = require('express');

function aisRoutes(hub) {
  const router = express.Router();
  router.get('/vessels/status', (req, res) => res.json(hub.statusJson()));
  router.get('/vessels/stream', (req, res) => hub.attachStream(req, res));
  return router;
}

module.exports = { aisRoutes };
