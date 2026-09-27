// OFAC — US Treasury Office of Foreign Assets Control sanctions lists.
// Keyless. Reads the SDN / consolidated list publication headers via the
// sanctionslistservice.ofac.treas.gov export endpoints (which 302 to signed
// S3 URLs) and emits one event per list republished within the last 10 days.

const EXPORTS = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports";
const UA = "Central-Intelligence/1.0";
const TIMEOUT_MS = 20000;
const RECENT_DAYS = 10;

const LISTS = [
  { key: "sdn", name: "SDN list", path: "SDN.XML" },
  { key: "consolidated", name: "consolidated sanctions list", path: "CONS_ADVANCED.XML" },
];

// Only the XML header is needed (publish date + record count), so fetch the
// first bytes via Range and let the redirect be followed automatically.
async function fetchHeader(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(url, {
      headers: { "User-Agent": UA, Range: "bytes=0-8191" },
      redirect: "follow",
    }), t__dl]);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t__t);
  }
}

function parseHeader(xml) {
  if (!xml) return null;
  let date = (xml.match(/<Publish_Date>([^<]*)<\/Publish_Date>/) || [])[1];
  const count = (xml.match(/<Record_Count>([^<]*)<\/Record_Count>/) || [])[1];
  if (!date) {
    // Advanced-format lists use <DateOfIssue><Year>..<Month>..<Day>
    const doi = xml.match(/<DateOfIssue>[\s\S]*?<Year>(\d+)<\/Year>[\s\S]*?<Month>(\d+)<\/Month>[\s\S]*?<Day>(\d+)<\/Day>/);
    if (doi) date = `${doi[2].padStart(2, "0")}/${doi[3].padStart(2, "0")}/${doi[1]}`;
  }
  return {
    date: date ? date.trim() : null,
    count: count ? count.trim() : null,
  };
}

// OFAC publish dates look like MM/DD/YYYY
function parsePubDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || "");
  if (!m) return null;
  return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
}

module.exports = {
  name: "ofac",
  description: "OFAC sanctions list publication updates (SDN + consolidated)",
  async fetch() {
    const now = Date.now();
    const out = [];
    for (const list of LISTS) {
      let xml = null;
      try {
        xml = await fetchHeader(`${EXPORTS}/${list.path}`);
      } catch {
        xml = null;
      }
      const meta = parseHeader(xml);
      if (!meta || !meta.date) continue;
      const pub = parsePubDate(meta.date);
      if (!pub) continue;
      const ageDays = (now - pub.getTime()) / 86400000;
      if (ageDays > RECENT_DAYS || ageDays < 0) continue;
      out.push({
        id: `ofac:${list.key}:${meta.date.replace(/\//g, "-")}`,
        title: `OFAC ${list.name} updated`,
        summary: `OFAC republished the ${list.name} on ${meta.date}${
          meta.count ? ` with ${meta.count} records` : ""
        }.`,
        lat: null,
        lon: null,
        region: null,
        time: pub.toISOString(),
        severity: "moderate",
        url: `${EXPORTS}/${list.path}`,
        attribution: "OFAC",
      });
    }
    return out;
  },
};
