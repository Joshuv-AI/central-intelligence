// STUB — real fetching lands in Phase 2 (ported from Crucix adapters).
// Contract: fetch() resolves to an array of RAW records; the scheduler
// normalizes them into { id, source, domain, title, summary, lat, lon,
// region, time, severity, url, attribution }.
module.exports = {
  name: "nvd_cve",
  description: "NVD / CVE vulnerability feeds",
  async fetch() {
    return [];
  },
};
