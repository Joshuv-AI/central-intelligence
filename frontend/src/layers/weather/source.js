import { readResponseTextCapped } from '../../sources/httpBody.js';

export const WEATHER_PRODUCTS = Object.freeze([
  'radar',
  'clouds',
  'clouds-regional',
  'lightning',
]);

/**
 * NOAA nowCOAST WMS product specs — ported verbatim from GEV's server
 * provider (`server/providers/weather.js`). In this architecture weather
 * imagery is a direct-from-browser layer (ARCH §4.3): the browser talks to
 * nowCOAST WMS itself (GetCapabilities for the manifest, GetMap for tiles
 * and whole-extent images); there is no `/api/weather` route (GAP-D2).
 */
export const NOWCOAST_BASE =
  'https://nowcoast.noaa.gov/geoserver/observations/';
const HOUR = 3600_000;

export const WEATHER_PRODUCT_SPECS = Object.freeze({
  lightning: Object.freeze({
    service: 'lightning_detection',
    layer: 'ldn_lightning_strike_density',
    style: 'lightning_density',
    title: 'Lightning density · 15 min',
    coverage:
      'Pacific and Americas: 110°E across the dateline to 0°, 25°S–80°N; not global coverage.',
    description:
      'Observed 15-minute lightning strike density on an approximately 8 km grid, scaled as strikes/km²/min ×10³. Ground-network density, not individual GLM flashes.',
    attribution: 'NOAA/NWS nowCOAST; derived from Vaisala NLDN/GLD360',
    metadataTtlMs: 600_000,
    image: Object.freeze({ width: 4096, height: 2048 }),
    // Fallback extent (the provider's published coverage) used only until
    // the first GetCapabilities parse replaces it with the advertised box.
    extent: Object.freeze({ west: 110, south: -25, east: 360, north: 80 }),
  }),
  radar: Object.freeze({
    service: 'weather_radar',
    layer: 'conus_base_reflectivity_mosaic',
    style: 'weather_radar_base_reflectivity',
    title: 'CONUS radar reflectivity',
    coverage:
      'Contiguous United States; gaps do not establish absence of precipitation.',
    description:
      'Observed MRMS radar base reflectivity (dBZ), approximately 1 km and 4-minute updates; not a rainfall forecast.',
    attribution: 'NOAA/NWS/NESDIS nowCOAST',
    image: Object.freeze({ width: 4096, height: 2048 }),
    extent: Object.freeze({ west: -135, south: 20, east: -60, north: 58 }),
  }),
  clouds: Object.freeze({
    service: 'satellite',
    layer: 'global_longwave_imagery_mosaic',
    style: 'reflectance',
    title: 'Global satellite infrared',
    coverage:
      'Global mosaic with incomplete polar coverage; nominal coverage 60°S–60°N.',
    description:
      'Longwave infrared cloud and land/sea temperature patterns, approximately 3 km; hourly updates with 2–3 hour source latency. Not a cloud-only mask.',
    attribution: 'NOAA/NWS/NESDIS nowCOAST',
    image: Object.freeze({ width: 2048, height: 1024 }),
    extent: Object.freeze({ west: -180, south: -60, east: 180, north: 60 }),
  }),
  'clouds-regional': Object.freeze({
    service: 'satellite',
    layer: 'goes_longwave_imagery',
    style: 'goes-lir',
    title: 'GOES regional satellite infrared',
    coverage:
      'GOES East/West regional North American coverage; not a global image.',
    description:
      'GOES-19/18 longwave infrared Band 14 cloud and surface temperature patterns, approximately 2 km and 5-minute updates. Not a cloud-only mask.',
    attribution: 'NOAA/NWS/NESDIS nowCOAST',
    image: Object.freeze({ width: 4096, height: 2048 }),
    extent: Object.freeze({ west: -180, south: 0, east: -30, north: 75 }),
  }),
});

