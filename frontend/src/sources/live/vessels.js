import { coordinates, epoch, finite, LiveSourceError } from './contract.js';

/** AIS positions are sea-surface observations; heading and course are distinct. */
export function normalizeVesselObservation(row, reference = null) {
  const id = String(row?.mmsi || row?.input_identifier || '').trim();
  const latitude = finite(row?.lat),
    longitude = finite(row?.lon);
  if (!id || !coordinates(latitude, longitude)) return null;
  const speedKts = finite(row.speed);
  return {
    id,
    reference: reference ?? id,
    latitude,
    longitude,
    name: String(row.name || row.input_name || id),
    imo: String(row.imo || ''),
    type: String(row.type_specific || row.type || ''),
    destination: String(row.destination || ''),
    speedMps: speedKts == null ? null : speedKts * 0.514444,
    courseDeg: finite(row.course),
    headingDeg: finite(row.heading),
    observedAtMs:
      epoch(row.last_position_epoch, 1000) ??
      epoch(Date.parse(row.last_position_UTC)),
    altitudeDatum: 'sea-surface',
  };
}

export function vesselSnapshot(
  payload,
  {
    source = 'AISStream',
    coverage = 'received AIS positions',
    referenceFor = (row) => String(row.mmsi || row.input_identifier || ''),
  } = {},
) {
  if (!Array.isArray(payload?.rows))
    throw new LiveSourceError('malformed', 'Malformed vessel response');
  const rows = payload.rows;
  const records = [],
    ids = new Set();
  for (const row of rows) {
    const record = normalizeVesselObservation(row);
    if (record) record.reference = referenceFor(row);
    if (record && !ids.has(record.id)) {
      records.push(record);
      ids.add(record.id);
    }
  }
  const observedAtMs =
    epoch(payload?.newestPositionAt) ??
    epoch(Date.parse(payload?.newestPositionAt)) ??
    records.reduce(
      (newest, row) => Math.max(newest || 0, row.observedAtMs || 0) || null,
      null,
    );
  return {
    records,
    source,
    coverage,
    complete: records.length === rows.length && !payload?.refreshing,
    rejectedCount: rows.length - records.length,
    observedAtMs,
    freshness: payload?.refreshing
      ? 'stale'
      : observedAtMs == null
        ? 'unknown'
        : 'current',
    stale: Boolean(payload?.refreshing),
    // Connection state is distinct from receipt of a usable position.
    transportStatus:
      typeof payload?.status === 'string' ? payload.status : null,
    lastMessageAt: payload?.lastMessageAt ?? null,
    nextAttemptAt: finite(payload?.nextAttemptAt),
    silentForMs: finite(payload?.silentForMs),
    reconnectAttempt: finite(payload?.reconnectAttempt),
    rawRowCount: rows.length,
  };
}

/**
 * Normalize one CI AIS-hub vessel record (server-owned AISStream hub):
 * `{mmsi, name, lat, lon, sog (kt), cog, heading, type, navStatus, at}`.
 * Output matches the observation shape the vessels layer consumes.
 */
export function normalizeHubVessel(row) {
  const id = String(row?.mmsi || '').trim();
  const latitude = finite(row?.lat),
    longitude = finite(row?.lon);
  if (!id || !coordinates(latitude, longitude)) return null;
  const speedKts = finite(row?.sog);
  return {
    id,
    reference: id,
    latitude,
    longitude,
    name: String(row?.name || id),
    imo: '',
    type: row?.type != null ? String(row.type) : '',
    destination: '',
    speedMps: speedKts == null ? null : speedKts * 0.514444,
    courseDeg: finite(row?.cog),
    headingDeg: finite(row?.heading),
    observedAtMs: epoch(row?.at) ?? null,
    altitudeDatum: 'sea-surface',
  };
}

/**
 * Snapshot over a hub vessel array + hub status. The hub state is carried
 * through verbatim as `transportStatus` — `no_key` is a first-class honest
 * state (no AIS key provisioned), never an empty-but-"live" fleet.
 */
export function hubVesselSnapshot(
  vessels,
  { status = null, source = 'AISStream', now = Date.now() } = {},
) {
  const rows = Array.isArray(vessels) ? vessels : [];
  const records = [],
    ids = new Set();
  for (const row of rows) {
    const record = normalizeHubVessel(row);
    if (record && !ids.has(record.id)) {
      records.push(record);
      ids.add(record.id);
    }
  }
  const observedAtMs =
    records.reduce(
      (newest, row) => Math.max(newest || 0, row.observedAtMs || 0) || null,
      null,
    ) ?? null;
  // Map CI hub states onto the vocabulary the vessels layer classifies:
  // ok→live, no_key→missing-key, auth_failed→auth-failed (hub: D2-11).
  const hubStatus = typeof status === 'string' ? status : null;
  const transportStatus =
    hubStatus === 'ok'
      ? 'live'
      : hubStatus === 'no_key'
        ? 'missing-key'
        : hubStatus === 'auth_failed'
          ? 'auth-failed'
          : hubStatus;
  return {
    records,
    source,
    coverage: 'received AIS positions',
    complete: records.length === rows.length,
    rejectedCount: rows.length - records.length,
    observedAtMs,
    freshness:
      transportStatus && transportStatus !== 'live'
        ? 'unknown'
        : observedAtMs == null
          ? 'unknown'
          : 'current',
    stale: false,
    transportStatus,
    hubStatus,
    lastMessageAt: transportStatus === 'live' ? (observedAtMs ?? now) : null,
    nextAttemptAt: null,
    silentForMs: null,
    reconnectAttempt: null,
    rawRowCount: rows.length,
  };
}

export function normalizeVesselTrack(samples) {
  if (!Array.isArray(samples)) return [];
  return samples.flatMap((sample) => {
    const latitude = finite(sample?.lat),
      longitude = finite(sample?.lon);
    if (!coordinates(latitude, longitude)) return [];
    return [
      {
        latitude,
        longitude,
        observedAtMs: epoch(sample?.t, 1000),
        altitudeDatum: 'sea-surface',
      },
    ];
  });
}
