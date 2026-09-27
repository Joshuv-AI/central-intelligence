// ProMED — recent global disease outbreak alerts.
// Keyless. The legacy /backend/feed RSS was retired with the 2026 site
// rebuild; the homepage now server-renders a recent-alerts JSON feed that
// this adapter scans directly (titles, alert ids, issue dates, places with
// lat/lon, disease names, generated summaries). The embedded JSON uses
// backslash-escaped quotes at varying depths, so fields are extracted with
// plain string scanning after collapsing backslash runs — the single
// backslash is built via String.fromCharCode to keep the source readable.

const FEED_URL = "https://www.promedmail.org/";
const UA = "Central-Intelligence/1.0";
const TIMEOUT_MS = 20000;
const MAX_EVENTS = 25;
const BS = String.fromCharCode(92); // one backslash
const HIGH_SEV = /(ebola|marburg|h5n1|h7n9|mers|nipah|lassa|plague|cholera|anthrax|hemorrhagic|sars|mpox|monkeypox)/i;

async function fetchText(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } }), t__dl]);
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; } finally { clearTimeout(t__t); }
}

// Collapse runs of 2+ backslashes to one, so every separator reads \"
function normalize(s) { return s.replace(/\\{2,}/g, "\\"); }

// Decode JSON string escapes (\uXXXX, \", \n, ...); tolerates leftover depth.
function decode(s) {
  let cur = s;
  for (let k = 0; k < 4; k++) {
    try { const n = JSON.parse('"' + cur + '"'); if (n === cur) return n; cur = n; }
    catch { return cur; }
  }
  return cur;
}

// Read an escaped string starting at i (just past the opening \").
// A backslash-quote ends the value; other backslash pairs are kept for decode().
function readValue(part, i) {
  let out = "", j = i;
  while (j < part.length) {
    const c = part[j];
    if (c === BS) { if (part[j + 1] === '"') break; out += part.slice(j, j + 2); j += 2; continue; }
    if (c === '"') break;
    out += c; j += 1;
  }
  return out;
}

// Escaped string field: \"name\":\"value\"   Escaped number field: \"name\":123
function strField(part, name) {
  const key = BS + '"' + name + BS + '":' + BS + '"';
  const i = part.indexOf(key);
  return i < 0 ? null : decode(readValue(part, i + key.length));
}
function numField(part, name) {
  const key = BS + '"' + name + BS + '":';
  const i = part.indexOf(key);
  if (i < 0) return null;
  const m = part.slice(i + key.length).match(/^(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// "$D2026-09-23T03:07:46.000Z" (Mongo extended JSON) or plain ISO
function parseDate(s) {
  if (!s) return null;
  const t = new Date(s.charAt(0) === "$" ? s.slice(2) : s).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function firstPlace(part) {
  const i = part.indexOf(BS + '"places' + BS + '":[');
  if (i < 0) return null;
  const seg = part.slice(i, i + 500);
  const name = strField(seg, "name"), country = strField(seg, "country");
  const lon = numField(seg, "lon"), lat = numField(seg, "lat");
  return (name == null || !Number.isFinite(lat) || !Number.isFinite(lon)) ? null : { name, country, lon, lat };
}

function firstDisease(part) {
  const i = part.indexOf(BS + '"diseases' + BS + '":[');
  return i < 0 ? null : strField(part.slice(i, i + 300), "name");
}

module.exports = {
  name: "promed",
  description: "ProMED — recent global disease outbreak alerts",
  async fetch() {
    const html = await fetchText(FEED_URL).catch(() => null);
    if (!html || html.indexOf("subject_line") < 0) return [];
    const norm = normalize(html);
    const parts = norm.split(BS + '"subject_line' + BS + '":' + BS + '"');
    const seen = new Set(), events = [];
    for (let i = 1; i < parts.length && events.length < MAX_EVENTS; i++) {
      const part = parts[i];
      const rawTitle = readValue(part, 0);
      const title = rawTitle ? decode(rawTitle).trim() : "";
      if (!title) continue;
      const alertId = numField(part, "alert_id");
      if (!Number.isFinite(alertId) || seen.has(alertId)) continue;
      seen.add(alertId);
      const issueDate = parseDate(strField(part, "issue_date")) || parseDate(strField(part, "date_created"));
      const place = firstPlace(part), disease = firstDisease(part);
      let summary = strField(part, "generated_summary");
      if (summary && summary.charAt(0) === "$") summary = null; // unresolved payload reference
      if (summary && summary.length > 300) summary = summary.slice(0, 300);
      events.push({
        id: "promed:" + alertId,
        title,
        summary: summary || null,
        lat: place && Number.isFinite(place.lat) ? place.lat : null,
        lon: place && Number.isFinite(place.lon) ? place.lon : null,
        region: (place && (place.country || place.name)) || null,
        time: issueDate || new Date().toISOString(),
        severity: HIGH_SEV.test(title + " " + (disease || "")) ? "high" : "moderate",
        url: FEED_URL,
        attribution: "ProMED",
      });
    }
    return events;
  },
};
