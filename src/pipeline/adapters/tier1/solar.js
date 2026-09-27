// Solar activity from NOAA SWPC: F10.7 radio flux, solar wind speed, Type II
// radio emission (CME) alerts, and NOAA R/S scales (radio blackouts, solar
// radiation storms). Sun-side only — geomagnetic/Kp/aurora live in the
// noaa_swpc adapter. Keyless.
const SWPC = 'https://services.swpc.noaa.gov/products/';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

async function fetchJson(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  try {
    const res = await Promise.race([fetch(url, { headers: { 'User-Agent': UA }, }, t__dl)]);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

const latestOf = arr => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);
const rSev = v => (v >= 5 ? 'critical' : v >= 3 ? 'high' : v >= 2 ? 'moderate' : 'low');
const sSev = v => (v >= 4 ? 'critical' : v >= 3 ? 'high' : v >= 2 ? 'moderate' : 'low');

module.exports = {
  name: 'solar',
  description: 'Solar activity: flares, F10.7 flux, solar wind, CMEs (NOAA SWPC)',
  async fetch() {
    try {
      const [f107Raw, speedRaw, alertsRaw, scalesRaw] = await Promise.all([
        fetchJson(SWPC + 'summary/10cm-flux.json'),
        fetchJson(SWPC + 'summary/solar-wind-speed.json'),
        fetchJson(SWPC + 'alerts.json'),
        fetchJson(SWPC + 'noaa-scales.json'),
      ]);
      const now = new Date().toISOString();
      const day = now.slice(0, 10);
      const events = [];
      const push = e => events.push(e);

      // --- F10.7 radio flux (current) ---
      const f107 = latestOf(f107Raw);
      const flux = f107 ? parseFloat(f107.flux) : NaN;
      if (!isNaN(flux)) {
        const lvl = flux > 200 ? 'very high' : flux > 180 ? 'high' : flux > 130 ? 'elevated' : 'moderate';
        push({
          id: `solar-f107-${day}`,
          title: `Solar radio flux F10.7 = ${flux.toFixed(0)} sfu (${lvl})`,
          summary: `F10.7 cm radio flux, a proxy for overall solar activity, is at ${flux.toFixed(0)} solar flux units — ${lvl} levels.`,
          lat: null, lon: null, region: 'Global', time: f107.time_tag || now,
          severity: flux > 220 ? 'high' : flux > 180 ? 'moderate' : 'low',
          url: 'https://www.swpc.noaa.gov/phenomena/f107-cm-radio-emissions',
          attribution: 'NOAA SWPC',
        });
      }

      // --- Solar wind speed / high-speed stream ---
      const sw = latestOf(speedRaw);
      const speed = sw ? parseFloat(sw.proton_speed) : NaN;
      if (!isNaN(speed) && speed > 550) {
        push({
          id: `solar-hssw-${day}`,
          title: `High-speed solar wind stream — ${Math.round(speed)} km/s`,
          summary: `Solar wind proton speed at L1 is ${Math.round(speed)} km/s, a high-speed stream (coronal hole origin) that can buff up geomagnetic activity.`,
          lat: null, lon: null, region: 'Global', time: sw.time_tag || now,
          severity: speed > 750 ? 'high' : 'moderate',
          url: 'https://www.swpc.noaa.gov/phenomena/solar-wind',
          attribution: 'NOAA SWPC',
        });
      }

      // --- Type II radio emission = CME detection (from SWPC alerts) ---
      const cutoff = Date.now() - 72 * 3600000;
      const type2 = (Array.isArray(alertsRaw) ? alertsRaw : [])
        .filter(a => a.product_id === 'TIIA')
        .filter(a => { const t = Date.parse(a.issue_datetime); return !isNaN(t) && t > cutoff; })
        .slice(0, 3);
      for (const a of type2) {
        const msg = a.message || '';
        const vel = (msg.match(/Estimated Velocity:\s*(\d+)\s*km/i) || [])[1];
        const begin = (msg.match(/Begin Time:\s*(.+?)\s*UTC/i) || [])[1];
        const v = vel ? parseInt(vel, 10) : null;
        const slug = begin ? begin.replace(/[^0-9]/g, '').slice(0, 12) : 'unknown';
        push({
          id: `solar-cme-${slug}`,
          title: `CME detected — Type II radio emission${v ? ` @ ${v} km/s` : ''}`,
          summary: v
            ? `A coronal mass ejection with estimated velocity ${v} km/s began ${begin || 'recently'} UTC. Geomagnetic storming possible if Earth-directed.`
            : 'A coronal mass ejection signature (Type II radio emission) was detected; details in the SWPC alert.',
          lat: null, lon: null, region: 'Global', time: a.issue_datetime || now,
          severity: v && v > 1000 ? 'high' : v && v > 750 ? 'moderate' : 'low',
          url: 'https://www.swpc.noaa.gov/products/alerts-watches-and-warnings',
          attribution: 'NOAA SWPC',
        });
      }

      // --- NOAA R (radio blackout) and S (solar radiation) scales, today ---
      const today = scalesRaw && scalesRaw['0'];
      if (today) {
        const r = today.R && parseInt(today.R.Scale, 10);
        if (r >= 1) push({
          id: `solar-r${r}-${day}`,
          title: `R${r} radio blackout${r >= 3 ? ' — X-class flare activity' : ''}`,
          summary: today.R.Text || `NOAA R${r} radio blackout scale event — HF radio degradation on the sunlit side of Earth.`,
          lat: null, lon: null, region: 'Global', time: today.TimeStamp || now,
          severity: rSev(r),
          url: 'https://www.swpc.noaa.gov/noaa-scales-explanation',
          attribution: 'NOAA SWPC',
        });
        const s = today.S && parseInt(today.S.Scale, 10);
        if (s >= 1) push({
          id: `solar-s${s}-${day}`,
          title: `S${s} solar radiation storm`,
          summary: today.S.Text || `NOAA S${s} solar radiation storm scale event — elevated solar energetic particles.`,
          lat: null, lon: null, region: 'Global', time: today.TimeStamp || now,
          severity: sSev(s),
          url: 'https://www.swpc.noaa.gov/noaa-scales-explanation',
          attribution: 'NOAA SWPC',
        });
      }

      return events;
    } catch {
      return [];
    }
  },
};
