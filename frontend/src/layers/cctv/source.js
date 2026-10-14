import {
  ACTIVE_FRAME_REFRESH_MS,
  CATALOG_ENDPOINT,
  SYNTHETIC_LABEL,
} from './sourcePolicy.js';

function safeNumber(value, fallback = NaN) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/** Direct still/video URL a browser may load itself, or null. */
export function directUrlFor(camera) {
  if (!camera || typeof camera !== 'object') return null;
  const candidates = [
    camera.snapshotUrl,
    camera.directUrl,
    camera.url,
    camera.media?.snapshotUrl,
    camera.media?.url,
  ];
  for (const candidate of candidates) {
    if (isHttpUrl(candidate)) return candidate.trim();
  }
  return null;
}

function isVideoCamera(camera) {
  const feedType = String(
    camera?.feedType || camera?.media?.feedType || '',
  ).toLowerCase();
  const kind = String(camera?.mediaKind || camera?.kind || '').toLowerCase();
  return (
    kind === 'player' ||
    kind === 'hls-direct' ||
    feedType === 'mp4' ||
    feedType === 'hls' ||
    feedType === 'webm' ||
    /\.m3u8($|\?)/i.test(directUrlFor(camera) || '')
  );
}

/**
 * Client-side reproduction of GEV's synthetic placeholder
 * (server/providers/cctv/media.js `buildSyntheticCctvSvg`, MIT): a clearly
 * labelled stand-in used when a camera has no playable direct feed in this
 * build. It is never presented as a live image — the triple label is part
 * of the image itself.
 */
