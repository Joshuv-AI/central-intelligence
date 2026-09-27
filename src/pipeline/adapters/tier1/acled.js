// STUB — real fetching lands in Phase 2 (ported from Crucix adapters).
// Contract: fetch() resolves to an array of RAW records; the scheduler
// normalizes them into { id, source, domain, title, summary, lat, lon,
// region, time, severity, url, attribution }.
module.exports = {
  name: "acled",
  description: "ACLED — armed conflict location and event data",
  async fetch() {
    return [];
  },
};
