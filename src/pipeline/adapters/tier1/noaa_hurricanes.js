// noaa_hurricanes.js — active tropical cyclones from the NOAA National
// Hurricane Center (keyless JSON): https://www.nhc.noaa.gov/CurrentStorms.json

const NHC_JSON = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const TIMEOUT_MS = 20_000;

const STORM_CLASS = {
  TY: 'Typhoon', HU: 'Hurricane', TS: 'Tropical Storm', TD: 'Tropical Depression',
  EX: 'Extratropical', SD: 'Subtropical Depression', SS: 'Subtropical Storm',
  LO: 'Low', WV: 'Tropical Wave', DB: 'Disturbance',
};

const BASIN_LABELS = {
  AL: 'Atlantic', EP: 'Eastern Pacific', CP: 'Central Pacific', WP: 'Western Pacific',
};

function windCategory(kt) {
  // NHC publishes sustained winds in knots
  if (kt == null || Number.isNaN(kt)) return 'Unknown';
  if (kt >= 137) return 'Cat 5';
  if (kt >= 113) return 'Cat 4';
  if (kt >= 96) return 'Cat 3';
  if (kt >= 84) return 'Cat 2';
  if (kt >= 65) return 'Cat 1';
  return 'Tropical Storm';
}

function basinFromId(id) {
  const m = /^([a-z]{2})/i.exec(id || '');
  return m ? (BASIN_LABELS[m[1].toUpperCase()] || null) : null;
}

function severityFor(category) {
  if (['Cat 4', 'Cat 5'].includes(category)) return 'critical';
  if (category === 'Cat 3') return 'high';
  return 'moderate';
}

function mapStorm(s) {
  const classCode = s.classification || 'TS';
  const classLabel = STORM_CLASS[classCode] || classCode;
  const kt = parseInt(s.intensity, 10);
  const wind = Number.isNaN(kt) ? null : kt;
  const category = windCategory(wind);
  const basin = basinFromId(s.id);
  const lat = typeof s.latitudeNumeric === 'number' ? s.latitudeNumeric : null;
  const lon = typeof s.longitudeNumeric === 'number' ? s.longitudeNumeric : null;
  const motion = typeof s.movementDir === 'number'
    ? ` moving ${s.movementDir}°${s.movementSpeed != null ? ` at ${s.movementSpeed} mph` : ''}`
    : '';
  return {
    id: `nhc_${s.id}`,
    title: `${classLabel} ${s.name} — ${basin || 'unknown basin'} (${category})`,
    summary: wind != null
      ? `${classLabel} ${s.name}, ${category} with ${wind} kt sustained winds${motion}.`
      : `${classLabel} ${s.name} active in the ${basin || 'basin'}.`,
    lat,
    lon,
    region: basin,
    time: s.lastUpdate || new Date().toISOString(),
    severity: severityFor(category),
    url: (s.publicAdvisory && s.publicAdvisory.url) || `https://www.nhc.noaa.gov/#${s.name}`,
    attribution: 'NOAA NHC',
  };
}

module.exports = {
  name: 'noaa_hurricanes',
  description: 'NOAA National Hurricane Center active tropical cyclones',
  async fetch() {
    let timer__t;
    const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
    timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
    try {
      const r = await Promise.race([fetch(NHC_JSON, {
        headers: { 'User-Agent': 'Central-Intelligence/1.0', Accept: 'application/json' },
      }), timer__dl]);
      clearTimeout(timer__t);
      if (!r.ok) return [];
      const raw = await r.json();
      const storms = Array.isArray(raw) ? raw : (raw && (raw.activeStorms || raw.storms)) || [];
      return storms
        .filter(s => s && s.name && s.id)
        .map(mapStorm);
    } catch {
      clearTimeout(timer__t);
      return [];
    }
  },
};
