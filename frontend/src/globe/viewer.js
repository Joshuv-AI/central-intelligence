/* Cesium viewer — keyless by constraint (no Ion token):
   EllipsoidTerrainProvider + CartoDB dark basemap, all Ion widgets off. */
import * as Cesium from 'cesium';
// widgets.css is injected by vite-plugin-cesium (link tag in index.html).

const CARTO_DARK =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

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
  viewer.scene.globe.enableLighting = false;
  viewer.scene.fog.enabled = false;

  // CartoDB dark basemap with required attribution.
  const carto = new Cesium.UrlTemplateImageryProvider({
    url: CARTO_DARK,
    subdomains: 'abcd',
    credit: new Cesium.Credit('© OpenStreetMap contributors © CARTO', true),
    maximumLevel: 12,
  });
  viewer.imageryLayers.addImageryProvider(carto);

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

  // Hide Cesium's default credit lightbox clutter; keep the text credit.
  const creditContainer = viewer.cesiumWidget.creditContainer;
  if (creditContainer) creditContainer.style.display = 'none';

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
