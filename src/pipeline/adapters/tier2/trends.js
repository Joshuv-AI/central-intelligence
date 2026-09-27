// trends — Google Trends "Trending Now" RSS (keyless).
// Endpoint note: the legacy /trends/trendingsearches/daily/rss feed is dead
// (404); the live feed is https://trends.google.com/trending/rss?geo=<GEO>.
// Emits rising search queries as events.

const UA = "Central-Intelligence/1.0";
const TIMEOUT_MS = 20000;
const GEOS = ["US"]; // extend with e.g. "GB", "IN" if broader coverage is wanted
const MAX_EVENTS = 20;

function stableId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

async function getText(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  try {
    const res = await Promise.race([fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" },
    }, t__dl)]);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

function field(block, tag) {
  const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
  return m ? decode(m[1].trim()) : "";
}

// Feed titles carry HTML entities (&amp; etc.) — decode the common ones.
function decode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

// "2000+" / "20K+" / "1M+" -> approximate search count
function trafficCount(s) {
  const m = String(s).match(/([\d.]+)\s*([KM])?/i);
  if (!m) return 0;
  const mult = (m[2] || "").toUpperCase() === "M" ? 1e6 : (m[2] || "").toUpperCase() === "K" ? 1e3 : 1;
  return parseFloat(m[1]) * mult;
}

function parseItems(xml, geo) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = field(block, "title");
    if (!title) continue;
    const traffic = field(block, "ht:approx_traffic");
    const newsTitle = field(block, "ht:news_item_title");
    const newsUrl = field(block, "ht:news_item_url");
    const newsSource = field(block, "ht:news_item_source");
    const pub = field(block, "pubDate");
    const ts = pub && !isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : new Date().toISOString();
    const searches = trafficCount(traffic);
    out.push({
      id: `trends-${geo.toLowerCase()}-${stableId(title)}`,
      title: `Trending search: ${title}`,
      summary: searches
        ? `Rising query with ~${traffic} searches. Related story: ${newsTitle || "n/a"}${newsSource ? ` (${newsSource})` : ""}.`
        : `Rising query. Related story: ${newsTitle || "n/a"}${newsSource ? ` (${newsSource})` : ""}.`,
      lat: null,
      lon: null,
      region: geo === "US" ? "United States" : geo,
      time: ts,
      severity: searches >= 50000 ? "high" : "moderate",
      url: newsUrl || `https://trends.google.com/trending/rss?geo=${geo}`,
      attribution: "Google Trends",
      _traffic: searches,
    });
  }
  return out;
}

module.exports = {
  name: "trends",
  description: "Google Trends rising search queries (keyless RSS)",
  async fetch() {
    try {
      const per = await Promise.all(
        GEOS.map(async (geo) => {
          const xml = await getText(`https://trends.google.com/trending/rss?geo=${geo}`);
          return xml ? parseItems(xml, geo) : [];
        })
      );
      const all = per.flat().sort((a, b) => b._traffic - a._traffic).slice(0, MAX_EVENTS);
      return all.map(({ _traffic, ...rec }) => rec);
    } catch {
      return [];
    }
  },
};
