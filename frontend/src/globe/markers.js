/* Marker management: event entities + clustering + connection rings + pulses.
   ~300 markers via entity collections (clustered CustomDataSource);
   connections live in a separate unclustered source. No per-marker DOM. */
import * as Cesium from 'cesium';
import { getViewer } from './viewer.js';
import { Sprites } from './sprites.js';
import { store, SEV_COLORS } from '../data/store.js';
import { holdContinuousRender, releaseContinuousRender } from './renderGovernor.js';

const SEV_RANK = { low: 0, moderate: 1, high: 2, critical: 3 };
const FADE_MS = 260;
const PULSE_S = 2.4; // connection ring pulse period (DESIGN.md)

// Hoisted cluster-label constants: clusterEvent fires every frame the camera
// moves, so nothing here may allocate or parse per call.
const CLUSTER_LABEL_FONT = '600 13px "JetBrains Mono", monospace';
const CLUSTER_LABEL_FILL = Cesium.Color.fromCssColorString('#EDF7FE');
const CLUSTER_LABEL_OUTLINE = Cesium.Color.fromCssColorString('#050B16');
const CLUSTER_LABEL_OFFSET = new Cesium.Cartesian2(0, 1);

/** Unwrap an Entity PropertyBag value that may be a ConstantProperty. */
function propValue(props, name) {
  if (!props) return undefined;
  const v = props[name];
  if (v && typeof v.getValue === 'function') {
    try { return v.getValue(); } catch { return undefined; }
  }
  return v;
}

let eventSource = null;   // clustered CustomDataSource
let connSource = null;    // unclustered CustomDataSource
const entities = new Map();   // eventId -> entity
const connEntities = new Map(); // connectionId -> { marker, pulse }
const tweens = [];
// Pulse + tween drivers live on Cesium's preRender (installed/removed
// dynamically) so marker animation ticks exactly once per rendered frame, in
// lockstep with the globe — no separate rAF cadence fighting the renderer.
// Each driver holds continuous render while active (render-governor).
let tweenOff = null;
let pulseOff = null;
// Persistent pulse rings: plain values written per frame, no CallbackProperty.
// (billboard.scale as a CallbackProperty crashes Cesium's visualizer.)
const pulses = new Map(); // id -> { entity, base: Color, scratchColor }

/* ——— tiny tween loop (preRender-driven) ——— */
function addTween(tw) {
  tweens.push({ ...tw, start: performance.now() });
  ensureTweenLoop();
}
function ensureTweenLoop() {
  if (tweenOff || tweens.length === 0) return;
  const viewer = getViewer();
  if (!viewer) return;
  holdContinuousRender('marker-tweens');
  tweenOff = viewer.scene.preRender.addEventListener(() => {
    // The render loop is sacred — never let a tween throw kill it.
    try { tickTweensAt(performance.now()); } catch (err) {
      console.error('[markers] tween tick error (render loop protected):', err);
    }
  });
}
// Single driver: removes itself + releases the hold when tweens run out.
function tickTweensAt(now) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    const p = Math.min(1, (now - tw.start) / tw.ms);
    try { tw.update(tw.ease ? tw.ease(p) : p); } catch { /* noop */ }
    if (p >= 1) {
      tweens.splice(i, 1);
      try { tw.done && tw.done(); } catch { /* noop */ }
    }
  }
  if (tweens.length === 0 && tweenOff) {
    tweenOff(); tweenOff = null;
    releaseContinuousRender('marker-tweens');
  }
}

const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

function setAlpha(entity, a) {
  if (!entity || !entity.billboard) return;
  entity.billboard.color = new Cesium.Color(1, 1, 1, a);
  entity._alpha = a;
}

