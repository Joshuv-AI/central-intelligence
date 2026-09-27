// GSCPI — NY Fed Global Supply Chain Pressure Index.
// Standard deviations from historical average. >0 = above-average pressure,
// >1.0 = elevated, <-1.0 = unusually loose. Keyless CSV from the NY Fed.

const CSV_URL =
  'https://www.newyorkfed.org/medialibrary/research/interactives/data/gscpi/gscpi_interactive_data.csv';
const UA = 'Central-Intelligence/1.0';
const TIMEOUT_MS = 20000;

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// "31-Jan-2026" -> "2026-01"
function parseNYFedDate(str) {
  const parts = String(str).split('-');
  if (parts.length !== 3) return null;
  const mon = MONTHS[parts[1]];
  if (!mon || !parts[2]) return null;
  return `${parts[2]}-${mon}`;
}

// Wide-format CSV: each column is a revision vintage; take the last
// non-empty, non-#N/A value per row (latest estimate).
function parseCSV(text, months) {
  const lines = text.trim().split('\n').filter((l) => l.trim() && !l.startsWith(','));
  if (lines.length < 2) return [];
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const dateStr = cols[0] && cols[0].trim();
    if (!dateStr) continue;
    let value = null;
    for (let j = cols.length - 1; j >= 1; j--) {
      const v = cols[j] && cols[j].trim();
      if (v && v !== '#N/A') {
        const num = parseFloat(v);
        if (!isNaN(num)) {
          value = num;
          break;
        }
      }
    }
    if (value === null) continue;
    const date = parseNYFedDate(dateStr);
    if (date) results.push({ date, value });
  }
  results.sort((a, b) => (a.date < b.date ? 1 : -1));
  return results.slice(0, months);
}

function interpret(v) {
  if (v > 1.0) return 'elevated';
  if (v > 0) return 'above average';
  if (v > -1.0) return 'below average';
  return 'unusually loose';
}

async function getGSCPI(months) {
  try {
    let t__t;
    const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
    const res = await Promise.race([fetch(CSV_URL, {
      headers: { 'User-Agent': UA },
    }, t__dl)]);
    clearTimeout(t__t);
    if (!res.ok) return [];
    return parseCSV(await res.text(), months);
  } catch {
    return [];
  }
}

module.exports = {
  name: 'gscpi',
  description: 'NY Fed Global Supply Chain Pressure Index — latest reading and trend',
  async fetch() {
    try {
      const history = await getGSCPI(12);
      if (history.length === 0) return [];
      const latest = history[0];
      const prev = history[1] || null;
      const events = [];

      const mom = prev ? latest.value - prev.value : null;
      let severity = 'low';
      if (Math.abs(latest.value) > 1.0 || (mom !== null && Math.abs(mom) > 0.5)) {
        severity = 'moderate';
      }

      let summary = `Interpretation: ${interpret(latest.value)} (values above 0 = above-average pressure; above 1.0 = elevated; below -1.0 = unusually loose).`;
      if (prev) {
        summary += ` Previous month (${prev.date}): ${prev.value.toFixed(2)}; change ${mom >= 0 ? '+' : ''}${mom.toFixed(2)} points.`;
      }

      events.push({
        id: `gscpi-${latest.date}`,
        title: `Global Supply Chain Pressure Index: ${latest.value >= 0 ? '+' : ''}${latest.value.toFixed(2)} (${latest.date})`,
        summary,
        region: 'Global',
        time: `${latest.date}-01T00:00:00Z`,
        severity,
        url: CSV_URL,
        attribution: 'NY Fed',
      });

      if (mom !== null && Math.abs(mom) > 0.5) {
        events.push({
          id: `gscpi-mom-${latest.date}`,
          title: `GSCPI ${mom > 0 ? 'surged' : 'dropped'} ${Math.abs(mom).toFixed(2)} points month-over-month`,
          summary: `Moved from ${prev.value.toFixed(2)} (${prev.date}) to ${latest.value.toFixed(2)} (${latest.date}).`,
          region: 'Global',
          time: `${latest.date}-01T00:00:00Z`,
          severity: 'moderate',
          url: CSV_URL,
          attribution: 'NY Fed',
        });
      }

      // 3-month trend
      if (history.length >= 3) {
        const r3 = history.slice(0, 3);
        let rising = 0, falling = 0;
        for (let i = 0; i < 2; i++) {
          if (r3[i].value > r3[i + 1].value) rising++;
          else if (r3[i].value < r3[i + 1].value) falling++;
        }
        const trend = rising > falling ? 'rising' : falling > rising ? 'falling' : 'stable';
        events.push({
          id: `gscpi-trend-${latest.date}`,
          title: `GSCPI 3-month trend: ${trend}`,
          summary: `Latest three readings: ${r3.map((r) => `${r.date}: ${r.value >= 0 ? '+' : ''}${r.value.toFixed(2)}`).join(', ')}.`,
          region: 'Global',
          time: `${latest.date}-01T00:00:00Z`,
          severity: trend === 'rising' && latest.value > 0 ? 'moderate' : 'low',
          url: CSV_URL,
          attribution: 'NY Fed',
        });
      }

      return events.slice(0, 10);
    } catch {
      return [];
    }
  },
};
