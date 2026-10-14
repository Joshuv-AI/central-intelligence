/* Lane G — B1 data client.
   Snapshot-first load, then SSE on /api/stream with the REAL semantics
   (Lane A contract proof): a full `snapshot` event on connect, then
   `update` PINGS {tier, at, newEvents} — a ping is not data, it triggers a
   coalesced /api/snapshot refetch. 25 s server heartbeats are comments
   (invisible to EventSource), so silence > 40 s is treated as a drop.
   Reconnect uses the old CI ladder 1/2/5/15/30 s. Diagnostics carry
   payload sizes from v1 (ARCH R8 snapshot-size discipline). */
import { approxBytes } from './model.js';

export const BACKOFFS_MS = [1000, 2000, 5000, 15000, 30000];
const SILENCE_LIMIT_MS = 40_000;
const WATCHDOG_MS = 5_000;

export class IntelClient {
  constructor({ onSnapshot, onStatus } = {}) {
    this.onSnapshot = onSnapshot || (() => {});
    this.onStatus = onStatus || (() => {});
    this.diag = {
      state: 'idle', // idle|connecting|live|stale|reconnecting|down
      attempt: 0,
      disconnectedAt: null,
      snapshotsReceived: 0,
      updatesReceived: 0,
      refetches: 0,
      lastSnapshotBytes: 0,
      lastSnapshotAt: null,
      totalBytes: 0,
      lastPing: null,
      lastError: null,
    };
    this._es = null;
    this._closed = false;
    this._retryTimer = null;
    this._watchdog = null;
    this._lastMessageAt = 0;
    this._fetchInFlight = false;
    this._refetchQueued = false;
  }

  _setState(state) {
    if (this.diag.state === state) return;
    this.diag.state = state;
    try { this.onStatus({ ...this.diag }); } catch { /* listener errors never break the client */ }
  }

  _touch() {
    this._lastMessageAt = Date.now();
  }

  async fetchSnapshot(reason = 'manual') {
    if (this._fetchInFlight) { this._refetchQueued = true; return null; }
    this._fetchInFlight = true;
    try {
      const res = await fetch('/api/snapshot', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      const text = await res.text();
      const bytes = approxBytes(text);
      const snap = JSON.parse(text);
      if (!snap || !Array.isArray(snap.markers) || !Array.isArray(snap.connections) || !Array.isArray(snap.feed) || typeof snap.meta !== 'object')
        throw new Error('snapshot shape mismatch');
      this.diag.snapshotsReceived++;
      this.diag.refetches += reason === 'update-ping' ? 1 : 0;
      this.diag.lastSnapshotBytes = bytes;
      this.diag.totalBytes += bytes;
      this.diag.lastSnapshotAt = Date.now();
      this._touch();
      try { this.onSnapshot(snap, { bytes, reason }); } catch { /* see above */ }
      return snap;
    } catch (err) {
      this.diag.lastError = String(err?.message || err);
      return null;
    } finally {
      this._fetchInFlight = false;
      if (this._refetchQueued) {
        this._refetchQueued = false;
        queueMicrotask(() => this.fetchSnapshot('update-ping'));
      }
    }
  }

  start() {
    if (this._closed || this._es) return;
    this._setState('connecting');
    // Seed from REST immediately so the feed is populated on fresh load
    // even before the stream's connect snapshot lands.
    this.fetchSnapshot('initial');
    this._openStream();
    this._watchdog = setInterval(() => {
      if (this._closed || !this._es) return;
      if (this._lastMessageAt && Date.now() - this._lastMessageAt > SILENCE_LIMIT_MS) {
        this.diag.lastError = 'stream silent >40s (heartbeat lost)';
        this._dropStream();
      }
    }, WATCHDOG_MS);
  }

  _openStream() {
    if (this._closed) return;
    let es;
    try {
      es = new EventSource('/api/stream');
    } catch (err) {
      this.diag.lastError = String(err?.message || err);
      this._scheduleRetry();
      return;
    }
    this._es = es;
    es.addEventListener('open', () => this._touch());
    es.addEventListener('snapshot', (ev) => {
      this._touch();
      this.diag.attempt = 0;
      this.diag.disconnectedAt = null;
      this._setState('live');
      try {
        const snap = JSON.parse(ev.data);
        const bytes = approxBytes(ev.data);
        this.diag.snapshotsReceived++;
        this.diag.lastSnapshotBytes = bytes;
        this.diag.totalBytes += bytes;
        this.diag.lastSnapshotAt = Date.now();
        this.onSnapshot(snap, { bytes, reason: 'stream-snapshot' });
      } catch { /* malformed payload: ignore, REST seed covers us */ }
    });
    es.addEventListener('update', (ev) => {
      this._touch();
      this.diag.updatesReceived++;
      try { this.diag.lastPing = JSON.parse(ev.data); } catch { this.diag.lastPing = null; }
      // A ping means "a sweep finished" — refetch the snapshot (coalesced).
      this.fetchSnapshot('update-ping');
    });
    es.onerror = () => this._dropStream();
  }

  _dropStream() {
    if (this._es) {
      try { this._es.close(); } catch { /* noop */ }
      this._es = null;
    }
    if (this._closed) return;
    if (!this.diag.disconnectedAt) this.diag.disconnectedAt = Date.now();
    this._setState(this.diag.attempt >= 3 ? 'down' : 'reconnecting');
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._closed || this._retryTimer) return;
    const wait = BACKOFFS_MS[Math.min(this.diag.attempt, BACKOFFS_MS.length - 1)];
    this.diag.attempt++;
    try { this.onStatus({ ...this.diag }); } catch { /* noop */ }
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      // On reconnect the server sends a fresh snapshot; also refetch via
      // REST so a half-open stream cannot leave us stale silently.
      this.fetchSnapshot('reconnect');
      this._openStream();
    }, wait);
  }

  /** E5 visibility rule: surface reconnect only after >5 s or attempt ≥3. */
  reconnectVisible(now = Date.now()) {
    if (this.diag.state !== 'reconnecting' && this.diag.state !== 'down') return false;
    if (this.diag.attempt >= 3) return true;
    return this.diag.disconnectedAt ? now - this.diag.disconnectedAt > 5000 : false;
  }

  close() {
    this._closed = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._watchdog);
    if (this._es) { try { this._es.close(); } catch { /* noop */ } this._es = null; }
    this._setState('idle');
  }
}
