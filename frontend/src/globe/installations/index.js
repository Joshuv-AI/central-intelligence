/* Military installations layer — `landuse=military` from keyless OpenMapTiles
   vector tiles (openFreeMap), min zoom 9, 16-tile request cap, 24-label cap.

   How it works: on camera moveEnd (300ms debounce) the layer fetches the z9
   vector tiles covering the view (max 16 — wider views keep their last data),
   decodes the `landuse` layer with the bundled minimal MVT decoder below
   (no npm deps; GEV used @mapbox/vector-tile + pbf — same wire format),
   keeps features with `class === 'military'`, clips each polygon ring to its
   tile core, and renders a dot + outline per fragment. Dots and outlines
   live in one CustomDataSource, removed on disable so an off layer costs
   nothing.

   2026-09-30 (Joshua: toggle showed nothing): the fetch was gated on camera
   height < 2M m, so at the default global view nothing ever loaded. Now, when
   zoomed out past the gate, the layer fetches the 4x4 z9 tiles around the
   view center instead of nothing.
   2026-09-30 (zoom-gate + dead-band fix): refresh() had a dead band — below
   the 2M gate but with the view spanning more than 16 z9 tiles, tilesForView
   refused and the layer kept (empty) last data, so mid-zoom views showed
   nothing too. Now over-wide/dateline views fall back to the 4x4 center
   patch, and a zoom gate skips refreshes on rotation-only moves (refetch
   only when height changes ≥15% or the center moves ≥1.4°).
   Outlines render as regular polylines at 500 m, not ground-clamped (same
   iOS GroundPolylinePrimitive crash as the cable layer).

   ODbL attribution: "© OpenMapTiles © OpenStreetMap contributors" is added
   to the scene credit display while the layer is on.

   NAMED-POINT FALLBACK: GEV falls back to a bundled 3.8MB OSM names pack at
   coarse zooms; per the final GEV audit (item 7), name data sourcing is
   Joshua's call, so CI ships the tile pipeline only. forEachInstallation()
   and the 24-label budget already iterate the live record set — a future
   names bundle slots in as a second record source with no rework.

   Exports (consumed by name, do not rename):
     initInstallations(viewer), setInstallations(on),
     installationsEnabled(), forEachInstallation(cb)  // cb({lat, lon, name})
*/
import * as Cesium from 'cesium';

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const FALLBACK_TEMPLATE =
  'https://tiles.openfreemap.org/planet/20260927_080001_pt/{z}/{x}/{y}.pbf';
const TILE_Z = 9;                 // min zoom per audit
const MAX_TILES = 16;             // tile request cap
const MAX_RENDERED = 600;         // feature cap, biggest-first
const LABEL_CAP = 24;             // label budget for NAMED records only
const FETCH_HEIGHT_M = 2_000_000; // ~zoom 9 gate (metres, camera height)
const DEBOUNCE_MS = 300;
const DOT_COLOR = '#ff7a1a';      // vivid orange — visible on ocean and terrain
const MARKER_PX = 18;             // diamond billboard size (Joshua 2026-09-30: grey dots were hard to see)

let viewer = null;
let enabled = false;
let dataSource = null;
let records = [];          // [{ id, lat, lon, name, ring }]
let tileTemplate = null;   // resolved from TileJSON once
let moveEndRemove = null;
let debounceTimer = 0;
let generation = 0;        // stale-fetch guard
// Tile cache (Joshua 2026-09-30 — the layer felt "slow and patchy" because
// every refresh re-fetched every tile from the network and blanked the screen
// while waiting). Decoded tiles are cached per session, so revisiting ground
// is instant; refreshes render cached coverage immediately and fetch only the
// missing tiles in the background. The tile set itself is the gate: pure
// rotation over already-cached ground is a no-op, and any move onto new
// territory fetches just the new tiles — no height/center heuristics.
const tileCache = new Map(); // "z/x/y" -> decoded records[]
const MAX_CACHED_TILES = 96; // session cap; oldest tiles evicted first
let renderedTileKey = '';    // sorted tile keys of the currently rendered set

const credit = new Cesium.Credit(
  '© OpenMapTiles © OpenStreetMap contributors',
  true,
);

/* ———————— minimal MVT (Mapbox Vector Tile) decoder ————————
   Enough of the protobuf wire format to read the `landuse` layer:
   fields (fieldNumber<<3|wireType), wire 0 = varint, wire 2 = length-delim. */
