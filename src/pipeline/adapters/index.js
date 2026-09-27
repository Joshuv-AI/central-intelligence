// Central Intelligence — source adapter registry.
// Each entry: { name, tier, domain, file }. The module must export
// { name, description, fetch() } where fetch() resolves to an array of
// RAW records (the scheduler normalizes them). STUBS ONLY for now —
// real fetching lands in Phase 2 when adapters are ported from Crucix.
const ADAPTERS = [
  // Tier 1 — every ~15 min (fast-moving, event-driven)
  { name: 'acled', tier: 1, domain: 'conflict', file: './tier1/acled.js' },
  { name: 'gdelt', tier: 1, domain: 'conflict', file: './tier1/gdelt.js' },
  { name: 'gdelt_disasters', tier: 1, domain: 'disasters', file: './tier1/gdelt_disasters.js' },
  { name: 'deepstate', tier: 1, domain: 'conflict', file: './tier1/deepstate.js' },
  { name: 'telegram', tier: 1, domain: 'social', file: './tier1/telegram.js' },
  { name: 'cisa_kev', tier: 1, domain: 'cyber', file: './tier1/cisa_kev.js' },
  { name: 'gdacs', tier: 1, domain: 'disasters', file: './tier1/gdacs.js' },
  { name: 'tsunamis', tier: 1, domain: 'disasters', file: './tier1/tsunamis.js' },
  { name: 'noaa_hurricanes', tier: 1, domain: 'disasters', file: './tier1/noaa_hurricanes.js' },
  { name: 'gps_jamming', tier: 1, domain: 'signals', file: './tier1/gps_jamming.js' },
  { name: 'solar', tier: 1, domain: 'space', file: './tier1/solar.js' },
  { name: 'noaa_swpc', tier: 1, domain: 'space', file: './tier1/noaa_swpc.js' },
  { name: 'infrastructure', tier: 1, domain: 'signals', file: './tier1/infrastructure.js' },
  // Tier 2 — every ~30-60 min (slower intel)
  { name: 'nvd_cve', tier: 2, domain: 'cyber', file: './tier2/nvd_cve.js' },
  { name: 'cloudflare_radar', tier: 2, domain: 'cyber', file: './tier2/cloudflare_radar.js' },
  { name: 'ripe_ris', tier: 2, domain: 'cyber', file: './tier2/ripe_ris.js' },
  { name: 'opensanctions', tier: 2, domain: 'sanctions', file: './tier2/opensanctions.js' },
  { name: 'ofac', tier: 2, domain: 'sanctions', file: './tier2/ofac.js' },
  { name: 'promed', tier: 2, domain: 'health', file: './tier2/promed.js' },
  { name: 'reliefweb', tier: 2, domain: 'health', file: './tier2/reliefweb.js' },
  { name: 'who', tier: 2, domain: 'health', file: './tier2/who.js' },
  { name: 'noaa_disasters', tier: 2, domain: 'disasters', file: './tier2/noaa_disasters.js' },
  { name: 'noaa_spc', tier: 2, domain: 'disasters', file: './tier2/noaa_spc.js' },
  { name: 'bluesky', tier: 2, domain: 'social', file: './tier2/bluesky.js' },
  { name: 'reddit', tier: 2, domain: 'social', file: './tier2/reddit.js' },
  { name: 'trends', tier: 2, domain: 'social', file: './tier2/trends.js' },
  { name: 'openaq', tier: 2, domain: 'environment', file: './tier2/openaq.js' },
  { name: 'safecast', tier: 2, domain: 'environment', file: './tier2/safecast.js' },
  { name: 'epa', tier: 2, domain: 'environment', file: './tier2/epa.js' },
  { name: 'kiwisdr', tier: 2, domain: 'signals', file: './tier2/kiwisdr.js' },
  { name: 'csg_tracker', tier: 2, domain: 'signals', file: './tier2/csg_tracker.js' },
  // Tier 3 — daily (slow-moving data)
  { name: 'fred', tier: 3, domain: 'economic', file: './tier3/fred.js' },
  { name: 'bls', tier: 3, domain: 'economic', file: './tier3/bls.js' },
  { name: 'eia', tier: 3, domain: 'economic', file: './tier3/eia.js' },
  { name: 'treasury', tier: 3, domain: 'economic', file: './tier3/treasury.js' },
  { name: 'comtrade', tier: 3, domain: 'economic', file: './tier3/comtrade.js' },
  { name: 'gscpi', tier: 3, domain: 'economic', file: './tier3/gscpi.js' },
];

function loadAdapters() {
  return ADAPTERS.map((a) => ({ ...a, mod: require(a.file) }));
}

function adaptersForTier(tier) {
  return loadAdapters().filter((a) => a.tier === tier);
}

module.exports = { ADAPTERS, loadAdapters, adaptersForTier };
