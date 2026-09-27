// safecast — Citizen radiation monitoring (no auth, CC0 public domain).
// Endpoint: https://api.safecast.org/measurements.json (keyless).
// Monitors recent readings near key nuclear sites; emits an event only when
// the average CPM exceeds the elevated threshold (>100 CPM; background 10-80).
// Readings older than 30 days are ignored so stale imports never raise alerts.

const UA = "Central-Intelligence/1.0";
const TIMEOUT_MS = 10000; // per-site; the API occasionally hangs on one geo query
const BASE = "https://api.safecast.org";
const MAX_EVENTS = 20;
const ELEVATED_CPM = 100; // vendor threshold: >100 CPM warrants attention
const HIGH_CPM = 300;
const SINCE_DAYS = 30;

const NUCLEAR_SITES = [
  { key: "zaporizhzhia", lat: 47.51, lon: 34.58, label: "Zaporizhzhia NPP", region: "Ukraine", radiusKm: 100 },
  { key: "chernobyl", lat: 51.39, lon: 30.1, label: "Chernobyl Exclusion Zone", region: "Ukraine", radiusKm: 50 },
  { key: "bushehr", lat: 28.83, lon: 50.89, label: "Bushehr NPP", region: "Iran", radiusKm: 100 },
  { key: "yongbyon", lat: 39.8, lon: 125.75, label: "Yongbyon", region: "North Korea", radiusKm: 100 },
  { key: "fukushima", lat: 37.42, lon: 141.03, label: "Fukushima Daiichi", region: "Japan", radiusKm: 50 },
  { key: "dimona", lat: 31.0, lon: 35.15, label: "Dimona", region: "Israel", radiusKm: 100 },
];

async function getJson(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  try {
    const res = await Promise.race([fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    }, t__dl)]);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

async function checkSite(site, since) {
  const params = new URLSearchParams({
    latitude: String(site.lat),
    longitude: String(site.lon),
    distance: String(site.radiusKm * 1000), // meters
    limit: "25",
    since,
  });
  const data = await getJson(`${BASE}/measurements.json?${params}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  // Normalize to CPM: Safecast reports both cpm and usv. For the bGeigie
  // tube Safecast uses ~330 CPM per 1 uSv/h, so convert usv readings to a
  // CPM-equivalent before applying the >100 CPM threshold.
  const cpms = data
    .map((m) => {
      if (typeof m.value !== "number" || !isFinite(m.value) || m.value < 0) return null;
      const unit = String(m.unit || "").toLowerCase();
      if (unit === "cpm") return m.value;
      if (unit === "usv") return m.value * 330;
      return null;
    })
    .filter((v) => v !== null);
  if (cpms.length === 0) return null;
  const avg = cpms.reduce((a, b) => a + b, 0) / cpms.length;
  if (avg <= ELEVATED_CPM) return null;
  const max = Math.max(...cpms);
  const latest = data.find((m) => m.captured_at)?.captured_at;
  const ts = latest && !isNaN(Date.parse(latest)) ? new Date(latest).toISOString() : new Date().toISOString();
  return {
    id: `safecast-${site.key}`,
    title: `Elevated radiation near ${site.label}`,
    summary: `Average ${avg.toFixed(1)} CPM across ${cpms.length} recent readings (peak ${max.toFixed(0)} CPM; normal background 10-80 CPM).`,
    lat: site.lat,
    lon: site.lon,
    region: site.region,
    time: ts,
    severity: max >= HIGH_CPM ? "high" : "moderate",
    url: "https://map.safecast.org/",
    attribution: "Safecast",
    _avg: avg,
  };
}

module.exports = {
  name: "safecast",
  description: "Safecast — elevated radiation events near nuclear sites",
  async fetch() {
    try {
      const since = new Date(Date.now() - SINCE_DAYS * 86400_000).toISOString().slice(0, 10);
      const results = await Promise.allSettled(NUCLEAR_SITES.map((s) => checkSite(s, since)));
      const events = results
        .filter((r) => r.status === "fulfilled" && r.value)
        .map((r) => r.value)
        .sort((a, b) => b._avg - a._avg)
        .slice(0, MAX_EVENTS);
      return events.map(({ _avg, ...rec }) => rec);
    } catch {
      return [];
    }
  },
};