/** Only bounded, explicit observations may become imagery requests. */
export function validateWeatherSnapshot(value, product) {
  if (!value || value.schemaVersion !== 1 || value.product !== product)
    throw new Error('Malformed weather manifest');
  if (value.unavailable) return value;
  const { bounds, times } = value;
  if (
    !bounds ||
    !['west', 'south', 'east', 'north'].every((key) =>
      Number.isFinite(bounds[key]),
    ) ||
    bounds.west < -180 ||
    bounds.east > 360 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north ||
    !Array.isArray(times) ||
    times.length < 1 ||
    times.length > 13 ||
    times.some(
      (time, i) =>
        typeof time !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) ||
        !Number.isFinite(Date.parse(time)) ||
        new Date(time).toISOString() !== time ||
        (i > 0 && time <= times[i - 1]),
    ) ||
    value.latest !== times.at(-1) ||
    value.tileSize !== 256 ||
    value.maxLevel !== 6 ||
    value.tilingScheme !== 'geographic'
  )
    throw new Error('Malformed weather manifest');
  return value;
}

/** Largest whole-extent image per product. */
export const WEATHER_IMAGE_SIZES = Object.freeze({
  radar: Object.freeze({ width: 4096, height: 2048 }),
  'clouds-regional': Object.freeze({ width: 4096, height: 2048 }),
  clouds: Object.freeze({ width: 2048, height: 1024 }),
  lightning: Object.freeze({ width: 4096, height: 2048 }),
});
/** Largest detail-window image for every product. */
export const WEATHER_DETAIL_SIZE = Object.freeze({ width: 4096, height: 2048 });

/** Canonicalize only explicit UTC observations; never expand time intervals. */
function observationTime(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const canonical = date.toISOString();
  return canonical.replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
    ? canonical
    : null;
}

/**
 * Parse one product's bounds + advertised observation times out of a WMS
 * GetCapabilities document — the same bounded leaf-layer extraction GEV's
 * server provider performed (no XML entity resolution; plain text scan).
 */
