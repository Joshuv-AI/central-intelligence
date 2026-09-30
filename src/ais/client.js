// Central Intelligence — server-side AISStream client.
//
// The AISStream API key MUST stay server-side (aisstream.io docs, Sep 2026:
// keys must remain server-side; direct browser WebSocket connections are
// not permitted). This module runs in Node (built-in WebSocket client,
// Node >= 22) and keeps exactly ONE subscription per account — well under
// AISStream's 3-connections-per-account limit — no matter how many globe
// viewers are attached.
//
// Protocol (https://aisstream.io/documentation):
// - wss://stream.aisstream.io/v0/stream
// - subscription JSON must go out within 3 s of open
// - server sends binary WebSocket frames containing UTF-8 JSON
//
// Callbacks:
//   onVessel(vessel) — one validated position report
//   onState(state, detail) — 'connecting' | 'ok' | 'auth_failed' | 'down'

const ENDPOINT = process.env.AISSTREAM_ENDPOINT || 'wss://stream.aisstream.io/v0/stream';
// Whole world, one box: [[[lat1, lon1], [lat2, lon2]]].
const WORLD_BOX = [[[-90, -180], [90, 180]]];
const POSITION_TYPES = ['PositionReport', 'StandardClassBPositionReport'];

const SILENCE_MS = 90 * 1000; // no data this long → reconnect
const WATCHDOG_MS = 15 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

function parseMeta(meta) {
  if (!meta) return null;
  const mmsi = String(meta.MMSI ?? '').trim();
  const lat = Number(meta.Latitude ?? meta.latitude);
  const lon = Number(meta.Longitude ?? meta.longitude);
  if (!mmsi || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { mmsi, lat, lon, name: String(meta.ShipName ?? meta.shipName ?? '').trim() };
}

function parseReport(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (!POSITION_TYPES.includes(msg.MessageType)) return null;
  const meta = parseMeta(msg.MetaData);
  if (!meta) return null;
  const rep = (msg.Message && (msg.Message[msg.MessageType] || msg.Message.PositionReport)) || {};
  const sog = Number(rep.Sog ?? rep.sog);
  const cog = Number(rep.Cog ?? rep.cog);
  const heading = Number(rep.TrueHeading ?? rep.trueHeading ?? rep.Heading ?? rep.heading);
  return {
    mmsi: meta.mmsi,
    name: meta.name,
    lat: meta.lat,
    lon: meta.lon,
    sog: Number.isFinite(sog) ? sog : NaN,
    cog: Number.isFinite(cog) ? cog : NaN,
    heading: Number.isFinite(heading) ? heading : NaN,
    type: rep.ShipType ?? rep.shipType,
    navStatus: String(rep.NavigationalStatus ?? rep.navigationalStatus ?? '').trim(),
  };
}

function createClient({ apiKey, onVessel, onState }) {
  let ws = null;
  let wantOpen = false;
  let backoffMs = 2000;
  let reconnectTimer = 0;
  let watchdogTimer = 0;
  let openedAt = 0;
  let didOpen = false;
  let lastMsgAt = 0;
  let gotData = false;

  const setState = (s, detail) => {
    try { onState && onState(s, detail); } catch (err) { console.error('[ais] state cb:', err); }
  };

  function cleanup() {
    clearTimeout(reconnectTimer); reconnectTimer = 0;
    clearInterval(watchdogTimer); watchdogTimer = 0;
    if (ws) {
      try { ws.close(); } catch { /* already dead */ }
      ws = null;
    }
  }

  function scheduleReconnect() {
    if (!wantOpen || reconnectTimer) return;
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = 0; if (wantOpen) open(); }, wait);
  }

  function startWatchdog() {
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return; // 1 = OPEN
      if (Date.now() - lastMsgAt > SILENCE_MS) {
        try { ws.close(); } catch { /* noop */ } // close → reconnect
      }
    }, WATCHDOG_MS);
  }

  function handleText(text) {
    let msg = null;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg && msg.MessageType === 'SubscriptionConfirmation') { lastMsgAt = Date.now(); return; }
    const v = parseReport(msg);
    if (!v) return;
    lastMsgAt = Date.now();
    if (!gotData) {
      gotData = true;
      backoffMs = 2000;
      setState('ok');
    }
    try { onVessel && onVessel(v); } catch (err) { console.error('[ais] vessel cb:', err); }
  }

  function open() {
    cleanup();
    if (!apiKey) { setState('down', 'no key'); return; }
    setState('connecting');
    openedAt = Date.now();
    lastMsgAt = Date.now();
    didOpen = false;
    gotData = false;
    let sock;
    try {
      sock = new WebSocket(ENDPOINT);
    } catch (err) {
      setState('down', String((err && err.message) || err));
      scheduleReconnect();
      return;
    }
    ws = sock;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      didOpen = true;
      try {
        ws.send(JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: WORLD_BOX,
          FilterMessageTypes: POSITION_TYPES,
        }));
      } catch (err) {
        setState('down', String((err && err.message) || err));
        scheduleReconnect();
        return;
      }
      lastMsgAt = Date.now();
      startWatchdog();
    };
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === 'string') handleText(d);
      else if (d instanceof ArrayBuffer) {
        try { handleText(Buffer.from(d).toString('utf-8')); } catch { /* ignore */ }
      } else if (d && typeof d.text === 'function') {
        d.text().then(handleText).catch(() => { /* ignore */ });
      }
    };
    ws.onerror = () => { /* close follows; handled in onclose */ };
    ws.onclose = () => {
      clearInterval(watchdogTimer); watchdogTimer = 0;
      ws = null;
      if (!wantOpen) return;
      if (!didOpen) {
        setState('down', 'network unreachable');
        scheduleReconnect();
        return;
      }
      if (!gotData && Date.now() - openedAt < 8000) {
        backoffMs = MAX_BACKOFF_MS; // don't hammer a rejected key
        setState('auth_failed', 'key rejected by AISStream');
        scheduleReconnect();
        return;
      }
      setState('down', 'connection lost');
      scheduleReconnect();
    };
  }

  return {
    connect() { wantOpen = true; backoffMs = 2000; open(); },
    disconnect() { wantOpen = false; cleanup(); },
  };
}

module.exports = { createClient };