function readVarint(bytes, pos) {
  let result = 0, shift = 0, b;
  do {
    b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [result >>> 0, pos];
}

function parseFields(bytes, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const [tag, p1] = readVarint(bytes, pos);
    pos = p1;
    const field = tag >>> 3, wire = tag & 7;
    if (wire === 0) {
      const [v, p2] = readVarint(bytes, pos);
      pos = p2;
      out.push({ field, v });
    } else if (wire === 1) { pos += 8; }
    else if (wire === 2) {
      const [len, p2] = readVarint(bytes, pos);
      pos = p2;
      out.push({ field, data: bytes.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 5) { pos += 4; }
    else throw new Error(`[installations] bad MVT wire type ${wire}`);
  }
  return out;
}

const textDecoder = new TextDecoder();
function str(data) { return textDecoder.decode(data); }

function zigzag(n) { return (n >>> 1) ^ -(n & 1); }

/** Decode packed MVT geometry commands into tile-coordinate rings. */
function decodeRings(packed) {
  const rings = [];
  let x = 0, y = 0, i = 0, ring = null;
  while (i < packed.length) {
    const cmd = packed[i++];
    const id = cmd & 7, count = cmd >>> 3;
    if (id === 1 || id === 2) {
      for (let c = 0; c < count; c++) {
        x += zigzag(packed[i++]);
        y += zigzag(packed[i++]);
        if (id === 1) { if (ring && ring.length) rings.push(ring); ring = []; }
        ring.push([x, y]);
      }
    } else if (id === 7) {
      if (ring && ring.length) rings.push(ring);
      ring = null;
    } else throw new Error(`[installations] bad MVT geom cmd ${id}`);
  }
  if (ring && ring.length) rings.push(ring);
  return rings;
}

/** Clip a polygon ring to the tile core (port of GEV militaryTileGeometry.clipTileRing). */
function clipTileRing(ring, box) {
  let points = ring.slice(0, -1);
  for (const [axis, edge, sign] of [
    [0, box.west, 1], [0, box.east, -1],
    [1, box.south, 1], [1, box.north, -1],
  ]) {
    const output = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length];
      const b = points[i];
      const ai = (a[axis] - edge) * sign >= 0;
      const bi = (b[axis] - edge) * sign >= 0;
      if (ai !== bi) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        p[axis] = edge;
        output.push(p);
      }
      if (bi) output.push(b);
    }
    points = output;
  }
  return points.length >= 3 ? [...points, points[0]] : [];
}

/** Area-weighted centroid (port of GEV openFreeMap.polygonCentroid). */
function polygonCentroid(ring) {
  if (!ring?.length) return null;
  const [ox, oy] = ring[0];
  let area = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0] - ox, ay = ring[j][1] - oy;
    const bx = ring[i][0] - ox, by = ring[i][1] - oy;
    const cross = ax * by - bx * ay;
    area += cross;
    x += (ax + bx) * cross;
    y += (ay + by) * cross;
  }
  return Math.abs(area) > 1e-15
    ? [ox + x / (3 * area), oy + y / (3 * area)]
    : ring[0];
}

function ringArea2(ring) {
  let s = 0;
  for (let i = 1; i < ring.length; i++)
    s += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return Math.abs(s / 2);
}

function tileToLonLat(x, y, tx, ty, z, extent) {
  const n = 2 ** z;
  const lon = ((tx + x / extent) / n) * 360 - 180;
  const latRad = Math.atan(
    Math.sinh(Math.PI * (1 - (2 * (ty + y / extent)) / n)),
  );
  return [lon, (latRad * 180) / Math.PI];
}

