// BLS — Bureau of Labor Statistics. CPI, unemployment, payrolls, PPI.
// Keyless v1 API (POST batch); v2 endpoint used when BLS_API_KEY is set.

'use strict';

const V1_BASE = 'https://api.bls.gov/publicAPI/v1/timeseries/data/';
const V2_BASE = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

// Series -> { label, unit, decimals, largeMove* }.
const SERIES = {
  CUUR0000SA0:    { label: 'CPI-U All Items', unit: 'index', decimals: 1, largeMovePct: 0.4 },
  CUUR0000SA0L1E:{ label: 'CPI-U Core (ex Food & Energy)', unit: 'index', decimals: 1, largeMovePct: 0.3 },
  LNS14000000:   { label: 'Unemployment Rate', unit: '%', decimals: 1, largeMove: 0.3, highIsModerateAt: 5.0 },
  CES0000000001: { label: 'Nonfarm Payrolls', unit: 'K', decimals: 0, largeMove: 250, dropIsModerateAt: -50 },
  WPUFD49104:    { label: 'PPI Final Demand', unit: 'index', decimals: 1, largeMovePct: 0.4 },
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function periodLabel(year, period) {
  const m = parseInt(period.slice(1), 10);
  if (period.startsWith('Q')) return `Q${period.slice(1)} ${year}`;
  if (m >= 1 && m <= 12) return `${MONTHS[m - 1]} ${year}`;
  return `${year}`;
}

function periodToISO(year, period) {
  const m = parseInt(period.slice(1), 10);
  const mm = m >= 1 && m <= 12 ? String(m).padStart(2, '0') : '01';
  return new Date(`${year}-${mm}-01T12:00:00Z`).toISOString();
}

function sortDesc(data) {
  return [...data]
    .filter(d => d.value !== '-' && d.value !== '.')
    .sort((a, b) => {
      const ya = parseInt(a.year, 10), yb = parseInt(b.year, 10);
      if (ya !== yb) return yb - ya;
      return b.period.localeCompare(a.period);
    });
}

function fmt(value, cfg) {
  const v = Number(value);
  if (cfg.unit === '%') return `${v.toFixed(cfg.decimals)}%`;
  if (cfg.unit === 'K') return `${(v / 1000).toFixed(1)}M`;
  return v.toFixed(cfg.decimals);
}

async function fetchBatch(apiKey) {
  const now = new Date();
  const payload = {
    seriesid: Object.keys(SERIES),
    startyear: String(now.getFullYear() - 1),
    endyear: String(now.getFullYear()),
  };
  if (apiKey) payload.registrationkey = apiKey;
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
  timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(apiKey ? V2_BASE : V1_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(payload),
    }), timer__dl]);
    clearTimeout(timer__t);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(timer__t);
    return null;
  }
}

module.exports = {
  name: 'bls',
  description: 'BLS — US inflation, unemployment, payrolls and producer prices',

  async fetch() {
    try {
      const resp = await fetchBatch(process.env.BLS_API_KEY || null);
      if (resp?.status !== 'REQUEST_SUCCEEDED' || !resp?.Results?.series?.length) return [];
      const events = [];
      for (const s of resp.Results.series) {
        if (events.length >= 12) break;
        const cfg = SERIES[s.seriesID];
        if (!cfg) continue;
        const sorted = sortDesc(s.data).filter(d => d.period.startsWith('M') && d.period !== 'M13');
        if (sorted.length < 2) continue;
        const [curr, prev] = sorted;
        const value = parseFloat(curr.value), pvalue = parseFloat(prev.value);
        if (isNaN(value) || isNaN(pvalue) || pvalue === 0) continue;
        const delta = value - pvalue;
        const deltaPct = (delta / pvalue) * 100;
        const dir = delta > 0 ? 'Up' : delta < 0 ? 'Down' : 'Flat';
        const deltaTxt = cfg.unit === '%'
          ? `${Math.abs(delta).toFixed(cfg.decimals)}pp`
          : `${Math.abs(delta).toFixed(cfg.decimals)}${cfg.unit === 'K' ? 'K' : ''} (${(deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(2)}% MoM)`;

        let severity = 'low';
        if (cfg.largeMove != null && Math.abs(delta) >= cfg.largeMove) severity = 'moderate';
        if (cfg.largeMovePct != null && Math.abs(deltaPct) >= cfg.largeMovePct) severity = 'moderate';
        if (cfg.highIsModerateAt != null && value >= cfg.highIsModerateAt) severity = 'moderate';
        if (cfg.dropIsModerateAt != null && delta <= cfg.dropIsModerateAt) severity = 'moderate';

        events.push({
          id: `bls-${s.seriesID}-${curr.year}${curr.period}`,
          title: `${cfg.label}: ${fmt(value, cfg)} (${periodLabel(curr.year, curr.period)})`,
          summary: `Previous: ${fmt(pvalue, cfg)} (${periodLabel(prev.year, prev.period)}). ${dir} ${deltaTxt}.`,
          region: 'United States',
          time: periodToISO(curr.year, curr.period),
          severity,
          url: 'https://www.bls.gov/',
          attribution: 'BLS',
        });
      }
      return events;
    } catch (e) {
      return [];
    }
  },
};
