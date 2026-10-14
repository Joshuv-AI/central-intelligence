import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export const ESRI_IMAGERY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';

/**
 * Deadline for the Esri World Imagery metadata fetch, mirroring the
 * terrain deadline (maps/terrain.js, SPEC §3.E D2 boot rule): provider
 * construction happens inside scene creation, which the catalog build
 * awaits — a metadata host that hangs (not just errors) must never
 * stall the boot. On deadline the construction throws, and the map
 * stack controller's existing construction fallback (OSM, see
 * maps/defaultSources.js) takes over loudly. When the metadata fetch
 * resolves inside the deadline, behaviour is unchanged.
 */
export const ESRI_IMAGERY_DEADLINE_MS = 6000;

export async function createEsriImagery() {
  const providerPromise = Cesium.ArcGisMapServerImageryProvider.fromUrl(
    ESRI_IMAGERY_URL,
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Esri World Imagery metadata fetch exceeded ${ESRI_IMAGERY_DEADLINE_MS} ms`,
          ),
        ),
      ESRI_IMAGERY_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([providerPromise, deadline]);
  } catch (error) {
    console.warn(
      '[MapStack] Esri World Imagery unavailable (metadata fetch failed ' +
        `or exceeded ${ESRI_IMAGERY_DEADLINE_MS} ms deadline), ` +
        'falling back to OSM:',
      error,
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}

/**
 * CI default basemap (SPEC §3.A KEEP FROM CI): Esri World Dark Gray Canvas,
 * keyless. Tile order is {z}/{y}/{x}. The MapSourceController hosts one
 * imagery layer per stack; CI's separate Dark Gray Reference overlay layer
 * is a step-5 rendering-core follow-up (see VENDOR.md strip/defaults record).
 */
export function createEsriDarkImagery() {
  return new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    credit: '© Esri, HERE, Garmin, FAO, NOAA, USGS',
    maximumLevel: 16,
    hasAlphaChannel: false,
  });
}