/** Decode one tile's bytes → military records. Returns [{id,lat,lon,name,ring}]. */
function decodeMilitaryTile(bytes, z, tx, ty) {
  const out = [];
  const n = 2 ** z;
  const box = {
    west: (tx / n) * 360 - 180,
    east: ((tx + 1) / n) * 360 - 180,
    north: (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))),
    south: (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + 1)) / n))),
  };
  for (const layerField of parseFields(bytes, 0, bytes.length)) {
    if (layerField.field !== 3 || !layerField.data) continue;
    const lf = parseFields(layerField.data, 0, layerField.data.length);
    const nameField = lf.find((f) => f.field === 1 && f.data);
    if (!nameField || str(nameField.data) !== 'landuse') continue;
    const extentField = lf.find((f) => f.field === 5 && f.v !== undefined);
    const extent = extentField ? extentField.v : 4096;
    const keys = lf.filter((f) => f.field === 3 && f.data).map((f) => str(f.data));
    const values = lf
      .filter((f) => f.field === 4 && f.data)
      .map((f) => {
        const vf = parseFields(f.data, 0, f.data.length);
        const s = vf.find((v) => v.field === 1 && v.data);
        return s ? str(s.data) : null;
      });
    for (const featField of lf.filter((f) => f.field === 2 && f.data)) {
      const ff = parseFields(featField.data, 0, featField.data.length);
      const typeField = ff.find((f) => f.field === 3 && f.v !== undefined);
      if (!typeField || typeField.v !== 3) continue; // polygons only (MVT GeomType POLYGON=3)
      const tagsField = ff.find((f) => f.field === 2 && f.data);
      const props = {};
      if (tagsField) {
        const tags = [];
        let tp = 0;
        const td = tagsField.data;
        while (tp < td.length) {
          const [v, np] = readVarint(td, tp);
          tp = np;
          tags.push(v);
        }
        for (let i = 0; i + 1 < tags.length; i += 2) {
          const k = keys[tags[i]];
          if (k !== undefined) props[k] = values[tags[i + 1]] ?? null;
        }
      }
      if (props.class !== 'military') continue;
      const geomField = ff.find((f) => f.field === 4 && f.data);
      if (!geomField) continue;
      const packed = [];
      let gp = 0;
      const gd = geomField.data;
      while (gp < gd.length) {
        const [v, np] = readVarint(gd, gp);
        gp = np;
        packed.push(v);
      }
      const idField = ff.find((f) => f.field === 1 && f.v !== undefined);
      const fid = idField ? idField.v : out.length;
      for (const ring of decodeRings(packed)) {
        const clipped = clipTileRing(
          ring.map(([x, y]) => tileToLonLat(x, y, tx, ty, z, extent)),
          box,
        );
        if (clipped.length < 4) continue;
        const centroid = polygonCentroid(clipped);
        if (!centroid) continue;
        out.push({
          id: `ofm:${z}/${tx}/${ty}:${fid}:${out.length}`,
          lat: centroid[1],
          lon: centroid[0],
          name: 'Military area', // unnamed in the landuse layer; names are Joshua's call
          ring: clipped,
          area: ringArea2(clipped),
        });
      }
    }
  }
  return out;
}

/* ———————— tile pipeline ———————— */