export function initMarkers() {
  const viewer = getViewer();

  eventSource = new Cesium.CustomDataSource('events');
  eventSource.clustering.enabled = true;
  // Calmer clustering: clusters only form for genuinely dense groups, and the
  // grouping radius is generous, so a slight camera move doesn't snap pins in
  // and out of cluster badges or reshuffle the counts. Verified against
  // Cesium 1.145's EntityCluster: on pan/zoom-out the greedy pass does not
  // reuse previous clusters as seeds, so a wide pixelRange is what keeps the
  // badges dependable while moving (2026-09-30).
  eventSource.clustering.pixelRange = 64;
  eventSource.clustering.minimumClusterSize = 5;
  // Zoom-gated re-clustering (2026-09-30): Cesium's EntityCluster re-runs its
  // greedy grouping pass on every camera.changed, which reshuffles badges on
  // slight pans/spins and reads as buggy. Auto regrouping is therefore
  // disabled (viewer.js sets camera.percentageChanged very high), and
  // clusters refresh ONLY here — when the camera settles after a genuine
  // zoom (≥1.6× height change). Spins and pans never regroup: badges stay
  // world-anchored, glide with the globe, and counts hold still. A deep zoom
  // in (or back out) re-runs the grouping so badges split/merge into the
  // correct places and numbers for that zoom level.
  let lastClusterHeight = 0;
  const ZOOM_RECLUSTER_RATIO = 1.6;
  viewer.camera.moveEnd.addEventListener(() => {
    try {
      if (!eventSource || !eventSource.clustering.enabled) return;
      const h = viewer.camera.positionCartographic.height;
      if (!Number.isFinite(h) || h <= 0) return;
      if (!lastClusterHeight) { lastClusterHeight = h; return; }
      const ratio = Math.max(h, lastClusterHeight) / Math.min(h, lastClusterHeight);
      if (ratio >= ZOOM_RECLUSTER_RATIO) {
        lastClusterHeight = h;
        // Nudge pixelRange off and back through the public setter: marks the
        // clusterer dirty so it rebuilds on the next update, without
        // destroying the cluster collections (no flash).
        const c = eventSource.clustering;
        const pr = c.pixelRange;
        c.pixelRange = pr + 1;
        c.pixelRange = pr;
      }
    } catch { /* camera not ready — try on the next settle */ }
  });
  eventSource.clustering.clusterEvent.addEventListener((clustered, cluster) => {
    let maxSev = 'low';
    let maxRank = -1;
    const memberIds = [];
    for (const e of clustered) {
      const sev = propValue(e.properties, 'severity') || 'low';
      if (SEV_RANK[sev] !== undefined && SEV_RANK[sev] > maxRank) { maxRank = SEV_RANK[sev]; maxSev = sev; }
      if (e.id) memberIds.push(e.id);
    }
    cluster.billboard.show = true;
    // Cesium 1.145 leaves cluster billboard.id unset — tag it ourselves so
    // scene.pick can identify cluster hits (label.id is already the id array).
    cluster.billboard.id = { __clusterIds: memberIds };
    cluster.billboard.image = Sprites.cluster(maxSev);
    cluster.billboard.width = 44;
    cluster.billboard.height = 44;
    cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
    cluster.label.show = true;
    cluster.label.text = String(clustered.length);
    cluster.label.font = CLUSTER_LABEL_FONT;
    cluster.label.fillColor = CLUSTER_LABEL_FILL;
    cluster.label.style = Cesium.LabelStyle.FILL_AND_OUTLINE;
    cluster.label.outlineColor = CLUSTER_LABEL_OUTLINE;
    cluster.label.outlineWidth = 3;
    cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
    cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
    cluster.label.pixelOffset = CLUSTER_LABEL_OFFSET;
  });
  viewer.dataSources.add(eventSource);

  connSource = new Cesium.CustomDataSource('connections');
  connSource.clustering.enabled = false;
  viewer.dataSources.add(connSource);
}

