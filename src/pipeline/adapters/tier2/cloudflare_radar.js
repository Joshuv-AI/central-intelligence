// Cloudflare Radar — internet outages and traffic anomalies.
// Requires a key: CLOUDFLARE_API_TOKEN (Bearer), or CLOUDFLARE_API_KEY +
// CLOUDFLARE_API_EMAIL (Basic). Without credentials, returns [].
// Get a token at https://dash.cloudflare.com/profile/api-tokens (Account Analytics Read).

const UA = "Central-Intelligence/1.0";
const TIMEOUT_MS = 20000;
const RADAR_BASE = "https://api.cloudflare.com/client/v4/radar";

// Countries of interest for internet-monitoring anomalies.
const WATCHLIST = new Set([
  "RU", "UA", "CN", "IR", "KP", "SY", "MM", "ET", "SD",
  "YE", "AF", "IQ", "LB", "PS", "TW", "BY", "VE", "CU",
]);

function authHeaders() {
  const apiKey = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_API_EMAIL;
  if (apiKey && email) {
    const enc = Buffer.from(`${email}:${apiKey}`).toString("base64");
    return { Authorization: `Basic ${enc}` };
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token) return { Authorization: `Bearer ${token}` };
  return null;
}

async function getJson(url, headers) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(url, { headers: { "User-Agent": UA, ...headers }, }), t__dl]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t__t);
  }
}

function watchlisted(locations) {
  return (locations || []).filter((l) => WATCHLIST.has(String(l).toUpperCase()));
}

module.exports = {
  name: "cloudflare_radar",
  description: "Internet outages and traffic anomalies in watchlist countries (Cloudflare Radar)",
keyEnv: [["CLOUDFLARE_API_TOKEN"], ["CLOUDFLARE_API_KEY", "CLOUDFLARE_API_EMAIL"]],
  async fetch() {
    try {
      const headers = authHeaders();
      if (!headers) return [];
      const [outagesRes, anomaliesRes] = await Promise.all([
        getJson(`${RADAR_BASE}/annotations/outages?dateRange=30d&format=json`, headers),
        getJson(`${RADAR_BASE}/traffic_anomalies?dateRange=7d&format=json&limit=50`, headers),
      ]);
      const now = Date.now();
      const events = [];

      for (const a of (outagesRes.result && outagesRes.result.annotations) || []) {
        const locs = watchlisted(a.locations);
        if (!locs.length) continue;
        const active = !a.endDate || Date.parse(a.endDate) > now;
        events.push({
          id: `cf-outage-${a.id || locs.join("-")}-${a.startDate}`,
          title: `Internet outage in ${locs.join(", ")}${active ? " (ongoing)" : ""}`,
          summary: a.description ? String(a.description).slice(0, 400) : null,
          lat: null,
          lon: null,
          region: locs.join(", "),
          time: a.startDate || new Date(now).toISOString(),
          severity: active ? "high" : "moderate",
          url: a.linkedUrl || null,
          attribution: "Cloudflare Radar",
        });
        if (events.length >= 20) break;
      }

      for (const a of (anomaliesRes.result && anomaliesRes.result.trafficAnomalies) || []) {
        const locs = a.locationDetails && a.locationDetails.locations
          ? watchlisted(a.locationDetails.locations.map((l) => l.code || l))
          : [];
        if (!locs.length) continue;
        events.push({
          id: `cf-anomaly-${locs.join("-")}-${a.startDate}-${a.type || "t"}`,
          title: `Traffic anomaly in ${locs.join(", ")} (${a.type || "unknown type"})`,
          summary: a.status
            ? `Cloudflare Radar flagged ${a.type || "a traffic"} anomaly; status: ${a.status}.`
            : null,
          lat: null,
          lon: null,
          region: locs.join(", "),
          time: a.startDate || new Date(now).toISOString(),
          severity: "moderate",
          url: null,
          attribution: "Cloudflare Radar",
        });
        if (events.length >= 25) break;
      }

      return events.slice(0, 25);
    } catch {
      return [];
    }
  },
};
