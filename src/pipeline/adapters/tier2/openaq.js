// openaq — Global air quality measurements (OpenAQ v3 API).
// NOTE: OpenAQ retired the keyless v2 API; v3 REQUIRES an API key sent as
// the X-API-Key header. Without OPENAQ_API_KEY this adapter returns [].
// Docs: https://docs.openaq.org/
// Emits events only for unhealthy readings (US AQI >= 151), capped at 20.

const UA = "Central-Intelligence/1.0";
const TIMEOUT_MS = 20000;
const BASE = "https://api.openaq.org/v3";
const MAX_EVENTS = 20;

// US EPA PM2.5 breakpoints: [concLow, concHigh, aqiLow, aqiHigh]
const PM25_BREAKS = [
  [0.0, 12.0, 0, 50],
  [12.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 150.4, 151, 200],
  [150.5, 250.4, 201, 300],
  [250.5, 500.0, 301, 500],
];

function pm25ToAqi(c) {
  for (const [cl, ch, al, ah] of PM25_BREAKS) {
    if (c >= cl && c <= ch) return Math.round(((ah - al) / (ch - cl)) * (c - cl) + al);
  }
  return c > 500 ? 500 : 0;
}

async function getJson(url, key) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  try {
    const res = await Promise.race([fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", "X-API-Key": key },
    }, t__dl)]);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

module.exports = {
  name: "openaq",
  description: "OpenAQ v3 — unhealthy air quality events (PM2.5)",
keyEnv: "OPENAQ_API_KEY",
  async fetch() {
    try {
      const key = process.env.OPENAQ_API_KEY;
      if (!key) return []; // v3 requires a key; v2 keyless API is retired
      const data = await getJson(`${BASE}/latest?limit=100`, key);
      const results = Array.isArray(data?.results) ? data.results : [];
      // Keep worst PM2.5 reading per location
      const byLoc = new Map();
      for (const r of results) {
        const param = (r?.sensors?.parameter?.name || "").toLowerCase();
        if (param !== "pm25") continue;
        const v = parseFloat(r.value);
        if (!isFinite(v) || v < 0) continue;
        const locId = r.locationsId ?? r?.locations?.id ?? "unknown";
        const prev = byLoc.get(locId);
        if (!prev || v > prev.value) {
          const coords = r.coordinates || r?.locations?.coordinates || {};
          byLoc.set(locId, {
            value: v,
            lat: coords.latitude ?? coords.lat ?? null,
            lon: coords.longitude ?? coords.lon ?? null,
            name: r?.locations?.name || r?.locations?.locality || "Unknown station",
            country: r?.locations?.country?.name || r?.locations?.country?.code || null,
            time: r?.datetime?.utc || null,
          });
        }
      }
      const events = [];
      for (const [locId, s] of byLoc) {
        const aqi = pm25ToAqi(s.value);
        if (aqi < 151) continue; // emit only unhealthy or worse
        const ts = s.time && !isNaN(Date.parse(s.time)) ? new Date(s.time).toISOString() : new Date().toISOString();
        events.push({
          id: `openaq-pm25-${locId}`,
          title: `Unhealthy air quality near ${s.name}`,
          summary: `PM2.5 at ${s.value.toFixed(1)} \u00b5g/m\u00b3 (US AQI ${aqi}, unhealthy).`,
          lat: s.lat,
          lon: s.lon,
          region: s.country,
          time: ts,
          severity: aqi >= 201 ? "critical" : "high",
          url: "https://explore.openaq.org/",
          attribution: "OpenAQ",
          _aqi: aqi,
        });
      }
      return events
        .sort((a, b) => b._aqi - a._aqi)
        .slice(0, MAX_EVENTS)
        .map(({ _aqi, ...rec }) => rec);
    } catch {
      return [];
    }
  },
};