/* ——— event entities ——— */
// Markers float slightly above the surface: pins anchored exactly on the
// ellipsoid wink out at the limb while their sprite still overlaps visible
// globe, which reads as flicker on small camera pivots. 1500 m is invisible
// at every practical zoom and keeps the anchor on the visible side longer.
//
// T5 (render-altitude resolver, src/data/renderAltitude.js): this constant
// is deliberately NOT routed through pickRenderAltitudeM. The resolver
// answers the datum question ("is this height MSL or ellipsoidal?") for
// contacts whose height describes their real-world position; event pins are
// a UI affordance — a fixed visual float above the surface, not a position
// reading — so the explicit constant is the honest encoding.
const MARKER_ALT_M = 1500;
function makeEventEntity(e) {
  const severity = SEV_RANK[e.severity] !== undefined ? e.severity : 'low';
  const entity = new Cesium.Entity({
    id: `evt-${e.id}`,
    position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, MARKER_ALT_M),
    billboard: {
      image: Sprites.event(severity),
      width: 34,
      height: 34,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
      disableDepthTestDistance: 0,
      color: new Cesium.Color(1, 1, 1, 1),
    },
    properties: { eventId: e.id, severity, kind: 'event' },
  });
  entity._alpha = 1;
  return entity;
}

export function syncEvents(events) {
  if (!eventSource) return;
  const nextIds = new Set();
  for (const e of events) {
    if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    nextIds.add(e.id);
    const existing = entities.get(e.id);
    if (!existing) {
      const ent = makeEventEntity(e);
      entities.set(e.id, ent);
      eventSource.entities.add(ent);
    } else {
      const sev = propValue(existing.properties, 'severity') || 'low';
      const newSev = SEV_RANK[e.severity] !== undefined ? e.severity : 'low';
      if (sev !== newSev) {
        existing.billboard.image = Sprites.event(newSev);
        existing.properties.severity = newSev;
      }
    }
  }
  for (const [id, ent] of [...entities]) {
    if (!nextIds.has(id)) {
      eventSource.entities.remove(ent);
      entities.delete(id);
    }
  }
  applyFilters();
}

/** Show/hide markers per the store's filter state, with a soft fade. */
export function applyFilters() {
  if (!eventSource) return;
  const visible = new Set(store.visibleEvents().map((e) => e.id));
  for (const [id, ent] of entities) {
    const shouldShow = visible.has(id);
    const isShown = ent.show !== false && (ent._alpha ?? 1) > 0.01;
    if (shouldShow === isShown) continue;
    if (shouldShow) {
      ent.show = true;
      const from = ent._alpha ?? 0;
      addTween({
        ms: FADE_MS, ease: easeInOut,
        update: (p) => setAlpha(ent, from + (1 - from) * p),
      });
    } else {
      const from = ent._alpha ?? 1;
      addTween({
        ms: FADE_MS, ease: easeInOut,
        update: (p) => setAlpha(ent, from * (1 - p)),
        done: () => { if ((ent._alpha ?? 0) < 0.02) ent.show = false; },
      });
    }
  }
}

