// Central Intelligence — cameras helpers test (no network).
// Covers Windy bbox order conversion and the camera shaping/filtering rules.
const assert = require('assert');

const { toWindyBbox, shapeCamera } = require('../src/api/cameras');

// toWindyBbox: (minLon,minLat,maxLon,maxLat) -> north,east,south,west.
const wb = toWindyBbox(-81, 28, -80, 29);
assert.deepStrictEqual(
  wb,
  { north: 29, east: -80, south: 28, west: -81 },
  'bbox converts to Windy north,east,south,west order'
);
const wb2 = toWindyBbox(-180, -90, 180, 90);
assert.deepStrictEqual(
  wb2,
  { north: 90, east: 180, south: -90, west: -180 },
  'full-globe bbox conversion'
);

// shapeCamera: full entry -> shaped camera.
const cam = shapeCamera({
  webcamId: '12345',
  title: 'Miami Beach Cam',
  status: 'active',
  location: {
    latitude: 25.76,
    longitude: -80.19,
    city: 'Miami Beach',
    region: 'Florida',
    country: 'United States',
    country_code: 'US',
  },
  images: {
    current: { preview: 'https://img.windycams/preview/12345.jpg', url: 'https://img.windycams/current/12345.jpg' },
    daylight: { preview: null },
    sizes: {},
  },
  player: { live: 'https://webcams.windy.com/webcams/public/player?webcamId=12345&playerType=live', day: null },
  urls: { detail: 'https://www.windy.com/webcams/12345' },
});
assert.strictEqual(cam.id, '12345', 'id from webcamId');
assert.strictEqual(cam.title, 'Miami Beach Cam', 'title preserved');
assert.strictEqual(cam.lat, 25.76, 'lat from location.latitude');
assert.strictEqual(cam.lon, -80.19, 'lon from location.longitude');
assert.strictEqual(cam.city, 'Miami Beach', 'city passed through');
assert.strictEqual(cam.country, 'United States', 'country passed through');
assert.strictEqual(cam.status, 'active', 'status passed through');
assert.strictEqual(cam.thumbnailUrl, 'https://img.windycams/preview/12345.jpg', 'preview preferred for thumbnail');
assert.ok(cam.playerEmbedUrl.includes('playerType=live'), 'live player embed preferred');
assert.strictEqual(cam.windyUrl, 'https://www.windy.com/webcams/12345', 'windy detail url');

// shapeCamera: thumbnail falls back to current.url when no preview.
const fallback = shapeCamera({
  webcamId: '9',
  title: 'No Preview Cam',
  status: 'active',
  location: { latitude: 40, longitude: -74 },
  images: { current: { url: 'https://img.windycams/current/9.jpg' } },
  player: {},
  urls: {},
});
assert.strictEqual(fallback.thumbnailUrl, 'https://img.windycams/current/9.jpg', 'thumbnail falls back to current.url');
assert.strictEqual(fallback.playerEmbedUrl, null, 'no player urls -> null');
assert.strictEqual(fallback.windyUrl, null, 'no detail url -> null');

// shapeCamera: entries missing lat/lon are skipped (null).
assert.strictEqual(
  shapeCamera({ webcamId: '7', title: 'Bad Cam', location: { latitude: null, longitude: -80 } }),
  null,
  'missing latitude -> null'
);
assert.strictEqual(
  shapeCamera({ webcamId: '8', title: 'No Loc Cam' }),
  null,
  'missing location -> null'
);

console.log('cameras.test.js: all assertions passed');
