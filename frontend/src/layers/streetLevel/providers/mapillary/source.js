import {
  IMAGE_FIELDS,
  MAPILLARY_GRAPH_HOST,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  SEQUENCE_IMAGE_FIELDS,
  SEQUENCE_IMAGES_LIMIT,
} from './policy.js';

/** HTTP error flagged `keyRequired`, `keyRejected` or `retryAfterSec` (429). */
export class MapillarySourceError extends Error {
  constructor(message, { status = 0, payload = null, retryAfterSec } = {}) {
    super(message);
    this.name = 'MapillarySourceError';
    this.status = status;
    this.payload = payload;
    this.keyRequired = payload?.keyRequired ?? payload?.error === 'no_key';
    this.keyRejected = payload?.keyRejected === true;
    const wait = Number(retryAfterSec ?? payload?.retryAfter);
    this.retryAfterSec =
      status === 429 ? (Number.isFinite(wait) && wait > 0 ? wait : 60) : null;
  }
}

async function readJsonOrThrow(response, label) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* status is authoritative */
  }
  if (!response.ok)
    throw new MapillarySourceError(
      payload?.error?.message ||
        payload?.error ||
        `${label} HTTP ${response.status}`,
      { status: response.status, payload },
    );
  return payload;
}

/**
 * Mapillary network access (Lane E / ARCH §6.9, D2-16): CLIENT-DIRECT.
 * There is no adapter route and no server tile proxy in the merged system:
 * vector tiles are fetched straight from Mapillary's tile host with the
 * client token (Mapillary's designed, referrer-restricted public-token
 * model), and Graph API lookups are direct, as MapillaryJS does. No
 * derived database is built from the imagery — viewer/coverage only.
 * With no token provisioned, every method fails fast as `keyRequired`
 * without touching the network: the layer's honest no-token state.
 * @param {{token?: string, fetchImpl?: Function, endpoints?: object}} options
 */
export function createMapillarySource({
  token = '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoints = {},
} = {}) {
  const urls = {
    tiles: 'https://tiles.mapillary.com/maps/vtp/mly1_public/2',
    graph: MAPILLARY_GRAPH_HOST,
    ...endpoints,
  };

  async function graph(path, params = {}, { signal } = {}) {
    if (!token)
      throw new MapillarySourceError('Mapillary token not configured', {
        status: 503,
        payload: { keyRequired: true },
      });
    const search = new URLSearchParams({ access_token: token, ...params });
    const response = await fetchImpl(`${urls.graph}/${path}?${search}`, {
      signal,
    });
    return readJsonOrThrow(response, 'Mapillary graph');
  }

  return {
    get token() {
      return token;
    },
    hasToken: () => Boolean(token),

    /**
     * Status is a local fact in the client-direct model: configured iff a
     * client token was provisioned at build time. No network call — the
     * old /api/mapillary/status route does not exist in the merged backend.
     */
    async getStatus() {
      return {
        configured: Boolean(token),
        keyRequired: !token,
        message: token
          ? null
          : 'Street Level needs a free Mapillary token, which is not set up yet. No street pictures are shown until it is.',
      };
    },

    /** Raw protobuf bytes for one tile; an empty array means no data. */
    async getTile(layer, z, x, y, { signal } = {}) {
      if (!token)
        throw new MapillarySourceError('Mapillary token not configured', {
          status: 503,
          payload: { keyRequired: true },
        });
      // The GEV proxy exposed one "coverage" layer (upstream mly1_public);
      // client-direct, that is the tile path itself.
      const response = await fetchImpl(
        `${urls.tiles}/${z}/${x}/${y}?access_token=${encodeURIComponent(token)}`,
        { signal },
      );
      if (response.status === 204) return new Uint8Array(0);
      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          /* ignore */
        }
        if (response.status === 401 || response.status === 403)
          payload = { ...(payload || {}), keyRejected: true };
        throw new MapillarySourceError(
          payload?.error?.message || payload?.error || `Tile HTTP ${response.status}`,
          {
            status: response.status,
            payload,
            retryAfterSec: response.headers?.get?.('retry-after') ?? undefined,
          },
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async getSequenceImages(
      sequenceId,
      { signal, limit = SEQUENCE_IMAGES_LIMIT } = {},
    ) {
      const payload = await graph(
        'images',
        {
          sequence_ids: String(sequenceId),
          fields: SEQUENCE_IMAGE_FIELDS,
          limit: String(limit),
        },
        { signal },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },

    async nearestImages(
      { lat, lon, radius = NEAREST_RADIUS_M, limit = NEAREST_LIMIT },
      { signal } = {},
    ) {
      const payload = await graph(
        'images',
        {
          lat: String(lat),
          lng: String(lon),
          radius: String(Math.min(50, Math.max(1, radius))),
          limit: String(Math.min(100, Math.max(1, limit))),
          fields: IMAGE_FIELDS,
        },
        { signal },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },
  };
}
