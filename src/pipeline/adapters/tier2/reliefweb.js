"use strict";
// ReliefWeb v2 disasters API (UN OCHA) — keyless.
// v1 is decommissioned; v2 REQUIRES POST with a JSON body (GET returns 406).
// `appname` is a plain client identifier, not a secret; RELIEFWEB_APPNAME
// may override the default. NOTE: ReliefWeb only accepts *approved* appnames
// (request at https://apidoc.reliefweb.int/parameters#appname); until one is
// approved the API returns 403 and this adapter yields no events.

const ENDPOINT = "https://api.reliefweb.int/v2/disasters";
const APPNAME = process.env.RELIEFWEB_APPNAME || "central-intelligence";
// v2 takes appname as a query parameter (body-only appname returns 400).
const URL = `${ENDPOINT}?appname=${encodeURIComponent(APPNAME)}`;
const LOOKBACK_DAYS = 7;
const LIMIT = 20;
const TIMEOUT_MS = 20_000;

async function postJson(url, body) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
  timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "Central-Intelligence/1.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }), timer__dl]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer__t);
  }
}

module.exports = {
  name: "reliefweb",
  description: "ReliefWeb — UN OCHA disaster reports from the last 7 days",
  async fetch() {
    try {
      // ReliefWeb range filters need ISO 8601 *dates* (YYYY-MM-DD), not datetimes.
      const from = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const data = await postJson(URL, {
        limit: LIMIT,
        profile: "list",
        preset: "latest",
        filter: { field: "date.created", value: { from, to } },
        fields: { include: ["name", "type", "country", "status", "date", "url"] },
      });
      const items = Array.isArray(data?.data) ? data.data : [];
      const now = new Date().toISOString();
      return items.map((d) => {
        const f = d.fields || {};
        const type = f.type?.[0]?.name || "Disaster";
        const country = f.country?.[0]?.name || null;
        const status = f.status || "ongoing";
        const date = f.date?.event || f.date?.created || null;
        const disasterId = f.id ?? d.id ?? "unknown";
        return {
          id: `reliefweb_${disasterId}`,
          title: `${type} — ${country || "Multiple countries"}: ${f.name || "Unnamed disaster"}`.slice(0, 140),
          summary: `Status: ${status}. ${type} affecting ${country || "multiple countries"}.`,
          lat: null,
          lon: null,
          region: country,
          time: date ? new Date(date).toISOString() : now,
          severity: status === "alert" ? "high" : "moderate",
          url: f.url || "https://reliefweb.int/disasters",
          attribution: "ReliefWeb",
        };
      });
    } catch {
      return [];
    }
  },
};
