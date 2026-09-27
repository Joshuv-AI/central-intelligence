// NVD CVE — National Vulnerability Database (NIST). Keyless; rate-limited
// to ~5 req/30s without an API key, fine for our scheduler cadence.
// Docs: https://nvd.nist.gov/developers/vulnerabilities

const UA = "Central-Intelligence/1.0";
const TIMEOUT_MS = 20000;

async function getJson(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    }), t__dl]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t__t);
  }
}

function fmtNvd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000`;
}

module.exports = {
  name: "nvd_cve",
  description: "Recently published high/critical CVEs (CVSS >= 7) from the NVD",
  async fetch() {
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 2 * 86400_000); // published in the last 2 days
      const url =
        "https://services.nvd.nist.gov/rest/json/cves/2.0?" +
        `pubStartDate=${encodeURIComponent(fmtNvd(start))}&` +
        `pubEndDate=${encodeURIComponent(fmtNvd(now))}&resultsPerPage=100`;
      const data = await getJson(url);
      const out = [];
      for (const v of data.vulnerabilities || []) {
        const cve = v.cve || {};
        const m = cve.metrics || {};
        const metric =
          (m.cvssMetricV31 && m.cvssMetricV31[0]) ||
          (m.cvssMetricV30 && m.cvssMetricV30[0]) ||
          (m.cvssMetricV2 && m.cvssMetricV2[0]);
        const score = metric && metric.cvssData && metric.cvssData.baseScore;
        if (typeof score !== "number" || score < 7) continue;
        const desc = (cve.descriptions || []).find((d) => d.lang === "en");
        const sev = score >= 9 ? "critical" : "high";
        out.push({
          id: cve.id,
          title: `${cve.id} — CVSS ${score} (${sev.toUpperCase()})`,
          summary: desc ? desc.value.slice(0, 400) : null,
          lat: null,
          lon: null,
          region: null,
          time: cve.published,
          severity: sev,
          url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
          attribution: "NVD",
          _score: score,
        });
      }
      // Critical first, then highest score; cap 25.
      out.sort((a, b) => b._score - a._score);
      return out.slice(0, 25).map(({ _score, ...rec }) => rec);
    } catch {
      return [];
    }
  },
};
