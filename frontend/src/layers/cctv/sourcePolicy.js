/**
 * Lane E (Phase 3): CCTV in the merged system has NO server relay
 * (ARCH §6.4 / D2-07 — no HLS puller or media relay ever runs on the VM).
 * The only backend route is the adapter catalog; frames and media are
 * loaded client-direct from the URLs that catalog carries, and anything
 * without a playable direct URL renders the labelled synthetic state.
 * The old GEV-server endpoints (/api/cctv/sources|health|frame|media)
 * do not exist in the merged backend and must never be called.
 */
export const CATALOG_ENDPOINT = '/api/cameras/catalog';

/** Legacy names kept for import compatibility; both point at the catalog. */
export const FRAME_ENDPOINT = CATALOG_ENDPOINT;
export const SOURCE_ENDPOINT = CATALOG_ENDPOINT;
export const HEALTH_ENDPOINT = CATALOG_ENDPOINT;
export const MEDIA_ENDPOINT = CATALOG_ENDPOINT;

export const ACTIVE_FRAME_REFRESH_MS = 10000;

/** Triple label for the honest fallback image (GEV synthetic pattern). */
export const SYNTHETIC_LABEL = 'SYNTHETIC · DEGRADED · NOT A LIVE IMAGE';