async function resolveTemplate() {
  if (tileTemplate) return tileTemplate;
  try {
    const res = await fetch(TILEJSON_URL, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tj = await res.json();
    const t = tj?.tiles?.[0];
    if (typeof t === 'string' && t.includes('{z}') && t.includes('{x}') && t.includes('{y}')) {
      tileTemplate = t;
      return tileTemplate;
    }
    throw new Error('bad tilejson');
  } catch (err) {
    console.warn('[installations] TileJSON failed, using pinned template:', err?.message || err);
    tileTemplate = FALLBACK_TEMPLATE;
    return tileTemplate;
  }
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return {
    x: Math.min(n - 1, Math.max(0, x)),
    y: Math.min(n - 1, Math.max(0, y)),
  };
}

function tilesForView(rect, z) {
  const west = Cesium.Math.toDegrees(rect.west);
  const east = Cesium.Math.toDegrees(rect.east);
  const south = Cesium.Math.toDegrees(rect.south);
  const north = Cesium.Math.toDegrees(rect.north);
  if (west > east) return null; // dateline-crossing view: caller falls back
  const nw = lonLatToTile(west, north, z);
  const se = lonLatToTile(east, south, z);
  // Estimate before allocating: over-wide views fall back to the center
  // patch instead of building (and discarding) a huge tile array.
  if ((se.x - nw.x + 1) * (se.y - nw.y + 1) > MAX_TILES) return [];
  const tiles = [];
  for (let y = nw.y; y <= se.y; y++)
    for (let x = nw.x; x <= se.x; x++) tiles.push({ z, x, y });
  return tiles;
}

/** 4x4 z9 tiles around the view center — the honest fallback when the view
    is wider than the tile cap or crosses the dateline. */
function centerPatchTiles() {
  const center = viewer.camera.positionCartographic;
  const c = lonLatToTile(
    Cesium.Math.toDegrees(center.longitude),
    Cesium.Math.toDegrees(center.latitude),
    TILE_Z,
  );
  const n = 2 ** TILE_Z;
  const tiles = [];
  for (let dy = -2; dy <= 1; dy++)
    for (let dx = -2; dx <= 1; dx++) {
      const x = c.x + dx, y = c.y + dy;
      if (x >= 0 && x < n && y >= 0 && y < n) tiles.push({ z: TILE_Z, x, y });
    }
  return tiles;
}

function tileKey(t) {
  return `${t.z}/${t.x}/${t.y}`;
}

function cacheTile(t, recs) {
  const k = tileKey(t);
  if (!tileCache.has(k) && tileCache.size >= MAX_CACHED_TILES) {
    // Evict the oldest tile (Maps iterate in insertion order).
    tileCache.delete(tileCache.keys().next().value);
  }
  tileCache.set(k, recs);
}

/** Render the union of cached records for these tiles, biggest first. Called
    immediately on every refresh so the user never stares at a blank layer
    while missing tiles download. */
function renderFromCache(tiles) {
  const all = [];
  for (const t of tiles) {
    const recs = tileCache.get(tileKey(t));
    if (recs) all.push(...recs);
  }
  all.sort((a, b) => b.area - a.area);
  renderRecords(all.slice(0, MAX_RENDERED));
}

async function fetchTile(template, tile) {
  const url = template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Diamond marker sprite (canvas) — more distinctive than a round dot and
    high-contrast on both ocean and terrain. Cached per color. */
let diamondSprite = null;
function getDiamondSprite() {
  if (diamondSprite) return diamondSprite;
  const S = MARKER_PX + 8;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const cx = S / 2;
  const r = MARKER_PX / 2;
  // Soft glow halo.
  const glow = g.createRadialGradient(cx, cx, 0, cx, cx, r + 4);
  const col = Cesium.Color.fromCssColorString(DOT_COLOR);
  glow.addColorStop(0, col.withAlpha(0.35).toCssColorString());
  glow.addColorStop(1, col.withAlpha(0).toCssColorString());
  g.fillStyle = glow;
  g.fillRect(0, 0, S, S);
  // Diamond with dark border.
  g.beginPath();
  g.moveTo(cx, cx - r);
  g.lineTo(cx + r, cx);
  g.lineTo(cx, cx + r);
  g.lineTo(cx - r, cx);
  g.closePath();
  g.fillStyle = DOT_COLOR;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(10,10,12,0.9)';
  g.stroke();
  // Small bright core so it reads at a glance.
  g.beginPath();
  g.moveTo(cx, cx - r * 0.38);
  g.lineTo(cx + r * 0.38, cx);
  g.lineTo(cx, cx + r * 0.38);
  g.lineTo(cx - r * 0.38, cx);
  g.closePath();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fill();
  diamondSprite = c;
  return diamondSprite;
}

function renderRecords(next) {
  records = next;
  if (!dataSource) {
    dataSource = new Cesium.CustomDataSource('military-installations');
    viewer.dataSources.add(dataSource);
  } else {
    dataSource.entities.removeAll();
  }
  const entities = dataSource.entities;
  entities.suspendEvents();
  const dotColor = Cesium.Color.fromCssColorString(DOT_COLOR);
  const markerImg = getDiamondSprite();
  let labeled = 0;
  for (const rec of records) {
    entities.add({
      id: `mil-${rec.id}`,
      position: Cesium.Cartesian3.fromDegrees(rec.lon, rec.lat),
      billboard: {
        image: markerImg,
        width: MARKER_PX + 8,
        height: MARKER_PX + 8,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 150000,
      },
      // Label budget (24): applies to NAMED records only. The landuse layer
      // carries no names, so this stays dormant until the named-point
      // fallback lands (name sourcing is Joshua's call — see header).
      label: rec.name !== 'Military area' && labeled < LABEL_CAP ? {
        text: rec.name,
        font: '11px system-ui, sans-serif',
        fillColor: Cesium.Color.WHITE.withAlpha(0.92),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -8),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: 150000,
      } : undefined,
    });
    if (rec.name !== 'Military area') labeled++;
    entities.add({
      id: `mil-${rec.id}:outline`,
      polyline: {
        // Regular polyline at 500 m — NOT clampToGround (GroundPolylinePrimitive
        // crashes iOS under 4x MSAA + real terrain; see cable layer fix).
        positions: rec.ring.map(([lon, lat]) =>
          Cesium.Cartesian3.fromDegrees(lon, lat, 500)),
        width: 2.5,
        material: dotColor.withAlpha(0.9),
      },
    });
  }
  entities.resumeEvents();
}

async function refresh() {
  if (!enabled || !viewer) return;
  const gen = generation;
  const height = viewer.scene.camera.positionCartographic.height;
  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return;
  let tiles;
  if (height >= FETCH_HEIGHT_M) {
    // Zoomed out past min zoom 9: the 4x4 z9 patch around the view center.
    tiles = centerPatchTiles();
  } else {
    tiles = tilesForView(rect, TILE_Z);
    if (!tiles || tiles.length > MAX_TILES || tiles.length === 0) {
      // Over-wide or dateline-crossing view: fall back to the center patch
      // instead of keeping (usually empty) last data — this was the dead
      // band where mid-zoom views showed nothing.
      tiles = centerPatchTiles();
    }
  }
  const keyStr = tiles.map(tileKey).sort().join(',');
  if (keyStr === renderedTileKey) return; // already showing this exact set
  if (window.__ciQa) window.__ciQa.lastTiles = tiles.map(tileKey); // QA visibility
  // Show cached coverage NOW — never blank the layer while fetching.
  renderFromCache(tiles);
  renderedTileKey = keyStr;
  const missing = tiles.filter((t) => !tileCache.has(tileKey(t)));
  if (window.__ciQa)
    window.__ciQa.lastFetch = {
      key: keyStr,
      tiles: tiles.length,
      missing: missing.length,
      cacheSize: tileCache.size,
    };
  if (missing.length === 0) return;
  let template;
  try {
    template = await resolveTemplate();
  } catch {
    return;
  }
  if (gen !== generation || !enabled) return;
  // Bounded concurrency (4 in flight), network only for uncached tiles.
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(4, missing.length) },
    async () => {
      while (idx < missing.length) {
        const tile = missing[idx++];
        try {
          const bytes = await fetchTile(template, tile);
          if (gen !== generation || !enabled) return;
          cacheTile(tile, decodeMilitaryTile(bytes, tile.z, tile.x, tile.y));
        } catch (err) {
          console.warn('[installations] tile failed:', tile, err?.message || err);
        }
      }
    },
  );
  await Promise.all(workers);
  if (gen !== generation || !enabled) return;
  // Re-render only if the camera still wants this tile set (the user may
  // have moved on mid-fetch — their refresh will handle the new set).
  if (tiles.map(tileKey).sort().join(',') === renderedTileKey) {
    renderFromCache(tiles);
  }
}

