// UN Comtrade — global trade flows for strategic commodities (keyless, rate-limited).
// 2 calls per run: US imports of crude petroleum + semiconductors.

const BASE = 'https://comtradeapi.un.org/public/v1';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

const COMMODITIES = {
  '2709': 'Crude Petroleum',
  '8542': 'Semiconductors (Electronic Integrated Circuits)',
};

// M49 numeric -> name for common trade partners (preview API returns codes only)
const COUNTRIES = {
  0: 'World', 12: 'Algeria', 24: 'Angola', 32: 'Argentina', 36: 'Australia', 40: 'Austria',
  56: 'Belgium', 76: 'Brazil', 100: 'Bulgaria', 124: 'Canada', 152: 'Chile', 156: 'China',
  170: 'Colombia', 203: 'Czechia', 208: 'Denmark', 218: 'Ecuador', 246: 'Finland',
  250: 'France', 276: 'Germany', 288: 'Ghana', 300: 'Greece', 348: 'Hungary', 352: 'Iceland',
  356: 'India', 360: 'Indonesia', 364: 'Iran', 368: 'Iraq', 372: 'Ireland', 376: 'Israel',
  380: 'Italy', 384: 'Ivory Coast', 392: 'Japan', 398: 'Kazakhstan', 404: 'Kenya',
  410: 'South Korea', 414: 'Kuwait', 428: 'Latvia', 430: 'Liberia', 434: 'Libya',
  440: 'Lithuania', 458: 'Malaysia', 484: 'Mexico', 498: 'Moldova', 504: 'Morocco',
  508: 'Mozambique', 528: 'Netherlands', 554: 'New Zealand', 566: 'Nigeria', 578: 'Norway',
  586: 'Pakistan', 591: 'Panama', 600: 'Paraguay', 604: 'Peru', 608: 'Philippines',
  616: 'Poland', 620: 'Portugal', 634: 'Qatar', 642: 'Romania', 643: 'Russia',
  682: 'Saudi Arabia', 688: 'Serbia', 703: 'Slovakia', 705: 'Slovenia', 710: 'South Africa',
  724: 'Spain', 752: 'Sweden', 756: 'Switzerland', 158: 'Taiwan', 764: 'Thailand',
  780: 'Trinidad and Tobago', 788: 'Tunisia', 792: 'Turkey', 800: 'Uganda', 804: 'Ukraine',
  784: 'United Arab Emirates', 826: 'United Kingdom', 842: 'United States', 862: 'Venezuela',
  704: 'Viet Nam', 894: 'Zambia', 716: 'Zimbabwe',
};

function countryName(code) {
  return COUNTRIES[code] || `Country ${code}`;
}

async function getJSON(url) {
  try {
    let t__t;
    const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
    const res = await Promise.race([fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    }, t__dl)]);
    clearTimeout(t__t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getTradeData(cmdCode) { // current year, fall back to previous
  const year = new Date().getFullYear();
  for (const period of [year, year - 1]) {
    const p = new URLSearchParams({
      reporterCode: '842', period: String(period), cmdCode, flowCode: 'M',
    });
    const json = await getJSON(`${BASE}/preview/C/A/HS?${p}`);
    let records = (json && (json.data || json.dataset)) || [];
    if (!Array.isArray(records)) records = [];
    if (records.length > 0) return { records, period };
  }
  return { records: [], period: year };
}

function compactRecord(rec) {
  return {
    reporter: rec.reporterDesc || rec.reporterCode,
    partner: rec.partnerDesc || rec.partnerCode,
    partnerCode: rec.partnerCode,
    commodity: rec.cmdDesc || rec.cmdCode,
    flow: rec.flowDesc || rec.flowCode,
    value: Number(rec.primaryValue || rec.cifvalue || rec.fobvalue) || null,
    period: rec.period,
  };
}

function fmtB(v) {
  return `$${(v / 1e9).toFixed(2)}B`;
}
module.exports = {
  name: 'comtrade',
  description: 'UN Comtrade — US import flows for strategic commodities',
  async fetch() {
    try {
      const events = [];

      for (const [cmdCode, cmdName] of Object.entries(COMMODITIES)) {
        const { records, period } = await getTradeData(cmdCode);
        const compact = records
          .map(compactRecord)
          .filter((r) => typeof r.value === 'number' && r.value > 0);
        if (compact.length === 0) continue;

        // partnerCode 0 = World aggregate row: use as total; nonzero codes are suppliers.
        const worldRow = compact.find((r) => Number(r.partnerCode) === 0);
        const suppliers = compact.filter((r) => Number(r.partnerCode) !== 0);
        const byPartner = new Map();
        for (const r of suppliers) {
          const code = Number(r.partnerCode) || 0;
          byPartner.set(code, (byPartner.get(code) || 0) + r.value);
        }
const partners = [...byPartner.entries()].map(([code, value]) => ({ code, partner: countryName(code), value })).sort((a, b) => b.value - a.value);
        if (partners.length === 0) continue;
        const total = (worldRow && worldRow.value > 0) ? worldRow.value : partners.reduce((a, p) => a + p.value, 0);
        const top3 = partners.slice(0, 3);

        const topLine = top3.map((p) => `${p.partner} ${fmtB(p.value)} (${((p.value / total) * 100).toFixed(1)}%)`).join('; ');

        events.push({
          id: `comtrade-842-${cmdCode}-M-${period}`,
          title: `US ${cmdName} Imports (${period}): ${fmtB(total)}`,
          summary: `Top suppliers: ${topLine}. ${partners.length} partner countries. (Comtrade data typically lags 1-2 months; most recent year shown.)`,
          region: 'United States',
          time: `${period}-01-01T00:00:00Z`,
          severity: 'low',
          url: null,
          attribution: 'UN Comtrade',
        });

        const vals = partners.slice(0, 10).map((p) => p.value);
        if (vals.length > 2) {
          const avg = vals.reduce((a, v) => a + v, 0) / vals.length;
          const sd = Math.sqrt(vals.reduce((a, v) => a + (v - avg) ** 2, 0) / vals.length);
          for (const p of partners.slice(0, 10)) {
            if (p.value > avg + 2 * sd) {
              events.push({
                id: `comtrade-842-${cmdCode}-outlier-${period}`,
                title: `Outlier Trade Flow: ${cmdName} from ${p.partner}`,
                summary: `United States imported ${fmtB(p.value)} of ${cmdName} from ${p.partner} in ${period} — well above the partner mean of ${fmtB(avg)}.`,
                region: 'United States',
                time: `${period}-01-01T00:00:00Z`,
                severity: 'moderate',
                url: null,
                attribution: 'UN Comtrade',
              });
              break; // one outlier per commodity
            }
          }
        }
        if (events.length >= 10) break;
      }

      return events.slice(0, 10);
    } catch {
      return [];
    }
  },
};