/* ——— connection markers: double-ring + slow 2.4s pulse ——— */
function connectionPoint(conn) {
  const step = (conn.chain || []).find((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  return step || null;
}

export function syncConnections(connections) {
  if (!connSource) return;
  const nextIds = new Set();
  for (const conn of connections || []) {
    const pt = connectionPoint(conn);
    if (!pt) continue;
    nextIds.add(conn.id);
    if (connEntities.has(conn.id)) continue;
    const severity = SEV_RANK[conn.severity] !== undefined ? conn.severity : 'low';
    const color = Cesium.Color.fromCssColorString(SEV_COLORS[severity]);
    const pos = Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, MARKER_ALT_M);

    const marker = new Cesium.Entity({
      id: `conn-${conn.id}`,
      position: pos,
      billboard: {
        image: Sprites.connection(severity),
        width: 52,
        height: 52,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: 0,
      },
      properties: { connectionId: conn.id, kind: 'connection', severity },
    });

    // Slow 2.4s pulse ring — driven by our own rAF loop (see pulseTick).
    // NOTE: billboard.scale must stay a plain NUMBER. A Cartesian2 scale
    // (constant or CallbackProperty) corrupts the frustum culling pass and
    // crashes the renderer ("Invalid array length"). Empirically verified.
    const pulse = new Cesium.Entity({
      id: `conn-pulse-${conn.id}`,
      position: pos,
      billboard: {
        image: Sprites.pulse(severity),
        width: 64,
        height: 64,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: 0,
        scale: 0.5,
        color: color.withAlpha(0.55),
      },
    });

    connSource.entities.add(marker);
    connSource.entities.add(pulse);
    connEntities.set(conn.id, { marker, pulse });
    pulses.set(conn.id, {
      entity: pulse,
      base: color,
      scratchColor: new Cesium.Color(),
    });
    startPulseLoop();
  }
  for (const [id, { marker, pulse }] of [...connEntities]) {
    if (!nextIds.has(id)) {
      connSource.entities.remove(marker);
      connSource.entities.remove(pulse);
      connEntities.delete(id);
      pulses.delete(id);
    }
  }
}

/** preRender driver for connection pulse rings — plain values, no CallbackProperty. */
function startPulseLoop() {
  if (pulseOff || pulses.size === 0) return;
  const viewer = getViewer();
  if (!viewer) return;
  holdContinuousRender('marker-pulses');
  pulseOff = viewer.scene.preRender.addEventListener(() => {
    // The render loop is sacred — never let a pulse throw kill it.
    try { pulseTick(performance.now()); } catch (err) {
      console.error('[markers] pulse tick error (render loop protected):', err);
    }
  });
}

function pulseTick(now) {
  const p = ((now / 1000) % PULSE_S) / PULSE_S;
  const s = 0.5 + p * 1.0;
  const alpha = 0.55 * (1 - p);
  for (const entry of pulses.values()) {
    try {
      entry.entity.billboard.scale = s; // plain number — see note above
      entry.scratchColor.red = entry.base.red;
      entry.scratchColor.green = entry.base.green;
      entry.scratchColor.blue = entry.base.blue;
      entry.scratchColor.alpha = alpha;
      entry.entity.billboard.color = entry.scratchColor;
    } catch { /* entity removed mid-frame */ }
  }
  if (pulses.size === 0 && pulseOff) {
    pulseOff(); pulseOff = null;
    releaseContinuousRender('marker-pulses');
  }
}

/* ——— one-shot pulse (feed/search selection) ——— */
export function pulseAt(lon, lat, severity = 'low', { duration = 1400 } = {}) {
  const viewer = getViewer();
  if (!viewer || !connSource) return;
  const color = Cesium.Color.fromCssColorString(SEV_COLORS[severity] || SEV_COLORS.low);
  const ent = new Cesium.Entity({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, MARKER_ALT_M),
    billboard: {
      image: Sprites.pulse(severity),
      width: 64,
      height: 64,
      heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
      disableDepthTestDistance: 0,
    },
  });
  connSource.entities.add(ent);
  addTween({
    ms: duration, ease: easeInOut,
    update: (p) => {
      ent.billboard.scale = 0.5 + p * 2.0; // plain number (see note in syncConnections)
      ent.billboard.color = color.withAlpha(0.8 * (1 - p));
    },
    done: () => connSource.entities.remove(ent),
  });
}

/* ——— highlight a marker in sequence (connection chain walk) ——— */
export function highlightEvent(eventId, { holdMs = 700 } = {}) {
  const ent = entities.get(eventId);
  if (!ent) return;
  const base = 1;
  addTween({
    ms: 320, ease: easeInOut,
    update: (p) => { ent.billboard.scale = base + p * 0.9; },
    done: () => {
      setTimeout(() => {
        addTween({
          ms: 320, ease: easeInOut,
          update: (p) => { ent.billboard.scale = base + (1 - p) * 0.9; },
        });
      }, holdMs);
    },
  });
}

