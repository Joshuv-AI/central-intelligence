/**
 * J4-09 · Timestamped data export — pure payload builders, no DOM.
 *
 * The timestamp is BURNED INTO the content (J4-09's §I.5 counter): a stale
 * export presented as current is the classic failure, so the header states
 * exactly when it was exported and how old the underlying data was.
 * Server-rendered image export is NOT built (rejected in evaluation — the
 * e2-micro budget); the share link remains the shareable artifact.
 */
export function buildExportPayload({
  exportedAt = new Date().toISOString(),
  camera = null, // { lat, lon, heightKm }
  layerHash = '',
  events = [],
  maxEvents = 200,
} = {}) {
  const rows = (Array.isArray(events) ? events : []).slice(0, maxEvents);
  const dataTimes = rows
    .map((e) => Date.parse(e.time))
    .filter((t) => Number.isFinite(t));
  const dataAsOf =
    dataTimes.length > 0
      ? new Date(Math.max(...dataTimes)).toISOString()
      : null;
  const staleNote = dataAsOf
    ? `Data as of ${dataAsOf} (${Math.max(0, Math.round((Date.parse(exportedAt) - Date.parse(dataAsOf)) / 60000))} min before export)`
    : 'No event timestamps available — data age unknown';
  return {
    exportedAt,
    dataAsOf,
    staleNote,
    camera,
    layers: layerHash || '(no layer state in URL)',
    eventCount: rows.length,
    events: rows.map((e) => ({
      id: e.id,
      title: e.title,
      severity: e.severity,
      time: e.time,
      region: e.region,
      source: e.source,
      lat: e.lat,
      lon: e.lon,
      url: e.url,
    })),
  };
}

export function exportFileName(exportedAt, ext) {
  const stamp = String(exportedAt || new Date().toISOString())
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  return `central-intelligence-export-${stamp}.${ext}`;
}

export function renderExportJson(payload) {
  return JSON.stringify(
    {
      exported_at: payload.exportedAt,
      data_as_of: payload.dataAsOf,
      data_age_note: payload.staleNote,
      camera: payload.camera,
      layers: payload.layers,
      event_count: payload.eventCount,
      events: payload.events,
    },
    null,
    2,
  );
}

export function renderExportTxt(payload) {
  const lines = [
    'CENTRAL INTELLIGENCE — DATA EXPORT',
    `Exported: ${payload.exportedAt}`,
    payload.staleNote,
    payload.camera
      ? `Camera: ${payload.camera.lat.toFixed(2)}°, ${payload.camera.lon.toFixed(2)}° @ ${payload.camera.heightKm.toFixed(0)} km`
      : 'Camera: unknown',
    `Layers: ${payload.layers}`,
    `Events: ${payload.eventCount}`,
    '',
  ];
  for (const e of payload.events) {
    lines.push(
      `- [${String(e.severity || 'low').toUpperCase()}] ${e.title || e.id} (${e.time || 'time unknown'}, ${e.source || 'unknown source'})`,
    );
  }
  lines.push('', '— end of export —');
  return lines.join('\n');
}

/** DOM side effect kept tiny and separate from the pure builders. */
export function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
