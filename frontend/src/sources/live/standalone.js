import { httpError, readResponse } from './contract.js';
import { normalizeAdapterTrack, adapterSnapshot } from './aircraft.js';
import { hubVesselSnapshot } from './vessels.js';

const defaultFetch = (...args) => globalThis.fetch(...args);
const header = (response, name) => response.headers?.get?.(name);

function flightError(response) {
  const error = httpError(response, 'Flights');
  if (response.status === 429) error.message = 'Flights rate limited';
  if (response.status === 401 || response.status === 403)
    error.message = 'Flights auth failed';
  return error;
}

/**
 * The provider a feed response names in `X-Feed-Source`, so a server that
 * answers a feed route from another provider is reported as that provider.
 */
function feedSource(response, fallback) {
  const named = header(response, 'x-feed-source');
  return typeof named === 'string' && named.trim()
    ? named.trim().slice(0, 80)
    : fallback;
}

/**
 * Civil flights feed — Lane A adapter route `GET /api/flights?lat&lon&dist`
 * (ARCH §4.2 #2, viewport model D2-12). The query carries the camera
 * position plus a height-derived radius (nautical miles, adapter cap 250).
 * No request starts during construction; the layer's §L gate decides when
 * this is called at all (no fetching while gated).
 */
export function createFlightSource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'Flights',
    async getSnapshot(query = {}, { signal } = {}) {
      const params = new URLSearchParams();
      if (Number.isFinite(query.latitude) && Number.isFinite(query.longitude)) {
        params.set('lat', query.latitude.toFixed(4));
        params.set('lon', query.longitude.toFixed(4));
      }
      if (Number.isFinite(query.dist)) params.set('dist', String(query.dist));
      const { response, payload } = await readResponse(
        fetchImpl,
        `/api/flights${params.size ? '?' + params : ''}`,
        { signal },
        'Flights',
      );
      if (!response.ok) throw flightError(response);
      return {
        ...adapterSnapshot(payload, {
          source: feedSource(response, 'adsb.lol'),
          coverage: 'aircraft in the visible region',
          now: now(),
        }),
        status: response.status,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/flights/track?icao24=' + encodeURIComponent(reference),
        { signal },
        'Flights',
      );
      if (!response.ok) throw httpError(response, 'Flights');
      return {
        records: normalizeAdapterTrack(payload),
        complete: payload?.complete === true,
      };
    },
  };
}

/**
 * Military flights feed — adapter route `GET /api/flights/mil` (ARCH §4.2
 * #3, global set). Track history rides the same adapter track route as
 * civil flights; there is no separate military track endpoint.
 */
export function createMilitarySource({
  fetchImpl = defaultFetch,
  now = () => Date.now(),
} = {}) {
  async function fetchMil(signal) {
    const { response, payload } = await readResponse(
      fetchImpl,
      '/api/flights/mil',
      { signal },
      'Military aircraft',
    );
    if (!response.ok) throw httpError(response, 'Military aircraft');
    return { response, payload };
  }
  return {
    label: 'Military aircraft',
    async getIdentities(_query = {}, { signal } = {}) {
      const { payload } = await fetchMil(signal);
      return (Array.isArray(payload?.aircraft) ? payload.aircraft : [])
        .map((row) => String(row?.icao24 || '').toLowerCase())
        .filter(Boolean);
    },
    async getSnapshot(_query = {}, { signal } = {}) {
      const { response, payload } = await fetchMil(signal);
      return {
        ...adapterSnapshot(payload, {
          source: feedSource(response, 'adsb.lol'),
          coverage: 'military aircraft, worldwide',
          now: now(),
        }),
        status: response.status,
      };
    },
    async getTrack(reference, { signal } = {}) {
      const { response, payload } = await readResponse(
        fetchImpl,
        '/api/flights/track?icao24=' + encodeURIComponent(reference),
        { signal },
        'Military aircraft',
      );
      if (!response.ok) throw httpError(response, 'Military aircraft');
      return {
        records: normalizeAdapterTrack(payload),
        complete: payload?.complete === true,
      };
    },
  };
}

