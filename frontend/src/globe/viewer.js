/* Cesium viewer — keyless by constraint (no Ion token):
   Esri World Imagery (satellite) + Boundaries & Places overlay, all keyless;
   Re:Earth quantized-mesh terrain for real relief (async upgrade from the
   ellipsoid) — same terrain God's Eye View uses, keyless, CC BY 4.0.
   All Ion widgets off. */
import * as Cesium from 'cesium';
// widgets.css is injected by vite-plugin-cesium (link tag in index.html).
import {
  installRenderGovernor,
  holdContinuousRender,
  releaseContinuousRender,
} from './renderGovernor.js';

// NOTE: Esri tile order is {z}/{y}/{x} — y before x, unlike most providers.
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_IMAGERY_CREDIT = 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
const ESRI_PLACES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_PLACES_CREDIT = 'Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community';
const REEARTH_TERRAIN = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';
const REEARTH_TERRAIN_CREDIT = 'Terrain: Re:Earth, Mapterhorn, EGM2008 (NGA), Protomaps, © OpenStreetMap contributors';

// F1: Re:Earth 429-retry policy, adapted from God's Eye View's terrainRetry.js.
// GEV's policy hooks Cesium Resource.retryCallback per tile; CI's provider
// comes from fromUrl's layer.json bootstrap, so the same policy (3 attempts,
// exponential backoff 750 ms base → 15 s max, one SHARED cooldown across
// attempts, Retry-After honored) wraps the bootstrap instead.
const TERRAIN_RETRY_ATTEMPTS = 3;
const TERRAIN_RETRY_BASE_MS = 750;
const TERRAIN_RETRY_MAX_MS = 15_000;
const TERRAIN_RETRY_JITTER_MS = 1_500;
const TERRAIN_RETRY_STATUSES = [429, 502, 503, 504];
/** Shared cooldown: retries wait behind one window, never a second burst. */
let nextTerrainRetryAt = 0;

function parseTerrainRetryAfter(err) {
  const headers = err && err.responseHeaders;
  if (!headers || typeof headers !== 'object') return null;
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== 'retry-after') continue;
    const text = String(value).trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text) * 1000;
    const at = Date.parse(text);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
    return null;
  }
  return null;
}

