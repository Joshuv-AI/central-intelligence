// RIPE RIS — Routing Information Service. Keyless, public.
// Flags BGP routing anomalies for major networks by comparing the latest
// 6-hour announcement count against its own trailing baseline (spike =
// route leak / churn; collapse = mass withdrawals, possible outage), and
// flags ASNs whose originating prefix count drops to zero.
// Docs: https://stat.ripe.net/docs/data-api/

const UA = "Central-Intelligence/1.0";
const TIMEOUT_MS = 20000;
const STAT = "https://stat.ripe.net/data";

const TARGETS = [
  { asn: "16509", label: "AWS" },
  { asn: "13335", label: "Cloudflare" },
  { asn: "15169", label: "Google" },
  { asn: "8075", label: "Microsoft" },
  { asn: "20940", label: "Akamai" },
];

async function getJson(url) {
  let t__t;
  const t__dl = new Promise((_, t__rej) => { t__t = setTimeout(() => t__rej(new Error('timeout')), TIMEOUT_MS); });
  t__dl.catch(() => {}); // guard: a fired deadline must never reject unobserved (Node 24 crashes the process on unhandled rejection)
  try {
    const res = await Promise.race([fetch(url, { headers: { "User-Agent": UA }, }), t__dl]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t__t);
  }
}

async function checkAsn({ asn, label }) {
  const events = [];
  const act = await getJson(`${STAT}/bgp-update-activity/data.json?resource=AS${asn}`);
  const samples = (act.data && act.data.updates) || [];
  if (samples.length >= 8) {
    const vals = samples.map((s) => Number(s.announcements) || 0);
    const last = vals[vals.length - 1];
    const base = vals.slice(0, -1).reduce((a, b) => a + b, 0) / (vals.length - 1);
    if (base > 0) {
      const ratio = last / base;
      if (ratio >= 2.5) {
        events.push({
          id: `ripe-spike-${asn}-${samples[samples.length - 1].starttime}`,
          title: `BGP announcement spike at ${label} (AS${asn})`,
          summary: `Latest 6h announcements (${Math.round(last).toLocaleString("en-US")}) are ${ratio.toFixed(1)}x the recent baseline (${Math.round(base).toLocaleString("en-US")}) — possible route leak or churn.`,
          lat: null, lon: null, region: null,
          time: samples[samples.length - 1].starttime,
          severity: "high",
          url: `https://stat.ripe.net/AS${asn}#tabId=routing`,
          attribution: "RIPE RIS",
        });
      } else if (ratio <= 0.4) {
        events.push({
          id: `ripe-drop-${asn}-${samples[samples.length - 1].starttime}`,
          title: `BGP announcement collapse at ${label} (AS${asn})`,
          summary: `Latest 6h announcements (${Math.round(last).toLocaleString("en-US")}) fell to ${(ratio * 100).toFixed(0)}% of the recent baseline (${Math.round(base).toLocaleString("en-US")}) — possible mass withdrawals or outage.`,
          lat: null, lon: null, region: null,
          time: samples[samples.length - 1].starttime,
          severity: "high",
          url: `https://stat.ripe.net/AS${asn}#tabId=routing`,
          attribution: "RIPE RIS",
        });
      }
    }
  }
  // Near-total visibility loss = likely outage.
  const px = await getJson(`${STAT}/ris-prefixes/data.json?resource=${asn}&af=v4&time=-1d`);
  const counts = (px.data && px.data.counts && px.data.counts.v4) || {};
  const originating = Number(counts.originating) || 0;
  if (originating === 0 && samples.length > 0) {
    events.push({
      id: `ripe-zero-${asn}-${new Date().toISOString().slice(0, 10)}`,
      title: `No IPv4 routes originating from ${label} (AS${asn}) visible to RIPE RIS`,
      summary: `RIPE RIS collectors see zero originating IPv4 prefixes for AS${asn} over the last day — possible outage or collector coverage gap.`,
      lat: null, lon: null, region: null,
      time: new Date().toISOString(),
      severity: "high",
      url: `https://stat.ripe.net/AS${asn}#tabId=routing`,
      attribution: "RIPE RIS",
    });
  }
  return events;
}

module.exports = {
  name: "ripe_ris",
  description: "BGP routing anomalies (announcement spikes/withdrawal drops) for major networks (RIPE RIS)",
  async fetch() {
    try {
      const results = await Promise.all(
        TARGETS.map((t) => checkAsn(t).catch(() => null))
      );
      return results.filter(Boolean).flat().slice(0, 12);
    } catch {
      return [];
    }
  },
};
