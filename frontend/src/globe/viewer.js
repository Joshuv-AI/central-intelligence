/* Cesium viewer — keyless by constraint (no Ion token):
   Esri World Imagery (satellite) + Boundaries & Places overlay, all keyless;
   Re:Earth quantized-mesh terrain for real relief (async upgrade from the
   ellipsoid) — same terrain God's Eye View uses, keyless, CC BY 4.0.
   All Ion widgets off. */
import * as Cesium from 'cesium';
// widgets.css is injected by vite-plugin-cesium (link tag in index.html).

// NOTE: Esri tile order is {z}/{y}/{x} — y before x, unlike most providers.
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_IMAGERY_CREDIT = 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
const ESRI_PLACES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_PLACES_CREDIT = 'Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community';
const REEARTH_TERRAIN = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';
const REEARTH_TERRAIN_CREDIT = 'Terrain: Re:Earth, Mapterhorn, EGM2008 (NGA), Protomaps, © OpenStreetMap contributors';

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

  // Atmosphere and starfield: the blue limb halo is half the wow factor.
  // (Was disabled for "polar night" — re-enabled for the GEV-grade look.)
  viewer.scene.skyBox.show = true;
  viewer.scene.skyAtmosphere.show = true;
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
    maximumLevel: isMobile ? 18 : 19,
    // Esri World Imagery is opaque JPEG — skipping alpha channel saves
    // texture memory and upload time.
    hasAlphaChannel: false,
  });
  viewer.imageryLayers.addImageryProvider(imagery);
  // Reference layer: boundaries + place labels over the imagery.
  const ref = new Cesium.UrlTemplateImageryProvider({
    url: ESRI_PLACES,
    credit: new Cesium.Credit(ESRI_PLACES_CREDIT, true),
    maximumLevel: isMobile ? 14 : 16,
  });
  viewer.imageryLayers.addImageryProvider(ref);

  // Globe performance tuning: higher screen-space error = fewer tiles,
  // faster loads. 3 is the sweet spot on mobile: sharper than 4, snappier than 2.
  viewer.scene.globe.maximumScreenSpaceError = isMobile ? 3 : 2;

  // Bigger tile cache for zoom in/out workflows — zooming back out re-shows
  // detail instantly instead of re-fetching.
  viewer.scene.globe.tileCacheSize = 250;
  // Preload sibling tiles for smoother panning (fewer pop-ins at edges).
  viewer.scene.globe.preloadSiblings = true;

  // MSAA: 4x is the default since Cesium 1.121, but it's very expensive on
  // iPhone GPUs. 2x on mobile is the biggest fill-rate win available.
  // (The legacy antialias context flag no longer controls this.)
  if (isMobile) {
    viewer.scene.msaaSamples = 2;
  }

  // Restore full request concurrency. The previous cap of 6 was starving tile
  // refinement during fast zooms — the official default is 18, and Esri's
  // tile hosts support HTTP/2.
  if (Cesium.RequestScheduler) {
    Cesium.RequestScheduler.maximumRequestsPerServer = 18;
  }

  // Real 3D terrain (Re:Earth quantized mesh — same terrain God's Eye View
  // uses; keyless, CC BY 4.0, CORS-open) — resolves async; the globe starts
  // on the smooth ellipsoid and upgrades when it arrives.
  Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN)
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
  let userTookOver = false;
  const stopSpin = () => { userTookOver = true; };
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
    if (!userTookOver && viewer && !viewer.isDestroyed()) {
      viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.00012);
    }
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
