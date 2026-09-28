/* Central store: backend state + UI filter state, with a tiny pub/sub.
   Domains come from the backend normalize contract. */

export const DOMAINS = [
  'conflict', 'cyber', 'economic', 'health', 'environment',
  'space', 'sanctions', 'disasters', 'signals', 'social',
];

export const DOMAIN_LABELS = {
  conflict: 'Conflict', cyber: 'Cyber', economic: 'Economic', health: 'Health',
  environment: 'Environment', space: 'Space', sanctions: 'Sanctions',
  disasters: 'Disasters', signals: 'Signals', social: 'Social',
};

// Layer families (per layout spec).
export const FAMILIES = {
  live: ['disasters', 'space', 'signals'],
  intel: ['conflict', 'cyber', 'sanctions', 'social'],
  environment: ['health', 'environment', 'economic'],
};
export const FAMILY_LABELS = { live: 'Live', intel: 'Intel', environment: 'Environment' };

export const SEV_COLORS = {
  low: '#7FCEF0',
  moderate: '#FFD166',
  high: '#FFB020',
  critical: '#FF5A5A',
};

// Region focus: camera views + keyword matchers against event.region.
export const REGIONS = [
  { id: 'world', label: 'WORLD', lon: 0, lat: 20, height: 26_000_000, keywords: [] },
  { id: 'americas', label: 'AMERICAS', lon: -100, lat: 22, height: 17_000_000,
    keywords: ['america', 'united states', 'usa', 'canada', 'mexico', 'brazil', 'latin', 'caribbean', 'north america', 'south america', 'colombia', 'argentina', 'peru', 'chile', 'venezuela', 'panama', 'cuba', 'haiti'] },
  { id: 'europe', label: 'EUROPE', lon: 15, lat: 50, height: 9_000_000,
    keywords: ['europe', 'ukraine', 'russia', 'belarus', 'poland', 'germany', 'france', 'united kingdom', 'uk ', 'italy', 'spain', 'balkans', 'eu '] },
  { id: 'middle-east', label: 'MIDDLE EAST', lon: 45, lat: 25, height: 9_000_000,
    keywords: ['middle east', 'israel', 'gaza', 'palestin', 'iran', 'iraq', 'syria', 'yemen', 'saudi', 'lebanon', 'turkey', 'turkiye', 'qatar', 'jordan', 'red sea'] },
  { id: 'asia-pacific', label: 'ASIA PACIFIC', lon: 130, lat: 14, height: 17_000_000,
    keywords: ['asia', 'china', 'taiwan', 'japan', 'korea', 'india', 'pakistan', 'pacific', 'australia', 'philippines', 'indonesia', 'myanmar', 'thailand', 'vietnam', 'south china sea'] },
  { id: 'africa', label: 'AFRICA', lon: 20, lat: 4, height: 13_000_000,
    keywords: ['africa', 'sudan', 'somalia', 'nigeria', 'egypt', 'libya', 'ethiopia', 'congo', 'sahel', 'mali', 'kenya', 'chad', 'niger'] },
];

export function familyOf(domain) {
  for (const [fam, list] of Object.entries(FAMILIES)) {
    if (list.includes(domain)) return fam;
  }
  return 'live';
}

export function regionMatches(regionId, event) {
  if (regionId === 'world') return true;
  const region = REGIONS.find((r) => r.id === regionId);
  if (!region) return true;
  const hay = `${event.region || ''} ${event.title || ''}`.toLowerCase();
  // Events without any regional signal stay visible in every region view.
  if (!event.region) return true;
  return region.keywords.some((k) => hay.includes(k));
}

const listeners = new Map();

export const store = {
  events: [],
  connections: [],
  feed: [],
  meta: null,
  lastSnapshotAt: null,
  streamConnected: false,
  streamReconnecting: false,

  // UI filter state
  families: { live: true, intel: true, environment: true },
  domains: Object.fromEntries(DOMAINS.map((d) => [d, true])),
  region: 'world',

  setSnapshot(snap) {
    this.events = Array.isArray(snap.markers) ? snap.markers : [];
    this.connections = Array.isArray(snap.connections) ? snap.connections : [];
    this.feed = Array.isArray(snap.feed) ? snap.feed : [];
    this.meta = snap.meta || null;
    this.lastSnapshotAt = Date.now();
    emit('data');
  },

  eventById(id) {
    return this.events.find((e) => e.id === id) || null;
  },

  connectionById(id) {
    return this.connections.find((c) => c.id === id) || null;
  },

  connectionsForEvent(eventId) {
    return this.connections.filter(
      (c) => Array.isArray(c.eventIds) && c.eventIds.includes(eventId)
    );
  },

  isGeo(e) {
    return Number.isFinite(e.lat) && Number.isFinite(e.lon);
  },

  geoEvents() {
    return this.events.filter((e) => this.isGeo(e));
  },

  // Events currently allowed on the globe by layer + region filters.
  visibleEvents() {
    return this.geoEvents().filter(
      (e) =>
        this.families[familyOf(e.domain)] &&
        this.domains[e.domain] !== false &&
        regionMatches(this.region, e)
    );
  },

  countsPerDomain() {
    const counts = Object.fromEntries(DOMAINS.map((d) => [d, 0]));
    for (const e of this.events) {
      if (counts[e.domain] !== undefined) counts[e.domain] += 1;
    }
    return counts;
  },
};

export function on(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic).delete(fn);
}

export function emit(topic, payload) {
  const set = listeners.get(topic);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(payload); } catch (err) { console.error('[store] listener failed:', err); }
  }
}
