// EIA — US Energy Information Administration. Oil, gas, inventories.
// Requires EIA_API_KEY.

'use strict';

const BASE = 'https://api.eia.gov/v2';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

// Series definitions with v2 API paths + facets (from vendor).
const SERIES = {
  wti: {
    label: 'WTI Crude Oil', unit: '$/bbl', decimals: 2, largeMove: 5,
    highIsModerateAt: 100, lowIsModerateAt: 50,
    path: '/petroleum/pri/spt/data/', frequency: 'daily', facet: 'RWTC',
    url: 'https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.php',
  },
  brent: {
    label: 'Brent Crude Oil', unit: '$/bbl', decimals: 2, largeMove: 5,
    path: '/petroleum/pri/spt/data/', frequency: 'daily', facet: 'RBRTE',
    url: 'https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.php',
  },
  henryHub: {
    label: 'Henry Hub Natural Gas', unit: '$/MMBtu', decimals: 2, largeMove: 0.50,
    highIsModerateAt: 6,
    path: '/natural-gas/pri/fut/data/', frequency: 'daily', facet: 'RNGWHHD',
    url: 'https://www.eia.gov/dnav/ng/ng_pri_fut_s1_d.php',
  },
  crudeStocks: {
    label: 'US Crude Oil Inventories', unit: 'k bbl', decimals: 0, largeMove: 5000,
    inventory: true,
    path: '/petroleum/stoc/wstk/data/', frequency: 'weekly', facet: 'WCESTUS1',
    url: 'https://www.eia.gov/dnav/pet/pet_stoc_wstk_d_nus_mbbl_w.htm',
  },
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function periodLabel(period) {
  const [y, m, d] = period.split('-');
  if (!y || !m || !d) return period;
  return `${MONTHS[+m - 1]} ${+d}, ${y}`;
}

function fmt(value, cfg) {
  const v = Number(value);
  if (cfg.unit === '$/bbl' || cfg.unit === '$/MMBtu') return `$${v.toFixed(cfg.decimals)}`;
  if (cfg.inventory) return `${(v / 1000).toFixed(1)}M bbl`;
  return v.toFixed(cfg.decimals);
}

async function fetchJson(url) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
  try {
    const res = await Promise.race([fetch(url, { headers: { 'User-Agent': UA }, }, timer__dl)]);
    clearTimeout(timer__t);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(timer__t);
    return null;
  }
}

function buildUrl(apiKey, def) {
  const url = new URL(`${BASE}${def.path}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('frequency', def.frequency);
  url.searchParams.set('data[0]', 'value');
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('length', '5');
  url.searchParams.set('facets[series][]', def.facet);
  return url.toString();
}

async function fetchSeries(key, id, def) {
  const resp = await fetchJson(buildUrl(key, def));
  const rows = (resp?.response?.data || [])
    .map(d => ({ value: parseFloat(d.value), period: d.period }))
    .filter(d => !isNaN(d.value));
  if (rows.length < 2) return null;
  return { id, def, latest: rows[0], prev: rows[1] };
}

module.exports = {
  name: 'eia',
  description: 'EIA — US oil, natural gas prices and crude inventories',
keyEnv: "EIA_API_KEY",

  async fetch() {
    const key = process.env.EIA_API_KEY;
    if (!key) return [];
    try {
      const results = await Promise.all(
        Object.entries(SERIES).map(([id, def]) => fetchSeries(key, id, def))
      );
      const events = [];
      for (const r of results) {
        if (!r || events.length >= 12) continue;
        const { id, def, latest, prev } = r;
        const delta = latest.value - prev.value;
        const dir = delta > 0 ? 'Up' : delta < 0 ? 'Down' : 'Flat';
        const move = def.inventory
          ? `${dir === 'Flat' ? 'flat' : dir === 'Up' ? 'build' : 'draw'} of ${Math.abs(delta / 1000).toFixed(1)}M bbl WoW`
          : `${dir} $${Math.abs(delta).toFixed(def.decimals)} (${(delta / prev * 100 >= 0 ? '+' : '') + (delta / prev * 100).toFixed(2)}%)`;

        let severity = 'low';
        if (def.largeMove != null && Math.abs(delta) >= def.largeMove) severity = 'moderate';
        if (def.highIsModerateAt != null && latest.value >= def.highIsModerateAt) severity = 'moderate';
        if (def.lowIsModerateAt != null && latest.value <= def.lowIsModerateAt) severity = 'moderate';

        events.push({
          id: `eia-${id}-${latest.period}`,
          title: `${def.label}: ${fmt(latest.value, def)} (${periodLabel(latest.period)})`,
          summary: `Previous: ${fmt(prev.value, def)} (${periodLabel(prev.period)}). ${move}.`,
          region: 'United States',
          time: new Date(`${latest.period}T12:00:00Z`).toISOString(),
          severity,
          url: def.url,
          attribution: 'EIA',
        });
      }
      return events;
    } catch (e) {
      return [];
    }
  },
};
