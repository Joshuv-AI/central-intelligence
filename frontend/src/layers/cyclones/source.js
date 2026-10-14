import { readResponseJsonCapped } from '../../sources/httpBody.js';

export const CYCLONE_RESPONSE_LIMIT = 4 * 1024 * 1024;
const malformed = () => new Error('Malformed cyclone snapshot');
const text = (value, max = 160) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f<>]/.test(value)
  )
    throw malformed();
  return value;
};
const number = (value, low, high) => {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < low || value > high) throw malformed();
  return value;
};
const time = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw malformed();
  return value;
};
const advisory = (value) => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})[A-Z]?$/.test(value))
    throw malformed();
  return value;
};
const position = (value) => {
  if (!value || value.longitude === null || value.latitude === null)
    throw malformed();
  return {
    longitude: number(value.longitude, -180, 180),
    latitude: number(value.latitude, -90, 90),
  };
};

function officialLink(value, outlook = false) {
  if (value === null) return null;
  const url = new URL(text(value, 256));
  if (
    url.origin !== 'https://www.nhc.noaa.gov' ||
    url.username ||
    url.password ||
    url.hash
  )
    throw malformed();
  if (
    outlook
      ? !/^\/gtwo\.php\?basin=(?:atlc|epac|cpac)&fdays=7$/.test(
          url.pathname + url.search,
        )
      : url.search || !/^\/text\/[A-Z0-9]+\.shtml$/.test(url.pathname)
  )
    throw malformed();
  return url.href;
}

function geometry(value, kind, budget) {
  if (value === null) return null;
  const allowed =
    kind === 'track'
      ? ['LineString', 'MultiLineString']
      : ['Polygon', 'MultiPolygon'];
  if (!allowed.includes(value?.type)) throw malformed();
  const point = (pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((v) => typeof v !== 'number')
    )
      throw malformed();
    position({ longitude: pair[0], latitude: pair[1] });
    if (++budget.coordinates > 25_000) throw malformed();
    return [...pair];
  };
  const list = (items, read, min = 1, max = 128) => {
    if (!Array.isArray(items) || items.length < min || items.length > max)
      throw malformed();
    return items.map(read);
  };
  const line = (pairs) => list(pairs, point, 2, 10_000);
  const ring = (pairs) => {
    const result = list(pairs, point, 4, 10_000);
    if (result[0][0] !== result.at(-1)[0] || result[0][1] !== result.at(-1)[1])
      throw malformed();
    return result;
  };
  const polygon = (rings) => list(rings, ring);
  const coordinates =
    value.type === 'LineString'
      ? line(value.coordinates)
      : value.type === 'MultiLineString'
        ? list(value.coordinates, line)
        : value.type === 'Polygon'
          ? polygon(value.coordinates)
          : list(value.coordinates, polygon);
  return { type: value.type, coordinates };
}

/** Project only the bounded status/geometry contract; never ingest GeoJSON properties or URLs. */
export function validateCycloneSnapshot(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.stale !== 'boolean' ||
    typeof value.unavailable !== 'boolean' ||
    !Array.isArray(value.storms) ||
    value.storms.length > 32
  )
    throw malformed();
  const seen = new Set(),
    budget = { coordinates: 0, points: 0 };
  const storms = value.storms.map((raw) => {
    if (
      !/^(?:al|ep|cp)\d{6}$/.test(raw?.id) ||
      seen.has(raw.id) ||
      !['current', 'pending', 'unavailable'].includes(raw.geometryStatus)
    )
      throw malformed();
    seen.add(raw.id);
    const advisoryNumber =
      raw.advisoryNumber === null ? null : advisory(raw.advisoryNumber);
    const geometryAdvisoryNumber =
      raw.geometryAdvisoryNumber === null
        ? null
        : advisory(raw.geometryAdvisoryNumber);
    if (
      raw.geometryStatus === 'current' &&
      geometryAdvisoryNumber !== advisoryNumber
    )
      throw malformed();
    if (
      !Array.isArray(raw.forecastPoints) ||
      (budget.points += raw.forecastPoints.length) > 500
    )
      throw malformed();
    const taus = new Set();
    const forecastPoints = raw.forecastPoints.map((point) => {
      const tauHours = number(point.tauHours, 0, 168);
      if (tauHours === null || taus.has(tauHours)) throw malformed();
      taus.add(tauHours);
      if (++budget.coordinates > 25_000) throw malformed();
      return {
        position: position(point.position),
        tauHours,
        windKt: number(point.windKt, 0, 300),
        gustKt: number(point.gustKt, 0, 350),
      };
    });
    const track = geometry(raw.track, 'track', budget),
      cone = geometry(raw.cone, 'cone', budget);
    if (
      raw.geometryStatus !== 'current' &&
      (track || cone || forecastPoints.length)
    )
      throw malformed();
    if (
      raw.geometryStatus === 'current' &&
      (!track || !cone || !forecastPoints.length)
    )
      throw malformed();
    if (raw.basin !== raw.id.slice(0, 2).toUpperCase()) throw malformed();
    return {
      id: raw.id,
      name: text(raw.name, 80),
      classification: text(raw.classification, 16),
      basin: raw.basin,
      position: position(raw.position),
      positionAt: raw.positionAt === null ? null : time(raw.positionAt),
      advisoryNumber,
      issuedAt: raw.issuedAt === null ? null : time(raw.issuedAt),
      windKt: number(raw.windKt, 0, 300),
      pressureHpa: number(raw.pressureHpa, 800, 1100),
      movement: {
        directionDegrees: number(raw.movement?.directionDegrees, 0, 360),
        speedKt: number(raw.movement?.speedKt, 0, 200),
      },
      advisoryUrl: officialLink(raw.advisoryUrl),
      outlookUrl: officialLink(raw.outlookUrl, true),
      geometryStatus: raw.geometryStatus,
      geometryAdvisoryNumber,
      forecastPoints,
      track,
      cone,
    };
  });
  if (value.unavailable && storms.length) throw malformed();
  return {
    schemaVersion: 1,
    source: text(value.source),
    attribution: text(value.attribution, 240),
    coverage: text(value.coverage, 240),
    fetchedAt: number(value.fetchedAt, 0, Number.MAX_SAFE_INTEGER),
    stale: value.stale,
    unavailable: value.unavailable,
    reason: value.reason === null ? null : text(value.reason, 240),
    storms,
  };
}

