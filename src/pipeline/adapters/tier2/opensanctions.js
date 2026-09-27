// OpenSanctions — aggregated global sanctions / PEP watchlists.
// Requires OPENSANCTIONS_API_KEY. Runs a broad sanctions search and emits
// one event per entity first seen in the last ~7 days (cap 25).
// API docs: https://api.opensanctions.org

const BASE = "https://api.opensanctions.org";
const UA = "Central-Intelligence/1.0";
const TIMEOUT_MS = 20000;
const LOOKBACK_DAYS = 7;
const MAX_EVENTS = 25;

async function osFetch(path, key) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(`${BASE}${path}`, {
      headers: { Authorization: key, "User-Agent": UA, Accept: "application/json" },
    }), t__dl]);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

function asLabel(v) {
  if (typeof v === "string") return v;
  return (v && v.label) || "";
}

module.exports = {
  name: "opensanctions",
  description: "OpenSanctions — newly listed sanctioned entities",
keyEnv: "OPENSANCTIONS_API_KEY",
  async fetch() {
    const key = process.env.OPENSANCTIONS_API_KEY;
    if (!key) return [];

    let data = null;
    try {
      data = await osFetch("/search/sanctions?limit=100", key);
    } catch {
      return [];
    }
    const results = (data && data.results) || [];
    const cutoff = Date.now() - LOOKBACK_DAYS * 86400000;

    const fresh = results
      .filter((e) => e && e.id && e.first_seen && new Date(e.first_seen).getTime() >= cutoff)
      .sort((a, b) => new Date(b.first_seen) - new Date(a.first_seen))
      .slice(0, MAX_EVENTS);

    const now = new Date().toISOString();
    return fresh.map((e) => {
      const name = e.caption || e.name || e.id;
      const countries = ((e.properties && e.properties.country) || []).map(asLabel).filter(Boolean);
      const programs = ((e.properties && e.properties.programId) || []).map(String).filter(Boolean);
      const datasets = (e.datasets || []).slice(0, 4);
      const bits = [];
      if (e.schema) bits.push(`listed as ${e.schema}`);
      if (datasets.length) bits.push(`in ${datasets.join(", ")}`);
      if (countries.length) bits.push(`linked to ${countries.slice(0, 3).join(", ")}`);
      if (programs.length) bits.push(`programs: ${programs.slice(0, 3).join(", ")}`);
      return {
        id: `opensanctions:${e.id}`,
        title: `New sanctions listing: ${name}`,
        summary: bits.length
          ? `${name} was added to sanctions watchlists (${bits.join("; ")}).`
          : `${name} was added to sanctions watchlists.`,
        lat: null,
        lon: null,
        region: countries[0] || null,
        time: e.first_seen || now,
        severity: "moderate",
        url: `https://www.opensanctions.org/entities/${encodeURIComponent(e.id)}/`,
        attribution: "OpenSanctions",
      };
    });
  },
};
