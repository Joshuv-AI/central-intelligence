// NOAA SWPC geomagnetic/planetary side: planetary Kp index, NOAA G-scale
// geomagnetic storms, Kp forecast, solar wind Bz coupling, and aurora
// outlook. Earth-side only — sun-side (F10.7, wind, CMEs, R/S scales) lives
// in the solar adapter. Keyless.
const SWPC = 'https://services.swpc.noaa.gov/products/';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

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

const latestOf = arr => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);
const kpSev = k => (k >= 9 ? 'critical' : k >= 7 ? 'high' : k >= 5 ? 'moderate' : 'low');
const gSev = g => (g >= 4 ? 'critical' : g >= 3 ? 'high' : g >= 2 ? 'moderate' : 'low');
const kpLabel = k => (k >= 9 ? 'extreme storm' : k >= 7 ? 'severe storm' : k >= 5 ? 'storm' : k >= 4 ? 'unsettled' : 'active');

module.exports = {
  name: 'noaa_swpc',
  description: 'Geomagnetic activity: Kp index, G-scale storms, aurora forecast (NOAA SWPC)',
  async fetch() {
    try {
      const [kpRaw, scalesRaw, fcstRaw, magRaw] = await Promise.all([
        fetchJson(SWPC + 'noaa-planetary-k-index.json'),
        fetchJson(SWPC + 'noaa-scales.json'),
        fetchJson(SWPC + 'noaa-planetary-k-index-forecast.json'),
        fetchJson(SWPC + 'summary/solar-wind-mag-field.json'),
      ]);
      const now = new Date().toISOString();
      const day = now.slice(0, 10);
      const events = [];
      const push = e => events.push(e);

      // --- Current planetary Kp index ---
      const kpLatest = latestOf(kpRaw);
      const kp = kpLatest ? parseFloat(kpLatest.Kp) : NaN;
      if (!isNaN(kp)) {
        push({
          id: `noaa-swpc-kp-${day}`,
          title: `Planetary K-index Kp ${kp.toFixed(2)} — ${kp >= 3 ? kpLabel(kp) : 'quiet'}`,
          summary: `Global geomagnetic activity is at Kp ${kp.toFixed(2)} (${kp >= 5 ? kpLabel(kp) : kp >= 3 ? 'active conditions' : 'quiet conditions'}). Kp ≥ 5 marks a geomagnetic storm.`,
          lat: null, lon: null, region: 'Global', time: kpLatest.time_tag || now,
          severity: kpSev(kp),
          url: 'https://www.swpc.noaa.gov/products/planetary-k-index',
          attribution: 'NOAA SWPC',
        });
      }

      // --- NOAA G-scale today ---
      const today = scalesRaw && scalesRaw['0'];
      const g = today && today.G ? parseInt(today.G.Scale, 10) : NaN;
      if (!isNaN(g) && g >= 1) {
        push({
          id: `noaa-swpc-g${g}-${day}`,
          title: `G${g} geomagnetic storm in progress`,
          summary: today.G.Text || `NOAA G${g} geomagnetic storm scale — power grid, GPS and radio effects possible depending on intensity.`,
          lat: null, lon: null, region: 'Global', time: today.TimeStamp || now,
          severity: gSev(g),
          url: 'https://www.swpc.noaa.gov/noaa-scales-explanation',
          attribution: 'NOAA SWPC',
        });
      }

      // --- Kp forecast: storm-level periods ahead (non-observed rows) ---
      const future = (Array.isArray(fcstRaw) ? fcstRaw : [])
        .filter(r => r.observed !== 'observed' && parseFloat(r.kp) >= 5)
        .slice(0, 2);
      for (const p of future) {
        const k = parseFloat(p.kp);
        const t = p.time_tag || now;
        push({
          id: `noaa-swpc-fcst-${t.replace(/[^0-9]/g, '').slice(0, 12)}`,
          title: `Geomagnetic storm forecast — Kp ${k} expected ${t.slice(0, 16).replace('T', ' ')} UTC`,
          summary: `SWPC forecast expects Kp ${k} (${kpLabel(k)})${k >= 7 ? ', with high-latitude power-grid and aurora effects' : ', aurora possible at mid-to-high latitudes'}.`,
          lat: null, lon: null, region: 'Global', time: t,
          severity: kpSev(k),
          url: 'https://www.swpc.noaa.gov/products/3-day-forecast',
          attribution: 'NOAA SWPC',
        });
      }

      // --- Solar wind Bz: strongly southward = geomagnetic coupling ---
      const mag = latestOf(magRaw);
      const bz = mag ? parseFloat(mag.bz_gsm) : NaN;
      if (!isNaN(bz) && bz < -10) {
        push({
          id: `noaa-swpc-bz-${day}`,
          title: `Solar wind Bz strongly southward — ${bz.toFixed(1)} nT`,
          summary: `Interplanetary magnetic field Bz at ${bz.toFixed(1)} nT southward — strong coupling to Earth's magnetosphere; aurora and geomagnetic activity likely.`,
          lat: null, lon: null, region: 'Global', time: mag.time_tag || now,
          severity: 'moderate',
          url: 'https://www.swpc.noaa.gov/phenomena/solar-wind',
          attribution: 'NOAA SWPC',
        });
      }

      // --- Aurora outlook when G2+ is current or forecast ---
      const futureG = [1, 2].map(o => scalesRaw && scalesRaw[String(o)]).filter(Boolean);
      const maxFutureG = Math.max(g || 0, ...futureG.map(f => parseInt(f.G && f.G.Scale, 10) || 0));
      if (maxFutureG >= 2) {
        push({
          id: `noaa-swpc-aurora-${day}`,
          title: `Aurora likely at mid-to-high latitudes (G${maxFutureG} activity)`,
          summary: `With G${maxFutureG} geomagnetic activity current or forecast, aurora may be visible at lower latitudes than usual — check the SWPC aurora dashboard for the viewing line.`,
          lat: 55, lon: -100, region: 'High latitudes', time: now,
          severity: maxFutureG >= 3 ? 'high' : 'moderate',
          url: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast',
          attribution: 'NOAA SWPC',
        });
      }

      return events;
    } catch {
      return [];
    }
  },
};
