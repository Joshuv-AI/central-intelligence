import { createStandaloneApplication } from './standalone/application.js';
import { initDiagnostics } from './diagnostics.js';
import { describeError } from './standalone/errors.js';
import { armIconFontFallback } from './iconFontFallback.js';
import { initMobilePanelDock } from './ui/mobilePanelDock.js';

initDiagnostics();
// Never show raw icon-ligature text if the Material Symbols webfont fails.
armIconFontFallback();
// F12: mobile panel docking — rails dock off by default at ≤720px.
initMobilePanelDock();

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("Central Intelligence initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

export { application };
