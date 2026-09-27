// GPS interference detection via ADS-B NAC-P (Navigation Accuracy Category)
// analysis. Lower NAC-P = worse position accuracy = possible GPS jamming or
// spoofing. Aircraft are aggregated into 1° grid cells over known hotspot
// regions; cells with a significant share of degraded aircraft are emitted
// as events. Keyless via the adsb.lol community API (OpenSky now requires
// OAuth, so it is no longer usable keyless).
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

const GRID_SIZE = 1.0; // degrees
const NAC_P_DEGRADED = 4; // NAC-P <= 4 = degraded accuracy
const NAC_P_CRITICAL = 2; // NAC-P <= 2 = severely degraded
const MIN_AIRCRAFT = 5; // need at least this many aircraft in a cell
const PCT_THRESHOLD = 20; // flag cells with 20%+ degraded aircraft
const MIN_DEGRADED = 3; // ...and at least this many degraded aircraft

// Hotspot regions: center + radius (nautical miles) covering the area.
const HOTSPOTS = [
  { lat: 49.5, lon: 36.5, r: 220, label: 'Eastern Ukraine' },
  { lat: 43.0, lon: 32.0, r: 220, label: 'Black Sea' },
  { lat: 56.5, lon: 19.5, r: 220, label: 'Baltic Sea' },
  { lat: 34.0, lon: 30.5, r: 220, label: 'Eastern Mediterranean' },
  { lat: 37.0, lon: 127.5, r: 200, label: 'Korean Peninsula' },
  { lat: 23.5, lon: 119.5, r: 200, label: 'Taiwan Strait' },
  { lat: 14.0, lon: 113.5, r: 250, label: 'South China Sea' },
  { lat: 27.5, lon: 50.0, r: 200, label: 'Persian Gulf' },
];

async function fetchJson(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(url, { headers: { 'User-Agent': UA }, }), t__dl]);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

function gridKey(lat, lon) {
  return `${Math.floor(lat / GRID_SIZE) * GRID_SIZE},${Math.floor(lon / GRID_SIZE) * GRID_SIZE}`;
}

async function checkHotspot(h) {
  const data = await fetchJson(
    `https://api.adsb.lol/v2/point/${h.lat}/${h.lon}/${h.r}`
  );
  const ac = data && Array.isArray(data.ac) ? data.ac : [];
  const grid = {};
  for (const a of ac) {
    const lat = a.lat;
    const lon = a.lon;
    const nacP = a.nac_p;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(nacP)) continue;
    const k = gridKey(lat, lon);
    if (!grid[k]) grid[k] = { total: 0, degraded: 0, critical: 0 };
    grid[k].total++;
    if (nacP <= NAC_P_DEGRADED) grid[k].degraded++;
    if (nacP <= NAC_P_CRITICAL) grid[k].critical++;
  }
  const zones = [];
  for (const [k, c] of Object.entries(grid)) {
    const pct = c.total > 0 ? Math.round((c.degraded / c.total) * 100) : 0;
    if (c.total >= MIN_AIRCRAFT && c.degraded >= MIN_DEGRADED && pct >= PCT_THRESHOLD) {
      const [gla, glo] = k.split(',').map(Number);
      zones.push({
        lat: gla + GRID_SIZE / 2,
        lon: glo + GRID_SIZE / 2,
        total: c.total,
        degraded: c.degraded,
        pct,
        severity: c.critical >= 3 ? 'high' : c.degraded >= 6 ? 'moderate' : 'low',
        region: h.label,
      });
    }
  }
  return zones.sort((a, b) => b.pct - a.pct);
}

module.exports = {
  name: 'gps_jamming',
  description: 'GPS interference zones detected from ADS-B position accuracy degradation',
  async fetch() {
    try {
      const results = await Promise.allSettled(HOTSPOTS.map(checkHotspot));
      const zones = results
        .filter((r) => r.status === 'fulfilled')
        .flatMap((r) => r.value)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 12);
      const day = new Date().toISOString().slice(0, 10);
      const now = new Date().toISOString();
      return zones.map((z) => ({
        id: `gpsjam-${day}-${z.lat.toFixed(1)}-${z.lon.toFixed(1)}`,
        title: `Possible GPS interference — ${z.region}`,
        summary: `${z.pct}% of ${z.total} aircraft near ${z.lat.toFixed(1)}, ${z.lon.toFixed(1)} show degraded GPS accuracy (NAC-P ≤ ${NAC_P_DEGRADED}), a signature of jamming or spoofing.`,
        lat: z.lat,
        lon: z.lon,
        region: z.region,
        time: now,
        severity: z.severity,
        url: 'https://adsb.lol/',
        attribution: 'adsb.lol / ADS-B',
      }));
    } catch {
      return [];
    }
  },
};
