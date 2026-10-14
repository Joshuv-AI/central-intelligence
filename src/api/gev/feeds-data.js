// Central Intelligence — GEV adapter static registries (CJS ports).
// Transit registry mirrors GEV src/data/transitFeeds.js (pinned SHA
// 8b8ccc9a) — registered feeds ONLY; the adapter never fetches a
// client-supplied transit URL. GBFS allowlist mirrors GEV src/data/
// gbfsSource.js. CCTV catalogs are the vendored GEV config files copied
// verbatim into ./data/ at adapter build time (see cameras route).
'use strict';
const fs = require('fs');
const path = require('path');

const TRANSIT_FEEDS = [
  { id: 'mbta', name: 'MBTA', operator: 'Massachusetts Bay Transportation Authority', region: 'Boston, MA', center: { lat: 42.3601, lon: -71.0589 }, loadRadiusKm: 70, url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb', attribution: 'MBTA / MassDOT', defaultMode: 'bus' },
  { id: 'capmetro-austin', name: 'CapMetro', operator: 'Capital Metropolitan Transportation Authority', region: 'Austin, TX', center: { lat: 30.2672, lon: -97.7431 }, loadRadiusKm: 60, url: 'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream', attribution: 'Capital Metropolitan Transportation Authority — data.texas.gov', defaultMode: 'bus' },
  { id: 'metrotransit-msp', name: 'Metro Transit', operator: 'Metro Transit (Metropolitan Council)', region: 'Minneapolis–St Paul, MN', center: { lat: 44.9778, lon: -93.265 }, loadRadiusKm: 70, url: 'https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb', attribution: 'Metro Transit — Metropolitan Council', defaultMode: 'bus' },
  { id: 'hsl-helsinki', name: 'HSL', operator: 'Helsinki Region Transport (HSL)', region: 'Helsinki, Finland', center: { lat: 60.1699, lon: 24.9384 }, loadRadiusKm: 70, url: 'https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl', attribution: 'HSL (Helsinki Region Transport)', defaultMode: 'bus' },
  { id: 'ovapi-nl', name: 'OVapi', operator: 'Stichting OpenGeo (NDOV data)', region: 'Netherlands', center: { lat: 52.2, lon: 5.3 }, loadRadiusKm: 220, url: 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb', attribution: 'OVapi / Stichting OpenGeo — Dutch integrated real-time transit data', defaultMode: 'bus' },
  { id: 'entur-norway', name: 'Entur', operator: 'Entur AS (Norwegian national transit data)', region: 'Norway', center: { lat: 64.0, lon: 11.5 }, loadRadiusKm: 720, url: 'https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions', headers: { 'ET-Client-Name': 'central-intelligence-transit' }, attribution: 'Entur — data under NLOD', defaultMode: 'bus' },
  { id: 'translink-seq', name: 'TransLink', operator: 'TransLink (Queensland Government)', region: 'South East Queensland, Australia', center: { lat: -27.4698, lon: 153.0251 }, loadRadiusKm: 150, url: 'https://gtfsrt.api.translink.com.au/api/realtime/seq/VehiclePositions', attribution: 'TransLink — Queensland Government (CC BY 4.0)', defaultMode: 'bus' },
];
const TRANSIT_BY_ID = new Map(TRANSIT_FEEDS.map((f) => [f.id, f]));

// --- GBFS allowlist (GEV gbfsSource.js) ---
const GBFS_ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com', 'gbfs.bluebikes.com', 'gbfs.bcycle.com',
  'gbfs.biketownpdx.com', 'gbfs.cogobikeshare.com',
  'austin.publicbikesystem.net', 'hon.publicbikesystem.net', 'chat.publicbikesystem.net',
]);
function isAllowedGbfsHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (GBFS_ALLOWED_HOSTS.has(host)) return true;
  return host.endsWith('.publicbikesystem.net');
}
function isAllowedGbfsPath(pathname) {
  return /\/station_(information|status)\.json$/i.test(String(pathname || ''));
}

// --- CCTV bundled municipal catalogs ---
// Source data: GEV config/cctv_sources.{austin,shinjuku,tallinn,warendorf}.json
// at pinned SHA 8b8ccc9a, copied verbatim to ./data/ by Lane A.
// Record shape per ARCH §4.2 #15. `kind`: still | player | hls-direct |
// synthetic-capable. A record with a playable stream URL is also
// synthetic-capable in GEV terms when its source pack supports the labelled
// synthetic fallback; we mark stills/player kinds directly and let the client
// layer apply synthetic degradation on unreachable media (no media relayed).
function cctvKind(rec) {
  const ft = String(rec.feedType || '').toLowerCase();
  const url = String(rec.url || rec.snapshotUrl || '');
  if (/\.m3u8($|\?)/i.test(url) || ft === 'hls') return 'hls-direct';
  if (ft === 'image' || /\.(jpe?g|png)($|\?)/i.test(url)) return 'still';
  if (ft === 'mp4' || ft === 'player' || /player/i.test(url)) return 'player';
  return 'still';
}

let cctvCatalogCache = null;
function loadBundledCctvCatalog() {
  if (cctvCatalogCache) return cctvCatalogCache;
  const files = [
    ['austin', 'cctv_sources.austin.json'],
    ['shinjuku', 'cctv_sources.shinjuku.json'],
    ['tallinn', 'cctv_sources.tallinn.json'],
    ['warendorf', 'cctv_sources.warendorf.json'],
  ];
  const out = [];
  for (const [pack, file] of files) {
    try {
      const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'));
      if (!Array.isArray(rows)) continue;
      for (const rec of rows) {
        const lat = Number(rec.lat); const lon = Number(rec.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        out.push({
          id: String(rec.id),
          name: rec.name || rec.id,
          lat, lon,
          source: rec.provider || pack,
          kind: cctvKind(rec),
          media: {
            url: rec.url || null,
            snapshotUrl: rec.snapshotUrl || null,
            feedType: rec.feedType || null,
          },
          pose: {
            hdg: Number.isFinite(Number(rec.headingDeg)) ? Number(rec.headingDeg) : null,
            fov: Number.isFinite(Number(rec.fovDeg)) ? Number(rec.fovDeg) : null,
            range: Number.isFinite(Number(rec.rangeM)) ? Number(rec.rangeM) : null,
          },
          calibration: {
            pitchDeg: Number.isFinite(Number(rec.pitchDeg)) ? Number(rec.pitchDeg) : null,
            mountHeightM: Number.isFinite(Number(rec.mountHeightM)) ? Number(rec.mountHeightM) : null,
            groundElevationM: Number.isFinite(Number(rec.groundElevationM)) ? Number(rec.groundElevationM) : null,
            headingConfidence: rec.headingConfidence || null,
          },
          city: rec.city || null,
          license: rec.license || null,
        });
      }
    } catch (err) {
      console.error('[gev/cameras] bundled catalog read failed:', file, err && err.message);
    }
  }
  cctvCatalogCache = out;
  return out;
}

module.exports = { TRANSIT_FEEDS, TRANSIT_BY_ID, isAllowedGbfsHost, isAllowedGbfsPath, loadBundledCctvCatalog };
