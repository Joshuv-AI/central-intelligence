// Central Intelligence — infrastructure status (unique signals only).
// Cloudflare Radar is covered by its own adapter and skipped here.
// This adapter emits maritime chokepoint traffic statuses from IMF PortWatch
// (daily AIS-derived transit counts, public ArcGIS REST, keyless).
// US power-grid status has no verifiable keyless feed, so it is skipped.
"use strict";

const UA = "Central-Intelligence/1.0";
const PORTWATCH_QUERY =
  "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query";
const PORTWATCH_PAGE = "https://portwatch.imf.org/";

const COORDS = {
  "Suez Canal": [30.4, 32.3],
  "Panama Canal": [9.1, -79.7],
  "Bab el-Mandeb Strait": [12.6, 43.4],
  "Malacca Strait": [4.0, 100.0],
  "Strait of Hormuz": [26.6, 56.3],
  "Cape of Good Hope": [-35.2, 18.4],
  "Strait of Gibraltar": [36.0, -5.6],
  "Taiwan Strait": [24.3, 119.5],
  "Dover Strait": [51.0, 1.5],
  Bosphorus: [41.1, 29.1],
  "Bosporus Strait": [41.1, 29.1],
  "Gibraltar Strait": [36.0, -5.6],
  "Korea Strait": [34.6, 129.2],
  "Oresund Strait": [55.8, 12.9],
};

function timedFetch(url, ms = 20000) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), ms); });
  timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  return Promise.race([fetch(url, { headers: { "User-Agent": UA }, }), timer__dl])
    .finally(() => clearTimeout(timer__t));
}

async function fetchChokepointRows() {
  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    outFields: "date,portid,portname,n_tanker,n_total,capacity_tanker,capacity",
    orderByFields: "date DESC",
    returnGeometry: "false",
    resultRecordCount: "400",
  });
  const res = await timedFetch(`${PORTWATCH_QUERY}?${params}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const features = data && Array.isArray(data.features) ? data.features : null;
  if (!features || !features.length) return null;
  return features.map((f) => f.attributes).filter((a) => a && a.portid && a.date);
}

function chokepointRecord(portid, rows) {
  rows.sort((a, b) => b.date - a.date);
  const latest = rows[0];
  const baseline = rows.slice(1);
  if (!latest || baseline.length < 7) return null;

  const mean = baseline.reduce((s, r) => s + (r.n_total || 0), 0) / baseline.length;
  const latestTotal = latest.n_total || 0;
  const dev = mean > 0 ? (latestTotal - mean) / mean : 0;
  const pct = Math.round(dev * 100);
  const day = new Date(latest.date).toISOString().slice(0, 10);
  const portname = latest.portname || portid;
  const coords = COORDS[portname];

  const direction = pct >= 0 ? `${pct}% above` : `${Math.abs(pct)}% below`;
  const normal = Math.abs(pct) < 10;
  return {
    id: `infra-chokepoint-${portid}-${day}`,
    title: normal
      ? `${portname} — vessel traffic normal`
      : `${portname} — vessel traffic ${direction} recent average`,
    summary:
      `${latestTotal} vessel transits on ${day} (${latest.n_tanker || 0} tankers), ` +
      `${normal ? "in line with" : `${direction}`} the ${baseline.length}-day average of ${Math.round(mean)}. ` +
      `AIS-derived estimate via IMF PortWatch.`,
    lat: coords ? coords[0] : null,
    lon: coords ? coords[1] : null,
    region: null,
    time: new Date(latest.date).toISOString(),
    severity: Math.abs(pct) >= 25 ? "high" : Math.abs(pct) >= 10 ? "moderate" : "low",
    url: PORTWATCH_PAGE,
    attribution: "IMF PortWatch",
  };
}

module.exports = {
  name: "infrastructure",
  description: "Maritime chokepoint traffic statuses (unique signals only)",
  async fetch() {
    try {
      const rows = await fetchChokepointRows();
      if (!rows) return [];
      const byPort = new Map();
      for (const r of rows) {
        if (!byPort.has(r.portid)) byPort.set(r.portid, []);
        byPort.get(r.portid).push(r);
      }
      const records = [];
      for (const [portid, portRows] of byPort) {
        const rec = chokepointRecord(portid, portRows);
        if (rec) records.push(rec);
      }
      return records;
    } catch {
      return [];
    }
  },
};
