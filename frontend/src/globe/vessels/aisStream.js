/* AISStream WebSocket client — real vessel positions, direct from the browser.
   Joshua's direction 2026-09-30: wire real ships via a free AISStream key
   instead of removing the Ships layer.

   KEY PRIVACY: the key lives ONLY in this browser (localStorage). It is
   never sent to our backend, never committed anywhere, never leaves the
   device except inside the wss subscription message to AISStream itself.
   Free signup: https://aisstream.io (sign in → API Keys page).

   Protocol (https://aisstream.io/documentation):
   - wss://stream.aisstream.io/v0/stream
   - send the subscription JSON within 3 s of open, or the server drops us
   - server sends binary WebSocket frames containing UTF-8 JSON
   - limits: 3 subscribed connections per account, 3 open per IP — we keep
     exactly one socket while the Ships layer is on. */

const ENDPOINT = 'wss://stream.aisstream.io/v0/stream';
const LS_KEY = 'ci.aisstream.key';
// Whole world, one box: [[[lat1, lon1], [lat2, lon2]]].
const WORLD_BOX = [[[-90, -180], [90, 180]]];
const POSITION_TYPES = ['PositionReport', 'StandardClassBPositionReport'];

const SILENCE_MS = 90 * 1000;      // no data this long → reconnect
const WATCHDOG_MS = 15 * 1000;
const MAX_BACKOFF_MS = 60 * 1000;

export function getAisKey() {
  try { return (localStorage.getItem(LS_KEY) || '').trim(); }
  catch { return ''; }
}
export function setAisKey(k) {
  try {
    const v = String(k || '').trim();
    if (v) localStorage.setItem(LS_KEY, v);
    else localStorage.removeItem(LS_KEY);
  } catch { /* storage unavailable — key simply won't persist */ }
}
export function hasAisKey() { return getAisKey().length > 0; }

const utf8 = new TextDecoder('utf-8');

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

/* One managed AISStream connection. Callbacks:
   onVessel(vessel) — one validated position report
   onState(state, detail) — 'connecting' | 'ok' | 'auth_failed' | 'down' */
export function createAisStream({ onVessel, onState }) {
  let ws = null;
  let wantOpen = false;
  let backoffMs = 2000;
  let reconnectTimer = 0;
  let watchdogTimer = 0;
  let openedAt = 0;
  let didOpen = false;
  let lastMsgAt = 0;
  let gotData = false;

  function setState(s, detail) {
    try { onState && onState(s, detail); } catch (err) { console.error('[ais]', err); }
  }

  function cleanup() {
    clearTimeout(reconnectTimer); reconnectTimer = 0;
    clearInterval(watchdogTimer); watchdogTimer = 0;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try { ws.close(); } catch { /* already dead */ }
      ws = null;
    }
  }

  function scheduleReconnect() {
    if (!wantOpen || reconnectTimer) return;
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = 0;
      if (wantOpen) open();
    }, wait);
  }

  function startWatchdog() {
    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMsgAt > SILENCE_MS) {
        // Stream went quiet — drop it and reconnect rather than
        // showing a frozen ocean.
        try { ws.close(); } catch { /* noop */ }
      }
    }, WATCHDOG_MS);
  }

  function handleText(text) {
    let msg = null;
    try { msg = JSON.parse(text); } catch { return; } // ignore malformed frames
    if (msg && msg.MessageType === 'SubscriptionConfirmation') {
      lastMsgAt = Date.now();
      return;
    }
    const v = parseReport(msg);
    if (!v) return;
    lastMsgAt = Date.now();
    if (!gotData) {
      gotData = true;
      backoffMs = 2000; // healthy stream — reset backoff
      setState('ok');
    }
    try { onVessel && onVessel(v); } catch (err) { console.error('[ais] vessel handler:', err); }
  }

  function open() {
    cleanup();
    const key = getAisKey();
    if (!key) { setState('down', 'no key'); return; }
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
      // Subscription MUST go out within 3 s — send it immediately.
      try {
        ws.send(JSON.stringify({
          APIKey: key,
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
        try { handleText(utf8.decode(d)); } catch { /* ignore bad frame */ }
      } else if (typeof Blob !== 'undefined' && d instanceof Blob) {
        d.text().then(handleText).catch(() => { /* ignore bad frame */ });
      }
    };
    ws.onerror = () => { /* close follows; handled in onclose */ };
    ws.onclose = () => {
      clearInterval(watchdogTimer); watchdogTimer = 0;
      ws = null;
      if (!wantOpen) return;
      if (!didOpen) {
        // Never got a socket at all — network/proxy failure, not the key.
        setState('down', 'network unreachable');
        scheduleReconnect();
        return;
      }
      // Opened, then closed before any data, shortly after subscribing →
      // the key was almost certainly rejected (bad paste / revoked). Say so
      // honestly instead of silently retrying forever.
      if (!gotData && Date.now() - openedAt < 8000) {
        backoffMs = MAX_BACKOFF_MS; // don't hammer a bad key
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
    disconnect() {
      wantOpen = false;
      cleanup();
    },
  };
}