/**
 * Vessels feed — CI AIS hub over SSE is the live path (ARCH §4.1/§4.2 #5,
 * D2-11). `getSnapshot` opens (or reuses) the `/api/vessels/stream`
 * EventSource, resolves with the hub's current snapshot + status, and
 * keeps the stream warm so later polls return fresh batches; the layer's
 * own poll cadence drives updates. With no AIS key provisioned the hub
 * reports `no_key` and the snapshot carries that state plainly — no
 * vessels are ever fabricated. `/api/vessels` (poll shim) is used only
 * where EventSource is unavailable. There is NO server track endpoint:
 * `getTrack` returns an empty history and trails accumulate client-side.
 */
export function createVesselSource({
  fetchImpl = defaultFetch,
  apiUrl = '/api/vessels',
  origin = () => globalThis.location?.origin || 'http://localhost',
  eventSourceImpl = (...args) => new globalThis.EventSource(...args),
} = {}) {
  let stream = null; // { es, vessels, status, waiters:Set, closed }
  function ensureStream() {
    if (stream && !stream.closed) return stream;
    if (typeof globalThis.EventSource !== 'function') return null;
    let es;
    try {
      es = eventSourceImpl('/api/vessels/stream');
    } catch {
      return null;
    }
    const state = {
      es,
      vessels: [],
      status: null,
      waiters: new Set(),
      closed: false,
      gotFirst: false,
    };
    const settle = () => {
      if (state.gotFirst) return;
      state.gotFirst = true;
      for (const resolve of state.waiters) resolve();
      state.waiters.clear();
    };
    es.addEventListener('status', (event) => {
      try {
        state.status = JSON.parse(event.data)?.state ?? state.status;
      } catch { /* keep prior status */ }
      settle();
    });
    es.addEventListener('vessels', (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (Array.isArray(parsed)) state.vessels = parsed;
      } catch { /* malformed batch ignored, prior snapshot kept */ }
      settle();
    });
    es.onerror = () => {
      // EventSource retries on its own; a dead stream still settles waiters
      // with whatever state we hold so the layer can show its honest state.
      settle();
    };
    stream = state;
    return state;
  }
  return {
    label: 'Vessels',
    async getSnapshot(_query = {}, { signal } = {}) {
      const state = ensureStream();
      if (!state) {
        // Fallback: adapter poll shim over the hub's in-memory snapshot.
        const url = new URL(apiUrl, origin());
        const { response, payload } = await readResponse(
          fetchImpl,
          url.toString(),
          { signal, cache: 'no-store' },
          'Vessels',
        );
        if (!response.ok) throw httpError(response, 'Vessels');
        return {
          ...hubVesselSnapshot(payload?.vessels, {
            status: payload?.status ?? null,
          }),
          status: response.status,
        };
      }
      if (!state.gotFirst) {
        await new Promise((resolve) => {
          if (state.gotFirst) return resolve();
          state.waiters.add(resolve);
          const timer = setTimeout(resolve, 4000);
          state.waiters.add(() => clearTimeout(timer));
          signal?.addEventListener?.(
            'abort',
            () => { clearTimeout(timer); resolve(); },
            { once: true },
          );
        });
      }
      if (signal?.aborted)
        throw new DOMException('Vessels update aborted', 'AbortError');
      return {
        ...hubVesselSnapshot(state.vessels, { status: state.status }),
        status: 200,
      };
    },
    async getTrack(_reference, { signal } = {}) {
      signal?.throwIfAborted();
      // D2-11: the hub keeps no history — no /api/vessels/track exists.
      // The layer accumulates the selected vessel's trail client-side from
      // live fixes; an empty backfill is the honest answer.
      return { records: [], complete: false };
    },
    /** Close the SSE stream (layer teardown / tests). */
    close() {
      if (stream && !stream.closed) {
        stream.closed = true;
        try { stream.es.close(); } catch { /* already closed */ }
      }
      stream = null;
    },
  };
}
