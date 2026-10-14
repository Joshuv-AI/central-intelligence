import { ERROR_BACKOFF_INTERVAL } from './recordPolicy.js';
import {
  MILITARY_GATE_MAX_HEIGHT_M,
  MILITARY_GATE_MESSAGE,
  cameraHeightM,
  gateOpen,
} from '../../sources/live/gate.js';

/** Own military source acquisition, cancellation, freshness and error backoff. */
export function createIngestion({
  feed,
  applySnapshot,
  setSourceLabel,
  applyPendingTrackingRestore,
  getCameraHeightM = null,
}) {
  const methods = {
    async update(viewer, { signal = null } = {}) {
      // §L gate (ARCH §7): military traffic renders only at camera
      // heights ≤4,000 km (B2 and below). While gated there is NO fetch.
      const heightM =
        (typeof getCameraHeightM === 'function' ? getCameraHeightM() : null) ??
        cameraHeightM(viewer);
      if (!gateOpen(heightM, MILITARY_GATE_MAX_HEIGHT_M)) {
        feed._gated = true;
        feed._lastError = MILITARY_GATE_MESSAGE;
        feed._backoff = false;
        feed._retryAt = 0;
        return;
      }
      if (feed._gated) {
        feed._gated = false;
        feed._lastError = null;
      }
      const nowMs = Date.now();
      const trackingRefreshEpoch = ++feed._trackingRefreshEpoch;
      feed._lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'source-unavailable',
        ids: new Set(),
        source: feed._lastSource,
      };
      if (feed._retryAt && nowMs < feed._retryAt) {
        feed._backoff = true;
        return;
      }

      const resourceController = new AbortController();
      feed._activeUpdateControllers.add(resourceController);
      const updateSignal = signal
        ? AbortSignal.any([signal, resourceController.signal])
        : resourceController.signal;
      try {
        updateSignal.throwIfAborted();
        const snapshot = await feed._source.getSnapshot(
          {},
          { signal: updateSignal },
        );
        updateSignal.throwIfAborted();
        feed._lastStatus = snapshot.status ?? 200;
        feed._lastSource = snapshot.source;
        setSourceLabel(feed._lastSource);
        feed._backoff = snapshot.stale || snapshot.freshness === 'unknown';
        feed._retryAt = 0;
        feed._lastError =
          snapshot.reason ||
          (snapshot.freshness === 'unknown'
            ? 'Source snapshot time unavailable'
            : null);
        const accepted = applySnapshot(snapshot, viewer);
        feed._count = accepted.count;
        feed._lastUpdate = snapshot.observedAtMs;
        feed._lastTrackingRefreshOutcome = {
          epoch: trackingRefreshEpoch,
          status: 'accepted',
          ids: accepted.ids,
          source: feed._lastSource,
        };
        console.log(`[Data:Military] Updated: ${feed._count} aircraft`);
        applyPendingTrackingRestore();
      } catch (e) {
        if (updateSignal.aborted || e?.name === 'AbortError') {
          throw new DOMException('Military update aborted', 'AbortError');
        }
        console.warn('[Data:Military] Fetch error:', e);
        feed._backoff = true;
        feed._retryAt =
          Date.now() + (e?.retryAfterMs ?? ERROR_BACKOFF_INTERVAL);
        feed._lastStatus = e?.status ?? null;
        if (e?.source) {
          feed._lastSource = e.source;
          setSourceLabel(feed._lastSource);
        }
        feed._lastError =
          e?.name === 'LiveSourceError' ? e.message : 'Live data unavailable';
      } finally {
        feed._activeUpdateControllers.delete(resourceController);
      }
    },
  };

  return { methods };
}

/** Construct an independent military source lifetime and status. */
export function createMilitaryFeed(source) {
  const feed = {};
  feed._source = source;
  feed._count = 0;
  feed._lastUpdate = null;
  feed._backoff = false;
  feed._retryAt = 0;
  feed._lastError = null;
  feed._activeUpdateControllers = new Set();
  feed._lastStatus = null;
  feed._lastSource = source?.label || 'Aircraft';
  feed._gated = false;
  feed._trackingRefreshEpoch = 0;
  feed._lastTrackingRefreshOutcome = {
    epoch: 0,
    status: 'unavailable',
    ids: new Set(),
    source: feed._lastSource,
  };
  return feed;
}
