/* Cesium viewer — keyless by constraint (no Ion token):
   EllipsoidTerrainProvider + keyless dark basemap, all Ion widgets off.
   Basemap: Esri World Dark Gray Canvas (free, no key, no quota).
   CARTO Dark Matter remains available at build time via VITE_CARTO_KEY — build
   with a free key from https://carto.com/basemaps/apikey and the viewer uses
   CARTO instead (CARTO began watermarking keyless tiles "API KEY
   REQUIRED" in late August 2026). */
import * as Cesium from 'cesium';
// widgets.css is injected by vite-plugin-cesium (link tag in index.html).

// NOTE: Esri tile order is {z}/{y}/{x} — y before x, unlike most providers.
const ESRI_BASE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const ESRI_REF = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
const ESRI_CREDIT = '© Esri, HERE, Garmin, FAO, NOAA, USGS';

const CARTO_DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const CARTO_CREDIT = '© OpenStreetMap contributors © CARTO';

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

  // Deep polar night: no starfield, no atmosphere glow.
  viewer.scene.skyBox.show = false;
  viewer.scene.skyAtmosphere.show = false;
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#050B16');
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#12283f');
  viewer.scene.globe.enableLighting = false;
  viewer.scene.fog.enabled = false;

  // Basemap: Esri Dark Gray Canvas by default (keyless). With a free CARTO
  // key set (VITE_CARTO_KEY), use CARTO Dark Matter instead.
  const cartoKey = (import.meta.env.VITE_CARTO_KEY || '').trim();
  if (cartoKey) {
    const carto = new Cesium.UrlTemplateImageryProvider({
      url: `${CARTO_DARK}?key=${encodeURIComponent(cartoKey)}`,
      subdomains: 'abcd',
      credit: new Cesium.Credit(CARTO_CREDIT, true),
      maximumLevel: 12,
    });
    viewer.imageryLayers.addImageryProvider(carto);
  } else {
    const base = new Cesium.UrlTemplateImageryProvider({
      url: ESRI_BASE,
      credit: new Cesium.Credit(ESRI_CREDIT, true),
      maximumLevel: 16,
    });
    viewer.imageryLayers.addImageryProvider(base);
    // Reference layer: subtle place labels over the dark canvas.
    const ref = new Cesium.UrlTemplateImageryProvider({
      url: ESRI_REF,
      maximumLevel: 16,
    });
    viewer.imageryLayers.addImageryProvider(ref);
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
  // OpenStreetMap/CARTO attribution must remain visible per their terms.
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