/* ——— picking ——— */
export function pickAt(clientX, clientY) {
  const viewer = getViewer();
  if (!viewer) return null;
  const picked = viewer.scene.pick(new Cesium.Cartesian2(clientX, clientY));
  if (!picked || !picked.id) return null;
  const id = picked.id;
  // Flight billboards: id is "flight-<hex>" string.
  if (typeof id === 'string' && id.startsWith('flight-')) {
    return { type: 'flight', hex: id.slice(7) };
  }
  // Satellite billboards: id is "sat-<index>" string.
  if (typeof id === 'string' && id.startsWith('sat-')) {
    return { type: 'satellite', satIdx: parseInt(id.slice(4), 10) };
  }
  // Earthquake entities: id is "quake-<id>" string.
  if (typeof id === 'string' && id.startsWith('quake-')) {
    return { type: 'quake', quakeId: id.slice(6) };
  }
  // Public camera entities: id is "cam-<id>" string.
  if (typeof id === 'string' && id.startsWith('cam-')) {
    return { type: 'camera', camId: id.slice(4) };
  }
  // Vessel billboards: id is "vessel-<mmsi>" string.
  if (typeof id === 'string' && id.startsWith('vessel-')) {
    return { type: 'vessel', mmsi: id.slice(7) };
  }
  // Datacenter billboards (localGeojson engine): id is "dc-<index>" string.
  if (typeof id === 'string' && id.startsWith('dc-')) {
    return { type: 'datacenter', dcIdx: parseInt(id.slice(3), 10) };
  }
  // Follow-mode tracked entity: a Cesium Entity whose own id is "flight-<hex>"
  // (startFollow stamps the tracked id on it). Tapping it hits the flight
  // branch instead of falling through to closeEventCard (UX-2).
  if (id && typeof id === 'object' && typeof id.id === 'string' && id.id.startsWith('flight-')) {
    return { type: 'flight', hex: id.id.slice(7) };
  }
  // Military installation entities: entity id is "mil-<recId>" (dot) or
  // "mil-<recId>:outline" (footprint polyline) — both open the same card.
  if (id && typeof id === 'object' && typeof id.id === 'string' && id.id.startsWith('mil-')) {
    const raw = id.id.slice(4);
    const instId = raw.endsWith(':outline') ? raw.slice(0, -8) : raw;
    return { type: 'installation', instId };
  }
  // Rocket launch pad entities: entity id is "launch-<space-devs-id>".
  if (id && typeof id === 'object' && typeof id.id === 'string' && id.id.startsWith('launch-')) {
    return { type: 'launch', launchId: id.id };
  }
  // Entity objects (earthquakes, cameras, launches, etc.) — check properties.
  if (id && typeof id === 'object' && id.properties) {
    const kind = propValue(id.properties, 'kind');
    if (kind === 'quake') {
      return { type: 'quake', quakeId: propValue(id.properties, 'quakeId') };
    }
    if (kind === 'cam') {
      return { type: 'camera', camId: propValue(id.properties, 'camId') };
    }
  }
  const primPos = picked.primitive && picked.primitive.position;
  // Cluster hits: billboard tagged in clusterEvent, or the label's id array.
  if ((id && id.__clusterIds) || Array.isArray(id)) {
    const members = id.__clusterIds || id.map((e) => (e && e.id) || e);
    return { type: 'cluster', members, position: primPos || null };
  }
  const props = id.properties;
  if (!props) return null;
  const kind = propValue(props, 'kind');
  if (kind === 'event') {
    return { type: 'event', eventId: propValue(props, 'eventId'), entity: id };
  }
  if (kind === 'connection') {
    return { type: 'connection', connectionId: propValue(props, 'connectionId'), entity: id };
  }
  return null;
}

export function screenPositionOf(cartesian) {
  const viewer = getViewer();
  if (!viewer || !cartesian) return null;
  const p = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, cartesian);
  return p ? { x: p.x, y: p.y } : null;
}

/** Project an event's position to screen coords (null when behind the globe). */
export function eventScreenPos(eventId) {
  const ent = entities.get(eventId);
  if (!ent || !ent.position) return null;
  const viewer = getViewer();
  const pos = ent.position.getValue(viewer.clock.currentTime);
  return screenPositionOf(pos);
}
