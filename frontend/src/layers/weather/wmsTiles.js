import { wmsTileUrl } from './source.js';

/**
 * Cesium imagery provider that serves nowCOAST WMS GetMap tiles directly
 * from the browser — the per-tile work GEV's server `/api/weather/tile`
 * route did (geographic-scheme bbox → WMS GetMap PNG), done client-side
 * (ARCH §4.3: weather imagery is direct-from-browser; GAP-D2).
 *
 * Mirrors the provider shape of `createRasterTileProvider`: a plain object
 * with a geographic tiling scheme whose `requestImage` resolves to an
 * image element Cesium can upload.
 */
export function createWmsTileProvider({
  cesium,
  product,
  time,
  rectangle,
  tileSize = 256,
  maximumLevel = 6,
  credit,
  fetchImpl = (...args) => globalThis.fetch(...args),
  decodeImage,
}) {
  const tilingScheme = new cesium.GeographicTilingScheme({
    rectangle,
    numberOfLevelZeroTilesX: 2,
    numberOfLevelZeroTilesY: 1,
  });
  const decode =
    decodeImage ??
    (async (blob) => {
      if (typeof globalThis.createImageBitmap === 'function')
        return globalThis.createImageBitmap(blob);
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return image;
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  return {
    tilingScheme,
    rectangle,
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: 0,
    maximumLevel,
    ready: true,
    tileDiscardPolicy: undefined,
    credit,
    errorEvent: new cesium.Event(),
    hasAlphaChannel: true,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    async requestImage(x, y, level, request) {
      const url = wmsTileUrl(product, time, level, x, y, { size: tileSize });
      const response = await fetchImpl(url, {
        signal: request?.abortSignal,
      }).catch((error) => {
        // Cesium treats a rejected requestImage as a tile error and drives
        // the provider errorEvent path the frame readiness logic consumes.
        throw error;
      });
      if (!response?.ok)
        throw Object.assign(new Error(`Weather tile HTTP ${response?.status}`), {
          statusCode: response?.status,
        });
      const blob = await response.blob();
      return decode(blob);
    },
  };
}
