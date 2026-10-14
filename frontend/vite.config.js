// Central Intelligence frontend — standalone Vite config.
// Derived from GEV build/vite.js createBrowserViteConfig WITHOUT importing
// anything from gev/server/ (never vendored). Kept: cesium plugin,
// applicationHtmlPlugin, panelBuildPlugin. Dropped: hostCheckPlugin
// (admission gate — CUT, ARCH §4/§9) and embedFramingPlugin.
import { defineConfig } from 'vite';
import { createBrowserViteConfig } from './build/vite.js';

export default defineConfig(({ command }) => {
  const config = createBrowserViteConfig({
    command,
    host: '127.0.0.1',
    port: 4173,
    googleApiKey: '',
    cesiumToken: '',
    mapillaryToken: process.env.MAPILLARY_CLIENT_TOKEN ?? '',
  });
  config.define = {
    ...config.define,
    'import.meta.env.VITE_BUILD_SHA': JSON.stringify(
      process.env.GIT_SHA || 'dev',
    ),
  };
  return config;
});