export function syntheticFrameUrl(camera, status = SYNTHETIC_LABEL) {
  const label = escapeXml(camera?.name || 'CCTV CAMERA');
  const city = escapeXml(camera?.city || 'GLOBAL');
  const id = escapeXml(camera?.id || '');
  let seed = 0;
  const text = String(camera?.id || label);
  for (let i = 0; i < text.length; i++) seed = (seed * 33 + text.charCodeAt(i)) >>> 0;
  const hue = seed % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="hsl(${hue},35%,10%)"/><stop offset="100%" stop-color="#020509"/></linearGradient></defs><rect width="960" height="540" fill="url(#bg)"/><g fill="none" stroke="rgba(180,248,255,0.25)"><rect x="70" y="80" width="820" height="380" rx="8"/><line x1="70" y1="270" x2="890" y2="270"/><line x1="480" y1="80" x2="480" y2="460"/></g><g fill="#9cefff" font-family="monospace"><text x="74" y="54" font-size="20" letter-spacing="2">${escapeXml(status)}</text><text x="74" y="486" font-size="16">${label} · ${city}</text><text x="74" y="512" font-size="13">${id}</text><text x="74" y="120" font-size="15">No playable live feed for this camera in this build.</text><text x="74" y="146" font-size="15">Camera pictures load directly from the source — never through a server relay.</text></g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function frameUrlFor(camera, refreshMs = ACTIVE_FRAME_REFRESH_MS) {
  const direct = directUrlFor(camera);
  // Video cameras have no still frame URL; their cards show the labelled
  // synthetic image and the motion feed opens in the camera (projection) view.
  if (direct && !isVideoCamera(camera)) {
    const cadenceMs = Math.max(
      1000,
      safeNumber(refreshMs, ACTIVE_FRAME_REFRESH_MS),
    );
    const tick = Math.floor(Date.now() / cadenceMs);
    return `${direct}${direct.includes('?') ? '&' : '?'}ci_ts=${tick}`;
  }
  return syntheticFrameUrl(camera);
}

function mediaUrlFor(camera) {
  const direct = directUrlFor(camera);
  if (direct) return direct;
  return syntheticFrameUrl(camera);
}

/** Map one adapter catalog record (§4.2 #15 shape) to the layer's source shape. */
export function adaptAdapterCamera(cam) {
  if (!cam || typeof cam !== 'object') return null;
  const id = String(cam.id || '').trim();
  const lat = Number(cam.lat);
  const lon = Number(cam.lon);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const media = cam.media && typeof cam.media === 'object' ? cam.media : {};
  const kind = String(cam.kind || 'still').toLowerCase();
  const feedType =
    media.feedType ||
    (kind === 'player' ? 'mp4' : kind === 'hls-direct' ? 'hls' : 'image');
  const directUrl = media.url || media.snapshotUrl || null;
  const calibration =
    cam.calibration && typeof cam.calibration === 'object'
      ? cam.calibration
      : {};
  const pose = cam.pose && typeof cam.pose === 'object' ? cam.pose : {};
  return {
    id,
    name: String(cam.name || id),
    lat, // validated finite above; catalog.js requires them to keep the record (E1)
    lon,
    city: String(cam.city || calibration.city || 'Global'),
    provider: String(cam.source || 'Configured CCTV Source'),
    sourceKind: kind,
    kind,
    mediaKind: kind,
    feedType,
    url: directUrl,
    directUrl,
    snapshotUrl: media.snapshotUrl || directUrl,
    playerEmbedUrl: media.playerEmbedUrl || null,
    detailUrl: media.detailUrl || null,
    headingDeg: pose.hdg,
    fovDeg: pose.fov,
    rangeM: pose.range,
    pitchDeg: calibration.pitchDeg,
    mountHeightM: calibration.mountHeightM,
    groundElevationM: calibration.groundElevationM,
    headingConfidence: calibration.headingConfidence || null,
    license: cam.license || null,
  };
}

/**
 * Supply catalog/health records from the adapter catalog only.
 * Media is client-direct (ARCH D2-07): this source never asks the server
 * to fetch, relay or synthesize a frame.
 */
export function createCctvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let lastCameras = null;

  async function readCatalog({ signal } = {}) {
    signal?.throwIfAborted();
    const response = await fetchImpl(CATALOG_ENDPOINT, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw new Error('Camera source HTTP ' + response.status);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (!Array.isArray(payload?.cameras))
      throw new Error('Malformed camera cameras snapshot');
    return payload;
  }

  async function loadCatalog(options = {}) {
    const payload = await readCatalog(options);
    const sources = payload.cameras.map(adaptAdapterCamera).filter(Boolean);
    lastCameras = sources;
    return {
      sources,
      cameras: payload.cameras,
      fetchedAt: payload.fetchedAt,
      stale: !!payload.stale,
    };
  }

  return {
    getCatalog: loadCatalog,
    /**
     * There is no server health route in the merged system. Health is
     * derived honestly from the catalog itself: a camera is "client-direct"
     * when it carries a direct URL, and "synthetic" when it does not —
     * neither claims the server verified a live picture.
     */
    async getHealth(options = {}) {
      const sources = lastCameras || (await loadCatalog(options)).sources;
      return {
        cameras: sources.map((camera) => {
          const direct = directUrlFor(camera);
          return {
            id: camera.id,
            status: direct ? 'client-direct' : 'synthetic',
            sourceKind: camera.mediaKind || camera.sourceKind || '',
            label: camera.provider || '',
            message: direct
              ? 'Picture loads directly from the source. The server does not check it is live.'
              : `${SYNTHETIC_LABEL} — no playable direct feed for this camera.`,
            updatedAt: Date.now(),
          };
        }),
      };
    },
    getFrameUrl: frameUrlFor,
    getMediaUrl: mediaUrlFor,
    /** Read one current frame client-direct; synthetic bytes when none exists. */
    async getFrame(camera, { signal } = {}) {
      signal?.throwIfAborted();
      const direct = directUrlFor(camera);
      if (!direct || isVideoCamera(camera)) {
        const svg = decodeURIComponent(
          syntheticFrameUrl(camera).split(',')[1] || '',
        );
        return {
          contentType: 'image/svg+xml',
          bytes: new TextEncoder().encode(svg),
        };
      }
      const response = await fetchImpl(frameUrlFor(camera), {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Camera frame HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      const type = response.headers.get('content-type') || '';
      return { contentType: type.split(';')[0].trim().toLowerCase(), bytes };
    },
  };
}

export { frameUrlFor, mediaUrlFor };
