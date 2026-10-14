/* Lane G — B2 markers + rings, B3 connections.
   Cesium layer `intel-events`: clustered severity markers in one
   CustomDataSource, connection nodes + arcs + pulse rings in a second
   (unclustered) source. Semantics preserved from the old CI markers.js:
   cluster badges freeze during motion and regroup only on a settled
   zoom change ≥1.6x; pulse rings animate via plain billboard values on
   preRender (never CallbackProperty on billboard.scale — renderer crash).
   §L bands gate rings/arcs (see model.js + lane log decision 5). */
import * as Cesium from 'cesium';
import { Sprites } from './sprites.js';
import { store, on, runtime } from './store.js';
import {
  SEV_COLORS, SEV_RANK, bandForHeight, clusterPixelRange,
  connectionTierVisible, regionMatches, isGeo, passesSeverityFloor,
} from './model.js';

const MARKER_ALT_M = 1500;
const PULSE_S = 2.4;
const CLUSTER_LABEL_FONT = '600 13px "JetBrains Mono", monospace';
const CLUSTER_LABEL_FILL = Cesium.Color.fromCssColorString('#EDF7FE');
const CLUSTER_LABEL_OUTLINE = Cesium.Color.fromCssColorString('#050B16');
const CLUSTER_LABEL_OFFSET = new Cesium.Cartesian2(0, 1);

function propValue(props, name) {
  if (!props) return undefined;
  const v = props[name];
  if (v && typeof v.getValue === 'function') {
    try { return v.getValue(); } catch { return undefined; }
  }
  return v;
}
function sevOf(e) { return SEV_RANK[e?.severity] !== undefined ? e.severity : 'low'; }

