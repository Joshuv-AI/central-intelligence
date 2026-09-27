"use strict";
// NOAA disasters — keyless free public endpoints (confirmed working):
//   1. FEMA Open API — weather disaster declarations, last 30 days.
//   2. USGS Water Services — major river gauges; emits an event only when a
//      gauge is at/above action stage (85% of flood stage) or flooding.
// (SPC outlooks/watches live in the separate noaa_spc adapter.)

const TIMEOUT_MS = 20_000;
const UA = { "User-Agent": "Central-Intelligence/1.0" };

async function fetchJson(url, timeout = TIMEOUT_MS) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), timeout); });
  try {
    const res = await Promise.race([fetch(url, { headers: UA }, timer__dl)]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer__t);
  }
}

async function fetchFema() {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const url =
    "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries" +
    "?$top=20" +
    "&$orderby=declarationDate desc" +
    `&$filter=declarationDate ge ${since}` +
    " and (incidentType eq 'Severe Storm' or incidentType eq 'Tornado' or " +
    "incidentType eq 'Flood' or incidentType eq 'Snow' or " +
    "incidentType eq 'Fire' or incidentType eq 'Severe Ice Storm')";
  const data = await fetchJson(url);
  const rows = data?.DisasterDeclarationsSummaries || [];
  const seenIds = new Set();
  return rows.map((d) => {
    const type = d.incidentType || "Disaster";
    const high = /tornado|flood/i.test(type);
    // FEMA returns multiple rows per (disaster, state); disambiguate with
    // incident type + date, plus a counter fallback for true duplicates.
    let id = `fema_${d.disasterNumber}_${d.state || "NA"}_${String(type).toLowerCase().replace(/[^a-z0-9]+/g, "-")}_${String(d.declarationDate || "").slice(0, 10)}`;
    let n = 2;
    while (seenIds.has(id)) id = `${id.replace(/-\d+$/, "")}-${n++}`;
    seenIds.add(id);
    return {
      id,
      title: `FEMA: ${d.declarationTitle || type} — ${d.state || "US"}`.slice(0, 140),
      summary: `${type} disaster declaration #${d.disasterNumber} in ${d.state || "US"}, declared ${String(d.declarationDate || "").slice(0, 10)}.`,
      lat: null,
      lon: null,
      region: d.state || "US",
      time: d.declarationDate ? new Date(d.declarationDate).toISOString() : new Date().toISOString(),
      severity: high ? "high" : "moderate",
      url: `https://www.fema.gov/disaster/${d.disasterNumber}`,
      attribution: "NOAA",
    };
  });
}

const MAJOR_GAUGES = [
  { site: "07144100", name: "Arkansas River at Tulsa, OK", state: "OK", floodStage: 21.0 },
  { site: "06805500", name: "Missouri River at Kansas City", state: "MO", floodStage: 22.0 },
  { site: "01646500", name: "Potomac River at Washington, DC", state: "MD", floodStage: 18.0 },
  { site: "08067500", name: "Trinity River at Liberty, TX", state: "TX", floodStage: 26.0 },
  { site: "09383000", name: "San Juan River at Bluff, UT", state: "UT", floodStage: 16.0 },
  { site: "06716500", name: "South Platte River at Denver, CO", state: "CO", floodStage: 8.0 },
];

async function fetchGauges() {
  const events = [];
  for (const g of MAJOR_GAUGES) {
    try {
      const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${g.site}&parameterCd=00065&agencyCd=USGS`;
      const data = await fetchJson(url, 10_000);
      const series = data?.value?.timeSeries?.[0]?.values?.[0]?.value;
      if (!series || !series.length) continue;
      const latest = parseFloat(series[series.length - 1].value);
      if (!Number.isFinite(latest)) continue;
      const actionFt = g.floodStage * 0.85;
      const flooding = latest >= g.floodStage;
      if (latest < actionFt) continue; // quiet gauges emit nothing
      const pct = Math.round((latest / g.floodStage) * 100);
      events.push({
        id: `usgs_gauge_${g.site}`,
        title: `${flooding ? "FLOOD" : "High water"}: ${g.name} — ${latest.toFixed(2)} ft`.slice(0, 140),
        summary: `River at ${latest.toFixed(2)} ft (${pct}% of ${g.floodStage} ft flood stage).`,
        lat: null,
        lon: null,
        region: g.state,
        time: new Date().toISOString(),
        severity: flooding ? "high" : "moderate",
        url: `https://waterdata.usgs.gov/nwis/uv?site_no=${g.site}`,
        attribution: "NOAA",
      });
    } catch { /* gauge failures are non-fatal */ }
  }
  return events;
}

module.exports = {
  name: "noaa_disasters",
  description: "NOAA-linked disasters — FEMA declarations + flooding river gauges",
  async fetch() {
    try {
      const [fema, gauges] = await Promise.all([fetchFema(), fetchGauges()]);
      return [...fema, ...gauges].slice(0, 30);
    } catch {
      return [];
    }
  },
};
