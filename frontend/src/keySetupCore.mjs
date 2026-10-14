/**
 * Provider key requirements — Central Intelligence (slim successor to GEV's
 * POWER UP core). The key-ENTRY machinery (Provider Settings panel, /api/setup
 * persistence, .env rewriting, admission gate) is CUT for public hosting
 * (SPEC A17): keys are provisioned server-side via host env only (ARCH §6.10).
 * What remains is the honest-labelling half: which providers need a key, and
 * the requirement string shown where a keyed feature is unavailable. The
 * merged system's capability source of truth is GET /api/capabilities
 * (ARCH §4.2 #1); this registry only names the requirement, never a value.
 */
export const KEY_SETUP_KEYS = Object.freeze([
  Object.freeze({
    id: 'aisstream',
    title: 'AISSTREAM',
    unlocks: 'Live vessels (AIS)',
    envVars: Object.freeze(['AISSTREAM_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'firms',
    title: 'NASA FIRMS',
    unlocks: 'Live active-fire detections',
    envVars: Object.freeze(['FIRMS_MAP_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'tomtom',
    title: 'TOMTOM',
    unlocks: 'Live traffic flow',
    envVars: Object.freeze(['TOMTOM_API_KEY']),
    tier: 'free',
  }),
  Object.freeze({
    id: 'mapillary',
    title: 'MAPILLARY',
    unlocks: 'Street Level imagery (client token, build-time)',
    envVars: Object.freeze(['MAPILLARY_CLIENT_TOKEN']),
    tier: 'free',
    clientExposed: true,
  }),
  Object.freeze({
    id: 'windy',
    title: 'WINDY',
    unlocks: 'Public cameras provider',
    envVars: Object.freeze(['WINDY_API_KEY']),
    tier: 'free',
  }),
]);

/** Tooltip guidance for a control gated by one registry entry. */
export function keySetupRequirement(id) {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
  if (!entry || entry.hidden) return '';
  return `Needs a server-side ${entry.envVars.join(' + ')} — not configured on this host`;
}

export function knownKeySetupEnvVars() {
  const names = new Set();
  for (const entry of KEY_SETUP_KEYS)
    for (const envVar of entry.envVars) names.add(envVar);
  return names;
}