export function createIntelLayer({ onPick } = {}) {
  let viewer = null;
  let eventSource = null;
  let connSource = null;
  let enabled = false;
  let destroyed = false;
  const entities = new Map(); // eventId -> entity
  const connEntities = new Map(); // connId -> {node, pulse, arc}
  const pulses = new Map(); // connId -> {entity, base, scratch}
  let pulseOff = null;
  let pickHandler = null;
  let moveEndOff = null;
  let band = 'B0';
  let unsubData = null;
  let unsubRegion = null;

  function connectionPoint(conn) {
    const step = (conn?.chain || []).find((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
    return step || null;
  }
  function visibleMarkers() {
    // J4-15: the severity floor dial filters globe markers too.
    return store.markers.filter((e) => isGeo(e) && regionMatches(store.region, e) && passesSeverityFloor(e, store.severityFloor));
  }
  function visibleConnections() {
    return store.connections.filter((c) => connectionTierVisible(c, band) && passesSeverityFloor(c, store.severityFloor));
  }

  function applyBand() {
    if (!viewer) return;
    const h = viewer.camera?.positionCartographic?.height;
    const next = bandForHeight(h);
    if (eventSource?.clustering) {
      eventSource.clustering.pixelRange = clusterPixelRange(next);
      eventSource.clustering.minimumClusterSize = next === 'B0' || next === 'B1' ? 3 : 5;
    }
    if (next !== band) {
      band = next;
      syncConnections();
    }
  }

  function syncEvents() {
    if (!eventSource) return;
    const list = visibleMarkers();
    const nextIds = new Set();
    for (const e of list) {
      nextIds.add(e.id);
      const existing = entities.get(e.id);
      if (!existing) {
        const ent = new Cesium.Entity({
          id: `intel-evt-${e.id}`,
          position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, MARKER_ALT_M),
          billboard: {
            image: Sprites.event(sevOf(e)),
            width: 34, height: 34,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: 0,
          },
          properties: { eventId: e.id, severity: sevOf(e), kind: 'intel-event' },
        });
        entities.set(e.id, ent);
        eventSource.entities.add(ent);
      } else if (propValue(existing.properties, 'severity') !== sevOf(e)) {
        existing.billboard.image = Sprites.event(sevOf(e));
        existing.properties.severity = sevOf(e);
      }
    }
    for (const [id, ent] of [...entities]) {
      if (!nextIds.has(id)) { eventSource.entities.remove(ent); entities.delete(id); }
    }
  }

  function syncConnections() {
    if (!connSource) return;
    const list = visibleConnections();
    const nextIds = new Set();
    for (const conn of list) {
      const pt = connectionPoint(conn);
      if (!pt) continue;
      nextIds.add(conn.id);
      if (connEntities.has(conn.id)) continue;
      const severity = sevOf(conn);
      const color = Cesium.Color.fromCssColorString(SEV_COLORS[severity]);
      const pos = Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, MARKER_ALT_M);
      const node = new Cesium.Entity({
        id: `intel-conn-${conn.id}`,
        position: pos,
        billboard: {
          image: Sprites.connection(severity),
          width: 52, height: 52,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: 0,
        },
        properties: { connectionId: conn.id, kind: 'intel-connection', severity },
      });
      const pulse = new Cesium.Entity({
        id: `intel-conn-pulse-${conn.id}`,
        position: pos,
        billboard: {
          image: Sprites.pulse(severity),
          width: 64, height: 64,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: 0,
          scale: 0.5,
          color: color.withAlpha(0.55),
        },
      });
      // Arc: cause -> ... -> effect, lifted polyline through the chain's
      // geo points (the connection made spatial — B3 presentation upgrade
      // over the old single node; semantics unchanged).
      let arc = null;
      const geoSteps = (conn.chain || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
      if (geoSteps.length >= 2) {
        const positions = [];
        for (let i = 0; i < geoSteps.length - 1; i++) {
          const a = geoSteps[i]; const b = geoSteps[i + 1];
          const steps = 24;
          for (let sIdx = 0; sIdx < steps; sIdx++) {
            const t = sIdx / steps;
            const lat = a.lat + (b.lat - a.lat) * t;
            let dLon = b.lon - a.lon;
            if (dLon > 180) dLon -= 360; if (dLon < -180) dLon += 360;
            const lon = a.lon + dLon * t;
            const lift = Math.sin(Math.PI * t) * 120_000 + MARKER_ALT_M;
            positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, lift));
          }
        }
        const last = geoSteps[geoSteps.length - 1];
        positions.push(Cesium.Cartesian3.fromDegrees(last.lon, last.lat, MARKER_ALT_M));
        arc = new Cesium.Entity({
          id: `intel-conn-arc-${conn.id}`,
          polyline: {
            positions,
            width: 1.6,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.18,
              color: color.withAlpha(0.75),
            }),
          },
        });
      }
      connSource.entities.add(node);
      connSource.entities.add(pulse);
      if (arc) connSource.entities.add(arc);
      connEntities.set(conn.id, { node, pulse, arc });
      pulses.set(conn.id, { entity: pulse, base: color, scratch: new Cesium.Color() });
      startPulseLoop();
    }
    for (const [id, { node, pulse, arc }] of [...connEntities]) {
      if (!nextIds.has(id)) {
        connSource.entities.remove(node);
        connSource.entities.remove(pulse);
        if (arc) connSource.entities.remove(arc);
        connEntities.delete(id);
        pulses.delete(id);
      }
    }
  }

  function pulseTick(now) {
    const p = ((now / 1000) % PULSE_S) / PULSE_S;
    const s = 0.5 + p * 1.0;
    const alpha = 0.55 * (1 - p);
    for (const entry of pulses.values()) {
      try {
        entry.entity.billboard.scale = s; // plain number — see header note
        entry.scratch.red = entry.base.red;
        entry.scratch.green = entry.base.green;
        entry.scratch.blue = entry.base.blue;
        entry.scratch.alpha = alpha;
        entry.entity.billboard.color = entry.scratch;
      } catch { /* entity removed mid-frame */ }
    }
    if (pulses.size === 0 && pulseOff) { pulseOff(); pulseOff = null; }
  }
  function startPulseLoop() {
    if (pulseOff || pulses.size === 0 || !viewer) return;
    pulseOff = viewer.scene.preRender.addEventListener(() => {
      try { pulseTick(performance.now()); } catch (err) {
        console.error('[intel] pulse tick error (render loop protected):', err);
      }
    });
  }

  function flyTo(lon, lat, height = 2_500_000) {
    if (!viewer || !Number.isFinite(lon) || !Number.isFinite(lat)) return;
    try {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        duration: 1.4,
      });
    } catch { /* camera busy — selection still opens the card */ }
  }

  const layer = {
    id: 'intel-events',
    name: 'Intel Events & Connections',
    icon: '◎',
    source: 'CI intel pipeline · 34 sources',
    updateInterval: 0, // data is push-driven via the SSE client, not polled

    attachDataManager(manager) {
      // Fresh-profile default-on (lane log decision 2): only when the user
      // has never stored a layer choice and did not arrive via a share link.
      try {
        const hasStored = !!localStorage.getItem('gev:layer-state:v2');
        const hasShare = /[?&#]v=2\b/.test(location.href) || location.hash.includes('v=2');
        if (hasStored || hasShare || !manager?.restoreLayerState) return;
        // Finisher fix (2026-10-13, gate evidence in lane log): a
        // non-throwing restore return is NOT success — the startup
        // coordinator restores every registry layer to its durable-state
        // target (fresh profile -> intel-events disabled) and that intent
        // can supersede this one after it resolves, and the old 40x300 ms
        // window also expired long before a contended boot settled. The
        // layer was left enabled:false with 0 markers rendered. Only stop
        // once the manager confirms the layer settled enabled; otherwise
        // re-assert (the newer intent wins) inside a bounded 5 min window.
        let tries = 0;
        let inFlight = false;
        const timer = setInterval(async () => {
          if (destroyed) { clearInterval(timer); return; }
          if (inFlight) return;
          tries++;
          inFlight = true;
          try {
            const result = await manager.restoreLayerState('intel-events', { enabled: true }, { origin: 'programmatic' });
            if (result?.succeeded === true && result?.settledEnabled === true) clearInterval(timer);
            else if (tries >= 300) clearInterval(timer);
          } catch {
            if (tries >= 300) clearInterval(timer); // registrations not finalized yet — keep retrying
          } finally {
            inFlight = false;
          }
        }, 1000);
      } catch { /* storage unavailable — layer stays a normal toggle */ }
    },

    init(viewerArg) {
      if (viewer) throw new Error('Intel layer is already initialized');
      viewer = viewerArg;
      runtime.viewer = viewer;
      runtime.layer = layer;
      runtime.flyToEvent = (e) => flyTo(e.lon, e.lat);
      runtime.flyToConnection = (conn) => {
        const pt = connectionPoint(conn);
        if (!pt) return;
        // Fly to a band where this connection actually renders (§L tiers,
        // mirroring model.connectionTierVisible's tier derivation): a
        // standard-tier connection flown to 4,000 km (B2) would be
        // invisible on arrival — the user clicked it to SEE it.
        // (finisher fix, 2026-10-13)
        const rank = SEV_RANK[conn?.severity] ?? 0;
        const tier = conn?.tier || (rank >= 3 ? 'critical' : rank >= 2 ? 'high' : 'standard');
        const height = tier === 'critical' ? 4_000_000 : tier === 'high' ? 2_000_000 : 300_000;
        flyTo(pt.lon, pt.lat, height);
      };
      runtime.flyToRegion = (region) => flyTo(region.lon, region.lat, region.height);

      eventSource = new Cesium.CustomDataSource('intel-events');
      eventSource.clustering.enabled = true;
      eventSource.clustering.pixelRange = 96;
      eventSource.clustering.minimumClusterSize = 3;
      eventSource.clustering.clusterEvent.addEventListener((clustered, cluster) => {
        let maxSev = 'low'; let maxRank = -1;
        const memberIds = [];
        for (const e of clustered) {
          const sev = propValue(e.properties, 'severity') || 'low';
          if (SEV_RANK[sev] !== undefined && SEV_RANK[sev] > maxRank) { maxRank = SEV_RANK[sev]; maxSev = sev; }
          const eid = propValue(e.properties, 'eventId');
          if (eid) memberIds.push(eid);
        }
        cluster.billboard.show = true;
        cluster.billboard.id = { __intelClusterIds: memberIds };
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
      // Cluster badges freeze during motion; regroup only on settled zoom
      // ≥1.6x (old CI inv. E4 discipline, kept).
      let lastClusterHeight = 0;
      moveEndOff = viewer.camera.moveEnd.addEventListener(() => {
        try {
          applyBand();
          const h = viewer.camera.positionCartographic.height;
          if (!Number.isFinite(h) || h <= 0) return;
          if (!lastClusterHeight) { lastClusterHeight = h; return; }
          const ratio = Math.max(h, lastClusterHeight) / Math.min(h, lastClusterHeight);
          if (ratio >= 1.6) {
            lastClusterHeight = h;
            const c = eventSource.clustering;
            const pr = c.pixelRange;
            c.pixelRange = pr + 1;
            c.pixelRange = pr;
          }
        } catch { /* camera not ready */ }
      });
      viewer.dataSources.add(eventSource);

      connSource = new Cesium.CustomDataSource('intel-connections');
      connSource.clustering.enabled = false;
      viewer.dataSources.add(connSource);
      eventSource.show = enabled;
      connSource.show = enabled;

      // Picking: only intel entities are ours; everything else falls
      // through untouched for the shell's own pick handling.
      pickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      pickHandler.setInputAction((movement) => {
        try {
          const picked = viewer.scene.pick(movement.position);
          if (!picked?.id) return;
          const id = picked.id;
          if (id && typeof id === 'object' && Array.isArray(id.__intelClusterIds)) {
            onPick?.({ type: 'cluster', members: id.__intelClusterIds });
            return;
          }
          if (id?.properties) {
            const kind = propValue(id.properties, 'kind');
            if (kind === 'intel-event') onPick?.({ type: 'event', eventId: propValue(id.properties, 'eventId') });
            else if (kind === 'intel-connection') onPick?.({ type: 'connection', connectionId: propValue(id.properties, 'connectionId') });
          }
        } catch { /* pick during teardown */ }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      unsubData = on('data', () => { if (enabled) { syncEvents(); syncConnections(); } });
      unsubRegion = on('region', () => { if (enabled) syncEvents(); });
      applyBand();
      if (enabled) { syncEvents(); syncConnections(); }
      console.log('[Intel] Layer initialized');
    },

    enable() {
      enabled = true;
      if (eventSource) eventSource.show = true;
      if (connSource) connSource.show = true;
      applyBand();
      syncEvents();
      syncConnections();
    },

    disable() {
      enabled = false;
      if (eventSource) eventSource.show = false;
      if (connSource) connSource.show = false;
    },

    // Push-driven: data arrives via the SSE store subscription, so update()
    // has nothing to fetch — but it must NOT return false. In this manager's
    // contract (lifecycle _doToggle first-update + _runPeriodicUpdate),
    // update() === false means "update rejected": the enable transaction
    // fails and rolls the layer back to disabled. That contract mismatch
    // (not a restore race) is why auto-enable never stuck — enable ran,
    // markers synced, then the failed first update disabled the layer
    // again (gate evidence + lifecycle probe, finisher 2026-10-13).
    async update() { return true; },

    destroy() {
      destroyed = true;
      unsubData?.(); unsubRegion?.();
      if (pulseOff) { pulseOff(); pulseOff = null; }
      if (pickHandler) { pickHandler.destroy(); pickHandler = null; }
      if (moveEndOff) { moveEndOff(); moveEndOff = null; }
      if (viewer) {
        if (eventSource) viewer.dataSources.remove(eventSource, true);
        if (connSource) viewer.dataSources.remove(connSource, true);
      }
      eventSource = null; connSource = null; viewer = null;
      entities.clear(); connEntities.clear(); pulses.clear();
      if (runtime.layer === layer) { runtime.layer = null; runtime.viewer = null; }
    },

    getStats() {
      return {
        count: entities.size,
        connections: connEntities.size,
        band,
        lastUpdate: store.lastSnapshotAt,
        error: null,
      };
    },

    // Gate/testing surface: what is actually on the globe right now.
    debugState() {
      return {
        enabled, destroyed, band,
        markers: entities.size,
        connectionNodes: connEntities.size,
        pulses: pulses.size,
        storeMarkers: store.markers.length,
        storeConnections: store.connections.length,
      };
    },
  };
  return layer;
}
