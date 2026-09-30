// Central Intelligence — server-side AIS vessel hub.
//
// One process-wide AISStream subscription (see ./client.js) feeds an
// in-memory vessel store; browsers attach via SSE and get snapshots +
// live batches. The API key never leaves this process.
//
// Lifecycle: the upstream connection is ON-DEMAND — it opens when the first
// SSE viewer subscribes and closes 5 minutes after the last one leaves, so
// an idle server holds no AISStream connection at all.
//
// Honest states: 'no_key' (AISSTREAM_KEY not configured) | 'connecting' |
// 'ok' | 'auth_failed' | 'down'.

const { createClient } = require('./client');

const MAX_VESSELS = 25000;
const STALE_MS = 10 * 60 * 1000;   // drop vessels silent this long
const SWEEP_MS = 60 * 1000;
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const BATCH_MS = 2000;             // SSE batch cadence

function createHub() {
  const apiKey = (process.env.AISSTREAM_KEY || '').trim();
  const vessels = new Map(); // mmsi -> vessel
  const clients = new Set(); // SSE response objects
  let client = null;
  let state = apiKey ? 'down' : 'no_key';
  let lastErr = apiKey ? '' : 'AISSTREAM_KEY not configured on server';
  let lastOk = 0;
  let idleTimer = 0;
  let sweepTimer = 0;
  let batchTimer = 0;
  let dirty = false;

  function sseSend(res, event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch { return false; }
  }

  function broadcast(event, data) {
    for (const res of [...clients]) {
      if (!sseSend(res, event, data)) {
        clients.delete(res);
        onClientCountChanged();
      }
    }
  }

  function snapshot() {
    return [...vessels.values()];
  }

  function prune() {
    const now = Date.now();
    let removed = 0;
    for (const [mmsi, v] of vessels) {
      if (now - v.at > STALE_MS) { vessels.delete(mmsi); removed++; }
    }
    if (removed) dirty = true;
  }

  function ensureUpstream() {
    if (!apiKey) return;
    if (client) return;
    clearTimeout(idleTimer); idleTimer = 0;
    client = createClient({
      apiKey,
      onVessel: (v) => {
        v.at = Date.now();
        if (!vessels.has(v.mmsi) && vessels.size >= MAX_VESSELS) {
          // Drop the oldest to stay under the cap.
          let oldest = null, oldestAt = Infinity;
          for (const [m, e] of vessels) {
            if (e.at < oldestAt) { oldestAt = e.at; oldest = m; }
          }
          if (oldest) vessels.delete(oldest);
        }
        vessels.set(v.mmsi, v);
        dirty = true;
      },
      onState: (s, detail) => {
        state = s;
        lastErr = s === 'ok' ? '' : (detail || s);
        if (s === 'ok') lastOk = Date.now();
        broadcast('status', statusJson());
      },
    });
    state = 'connecting';
    lastErr = '';
    client.connect();
    if (!sweepTimer) sweepTimer = setInterval(prune, SWEEP_MS);
    if (!batchTimer) {
      batchTimer = setInterval(() => {
        if (dirty && clients.size) {
          dirty = false;
          broadcast('vessels', snapshot());
        }
      }, BATCH_MS);
    }
  }

  function maybeIdleClose() {
    if (clients.size || !client) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (clients.size) return;
      try { client.disconnect(); } catch { /* noop */ }
      client = null;
      state = apiKey ? 'down' : 'no_key';
      lastErr = apiKey ? 'idle — upstream closed' : lastErr;
    }, IDLE_CLOSE_MS);
  }

  function onClientCountChanged() {
    if (clients.size) ensureUpstream();
    else maybeIdleClose();
  }

  function statusJson() {
    return {
      state,
      keyConfigured: !!apiKey,
      vessels: vessels.size,
      viewers: clients.size,
      lastOk,
      lastErr,
    };
  }

  function attachStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    sseSend(res, 'status', statusJson());
    sseSend(res, 'vessels', snapshot());
    onClientCountChanged();
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* dead */ } }, 25000);
    req.on('close', () => {
      clearInterval(hb);
      clients.delete(res);
      onClientCountChanged();
    });
  }

  return { attachStream, statusJson };
}

module.exports = { createHub };
