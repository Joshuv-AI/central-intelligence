/* Lane G — intel store: snapshot state + UI state, tiny pub/sub.
   Also owns the shared runtime handle (Cesium viewer, set by the layer)
   that the DOM surfaces use for fly-to, plus the test/gate handle
   `window.__ciIntel`. */
import { dedupeFeed } from './model.js';
import { normalizeSeverityFloor } from './model.js';

const listeners = new Map();
export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}
export function emit(topic, payload) {
  const set = listeners.get(topic);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(payload); } catch (err) { console.error('[intel] listener failed:', err); }
  }
}

export const store = {
  markers: [],
  connections: [],
  feed: [], // deduped, threshold-gated view of the raw feed
  rawFeedCount: 0,
  meta: null,
  lastSnapshotAt: null,
  lastSnapshotBytes: 0,
  region: 'world',
  selectedEventId: null,
  selectedConnectionId: null,
  clientDiag: null,
  severityFloor: 'all', // J4-15: 'all' | 'notable' | 'high' — global dial, share-link encoded

  setSnapshot(snap, { bytes = 0 } = {}) {
    this.markers = Array.isArray(snap.markers) ? snap.markers : [];
    this.connections = Array.isArray(snap.connections) ? snap.connections : [];
    this.rawFeedCount = Array.isArray(snap.feed) ? snap.feed.length : 0;
    this.feed = dedupeFeed(snap.feed);
    this.meta = snap.meta || null;
    this.lastSnapshotAt = Date.now();
    this.lastSnapshotBytes = bytes;
    emit('data');
  },
  setClientDiag(diag) {
    this.clientDiag = diag;
    emit('status');
  },
  eventById(id) { return this.markers.find((e) => e.id === id) || null; },
  connectionById(id) { return this.connections.find((c) => c.id === id) || null; },
  connectionsForEvent(eventId) {
    return this.connections.filter((c) => Array.isArray(c.eventIds) && c.eventIds.includes(eventId));
  },
  setRegion(id) {
    this.region = id;
    emit('region');
    emit('data');
  },
  /** J4-15: severity floor dial. Normalized; emits so feed/connections/layer re-filter. */
  setSeverityFloor(id) {
    const next = normalizeSeverityFloor(id);
    if (this.severityFloor === next) return;
    this.severityFloor = next;
    emit('severityFloor');
    emit('data');
  },
  selectEvent(id) {
    this.selectedEventId = id;
    this.selectedConnectionId = null;
    emit('selection');
  },
  selectConnection(id) {
    this.selectedConnectionId = id;
    this.selectedEventId = null;
    emit('selection');
  },
  clearSelection() {
    this.selectedEventId = null;
    this.selectedConnectionId = null;
    emit('selection');
  },
};

/** Shared runtime: the Cesium viewer + layer API, set by layer.js. */
export const runtime = {
  viewer: null,
  layer: null,
  flyToEvent: null, // (event) => void, installed by layer
  flyToConnection: null, // (conn) => void
  flyToRegion: null, // (region) => void
};
