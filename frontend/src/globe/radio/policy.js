/* Radio Browser policy constants — ported from bilawalsidhu/gods-eye-view (MIT),
   src/layers/radio/policy.js (RADIO_UUID_RE, RADIO_TUNER_STATIC_MAX_GAIN,
   CATEGORY_MATCHERS, RADIO_CATEGORY_COLORS pattern).

   CI constrains Radio to INTEL-relevant categories only:
     public-safety, aviation-marine, weather, news-talk.
   Music genres and traffic/transit are EXPLICITLY EXCLUDED — stations
   matching them are dropped by categorizeStation() (returns null).
*/
import { esc } from '../../data/format.js';

export const RADIO_PREFIX = 'radio:';

export const RADIO_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Max tuner-static gain, per GEV's RADIO_TUNER_STATIC_MAX_GAIN. */
export const RADIO_TUNER_STATIC_MAX_GAIN = 0.018;

export const RADIO_CATEGORIES = Object.freeze([
  'public-safety',
  'aviation-marine',
  'weather',
  'news-talk',
]);

/** Marker color per intel category (CI globe palette, GEV hues kept). */
export const RADIO_CATEGORY_COLORS = Object.freeze({
  'public-safety': '#ff8b4a',
  'aviation-marine': '#a87cff',
  weather: '#ff5c78',
  'news-talk': '#44adff',
});

export const RADIO_CATEGORY_LABELS = Object.freeze({
  'public-safety': 'PUBLIC SAFETY',
  'aviation-marine': 'AVIATION / MARINE',
  weather: 'WEATHER',
  'news-talk': 'NEWS / TALK',
});

/** Evaluation order for category matching (first hit wins). */
export const RADIO_CATEGORY_ORDER = Object.freeze([
  'news-talk',
  'public-safety',
  'weather',
  'aviation-marine',
]);

/** Radio Browser tags (lowercased) that map to each intel category. */
export const CATEGORY_MATCHERS = Object.freeze({
  'public-safety': [
    'public safety', 'scanner', 'police', 'fire', 'ems', 'dispatch',
    'sheriff', 'rescue', 'fire department', 'police department',
  ],
  'aviation-marine': [
    'aviation', 'air traffic', 'atc', 'airport', 'airband', 'air band',
    'marine', 'maritime', 'coast guard', 'vhf marine', 'shipping',
  ],
  weather: [
    'weather', 'noaa', 'emergency alert', 'severe weather', 'storm',
    'hurricane', 'tornado',
  ],
  'news-talk': [
    'news', 'current affairs', 'journalism', 'talk', 'talk radio',
    'spoken word', 'interview', 'public radio',
  ],
});

/**
 * Tags used for the initial Radio Browser directory queries, per category.
 * (Radio Browser's `tag` search param is singular, so source.js fans out one
 * request per tag and dedupes by uuid.)
 */
export const CATEGORY_SEARCH_TAGS = Object.freeze({
  'public-safety': ['scanner', 'police', 'dispatch'],
  'aviation-marine': ['aviation', 'atc'],
  weather: ['weather', 'noaa'],
  'news-talk': ['news', 'talk'],
});

/**
 * Exclusion matchers. Checked BEFORE the intel matchers: a station tagged
 * with any of these returns null from categorizeStation() — CI does not
 * show music or traffic/transit stations at all.
 */
export const EXCLUDED_MATCHERS = Object.freeze({
  music: [
    'music', 'alternative', 'ambient', 'blues', 'classical', 'country',
    'dance', 'electronic', 'folk', 'funk', 'hip hop', 'hip-hop', 'house',
    'indie', 'jazz', 'latin', 'metal', 'oldies', 'pop', 'punk', 'r&b',
    'reggae', 'rock', 'soul', 'techno', 'trance', 'world', 'top 40',
  ],
  'traffic-transit': ['traffic', 'transit', 'transport', 'rail', 'metro'],
});

const normTag = (t) => String(t || '').trim().toLowerCase();
const hit = (tags, keywords) =>
  keywords.some((kw) => tags.some((t) => t.includes(kw)));

/**
 * Map a normalized station to one of the 4 intel categories, or null when
 * the station is excluded (music / traffic-transit) or irrelevant.
 * Exclusion always wins over intel matching.
 * @param {object} station normalized station (see source.js normalizeStation)
 * @returns {string|null} category key or null
 */
export function categorizeStation(station) {
  const tags = (Array.isArray(station?.tags) ? station.tags : []).map(normTag).filter(Boolean);
  if (hit(tags, EXCLUDED_MATCHERS.music)) return null;
  if (hit(tags, EXCLUDED_MATCHERS['traffic-transit'])) return null;
  for (const key of RADIO_CATEGORY_ORDER) {
    if (hit(tags, CATEGORY_MATCHERS[key])) return key;
  }
  return null;
}

/** True when `category` is one of the 4 allowed intel categories. */
export function isRadioCategory(category) {
  return RADIO_CATEGORIES.includes(category);
}

/** Escape a station name for DOM injection. */
export function escName(name) {
  return esc(String(name || 'Unknown station'));
}
