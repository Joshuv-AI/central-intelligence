/* AIS vessel type normalization + type colors.
   Ported from God's Eye View src/data/vesselLabels.js (MIT —
   bilawalsidhu/gods-eye-view). Single source of truth for vessel type
   colors so chevron billboards and cards cannot drift apart. */

export const VESSEL_OVERLAY_SOURCE_ID = 'ais-live-vessels';

/** AIS type family → chevron hue + card accent. */
const TYPE_STYLES = [
  { pattern: /tanker/i, css: '#ffb347', accent: '255, 179, 71' },
  { pattern: /cargo|container|bulk|carrier/i, css: '#39d5ff', accent: '57, 213, 255' },
  { pattern: /passenger|ferry|cruise/i, css: '#ff7adf', accent: '255, 122, 223' },
  { pattern: /fishing/i, css: '#7cff9b', accent: '124, 255, 155' },
  { pattern: /tug|tow|pilot|supply|service/i, css: '#f7f0a3', accent: '247, 240, 163' },
  { pattern: /military|warship|naval/i, css: '#ff6b6b', accent: '255, 107, 107' },
  { pattern: /sailing|pleasure|yacht/i, css: '#c9a7ff', accent: '201, 167, 255' },
];
const DEFAULT_STYLE = { css: '#39d5ff', accent: '57, 213, 255' };

const NUMERIC_TYPE_SPECIALS = {
  30: 'FISHING', 31: 'TOWING', 32: 'TOWING', 33: 'DREDGER',
  34: 'DIVE OPS', 35: 'MILITARY', 36: 'SAILING', 37: 'PLEASURE',
  50: 'PILOT', 51: 'SAR', 52: 'TUG', 53: 'PORT TENDER',
  54: 'ANTI-POLLUTION', 55: 'LAW ENFORCE', 58: 'MEDICAL',
};
const NUMERIC_TYPE_FAMILIES = {
  4: 'HIGH-SPEED', 6: 'PASSENGER', 7: 'CARGO', 8: 'TANKER', 9: 'OTHER',
};

/**
 * Resolve an AIS type to display text: bare numeric ship-type codes map to
 * family names ("71" → "CARGO"); text types pass through unchanged.
 * @param {string|number} type Raw AIS type.
 */
export function normalizeVesselType(type) {
  const text = String(type ?? '').trim();
  if (!text || !/^\d{1,2}$/.test(text)) return text;
  const code = Number(text);
  if (code <= 0) return '';
  if (NUMERIC_TYPE_SPECIALS[code]) return NUMERIC_TYPE_SPECIALS[code];
  return NUMERIC_TYPE_FAMILIES[Math.floor(code / 10)] || 'OTHER';
}

function styleForType(type) {
  const text = normalizeVesselType(type);
  return TYPE_STYLES.find((entry) => entry.pattern.test(text)) || DEFAULT_STYLE;
}

/** AIS ship type → CSS hex hue for the billboard chevron. */
export function vesselTypeCss(type) {
  return styleForType(type).css;
}

/** AIS ship type → "r, g, b" accent string for the card. */
export function accentForVesselType(type) {
  return styleForType(type).accent;
}
