// Central Intelligence — normalized event schema.
// Every source adapter maps its raw feed into this shape. Nothing else
// enters the state store.
const SEVERITIES = ['low', 'moderate', 'high', 'critical'];
const DOMAINS = [
  'conflict',
  'cyber',
  'economic',
  'health',
  'environment',
  'space',
  'sanctions',
  'disasters',
  'signals',
  'social',
];

/**
 * Coerce a raw adapter record into the canonical event shape:
 * { id, source, domain, title, summary, lat, lon, region,
 *   time, severity, url, attribution }
 * Missing optional fields become null; invalid records return null.
 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, source, domain, title } = raw;
  if (!id || !source || !title) return null; // hard minimum

  const severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'low';
  const cleanDomain = DOMAINS.includes(domain) ? domain : 'signals';

  const lat = raw.lat == null ? null : Number(raw.lat);
  const lon = raw.lon == null ? null : Number(raw.lon);

  return {
    id: String(id),
    source: String(source),
    domain: cleanDomain,
    title: String(title),
    summary: raw.summary != null ? String(raw.summary) : null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    region: raw.region != null ? String(raw.region) : null,
    time: raw.time || new Date().toISOString(),
    severity,
    url: raw.url != null ? String(raw.url) : null,
    attribution: raw.attribution != null ? String(raw.attribution) : null,
  };
}

module.exports = { SEVERITIES, DOMAINS, normalizeEvent };
