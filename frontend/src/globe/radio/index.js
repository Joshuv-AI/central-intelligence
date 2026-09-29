/* Radio layer — module entry. Ported from bilawalsidhu/gods-eye-view (MIT),
   src/layers/radio/ (source, policy, playback, tuning, tuningNoise) and
   src/ui/radioTunerModel.js + radioBindings.js.

   INTEGRATION (documented, not implemented — no existing CI file is touched):
   - Markers: each station has geo_lat/geo_long → CI lat/lon and an id of
     the form 'radio:<stationuuid>'. A markers.js-style entity collection
     can render them with RADIO_CATEGORY_COLORS[station.category] as the
     tint and 'radio' as the marker kind. Strip the RADIO_PREFIX before any
     Radio Browser call (source.js does this automatically).
   - Panels: the tuner dial (initTuner, ./tuner.js) is designed to dock in a
     'radio' panel in panels.js (~340px left overlay). Wire the tuner into
     the panel body via initTuner({ container, playback, onCommit }), feed
     it getStations(), and route onCommit → onStationSelect.
   - Emit bus: CI's ui/panels.js listens on the 'open-panel' bus from
     data/store.js; a radio panel would open via emit('open-panel', 'radio')
     after wiring a META entry — parent-app work, out of scope here.

   DATA: live Radio Browser directory only (see source.js header for
   endpoints, terms, User-Agent note). Stations are fetched per intel
   category, deduped by uuid, then passed through categorizeStation() as the
   final gate: anything music / traffic-transit / uncategorized is dropped.
*/
import { createRadioSource } from './source.js';
import {
  RADIO_CATEGORIES,
  RADIO_CATEGORY_COLORS,
  RADIO_CATEGORY_LABELS,
  categorizeStation,
  isRadioCategory,
} from './policy.js';
import {
  initPlayback,
  playStation,
  pausePlayback,
  stopPlayback,
  setVolume,
  getPlaybackState,
  subscribePlayback,
} from './playback.js';

let viewer = null;
let onStationSelect = null;
let source = null;
let enabled = false;
let categories = new Set(RADIO_CATEGORIES);
let stations = [];
let lastError = null;
let refreshing = false;
let refreshSeq = 0;

function tag(station, category) {
  return { ...station, category };
}

/**
 * Fetch one band per enabled intel category and merge into a single
 * deduped, click-ranked station list. categorizeStation() is the final
 * gate — no music, no traffic, no uncategorized stations.
 */
async function refreshStations() {
  if (!source) return [];
  const seq = ++refreshSeq;
  refreshing = true;
  lastError = null;
  const seen = new Set();
  const merged = [];
  try {
    for (const category of RADIO_CATEGORIES) {
      if (!categories.has(category)) continue;
      const rows = await source.searchStations({ category });
      for (const row of rows) {
        if (seen.has(row.uuid)) continue;
        seen.add(row.uuid);
        const resolved = categorizeStation(row);
        if (resolved) merged.push(tag(row, resolved));
      }
    }
  } catch (err) {
    lastError = err?.message || String(err);
  }
  if (seq !== refreshSeq) return stations; // superseded by a newer refresh
  merged.sort((a, b) => (b.clicks || 0) - (a.clicks || 0));
  stations = merged;
  refreshing = false;
  return stations;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.viewer] Cesium viewer (kept for camera hooks by the app)
 * @param {Function} [opts.onStationSelect] (station) when a station is committed
 */
export function initRadio({ viewer: v = null, onStationSelect: fn = null } = {}) {
  viewer = v;
  onStationSelect = typeof fn === 'function' ? fn : null;
  source = createRadioSource();
  initPlayback({ source });
  return { setRadioEnabled, setRadioCategories, getStations, refreshStations, destroyRadio };
}

/** Enable/disable the layer; enabling triggers the first directory fetch. */
export function setRadioEnabled(bool) {
  enabled = Boolean(bool);
  if (!enabled) {
    stopPlayback();
    return Promise.resolve([]);
  }
  return refreshStations();
}

/**
 * Set the active intel categories (subset of the 4 policy keys).
 * Invalid keys are dropped; an empty valid set clears the band.
 */
export function setRadioCategories(list) {
  const next = new Set(
    (Array.isArray(list) ? list : []).filter(isRadioCategory),
  );
  categories = next;
  if (!enabled) return Promise.resolve([]);
  return refreshStations();
}

/** Current station band (normalized stations with .category set). */
export function getStations() {
  return [...stations];
}

/** Whether a directory refresh is in flight. */
export function isRefreshing() {
  return refreshing;
}

/** Last directory error message, or null. */
export function getRadioError() {
  return lastError;
}

/**
 * Commit playback of a station object (explicit user action only — the
 * tuner calls this on gesture release). Records nothing the user didn't
 * ask for; the click counter is registered by playback.js.
 */
export function commitStation(station) {
  if (!station?.streamUrl) return Promise.resolve(false);
  onStationSelect?.(station);
  return playStation(station, { fadeInMs: 300 });
}

/** Tear down: stop audio, clear the band, release references. */
export function destroyRadio() {
  refreshSeq += 1;
  refreshing = false;
  stopPlayback();
  stations = [];
  categories = new Set(RADIO_CATEGORIES);
  source = null;
  viewer = null;
  onStationSelect = null;
  enabled = false;
  lastError = null;
}

export {
  RADIO_CATEGORIES,
  RADIO_CATEGORY_COLORS,
  RADIO_CATEGORY_LABELS,
  categorizeStation,
  playStation,
  pausePlayback,
  stopPlayback,
  setVolume,
  getPlaybackState,
  subscribePlayback,
};