function scheduleRefresh() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { refresh().catch(() => {}); }, DEBOUNCE_MS);
}

function showCredit() {
  try {
    viewer.scene.frameState.creditDisplay.addDefaultCredit(credit);
  } catch { /* credit display not ready */ }
}
function hideCredit() {
  try {
    viewer.scene.frameState.creditDisplay.removeDefaultCredit(credit);
  } catch { /* noop */ }
}

/* ———————— public API ———————— */

export function installationsEnabled() { return enabled; }

/** Iterate the currently rendered installations. cb receives {lat, lon, name}. */
export function forEachInstallation(cb) {
  for (const rec of records) cb({ lat: rec.lat, lon: rec.lon, name: rec.name });
}

/** Find a rendered installation by its pick id (the part after `mil-`). */
export function getInstallation(instId) {
  const rec = records.find((r) => String(r.id) === String(instId));
  if (!rec) return null;
  // area is in square degrees — convert to km² at the record's latitude.
  const km2 = rec.area * 111.32 * 111.32 * Math.cos((rec.lat * Math.PI) / 180);
  return {
    id: rec.id,
    name: rec.name,
    lon: rec.lon,
    lat: rec.lat,
    areaKm2: km2,
  };
}

export function setInstallations(on) {
  enabled = on;
  if (!viewer) return enabled;
  if (enabled) {
    if (!moveEndRemove) {
      moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleRefresh);
    }
    showCredit();
    renderedTileKey = ''; // force a fresh render (dataSource was destroyed)
    refresh().catch(() => {});
  } else {
    generation++; // abandon in-flight fetches
    clearTimeout(debounceTimer);
    if (moveEndRemove) {
      moveEndRemove();
      moveEndRemove = null;
    }
    if (dataSource) {
      viewer.dataSources.remove(dataSource, true);
      dataSource = null;
    }
    records = [];
    hideCredit();
  }
  return enabled;
}

export function initInstallations(v) {
  viewer = v;
}
