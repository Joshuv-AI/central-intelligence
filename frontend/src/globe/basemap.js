/* Basemap system — the globe's default view and the satellite toggle.
   CARTO Dark Matter (dark_all) is the default basemap: a lightweight dark
   raster that keeps tile traffic low and matches the 3D intel aesthetic.
   Esri World Imagery + Boundaries & Places stays available as the
   "Satellite" option; if Esri tiles fail repeatedly the satellite path
   falls back to OSM until Esri recovers (audit 2.3).
   viewer.js owns the Viewer; this module owns its imagery layers. */
import * as Cesium from 'cesium';

const STORAGE_KEY = 'ci-basemap';
export const BASEMAP_DARK = 'dark';
export const BASEMAP_SATELLITE = 'satellite';

// CARTO Dark Matter — dark_all raster tiles, keyless, CORS-open.
const CARTO_DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';
const CARTO_DARK_CREDIT = '© OpenStreetMap contributors © CARTO';
const CARTO_DARK_MAX_LEVEL = 20;

// Satellite path: Esri World Imagery + boundaries/places reference overlay.
// NOTE: Esri tile order is {z}/{y}/{x} — y before x, unlike most providers.
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_IMAGERY_CREDIT = 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
const ESRI_PLACES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_PLACES_CREDIT = 'Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community';
const ESRI_MAX_LEVEL = 19;
const ESRI_PLACES_MAX_LEVEL = 16;

// OSM keyless backup for the satellite path only (audit 2.3).
const OSM_FALLBACK_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const FAILURE_THRESHOLD = 12;
const PROBE_MS = 60_000;

let viewer = null;
let mode = BASEMAP_DARK;
/** Every imagery layer this module added (basemap + overlay + any fallback). */
let activeLayers = [];
let removeSatelliteErrorListener = null;
let tileFailures = 0, onFallback = false, fallbackLayer = null;

function readStoredMode() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === BASEMAP_SATELLITE) return BASEMAP_SATELLITE;
  } catch { /* storage unavailable */ }
  return BASEMAP_DARK;
}

function clearLayers() {
  // Detach the satellite tile-failure listener so a destroyed provider
  // can't fire into the new mode.
  if (removeSatelliteErrorListener) {
    try { removeSatelliteErrorListener(); } catch { /* already removed */ }
    removeSatelliteErrorListener = null;
  }
  tileFailures = 0;
  onFallback = false;
  fallbackLayer = null;
  const layers = viewer.imageryLayers;
  for (let i = activeLayers.length - 1; i >= 0; i -= 1) {
    const layer = activeLayers[i];
    try {
      if (layers.contains(layer)) layers.remove(layer, true);
    } catch { /* viewer mid-teardown */ }
  }
  activeLayers = [];
}

function addDarkBasemap() {
  const dark = new Cesium.UrlTemplateImageryProvider({
    url: CARTO_DARK,
    subdomains: 'abcd',
    credit: new Cesium.Credit(CARTO_DARK_CREDIT, true),
    maximumLevel: CARTO_DARK_MAX_LEVEL,
    // Dark raster is opaque — skipping alpha saves texture memory/upload.
    hasAlphaChannel: false,
  });
  activeLayers.push(viewer.imageryLayers.addImageryProvider(dark));
}

function addSatelliteBasemap() {
  const imagery = new Cesium.UrlTemplateImageryProvider({
    url: ESRI_IMAGERY,
    credit: new Cesium.Credit(ESRI_IMAGERY_CREDIT, true),
    maximumLevel: ESRI_MAX_LEVEL,
    // Esri World Imagery is opaque JPEG — skipping alpha channel saves
    // texture memory and upload time.
    hasAlphaChannel: false,
  });
  activeLayers.push(viewer.imageryLayers.addImageryProvider(imagery));
  // Reference layer: boundaries + place labels over the imagery.
  const ref = new Cesium.UrlTemplateImageryProvider({
    url: ESRI_PLACES,
    credit: new Cesium.Credit(ESRI_PLACES_CREDIT, true),
    maximumLevel: ESRI_PLACES_MAX_LEVEL,
  });
  activeLayers.push(viewer.imageryLayers.addImageryProvider(ref));

  // OSM fallback for the satellite path: after repeated tile failures,
  // swap to a keyless backup instead of showing a dead globe (audit 2.3).
  removeSatelliteErrorListener = imagery.errorEvent.addEventListener(() => {
    tileFailures += 1;
    if (!onFallback && tileFailures >= FAILURE_THRESHOLD) {
      onFallback = true;
      const layers = viewer.imageryLayers;
      fallbackLayer = layers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: OSM_FALLBACK_URL,
          credit: new Cesium.Credit('© OpenStreetMap contributors', true),
          maximumLevel: ESRI_MAX_LEVEL,
        }),
      );
      activeLayers.push(fallbackLayer);
      layers.lowerToBottom(fallbackLayer); // fallback renders on top
      console.warn('[basemap] Esri failing — on OSM fallback');
    }
  });
}

// Recovery probe: every 60 s, if a single Esri tile loads, restore it.
function startRecoveryProbe() {
  setInterval(() => {
    if (!viewer || viewer.isDestroyed() || !onFallback || !fallbackLayer) return;
    if (mode !== BASEMAP_SATELLITE) return;
    const probe = new Image();
    probe.onload = () => {
      onFallback = false; tileFailures = 0;
      const layers = viewer.imageryLayers;
      if (layers.contains(fallbackLayer)) layers.remove(fallbackLayer, true);
      const idx = activeLayers.indexOf(fallbackLayer);
      if (idx >= 0) activeLayers.splice(idx, 1);
      fallbackLayer = null;
      console.info('[basemap] Esri recovered');
    };
    probe.src = ESRI_IMAGERY.replace('{z}/{y}/{x}', '2/1/2') + `?t=${Date.now()}`;
  }, PROBE_MS);
}

function applyMode(nextMode) {
  mode = nextMode;
  clearLayers();
  if (mode === BASEMAP_SATELLITE) addSatelliteBasemap();
  else addDarkBasemap();
}

/** Read the persisted choice (default 'dark') and install the basemap layers. Call once per Viewer. */
export function initBasemap(view) {
  viewer = view;
  applyMode(readStoredMode());
  startRecoveryProbe();
}

/** Swap the basemap ('dark' | 'satellite'); removes old layers cleanly (no
    duplicates/leaks) and persists the choice. */
export function setBasemapMode(nextMode) {
  if (!viewer || viewer.isDestroyed()) return;
  if (nextMode !== BASEMAP_SATELLITE) nextMode = BASEMAP_DARK;
  if (nextMode === mode && activeLayers.length > 0) return;
  applyMode(nextMode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch { /* storage unavailable */ }
  console.info(`[basemap] mode: ${mode}`);
}

/** Current basemap mode ('dark' | 'satellite'). */
export function basemapMode() {
  return mode;
}
