/* Cesium viewer — keyless by constraint (no Ion token):
   Esri World Imagery (satellite) + Boundaries & Places overlay, all keyless;
   Esri Terrain3D for real relief (async upgrade from the ellipsoid).
   All Ion widgets off. */
import * as Cesium from 'cesium';
// widgets.css is injected by vite-plugin-cesium (link tag in index.html).

// NOTE: Esri tile order is {z}/{y}/{x} — y before x, unlike most providers.
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_IMAGERY_CREDIT = 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
const ESRI_PLACES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_PLACES_CREDIT = 'Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS user community';
const ESRI_TERRAIN = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';
const ESRI_TERRAIN_CREDIT = 'Sources: Vantor, Airbus DS, USGS, NGA, NASA, CGIAR, GEBCO, N Robinson, NCEAS, NLS, OS, NMA, Geodatastyrelsen and the GIS User Community';

let viewer = null;

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
  viewer.scene.fog.enabled = false;

  // Basemap: Esri Dark Gray Canvas by default (keyless). With a free CARTO
  // key set (VITE_CARTO_KEY), use CARTO Dark Matter instead.
  // Satellite basemap (Esri World Imagery, keyless) + boundaries/places overlay.
  const imagery = new Cesium.UrlTemplateImageryProvider({
    url: ESRI_IMAGERY,
    credit: new Cesium.Credit(ESRI_IMAGERY_CREDIT, true),
    maximumLevel: 19,
  });
  viewer.imageryLayers.addImageryProvider(imagery);
  // Reference layer: boundaries + place labels over the imagery.
  const ref = new Cesium.UrlTemplateImageryProvider({
    url: ESRI_PLACES,
    credit: new Cesium.Credit(ESRI_PLACES_CREDIT, true),
    maximumLevel: 16,
  });
  viewer.imageryLayers.addImageryProvider(ref);

  // Real 3D terrain (Esri Terrain3D, keyless) — resolves async; the globe
  // starts on the smooth ellipsoid and upgrades when it arrives.
  if (Cesium.ArcGISTiledElevationTerrainProvider) {
    Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(ESRI_TERRAIN)
      .then((terrainProvider) => {
        if (viewer && !viewer.isDestroyed()) {
          viewer.terrainProvider = terrainProvider;
          viewer.scene.globe.credit = new Cesium.Credit(ESRI_TERRAIN_CREDIT, true);
        }
      })
      .catch((err) => console.warn('[globe] terrain unavailable, staying on ellipsoid:', err));
  }

  // Gentle initial view.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(10, 18, 26_000_000),
  });

  // Slow idle rotation until the user takes over (glacial, not distracting).
  let userTookOver = false;
  const stopSpin = () => { userTookOver = true; };
  viewer.scene.screenSpaceCameraController.enableRotate = true;
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

// True when WebGL + Cesium actually produced frames.
export function viewerReady() {
  return !!(viewer && !viewer.isDestroyed());
}
