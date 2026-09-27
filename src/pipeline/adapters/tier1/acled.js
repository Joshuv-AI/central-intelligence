// Central Intelligence — ACLED (Armed Conflict Location & Event Data).
// Requires ACLED_EMAIL + ACLED_PASSWORD env vars. Auth: OAuth2 password
// grant first, cookie-session fallback. Returns recent conflict events.
// https://acleddata.com
"use strict";

const TOKEN_URL = "https://acleddata.com/oauth/token";
const LOGIN_URL = "https://acleddata.com/user/login?_format=json";
const API_BASE = "https://acleddata.com/api/acled/read";
const UA = "Central-Intelligence/1.0";

// Module-scoped session cache; scheduler may call fetch() on every sweep.
let session = null;

function timedFetch(url, opts, ms = 20000) {
  let timer__t;
  const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), ms); });
  timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  return Promise.race([fetch(url, { ...opts, }), timer__dl])
    .finally(() => clearTimeout(timer__t));
}

// OAuth2 password grant — the official programmatic method.
async function loginOAuth(email, password) {
  const res = await timedFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ username: email, password, grant_type: "password", client_id: "acled" }).toString(),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.access_token) return null;
  return { method: "oauth", token: data.access_token, expires: Date.now() + 23 * 3600 * 1000 };
}

// Cookie session — mirrors the browser login form.
async function loginCookie(email, password) {
  const res = await timedFetch(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ name: email, pass: password }),
    redirect: "manual",
  });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const jar = setCookies.map((c) => c.split(";")[0]).join("; ");
  if (jar && (res.ok || (res.status >= 300 && res.status < 400))) {
    return { method: "cookie", cookies: jar, expires: Date.now() + 12 * 3600 * 1000 };
  }
  return null;
}

function severityOf(eventType, fatalities) {
  if (fatalities >= 10) return "critical";
  if (fatalities > 0) return "high";
  if (eventType === "Violence against civilians") return "high";
  if (eventType === "Battles" || eventType === "Explosions/Remote violence") return "moderate";
  return "low";
}

function toRecord(e) {
  const id = e.event_id_no_cnt || e.event_id_cnty;
  if (!id) return null;
  const lat = parseFloat(e.latitude);
  const lon = parseFloat(e.longitude);
  const fatalities = parseInt(e.fatalities, 10) || 0;
  const where = e.location || e.admin1 || e.country || "";
  return {
    id: `acled-${id}`,
    title: `${e.event_type || "Conflict event"}${where ? " — " + where : ""}`,
    summary: e.notes ? String(e.notes).slice(0, 300) : null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    region: e.region || e.country || null,
    time: e.event_date ? `${e.event_date}T00:00:00Z` : new Date().toISOString(),
    severity: severityOf(e.event_type, fatalities),
    url: null,
    attribution: "ACLED",
  };
}

module.exports = {
  name: "acled",
  description: "ACLED — armed conflict location and event data",
keyEnv: ["ACLED_EMAIL", "ACLED_PASSWORD"],
  async fetch() {
    try {
      const email = process.env.ACLED_EMAIL;
      const password = process.env.ACLED_PASSWORD;
      if (!email || !password) return []; // credentials required

      if (!session || Date.now() >= session.expires) {
        session = (await loginOAuth(email, password)) || (await loginCookie(email, password));
        if (!session) return [];
      }

      const now = new Date();
      const fmt = (d) => d.toISOString().slice(0, 10);
      const params = new URLSearchParams({
        _format: "json",
        limit: "500",
        event_date: `${fmt(new Date(now.getTime() - 7 * 86400 * 1000))}|${fmt(now)}`,
        event_date_where: "BETWEEN",
      });
      const headers = { "User-Agent": UA };
      if (session.method === "oauth") headers.Authorization = `Bearer ${session.token}`;
      else headers.Cookie = session.cookies;

      const res = await timedFetch(`${API_BASE}?${params}`, { headers });
      if (res.status === 401 || res.status === 403) { session = null; return []; }
      if (!res.ok) return [];
      const data = await res.json().catch(() => null);
      const events = data && data.status === 200 && Array.isArray(data.data) ? data.data : [];
      return events.map(toRecord).filter(Boolean);
    } catch {
      return [];
    }
  },
};
