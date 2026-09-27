"use strict";
// WHO Disease Outbreak News — keyless JSON API.
// The old RSS feed (/feeds/entity/don/en/rss.xml) returns 404; this JSON
// endpoint returns ~50 items and ignores OData $orderby, so we sort
// client-side by PublicationDate descending and keep the last 30 days.

const DON_API = "https://www.who.int/api/news/diseaseoutbreaknews";
const LOOKBACK_DAYS = 30;
const LIMIT = 20;
const TIMEOUT_MS = 20_000;

function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || null;
}

module.exports = {
  name: "who",
  description: "WHO Disease Outbreak News — recent outbreak items",
  async fetch() {
    try {
      let timer__t;
      const timer__dl = new Promise((_, timer__rej) => { timer__t = setTimeout(() => timer__rej(new Error('timeout')), TIMEOUT_MS); });
      timer__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
      let data;
      try {
        const res = await Promise.race([fetch(DON_API, {
          headers: { "User-Agent": "Central-Intelligence/1.0" },
        }), timer__dl]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } finally {
        clearTimeout(timer__t);
      }
      const items = Array.isArray(data?.value) ? data.value : [];
      items.sort((a, b) => new Date(b.PublicationDate || 0) - new Date(a.PublicationDate || 0));
      const cutoff = Date.now() - LOOKBACK_DAYS * 86400_000;
      const now = new Date().toISOString();
      return items
        .filter((it) => new Date(it.PublicationDate || 0).getTime() >= cutoff)
        .slice(0, LIMIT)
        .map((it) => {
          const title = stripHtml(it.Title) || "WHO disease outbreak update";
          const summary = (stripHtml(it.Summary || it.Overview) || "").slice(0, 300) || null;
          const pub = it.PublicationDate ? new Date(it.PublicationDate).toISOString() : now;
          const donId = it.DonId || Buffer.from(title).toString("base64").slice(0, 12);
          const url = it.ItemDefaultUrl
            ? `https://www.who.int/emergencies/disease-outbreak-news${it.ItemDefaultUrl}`
            : null;
          return {
            id: `who_don_${donId}`,
            title: title.slice(0, 140),
            summary,
            lat: null,
            lon: null,
            region: null,
            time: pub,
            severity: "moderate",
            url,
            attribution: "WHO",
          };
        });
    } catch {
      return [];
    }
  },
};
