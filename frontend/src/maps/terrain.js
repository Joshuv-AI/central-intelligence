import * as Cesium from 'cesium';
import { createTerrainRetryPolicy } from './terrainRetry.js';

/**
 * Terrain host (SPEC §3.A KEEP FROM CI): Esri Terrain3D, keyless — the host
 * CI's live viewer uses. (GEV's keyless default was Re:Earth/Mapterhorn;
 * CI's stale Re:Earth credit is corrected in THIRD-PARTY-NOTICES.md.)
 */
export const KEYLESS_TERRAIN_URL =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';
export const ESRI_TERRAIN3D_URL = KEYLESS_TERRAIN_URL;

/** These factories are lazy: a hidden globe must not trigger terrain loading. */
export async function createWorldTerrain(accessToken, { signal } = {}) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken)
    throw new Error('World terrain requires an explicit ion token');
  signal?.throwIfAborted();
  const resource = await Cesium.IonResource.fromAssetId(1, { accessToken });
  signal?.throwIfAborted();
  return {
    provider: await Cesium.CesiumTerrainProvider.fromUrl(resource, {
      requestVertexNormals: true,
      requestWaterMask: false,
      ellipsoid: Cesium.Ellipsoid.WGS84,
    }),
  };
}

function logThrottle({ statusCode, delayMs, inWindow }) {
  // One line per cooldown window, not per tile: a burst throttles dozens.
  if (inWindow !== 1) return;
  console.warn(
    `[MapStack] Terrain host answered ${statusCode}; retrying throttled tiles after ${Math.round(delayMs)} ms`,
  );
}

/**
 * The Re:Earth resource with the tile retry policy attached. Cesium copies
 * `retryCallback`/`retryAttempts` onto every derived resource, so layer.json
 * and each `{z}/{x}/{y}.terrain` fetch inherit it (see `terrainRetry.js`).
 * @param {ReturnType<typeof createTerrainRetryPolicy>} [policy]
 * @returns {Cesium.Resource}
 */
export function createKeylessTerrainResource(
  policy = createTerrainRetryPolicy({ onThrottle: logThrottle }),
) {
  return new Cesium.Resource({
    url: KEYLESS_TERRAIN_URL,
    retryCallback: policy.retryCallback,
    retryAttempts: policy.retryAttempts,
  });
}

const KEYLESS_TERRAIN_DEADLINE_MS = 6000;

export async function createKeylessTerrain() {
  // GEV's terrain retry policy (terrainRetry.js: 429/5xx + backoff +
  // Retry-After) ported onto the Esri Terrain3D host at construction:
  // provider creation is retried before degrading to the ellipsoid, and the
  // degradation is announced, never silent (SPEC §3.A; CI's old behaviour
  // was a silent permanent ellipsoid).
  // CI boot rule (SPEC §3.E D2): terrain construction is deadline-bounded —
  // a terrain host that hangs (not just errors) must never block the boot;
  // the same loud ellipsoid fallback applies when the deadline expires.
  const policy = createTerrainRetryPolicy({ onThrottle: logThrottle });
  let lastError;
  const attempts = (async () => {
    for (let attempt = 0; attempt <= policy.retryAttempts; attempt += 1) {
      try {
        return await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(
          ESRI_TERRAIN3D_URL,
        );
      } catch (error) {
        lastError = error;
        if (attempt < policy.retryAttempts)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(1000 * 2 ** attempt, 8000)),
          );
      }
    }
    return null;
  })();
  const deadline = new Promise((resolve) =>
    setTimeout(() => resolve(null), KEYLESS_TERRAIN_DEADLINE_MS),
  );
  const provider = await Promise.race([attempts, deadline]);
  if (provider) return { provider };
  console.warn(
    '[MapStack] Esri Terrain3D unavailable (retries exhausted or ' +
      `${KEYLESS_TERRAIN_DEADLINE_MS} ms deadline), falling back to flat ellipsoid terrain:`,
    lastError ?? 'deadline',
  );
  return { provider: new Cesium.EllipsoidTerrainProvider() };
}