/**
 * Translate the CI adapter's `/api/cyclones` shape (Lane A contract:
 * normalized NHC CurrentStorms subset + `{fetchedAt, stale, ttlMs}`, with
 * `{storms: [], note: "no_active_storms"}` as the seasonal empty state)
 * into this layer's internal contract. The adapter carries current
 * position/classification/intensity only — no GIS track/cone and no
 * forecastAdvisory (advNum/issuance/url are dropped upstream, GAP-D1) —
 * so storms honestly arrive as `geometryStatus: 'unavailable'`
 * (position-only, "Track/cone unavailable") with null advisory fields,
 * never with fabricated geometry. The basin outlook link is the canonical
 * NHC URL GEV's own provider constructed per basin.
 */
export function translateCycloneAdapterSnapshot(payload) {
  if (!payload || !Array.isArray(payload.storms) || payload.storms.length > 32)
    throw malformed();
  const isoOrNull = (value) => {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };
  const numOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const outlookByBasin = {
    AL: 'https://www.nhc.noaa.gov/gtwo.php?basin=atlc&fdays=7',
    EP: 'https://www.nhc.noaa.gov/gtwo.php?basin=epac&fdays=7',
    CP: 'https://www.nhc.noaa.gov/gtwo.php?basin=cpac&fdays=7',
  };
  const storms = payload.storms.map((raw) => {
    const basin =
      typeof raw?.id === 'string' ? raw.id.slice(0, 2).toUpperCase() : '';
    return {
      id: raw?.id,
      name: raw?.name,
      classification: raw?.classification,
      basin,
      position: { longitude: raw?.longitude, latitude: raw?.latitude },
      positionAt: isoOrNull(raw?.lastUpdate),
      advisoryNumber: null,
      issuedAt: null,
      windKt: numOrNull(raw?.intensity),
      pressureHpa: numOrNull(raw?.pressure),
      movement: {
        directionDegrees: numOrNull(raw?.movementDir),
        speedKt: numOrNull(raw?.movementSpeed),
      },
      advisoryUrl: null,
      outlookUrl: outlookByBasin[basin] ?? null,
      geometryStatus: 'unavailable',
      geometryAdvisoryNumber: null,
      forecastPoints: [],
      track: null,
      cone: null,
    };
  });
  return validateCycloneSnapshot({
    schemaVersion: 1,
    source: 'NOAA NHC / CPHC',
    attribution:
      'NOAA National Hurricane Center and Central Pacific Hurricane Center (via the Central Intelligence adapter)',
    coverage:
      'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.',
    fetchedAt: numOrNull(payload.fetchedAt),
    stale: Boolean(payload.stale),
    unavailable: false,
    reason: null,
    storms,
  });
}

/** Lazy same-origin acquisition; source owns only its deadline and cancellation. */
export function createCycloneSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Cyclone request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/cyclones', {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          // Adapter/upstream failure is the layer's designed unavailable
          // state (GEV's provider answered failures the same way), never a
          // raw HTTP string in the row.
          return validateCycloneSnapshot({
            schemaVersion: 1,
            source: 'NOAA NHC / CPHC',
            attribution:
              'NOAA National Hurricane Center and Central Pacific Hurricane Center (via the Central Intelligence adapter)',
            coverage:
              'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.',
            fetchedAt: null,
            stale: true,
            unavailable: true,
            reason: 'Cyclone advisories unavailable',
            storms: [],
          });
        }
        const result = await readResponseJsonCapped(
          response,
          CYCLONE_RESPONSE_LIMIT,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return translateCycloneAdapterSnapshot(result);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