export function parseWeatherCapabilities(xml, product, nowMs = Date.now()) {
  const spec = WEATHER_PRODUCT_SPECS[product];
  const invalid = () => new Error('Invalid weather metadata');
  if (
    !spec ||
    typeof xml !== 'string' ||
    xml.length > 512 * 1024 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw invalid();
  const stack = [];
  let leaf = null;
  let tags = 0;
  for (const match of xml.matchAll(/<\/?(?:[\w.-]+:)?Layer\b[^>]*>/g)) {
    if (++tags > 2048) throw invalid();
    if (!match[0].startsWith('</')) {
      if (stack.length) stack.at(-1).nested = true;
      if (stack.length >= 16 || match[0].endsWith('/>')) throw invalid();
      stack.push({ start: match.index + match[0].length, nested: false });
    } else {
      const opened = stack.pop();
      if (!opened) throw invalid();
      if (opened.nested) continue;
      const candidate = xml.slice(opened.start, match.index);
      const name = candidate
        .match(/<(?:[\w.-]+:)?Name\s*>([^<]+)<\/(?:[\w.-]+:)?Name>/)?.[1]
        ?.trim();
      if (name === spec.layer) {
        if (leaf !== null) throw invalid();
        leaf = candidate;
      }
    }
  }
  if (stack.length || !leaf) throw invalid();
  const box = leaf.match(
    /<(?:[\w.-]+:)?EX_GeographicBoundingBox\s*>([\s\S]*?)<\/(?:[\w.-]+:)?EX_GeographicBoundingBox>/,
  )?.[1];
  const bounds = {};
  for (const [key, tag] of Object.entries({
    west: 'westBoundLongitude',
    south: 'southBoundLatitude',
    east: 'eastBoundLongitude',
    north: 'northBoundLatitude',
  })) {
    const value = box
      ?.match(
        new RegExp(`<(?:[\\w.-]+:)?${tag}\\s*>([^<]+)</(?:[\\w.-]+:)?${tag}>`),
      )?.[1]
      ?.trim();
    bounds[key] = value ? Number(value) : NaN;
  }
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.west < -180 ||
    bounds.east > 360 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north
  )
    throw invalid();
  const dimensions = [
    ...leaf.matchAll(
      /<(?:[\w.-]+:)?Dimension\b([^>]*)>([^<]*)<\/(?:[\w.-]+:)?Dimension>/g,
    ),
  ].filter((entry) => /\bname\s*=\s*["']time["']/.test(entry[1]));
  if (
    dimensions.length !== 1 ||
    !/\bunits\s*=\s*["']ISO8601["']/.test(dimensions[0][1])
  )
    throw invalid();
  const raw = dimensions[0][2].trim().split(',');
  if (!raw.length || raw.length > 512) throw invalid();
  const times = raw.map((value) => observationTime(value.trim()));
  if (times.some((value) => !value || Date.parse(value) > nowMs + 5 * 60_000))
    throw invalid();
  const defaultTime = observationTime(
    dimensions[0][1].match(/\bdefault\s*=\s*["']([^"']+)["']/)?.[1],
  );
  if (!defaultTime || !times.includes(defaultTime)) throw invalid();
  const recent = [...new Set(times)]
    .filter((value) => nowMs - Date.parse(value) <= 24 * HOUR)
    .sort()
    .slice(-26);
  if (!recent.length) throw new Error('Weather observations expired');
  return { bounds, times: recent.slice(-13), allowedTimes: recent };
}

/** GeographicTilingScheme tile bounds, as GEV's server tile route computed. */
export function weatherTileBounds(z, x, y) {
  if (
    ![z, x, y].every(Number.isInteger) ||
    z < 0 ||
    z > 6 ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** (z + 1) ||
    y >= 2 ** z
  )
    throw new Error('Invalid weather tile');
  const span = 180 / 2 ** z;
  return [
    -180 + x * span,
    90 - (y + 1) * span,
    -180 + (x + 1) * span,
    90 - y * span,
  ];
}

/** One direct nowCOAST WMS GetMap URL for an explicit bbox + pixel size. */
export function wmsGetMapUrl(product, time, bbox, width, height) {
  const spec = WEATHER_PRODUCT_SPECS[product];
  if (!spec || !Number.isFinite(Date.parse(time)))
    throw new Error('Invalid weather frame');
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: spec.layer,
    styles: spec.style,
    srs: 'EPSG:4326',
    bbox: bbox.join(','),
    width: String(width),
    height: String(height),
    format: 'image/png',
    transparent: 'true',
    time,
  });
  return `${NOWCOAST_BASE}${spec.service}/ows?${params}`;
}

/** Direct WMS URL for one geographic-scheme tile at an observation time. */
export function wmsTileUrl(product, time, z, x, y, { size = 256 } = {}) {
  if (!WEATHER_PRODUCTS.includes(product) || !Number.isFinite(Date.parse(time)))
    throw new Error('Invalid weather frame');
  if (![256, 512, 1024].includes(size))
    throw new Error('Invalid weather tile size');
  return wmsGetMapUrl(product, time, weatherTileBounds(z, x, y), size, size);
}

// Last advertised bounds per product, learned from GetCapabilities. The
// server provider kept the same state to build whole-extent images; here
// it lets `weatherImageUrl` address the exact extent the manifest showed.
const advertisedBounds = new Map();
export function noteWeatherBounds(product, bounds) {
  if (bounds) advertisedBounds.set(product, { ...bounds });
}
export function weatherBoundsFor(product) {
  return advertisedBounds.get(product) ?? WEATHER_PRODUCT_SPECS[product]?.extent;
}

/** A whole-extent image, or with `bbox` ({ west, south, east, north } degrees)
 * a detail window of the same product — as a direct nowCOAST GetMap URL. */
export function weatherImageUrl(
  product,
  time,
  { width, height } = {},
  bbox = null,
) {
  if (!WEATHER_PRODUCTS.includes(product) || !Number.isFinite(Date.parse(time)))
    throw new Error('Invalid weather frame');
  let box;
  if (bbox !== null) {
    const edges = [bbox.west, bbox.south, bbox.east, bbox.north];
    if (
      !edges.every(Number.isFinite) ||
      edges[0] >= edges[2] ||
      edges[1] >= edges[3]
    )
      throw new Error('Invalid weather window');
    box = edges;
  } else {
    const bounds = weatherBoundsFor(product);
    box = [bounds.west, bounds.south, bounds.east, bounds.north];
  }
  const largest =
    bbox === null ? WEATHER_IMAGE_SIZES[product] : WEATHER_DETAIL_SIZE;
  let w = largest.width;
  let h = largest.height;
  if (width !== undefined || height !== undefined) {
    if (
      ![1024, 2048, 4096].includes(width) ||
      height !== width / 2 ||
      width > largest.width
    )
      throw new Error('Invalid weather image size');
    w = width;
    h = height;
  }
  return wmsGetMapUrl(product, time, box, w, h);
}

function describeManifest(product, value) {
  const spec = WEATHER_PRODUCT_SPECS[product];
  const time = value?.times.at(-1) ?? null;
  return {
    schemaVersion: 1,
    product,
    title: spec.title,
    coverage: spec.coverage,
    description: spec.description,
    source: 'NOAA nowCOAST',
    attribution: spec.attribution,
    bounds: value?.bounds ?? null,
    times: value?.times ?? [],
    latest: time,
    time,
    observedAt: time,
    fetchedAt: value?.fetchedAt ?? null,
    stale: value?.stale ?? true,
    unavailable: !value,
    reason: !value
      ? 'Weather imagery unavailable'
      : value.stale
        ? 'Cached weather metadata; upstream unavailable'
        : null,
    tileSize: 256,
    maxLevel: 6,
    tilingScheme: 'geographic',
    imageSize: { ...spec.image },
  };
}

/** Acquisition is lazy and shares the application's existing source contract. */
export function createWeatherSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
  now = () => Date.now(),
} = {}) {
  const metadata = new Map();
  const attempts = new Map();
  async function getMetadata(product, signal) {
    const spec = WEATHER_PRODUCT_SPECS[product];
    const old = metadata.get(product);
    if (old && now() - old.fetchedAt < (spec.metadataTtlMs ?? 120_000))
      return { ...old, stale: false };
    try {
      if (
        now() - (attempts.get(product) ?? -Infinity) < 30_000 &&
        old === undefined
      )
        throw new Error('Weather upstream unavailable');
      attempts.set(product, now());
      const url = `${NOWCOAST_BASE}${spec.service}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
      const response = await fetchImpl(url, {
        signal,
        redirect: 'error',
        headers: { Accept: 'application/xml,text/xml' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Weather upstream unavailable');
      }
      const xml = await readResponseTextCapped(response, 512 * 1024, signal);
      signal.throwIfAborted();
      const value = { ...parseWeatherCapabilities(xml, product, now()), fetchedAt: now() };
      metadata.set(product, value);
      noteWeatherBounds(product, value.bounds);
      return { ...value, stale: false };
    } catch (error) {
      if (signal.aborted) attempts.delete(product);
      signal.throwIfAborted();
      if (old && now() - old.fetchedAt <= HOUR) return { ...old, stale: true };
      throw error;
    }
  }
  return {
    async getSnapshot({ product = 'radar', signal } = {}) {
      if (!WEATHER_PRODUCTS.includes(product))
        throw new Error('Unknown weather product');
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Weather request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        try {
          const value = await getMetadata(product, controller.signal);
          controller.signal.throwIfAborted();
          return validateWeatherSnapshot(
            describeManifest(product, value),
            product,
          );
        } catch (error) {
          controller.signal.throwIfAborted();
          // The provider answered metadata failures with a designed
          // unavailable manifest, never an exception — same here.
          return validateWeatherSnapshot(
            describeManifest(product, null),
            product,
          );
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
    /** Read one image frame directly from nowCOAST WMS. */
    async getImage({ product, time, size, bbox = null, signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(
        weatherImageUrl(product, time, size, bbox),
        { signal, redirect: 'error' },
      );
      if (!response.ok)
        throw new Error(`Weather image HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      const type = response.headers.get('content-type') || '';
      return { contentType: type.split(';')[0].trim().toLowerCase(), bytes };
    },
  };
}
