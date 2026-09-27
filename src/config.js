// Central Intelligence — runtime configuration.
// Everything is overridable via environment variables for Docker / VM deploys.
const path = require('path');

module.exports = {
  port: parseInt(process.env.PORT || '3001', 10),

  // JSON state store location. Mounted as a volume in docker-compose.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Sweep intervals per tier (ms). Staggered at startup so tiers never stampede.
  intervals: {
    tier1: parseInt(process.env.TIER1_MS || String(15 * 60 * 1000), 10), // ~15 min
    tier2: parseInt(process.env.TIER2_MS || String(45 * 60 * 1000), 10), // ~45 min
    tier3: parseInt(process.env.TIER3_MS || String(24 * 60 * 60 * 1000), 10), // daily
  },

  // Per-source fetch timeout (ms). A slow source never blocks the sweep.
  fetchTimeoutMs: parseInt(process.env.FETCH_TIMEOUT_MS || '25000', 10),

  // Max items kept in the public feed.
  feedLimit: parseInt(process.env.FEED_LIMIT || '200', 10),
};
