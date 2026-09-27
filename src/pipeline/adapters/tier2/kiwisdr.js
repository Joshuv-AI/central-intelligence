// KiwiSDR — public HF (0-30 MHz) receiver availability from receiverbook.de.
// The page embeds ~700 sites as a JS variable; we flatten it and emit a
// small set of sensor-availability markers: receivers inside regions of
// interest first, then recently-updated receivers elsewhere. Keyless.
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;
const URL = 'https://www.receiverbook.de/map?type=kiwisdr';
const CAP = 15;

const REGIONS = [
  { key: 'ukraine',       label: 'Ukraine / Eastern Europe', lamin: 44, lomin: 22, lamax: 53, lomax: 41 },
  { key: 'middleEast',    label: 'Middle East',              lamin: 12, lomin: 30, lamax: 42, lomax: 65 },
  { key: 'taiwan',        label: 'Taiwan Strait',            lamin: 20, lomin: 115, lamax: 28, lomax: 125 },
  { key: 'baltics',       label: 'Baltic Region',            lamin: 53, lomin: 19, lamax: 60, lomax: 29 },
  { key: 'southChinaSea', label: 'South China Sea',          lamin: 5,  lomin: 105, lamax: 23, lomax: 122 },
  { key: 'koreanPenin',   label: 'Korean Peninsula',         lamin: 33, lomin: 124, lamax: 43, lomax: 132 },
  { key: 'iran',          label: 'Iran',                     lamin: 25, lomin: 44, lamax: 40, lomax: 63 },
  { key: 'sahel',         label: 'Sahel / West Africa',      lamin: 10, lomin: -17, lamax: 20, lomax: 25 },
];

function inBounds(lat, lon, b) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= b.lamin && lat <= b.lamax && lon >= b.lomin && lon <= b.lomax;
}

function verTuple(v) {
  return String(v || '0').split('.').map(x => parseInt(x, 10) || 0);
}
function verNewer(a, b) {
  const x = verTuple(a), y = verTuple(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

function slug(s, i) {
  const base = (String(s || `rx-${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || `rx-${i}`);
  return `${base}-${i}`; // index suffix guarantees uniqueness across similar names
}

module.exports = {
  name: 'kiwisdr',
  description: 'KiwiSDR — HF receiver availability near regions of interest',
  async fetch() {
    let t__t;
    const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
    try {
      const res = await Promise.race([fetch(URL, { headers: { 'User-Agent': UA }, }, t__dl)]);
      if (!res.ok) return [];
      const html = await res.text();
      const m = html.match(/var\s+receivers\s*=\s*(\[[\s\S]*?\]);/);
      if (!m) return [];
      const sites = JSON.parse(m[1]);
      const flat = [];
      for (const site of sites) {
        const [lon, lat] = site.location?.coordinates || [NaN, NaN];
        const countryRaw = String(site.label || '').split(',').pop().trim();
        const country = /^[A-Za-z][A-Za-z .\-']{1,60}$/.test(countryRaw) ? countryRaw : '';
        for (const rx of (site.receivers || [])) {
          if (!rx.label) continue;
          const region = REGIONS.find(b => inBounds(lat, lon, b)) || null;
          flat.push({ name: String(rx.label).slice(0, 120), site: String(site.label || '').slice(0, 120),
                      lat, lon, country, url: rx.url || null, version: rx.version || '', region });
        }
      }
      if (!flat.length) return [];
      const inZone = flat.filter(r => r.region);
      const newest = flat.slice().sort((a, b) => (verNewer(a.version, b.version) ? -1 : 1));
      const picked = [];
      const seen = new Set();
      const take = r => {
        const k = r.url || r.name;
        if (seen.has(k) || picked.length >= CAP) return;
        seen.add(k); picked.push(r);
      };
      // Up to 2 per region of interest, then newest firmware elsewhere.
      for (const b of REGIONS) {
        let n = 0;
        for (const r of inZone) {
          if (n >= 2) break;
          if (r.region.key === b.key) { take(r); n++; }
        }
      }
      for (const r of newest) take(r);
      const now = new Date().toISOString();
      return picked.map((r, i) => ({
        id: `kiwisdr-${slug(r.name, i)}`,
        title: r.region ? `KiwiSDR listening post online — ${r.region.label}` : `KiwiSDR receiver online — ${r.country || 'unknown location'}`,
        summary: `Public HF (0–30 MHz) receiver "${r.name}" at ${r.site} is listed on ReceiverBook${r.region ? `, covering the ${r.region.label}` : ''}${r.version ? ` (firmware ${r.version})` : ''} — a sensor-availability marker, not an alert.`,
        lat: Number.isFinite(r.lat) ? r.lat : null,
        lon: Number.isFinite(r.lon) ? r.lon : null,
        region: r.region ? r.region.label : (r.country || null),
        time: now,
        severity: 'low',
        url: r.url,
        attribution: 'KiwiSDR/ReceiverBook',
      }));
    } catch {
      return [];
    } finally {
      clearTimeout(t__t);
    }
  },
};
