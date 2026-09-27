// Central Intelligence — shared intelligence vocabulary.
// Impact tags, cascade rules, causality map, severity ranks.
// Rule-based only. No LLM, no network, no side effects.
const SEV_RANK = { low: 1, moderate: 2, high: 3, critical: 4 };

function sevRank(s) {
  return SEV_RANK[s] || 1;
}

// Impact tags inferred per source. Adapted from the Crucix tag rules,
// keyed to our adapter names and domains.
const SOURCE_TAGS = {
  // conflict
  acled: ['military', 'population', 'government'],
  deepstate: ['military', 'government', 'infrastructure'],
  telegram: ['government', 'military', 'comms'],
  gdelt: ['government', 'population'],
  // cyber
  cisa_kev: ['infrastructure', 'comms'],
  nvd_cve: ['infrastructure', 'comms'],
  ripe_ris: ['comms', 'infrastructure'],
  cloudflare_radar: ['comms', 'population'],
  // disasters
  gdacs: ['population', 'infrastructure', 'health', 'supply_chain'],
  gdelt_disasters: ['population', 'infrastructure'],
  tsunamis: ['population', 'maritime', 'infrastructure'],
  noaa_hurricanes: ['population', 'infrastructure', 'supply_chain'],
  noaa_disasters: ['population', 'infrastructure'],
  noaa_spc: ['population', 'infrastructure'],
  // space / signals
  solar: ['comms', 'GPS', 'power_grid', 'space'],
  noaa_swpc: ['GPS', 'comms', 'power_grid'],
  gps_jamming: ['GPS', 'airspace', 'maritime'],
  kiwisdr: ['comms'],
  csg_tracker: ['military', 'maritime', 'government'],
  infrastructure: ['power_grid', 'infrastructure'],
  // sanctions
  opensanctions: ['economy', 'government'],
  ofac: ['economy', 'government'],
  // economic
  fred: ['economy'],
  bls: ['economy'],
  eia: ['economy', 'energy'],
  treasury: ['economy', 'government'],
  comtrade: ['supply_chain', 'economy'],
  gscpi: ['supply_chain', 'economy'],
  // health / environment
  promed: ['health', 'population'],
  reliefweb: ['health', 'population'],
  who: ['health', 'population'],
  openaq: ['health', 'population'],
  safecast: ['health', 'population'],
  epa: ['health', 'population'],
  // social
  bluesky: ['comms', 'population'],
  reddit: ['comms', 'population'],
  trends: ['population'],
};

function impactTags(event) {
  const base = SOURCE_TAGS[event.source] || [];
  const extra = event.cascadeWatches || [];
  return [...new Set([...base, ...extra])];
}

// Cascade rules: "if A then watch B". When an event matches, the listed
// impact tags are attached to it so fusion can link downstream effects.
const CASCADE_RULES = [
  {
    match: (e) => e.source === 'tsunamis' && sevRank(e.severity) >= 3,
    tags: ['maritime', 'supply_chain', 'population'],
    note: 'tsunami threat — watch ports, shipping, coastal population',
  },
  {
    match: (e) => e.source === 'noaa_hurricanes' && sevRank(e.severity) >= 2,
    tags: ['supply_chain', 'power_grid', 'population'],
    note: 'hurricane — watch supply chain and power grid',
  },
  {
    match: (e) => e.source === 'solar' && sevRank(e.severity) >= 3,
    tags: ['GPS', 'comms', 'power_grid', 'space'],
    note: 'solar storm — watch GPS, comms, grid, satellites',
  },
  {
    match: (e) => e.source === 'noaa_swpc' && sevRank(e.severity) >= 2,
    tags: ['GPS', 'comms', 'power_grid'],
    note: 'geomagnetic activity — watch GPS, comms, grid',
  },
  {
    match: (e) => e.source === 'gps_jamming' && sevRank(e.severity) >= 3,
    tags: ['airspace', 'maritime', 'military'],
    note: 'GPS interference — watch aviation, shipping, military',
  },
  {
    match: (e) => e.domain === 'conflict' && sevRank(e.severity) >= 3,
    tags: ['energy', 'supply_chain', 'maritime'],
    note: 'major conflict event — watch energy and shipping lanes',
  },
  {
    match: (e) => e.domain === 'cyber' && sevRank(e.severity) >= 3,
    tags: ['infrastructure', 'comms'],
    note: 'severe cyber incident — watch critical infrastructure',
  },
  {
    match: (e) => e.source === 'gdacs' && sevRank(e.severity) >= 3,
    tags: ['supply_chain', 'population', 'food'],
    note: 'major disaster — watch supply chain and food',
  },
  {
    match: (e) => e.source === 'csg_tracker' && sevRank(e.severity) >= 2,
    tags: ['maritime', 'government'],
    note: 'fleet movement — watch sea lanes and regional posture',
  },
];

// Causality map: cause-tag -> effect-tags it can plausibly drive.
// Used to order chains (cause -> effect) and award cascade score.
const CAUSALITY = {
  space: ['comms', 'GPS', 'power_grid'],
  solar: ['comms', 'GPS', 'power_grid'],
  disaster: ['supply_chain', 'population', 'food', 'maritime'],
  conflict: ['energy', 'supply_chain', 'maritime', 'population'],
  cyber: ['infrastructure', 'comms'],
  health: ['supply_chain', 'population'],
  economy: ['supply_chain', 'population'],
  sanctions: ['economy', 'supply_chain'],
};

function causesTag(causeEvent, effectEvent) {
  const causeTags = impactTags(causeEvent);
  const effectTags = impactTags(effectEvent);
  for (const ct of causeTags) {
    const effects = CAUSALITY[ct];
    if (!effects) continue;
    if (effectTags.some((et) => effects.includes(et))) return true;
  }
  return false;
}

module.exports = {
  SEV_RANK,
  sevRank,
  SOURCE_TAGS,
  CASCADE_RULES,
  CAUSALITY,
  impactTags,
  causesTag,
};
