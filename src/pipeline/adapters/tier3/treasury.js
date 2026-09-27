// US Treasury Fiscal Data — national debt, average interest rates, operating cash.
// Keyless API: https://api.fiscaldata.treasury.gov (daily updates).

const BASE = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

// Vendor threshold (from original adapter): flag debt above $36T.
const DEBT_FLAG_T = 36_000_000_000_000;

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

function daysAgoISO(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}
function isoDay(d) {
  return d ? `${d}T00:00:00Z` : new Date().toISOString();
}
function fmtT(v) {
  return `$${(v / 1e12).toFixed(2)}T`;
}
function fmtB(v) {
  const a = Math.abs(v);
  return `${a >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : (v / 1e6).toFixed(1) + 'M'}`;
}

async function debtEvents(events) {
  const p = new URLSearchParams({
    fields: 'record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt',
    sort: '-record_date',
    'page[size]': '10',
    filter: `record_date:gte:${daysAgoISO(14)}`,
  });
  const json = await getJSON(`${BASE}/v2/accounting/od/debt_to_penny?${p}`);
  const rows = (json && Array.isArray(json.data) && json.data) || [];
  if (rows.length === 0) return;

  const latest = rows[0];
  const prev = rows[1] || null;
  const total = parseFloat(latest.tot_pub_debt_out_amt);
  const pub = parseFloat(latest.debt_held_public_amt);
  const ig = parseFloat(latest.intragov_hold_amt);
  if (!isFinite(total)) return;

  let summary = '';
  let daily = null;
  if (prev) {
    const pTotal = parseFloat(prev.tot_pub_debt_out_amt);
    if (isFinite(pTotal)) {
      daily = total - pTotal;
      summary += `Previous day: ${fmtT(pTotal)} (change ${daily >= 0 ? '+' : ''}$${fmtB(daily)}). `;
    }
  }
  if (isFinite(pub)) summary += `Debt held by public: ${fmtT(pub)} (${((pub / total) * 100).toFixed(1)}% of total). `;
  if (isFinite(ig)) summary += `Intragovernmental holdings: ${fmtT(ig)}.`;

  events.push({
    id: `treasury-debt-${latest.record_date}`,
    title: `US National Debt: ${fmtT(total)}`,
    summary: summary.trim() || undefined,
    region: 'United States',
    time: isoDay(latest.record_date),
    severity: total > DEBT_FLAG_T || (daily !== null && Math.abs(daily) > 100e9) ? 'moderate' : 'low',
    url: null,
    attribution: 'US Treasury',
  });
}

const RATE_SECURITIES = ['Treasury Bills', 'Treasury Notes', 'Treasury Bonds'];

async function rateEvents(events) {
  const p = new URLSearchParams({
    fields: 'record_date,security_desc,avg_interest_rate_amt',
    sort: '-record_date',
    'page[size]': '100',
    filter: `record_date:gte:${daysAgoISO(30)}`,
  });
  const json = await getJSON(`${BASE}/v2/accounting/od/avg_interest_rates?${p}`);
  const rows = (json && Array.isArray(json.data) && json.data) || [];
  if (rows.length === 0) return;

  for (const sec of RATE_SECURITIES) {
    const sr = rows.filter((r) => r.security_desc === sec);
    if (sr.length === 0) continue;
    const cur = parseFloat(sr[0].avg_interest_rate_amt);
    const prevRow = sr.find((r) => r.record_date !== sr[0].record_date);
    const prev = prevRow ? parseFloat(prevRow.avg_interest_rate_amt) : NaN;
    if (!isFinite(cur)) continue;

    let summary = '';
    if (isFinite(prev)) {
      const d = cur - prev;
      summary = `Previous: ${prev.toFixed(3)}% (change ${d >= 0 ? '+' : ''}${d.toFixed(3)} pts, vintage ${prevRow.record_date}).`;
    }
    events.push({
      id: `treasury-rate-${sec.replace(/[^a-z]+/gi, '-').toLowerCase()}-${sr[0].record_date}`,
      title: `US ${sec} Avg Interest Rate: ${cur.toFixed(3)}%`,
      summary: summary || undefined,
      region: 'United States',
      time: isoDay(sr[0].record_date),
      severity: 'low',
      url: null,
      attribution: 'US Treasury',
    });
    if (events.length >= 9) break;
  }
}

module.exports = {
  name: 'treasury',
  description: 'US Treasury fiscal data — national debt and interest rates',
  async fetch() {
    try {
      const events = [];
      await debtEvents(events);
      await rateEvents(events);
      return events.slice(0, 10);
    } catch {
      return [];
    }
  },
};