async function loadTerrainWithRetry() {
  for (let attempt = 0; attempt < TERRAIN_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN);
    } catch (err) {
      const status = err && err.statusCode;
      const last = attempt === TERRAIN_RETRY_ATTEMPTS - 1;
      if (!TERRAIN_RETRY_STATUSES.includes(status) || last) throw err;
      const backoff = Math.min(
        TERRAIN_RETRY_MAX_MS,
        TERRAIN_RETRY_BASE_MS * 2 ** attempt,
      );
      const delay = Math.min(
        TERRAIN_RETRY_MAX_MS,
        Math.max(backoff, parseTerrainRetryAfter(err) ?? 0),
      );
      const now = Date.now();
      if (now + delay > nextTerrainRetryAt) nextTerrainRetryAt = now + delay;
      const wait = Math.max(0, nextTerrainRetryAt + Math.random() * TERRAIN_RETRY_JITTER_MS - now);
      console.warn(
        `[globe] terrain ${status} (attempt ${attempt + 1}/${TERRAIN_RETRY_ATTEMPTS}); retrying in ${Math.round(wait)} ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw new Error('terrain retries exhausted');
}

let viewer = null;
let stopIdleSpin = null;

/** Stop the idle auto-rotation (e.g. when opening a shared scene link). */
export function haltIdleSpin() {
  if (stopIdleSpin) stopIdleSpin();
}

export function createViewer(container) {
  viewer = new Cesium.Viewer(container, {
    // Keyless: no base layer from Ion; we add our own below.
    baseLayer: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),

    // Strip every widget — the UI chrome is ours.
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    navigationInstructionsInitiallyVisible: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    vrButton: false,

    // Calm defaults.
    contextOptions: { webgl: { antialias: true } },
  });

  // Idle render governor: stops the render loop when nothing animates,
  // the biggest battery win for a parked dashboard (audit 1.1).
  installRenderGovernor(viewer);

  // Cluster stability: camera.changed drives Cesium's EntityCluster greedy
  // re-group pass, which reshuffles badges on slight pans/spins. Set the
  // threshold very high so the auto pass effectively never fires — clusters
  // regroup ONLY on genuine deep zooms via the moveEnd handler in markers.js
  // (zoom-gated re-clustering, 2026-09-30). Documented Camera property
  // (default 0.5). The only other camera.changed listener here is the SSE
  // updater, which is idempotent and also driven directly by
  // moveStart/moveEnd (2026-09-30).
  viewer.camera.percentageChanged = 8;

  // Atmosphere and starfield: the blue limb halo is half the wow factor.
  // (Was disabled for "polar night" — re-enabled for the GEV-grade look.)
  viewer.scene.skyBox.show = true;
  viewer.scene.skyAtmosphere.show = true;
  // GEV-tuned limb values: the limb reads correctly against the starfield
  // instead of default haze (audit 2.1).
  viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
  viewer.scene.skyAtmosphere.saturationShift = -0.12;
  viewer.scene.skyAtmosphere.brightnessShift = -0.08;
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#050B16');
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#12283f');
  viewer.scene.globe.enableLighting = false;
  // Fog re-enabled: it's a tile-culling mechanism, not just visuals. Without
  // it, the tile queue fills with horizon tiles instead of what's on screen,
  // slowing refinement during zoom. visualDensityScalar keeps it visually
  // subtle while retaining the culling benefit.
  viewer.scene.fog.enabled = true;
  viewer.scene.fog.density = 0.0006;
  if (viewer.scene.fog.visualDensityScalar !== undefined) {
    viewer.scene.fog.visualDensityScalar = 0.3;
  }

  // Basemap: Esri Dark Gray Canvas by default (keyless). With a free CARTO
  // key set (VITE_CARTO_KEY), use CARTO Dark Matter instead.
  // Satellite basemap (Esri World Imagery, keyless) + boundaries/places overlay.
  // Performance: on mobile, cap zoom levels lower and relax tile quality
  // to keep pinch-zoom responsive (fewer, faster tile loads).
  const isMobile = window.matchMedia('(max-width: 640px)').matches;
  const imagery = new Cesium.UrlTemplateImageryProvider({
    url: ESRI_IMAGERY,
    credit: new Cesium.Credit(ESRI_IMAGERY_CREDIT, true),
    maximumLevel: 19,
    // Esri World Imagery is opaque JPEG — skipping alpha channel saves
    // texture memory and upload time.
    hasAlphaChannel: false,
  });
  viewer.imageryLayers.addImageryProvider(imagery);
  // Reference layer: boundaries + place labels over the imagery.
  const ref = new Cesium.UrlTemplateImageryProvider({
    url: ESRI_PLACES,
    credit: new Cesium.Credit(ESRI_PLACES_CREDIT, true),
    maximumLevel: 16,
  });
  viewer.imageryLayers.addImageryProvider(ref);

  // Basemap fallback: after repeated tile failures, swap to a keyless backup
  // instead of showing a dead globe (audit 2.3).
  const FALLBACK_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const FAILURE_THRESHOLD = 12;
  let tileFailures = 0, onFallback = false, fallbackLayer = null;
  imagery.errorEvent.addEventListener(() => {
    tileFailures += 1;
    if (!onFallback && tileFailures >= FAILURE_THRESHOLD) {
      onFallback = true;
      const layers = viewer.imageryLayers;
      fallbackLayer = layers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: FALLBACK_URL,
          credit: new Cesium.Credit('© OpenStreetMap contributors', true),
          maximumLevel: 19,
        }),
      );
      layers.lowerToBottom(fallbackLayer); // fallback renders on top
      console.warn('[basemap] Esri failing — on OSM fallback');
    }
  });
  // Recovery probe: every 60 s, if a single Esri tile loads, restore it.
  setInterval(() => {
    if (!onFallback || !fallbackLayer) return;
    const probe = new Image();
    probe.onload = () => {
      onFallback = false; tileFailures = 0;
      if (viewer.imageryLayers.contains(fallbackLayer)) {
        viewer.imageryLayers.remove(fallbackLayer, true);
      }
      fallbackLayer = null;
      console.info('[basemap] Esri recovered');
    };
    probe.src = ESRI_IMAGERY.replace('{z}/{y}/{x}', '2/1/2') + `?t=${Date.now()}`;
  }, 60_000);

  // Globe quality: full tile refinement on all devices. SSE 2 is the
  // quality baseline — the mobile relaxation to 3 was a visible regression.
  const baseSSE = 2;
  viewer.scene.globe.maximumScreenSpaceError = baseSSE;

  // Dynamic SSE: when zoomed out (high camera altitude), force sharper tiles
  // by lowering SSE. Low-zoom tiles are naturally blurry — without this, the
  // globe looks soft from far away. When zoomed in, restore the base SSE for
  // performance.
  //
  // Motion-adaptive relaxation (2026-09-30): while the camera is ZOOMING
  // (height genuinely changing), multiply SSE by MOTION_RELAX so far fewer
  // tiles are in flight and the visible set converges quickly instead of
  // churning in a perpetually blurry state. When the camera settles
  // (moveEnd), full sharpness is restored.
  //
  // Rotation-only moves are deliberately EXCLUDED (2026-09-30): relaxing SSE
  // on every moveStart — including pure rotations, pans, and the idle
  // auto-spin — blurred newly-visible edge tiles for no benefit (the tile
  // set barely changes at constant height) and forced a full refinement
  // re-render on every moveEnd, which read as the globe "distorting" on
  // every slight turn. Relaxation now engages only once the camera height
  // has changed by ZOOM_RELAX_RATIO since the move began — a genuine zoom.
  const MOTION_RELAX = 1.3;
  const ZOOM_RELAX_RATIO = 1.15; // ≥15% height change since moveStart = zoom
  let motionRelax = 1;
  let moveStartHeight = 0;
  let sseRaf = 0;
  const updateDynamicSSE = () => {
    sseRaf = 0;
    if (!viewer || viewer.isDestroyed()) return;
    try {
      const h = viewer.camera.positionCartographic.height;
      // Zoom-gated relaxation: compare against the height when this move
      // began. Rotations/pans hold height constant, so they keep full SSE.
      if (moveStartHeight > 0 && Number.isFinite(h) && h > 0) {
        const ratio =
          Math.max(h, moveStartHeight) / Math.min(h, moveStartHeight);
        const wantRelax = ratio >= ZOOM_RELAX_RATIO ? MOTION_RELAX : 1;
        if (wantRelax !== motionRelax) motionRelax = wantRelax;
      }
      let sse = baseSSE;
      if (h > 15000000) sse = baseSSE * 0.5;      // whole globe: sharpest
      else if (h > 8000000) sse = baseSSE * 0.65;  // continental view
      else if (h > 3000000) sse = baseSSE * 0.8;   // regional view
      viewer.scene.globe.maximumScreenSpaceError = sse * motionRelax;
    } catch { /* camera not ready */ }
  };
  viewer.camera.changed.addEventListener(() => {
    if (!sseRaf) sseRaf = requestAnimationFrame(updateDynamicSSE);
  });
  // moveStart fires when any camera motion begins (user gesture, flight, or
  // the idle auto-spin); moveEnd fires after ~500 ms of stillness
  // (scene.cameraEventWaitTime). Documented Camera events.
  //
  // The height baseline is recorded here; updateDynamicSSE (driven by
  // camera.changed) engages the motion relaxation only once the height has
  // genuinely changed — a zoom. Pure rotations/pans and the idle spin keep
  // full sharpness for the whole gesture: no blur-while-turning, no
  // refinement re-render on settle.
  viewer.camera.moveStart.addEventListener(() => {
    try {
      const h = viewer.camera.positionCartographic.height;
      moveStartHeight = Number.isFinite(h) && h > 0 ? h : 0;
    } catch {
      moveStartHeight = 0;
    }
  });
  viewer.camera.moveEnd.addEventListener(() => {
    moveStartHeight = 0;
    if (motionRelax !== 1) {
      motionRelax = 1;
      updateDynamicSSE();
    }
  });

  // Bigger tile cache for zoom in/out workflows — zooming back out re-shows
  // detail instantly instead of re-fetching.
  viewer.scene.globe.tileCacheSize = 250;
  // Preload sibling tiles for smoother panning (fewer pop-ins at edges).
  viewer.scene.globe.preloadSiblings = true;

  // Globe quality: full native resolution on all devices. The DPR cap and
  // reduced MSAA were a visible quality regression — removed (2026-09-29).
  // The render governor already idles the loop when nothing animates, so the
  // battery cost of full resolution is bounded.
  // (MSAA left at Cesium's 4x default; resolutionScale left at 1.0 = native.)

  // Restore full request concurrency. The previous cap of 6 was starving tile
  // refinement during fast zooms — the official default is 18, and Esri's
  // tile hosts support HTTP/2.
  if (Cesium.RequestScheduler) {
    Cesium.RequestScheduler.maximumRequestsPerServer = 18;
  }

  // Real 3D terrain (Re:Earth quantized mesh — same terrain God's Eye View
  // uses; keyless, CC BY 4.0, CORS-open) — resolves async; the globe starts
  // on the smooth ellipsoid and upgrades when it arrives. 429 bursts retry
  // with exponential backoff (F1); final failure stays on the ellipsoid.
  loadTerrainWithRetry()
    .then((terrainProvider) => {
      if (viewer && !viewer.isDestroyed()) {
        viewer.terrainProvider = terrainProvider;
        viewer.scene.globe.credit = new Cesium.Credit(REEARTH_TERRAIN_CREDIT, true);
      }
    })
    .catch((err) => console.warn('[globe] terrain unavailable, staying on ellipsoid:', err));

  // Gentle initial view.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(10, 18, 26_000_000),
  });

  // Slow idle rotation until the user takes over (glacial, not distracting).
  // Registered as a render-governor hold: the spin needs continuous frames,
  // and releasing it on takeover lets the governor drop to idle (audit 1.1).
  let userTookOver = false;
  holdContinuousRender('idle-spin');
  const stopSpin = () => {
    userTookOver = true;
    releaseContinuousRender('idle-spin');
  };
  stopIdleSpin = stopSpin;
  viewer.scene.screenSpaceCameraController.enableRotate = true;
  // Mobile camera tuning: calmer pinch zoom, less coasting after release,
  // and keep the camera out of the sub-native blur zone.
  if (isMobile) {
    const controller = viewer.scene.screenSpaceCameraController;
    controller.zoomFactor = 2.5; // default 5.0 — slower, calmer pinch zoom
    controller.inertiaZoom = 0.4; // default 0.8 — crisper stops, smaller tile stampedes
    controller.inertiaTranslate = 0.7; // default 0.9
    controller.minimumZoomDistance = 500; // default 1m — bounds L18/19 requests
  }
  container.addEventListener('pointerdown', stopSpin, { once: true });
  container.addEventListener('wheel', stopSpin, { once: true });
  const spin = () => {
    if (userTookOver || !viewer || viewer.isDestroyed()) return; // stop rescheduling once taken over
    viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.00012);
    requestAnimationFrame(spin);
  };
  requestAnimationFrame(spin);

  // Style Cesium's credit container minimally (Glacial Calm) instead of hiding it —
  // Esri/OSM attribution must remain visible per their terms.
  const creditContainer = viewer.cesiumWidget.creditContainer;
  if (creditContainer) {
    creditContainer.style.display = 'block';
    creditContainer.style.position = 'absolute';
    creditContainer.style.bottom = '6px';
    creditContainer.style.right = '8px';
    creditContainer.style.background = 'rgba(5, 11, 22, 0.55)';
    creditContainer.style.backdropFilter = 'blur(8px)';
    creditContainer.style.padding = '3px 8px';
    creditContainer.style.borderRadius = '6px';
    creditContainer.style.fontSize = '10px';
    creditContainer.style.color = 'rgba(127, 206, 240, 0.6)';
    creditContainer.style.border = '1px solid rgba(127, 206, 240, 0.12)';
    creditContainer.style.zIndex = '10';
    // Hide the lightbox info button, keep the text credit.
    const infoBtn = creditContainer.querySelector('.cesium-credit-lightbox');
    if (infoBtn) infoBtn.style.display = 'none';
  }

  // Surface render errors instead of swallowing them.
  viewer.scene.renderError.addEventListener((scene, error) => {
    console.error('[globe] render error:', error);
  });

  return viewer;
}

export function getViewer() {
  return viewer;
}
