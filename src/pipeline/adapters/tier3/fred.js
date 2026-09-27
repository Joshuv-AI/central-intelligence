// FRED — Federal Reserve Economic Data (St. Louis Fed).
// Latest value + previous value for key macro series. Requires FRED_API_KEY.

'use strict';

const BASE = 'https://api.stlouisfed.org/fred/series/observations';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

// Series -> { label, unit, decimals, largeMove }.
// largeMove: absolute change vs previous obs that marks severity "moderate".
const SERIES = {
  DGS10:  { label: '10-Year Treasury Yield', unit: '%', decimals: 2, largeMove: 0.50 },
  T10Y2Y: { label: '10Y-2Y Spread', unit: 'pp', decimals: 2, largeMove: 0.30, invertIsModerate: true },
  DFF:    { label: 'Fed Funds Rate', unit: '%', decimals: 2, largeMove: 0.25 },
  CPIAUCSL: { label: 'CPI All Items (Index)', unit: 'index', decimals: 1, largeMovePct: 0.4 },
  UNRATE: { label: 'Unemployment Rate', unit: '%', decimals: 1, largeMove: 0.30, highIsModerateAt: 5.0 },
  PAYEMS: { label: 'Nonfarm Payrolls', unit: 'K', decimals: 0, largeMove: 250 },
  M2SL:   { label: 'M2 Money Supply', unit: 'B$', decimals: 0, largeMovePct: 1.0 },
  VIXCLS: { label: 'VIX (Fear Index)', unit: '', decimals: 1, largeMoveAt: 30 },
  DCOILWTICO: { label: 'WTI Crude Oil', unit: '$', decimals: 2, largeMove: 5 },
  GOLDAMGBD228NLBM: { label: 'Gold (London Fix)', unit: '$', decimals: 2, largeMove: 50 },
  MORTGAGE30US: { label: '30-Year Mortgage Rate', unit: '%', decimals: 2, largeMove: 0.25 },
  DTWEXBGS: { label: 'USD Trade-Weighted Index', unit: '', decimals: 2, largeMovePct: 2.0 },
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

async function fetchJson(url) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
  timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(url, { headers: { 'User-Agent': UA }, }), timer__dl]);
    clearTimeout(timer__t);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(timer__t);
    return null;
  }
}

function periodLabel(isoDate) {
  const [y, m, d] = isoDate.split('-');
  if (d === '01') return `${MONTHS[+m - 1]} ${y}`;
  return `${MONTHS[+m - 1]} ${+d}, ${y}`;
}

function fmt(value, cfg) {
  const v = Number(value);
  if (cfg.unit === '$') return `$${v.toFixed(cfg.decimals)}`;
  if (cfg.unit === '%') return `${v.toFixed(cfg.decimals)}%`;
  if (cfg.unit === 'pp') return `${v.toFixed(cfg.decimals)}pp`;
  if (cfg.unit === 'K') return `${(v / 1000).toFixed(1)}M`;
  if (cfg.unit === 'B$') return `$${(v / 1000).toFixed(2)}T`;
  return v.toFixed(cfg.decimals);
}

async function fetchSeries(id, key) {
  const start = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    series_id: id, api_key: key, file_type: 'json',
    sort_order: 'desc', limit: '5', observation_start: start,
  });
  const data = await fetchJson(`${BASE}?${params}`);
  const obs = (data?.observations || []).filter(o => o.value !== '.');
  if (obs.length < 2) return null;
  return { id, latest: obs[0], prev: obs[1] };
}

module.exports = {
  name: 'fred',
  description: 'FRED — key US macro indicators (yields, CPI, labor, money, commodities)',
keyEnv: "FRED_API_KEY",

  async fetch() {
    const key = process.env.FRED_API_KEY;
    if (!key) return [];
    try {
      const results = await Promise.all(
        Object.keys(SERIES).map(id => fetchSeries(id, key))
      );
      const events = [];
      for (const r of results) {
        if (!r || events.length >= 12) continue;
        const cfg = SERIES[r.id];
        const value = parseFloat(r.latest.value);
        const prev = parseFloat(r.prev.value);
        if (isNaN(value) || isNaN(prev)) continue;
        const delta = value - prev;
        const dir = delta > 0 ? 'Up' : delta < 0 ? 'Down' : 'Flat';
        const deltaTxt = cfg.unit === '%' || cfg.unit === 'pp'
          ? `${Math.abs(delta).toFixed(cfg.decimals)}pp`
          : `${Math.abs(delta).toFixed(cfg.decimals)}${cfg.unit === 'K' ? 'K' : cfg.unit === 'B$' ? 'B' : ''}`;

        let severity = 'low';
        if (cfg.largeMove != null && Math.abs(delta) >= cfg.largeMove) severity = 'moderate';
        if (cfg.largeMovePct != null && prev !== 0 && Math.abs(delta / prev) * 100 >= cfg.largeMovePct) severity = 'moderate';
        if (cfg.invertIsModerate && value < 0) severity = 'moderate';
        if (cfg.highIsModerateAt != null && value >= cfg.highIsModerateAt) severity = 'moderate';
        if (cfg.largeMoveAt != null && value >= cfg.largeMoveAt) severity = 'moderate';

        events.push({
          id: `fred-${r.id}-${r.latest.date}`,
          title: `${cfg.label}: ${fmt(value, cfg)} (${periodLabel(r.latest.date)})`,
          summary: `Previous: ${fmt(prev, cfg)} (${periodLabel(r.prev.date)}). ${dir} ${deltaTxt}.`,
          region: 'United States',
          time: new Date(`${r.latest.date}T12:00:00Z`).toISOString(),
          severity,
          url: `https://fred.stlouisfed.org/series/${r.id}`,
          attribution: 'FRED',
        });
      }
      return events;
    } catch (e) {
      return [];
    }
  },
};
