/* Live flights — military via /proxy/adsblol/mil, civil via /proxy/adsblol/near
   (camera-target centered, 250 NM). One BillboardCollection, 15 s polls,
   ~12 Hz dead reckoning between polls (track + ground speed), NearFarScalar
   distance scaling, horizon culling via EllipsoidalOccluder.
   Data: adsb.lol (ODbL 1.0 — credited in the Layers panel). */
import * as Cesium from 'cesium';
import { classifyAircraft } from '../aircraft/aircraftClass.js';
import { aircraftIcon, FLEET_ICON_PX, FLEET_ICON_PX_RETINA } from '../aircraft/aircraftIcons.js';
import { isTaggedMilitary } from '../aircraft/militaryRegistry.js';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { screenProjectedRotation, stabilizeScreenRotation } from '../aircraft/iconOrientation.js';
import { followedId, stopFollow } from '../aircraft/followMode.js';

const POLL_MS = 15 * 1000;
// Civilian planes only render when the camera is closer than this height
// (Joshua 2026-09-29): zoomed-out views would try to draw thousands of
// overlapping billboards. Military traffic is unaffected.
// Threshold measured 2026-09-29: a full-state-of-Florida phone view (the
// reference screenshot Joshua approved) sits at ~580-650 km camera height,
// so civilian traffic begins appearing right around that zoom.
const CIVIL_ZOOM_HEIGHT_M = 650_000;
// Billboard base scales (Joshua 2026-09-29): military keeps the uniform 0.6;
// civilian blue planes are smaller (0.45) so dense civil traffic reads as
// less cluttered. Multiplied by the retina ratio below, as before.
const MIL_SCALE = 0.5;
const CIV_SCALE = 0.45;

let viewer = null;
let billboards = null;
let milOn = false;
let civOn = false;
let pollTimer = 0;
let preRenderRemove = null;
let occluder = null;
// Zoom gate for civilian traffic (Joshua 2026-09-29). Tracks whether the
// camera is currently close enough to render civil planes.
let civZoomIn = false;
// Source heartbeat for the dock: last successful poll + last error, per feed.
const feedStatus = {
  military: { lastOk: 0, lastErr: '' },
  civil: { lastOk: 0, lastErr: '', gated: false },
};
/** Heartbeat for the Live Source Dock: { lastOk, lastErr, gated } per feed. */
export function flightStatus() { return feedStatus; }

/** True when the camera is close enough for civilian planes to render. */
export function civilZoomedIn() {
  if (!viewer) return false;
  return viewer.scene.camera.positionCartographic.height < CIVIL_ZOOM_HEIGHT_M;
}

/**
 * Sync the civilian zoom gate. Call when the zoom may have changed or the
 * layer toggles. On a zoom-in transition with the layer on, fetches fresh
 * traffic immediately instead of waiting for the next 15 s tick.
 * Returns true if it triggered a poll.
 */
function refreshCivilGate() {
  const zin = civilZoomedIn();
  feedStatus.civil.gated = civOn && !zin;
  if (zin === civZoomIn) return false;
  const wasIn = civZoomIn;
  civZoomIn = zin;
  cullHorizon(); // re-apply show flags; civilian layerOn includes the gate
  // F2: zooming out past the civil gate while tracking a civil aircraft —
  // its data layer just disappeared, so release the follow instead of
  // freezing on a hidden, aging ghost.
  if (wasIn && !zin) releaseFollowIf((a) => !a.military, 'zoom-gate');
  if (zin && civOn) { poll(); return true; }
  return false;
}

// Stop following the tracked aircraft when `pred` matches it (F2): its data
// layer just disappeared (layer turned off / zoom gate closed). The camera
// releases in place instead of freezing on a ghost.
function releaseFollowIf(pred, reason) {
  const fid = followedId();
  if (!fid || !fid.startsWith('flight-')) return;
  const fa = aircraft.get(fid.slice('flight-'.length));
  if (fa && pred(fa)) stopFollow(reason);
}

// hex -> { billboard, lat, lon, track, gs, alt, lastUpdate, missedPolls }
const aircraft = new Map();

function planeSprite(tint) {
  const size = 56;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.translate(size / 2, size / 2);
  // Draw pointing up (north); billboard rotation adds heading.
  // More detailed airliner silhouette: fuselage, swept wings, tailplane,
  // vertical stabilizer, and engine nacelles.
  g.fillStyle = tint;
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 1.5;

  // Fuselage: rounded nose to tapered tail.
  g.beginPath();
  g.moveTo(0, -24);                    // nose tip
  g.bezierCurveTo(3, -20, 3, -12, 2.5, -4);
  g.lineTo(2.5, 10);                   // mid fuselage
  g.bezierCurveTo(2.5, 16, 1.5, 20, 0, 22); // tail taper
  g.bezierCurveTo(-1.5, 20, -2.5, 16, -2.5, 10);
  g.lineTo(-2.5, -4);
  g.bezierCurveTo(-3, -12, -3, -20, 0, -24);
  g.closePath();
  g.fill();
  g.stroke();

  // Main wings: swept back, tapered.
  g.beginPath();
  g.moveTo(2, -2);
  g.lineTo(22, 8);                     // right wingtip leading
  g.lineTo(22, 11);                    // right wingtip trailing
  g.lineTo(2, 6);                      // wing root trailing
  g.closePath();
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(-2, -2);
  g.lineTo(-22, 8);
  g.lineTo(-22, 11);
  g.lineTo(-2, 6);
  g.closePath();
  g.fill();
  g.stroke();

  // Engine nacelles under wings.
  g.beginPath();
  g.ellipse(9, 6, 2.5, 4, 0.15, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.beginPath();
  g.ellipse(-9, 6, 2.5, 4, -0.15, 0, Math.PI * 2);
  g.fill();
  g.stroke();

  // Horizontal stabilizers (tailplane).
  g.beginPath();
  g.moveTo(1.5, 14);
  g.lineTo(10, 19);
  g.lineTo(10, 21);
  g.lineTo(1.5, 17);
  g.closePath();
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(-1.5, 14);
  g.lineTo(-10, 19);
  g.lineTo(-10, 21);
  g.lineTo(-1.5, 17);
  g.closePath();
  g.fill();
  g.stroke();

  // Vertical stabilizer.
  g.beginPath();
  g.moveTo(0, 12);
  g.lineTo(0, 22);
  g.lineTo(-2.5, 18);
  g.lineTo(-2.5, 14);
  g.closePath();
  g.fillStyle = tint;
  g.fill();
  g.stroke();

  // Cockpit windows (subtle dark band near nose).
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.beginPath();
  g.ellipse(0, -18, 1.8, 2.5, 0, 0, Math.PI * 2);
  g.fill();

  return c;
}

function ensureBillboards() {
  if (billboards) return;
  const scene = viewer.scene;
  billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    viewer.scene.camera.positionWC
  );
}

function toCartesian(lat, lon, altM, result) {
  // NOTE: Cartesian3.fromDegrees is (lon, lat, height, ellipsoid, result) —
  // the 4th slot is the ELLIPSOID, not the result. A scratch Cartesian3 passed
  // in the 4th slot is read as the ellipsoid (its .radiiSquared is undefined)
  // and crashes the render loop inside multiplyComponents. Always pass
  // undefined for the default WGS84 ellipsoid.
  return Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(altM, 0), undefined, result);
}

// Advance a position by speed/track over dt seconds. Constant-rate-turn
// integration (ported from God's Eye View motionModel.js, MIT): the track
// itself rotates through the turn, so a banking aircraft follows an arc
// instead of drifting off its curved path — straight-line DR can be ~1.4 km
// off over a 15 s poll at 500 kt in a standard-rate turn (audit S2).
const MS_PER_KNOT = 0.514444;
const M_PER_DEG_LAT = 111320; // spherical approx, matches GEV
function norm180(d) { d = (d + 180) % 360; if (d < 0) d += 360; return d - 180; }
function norm360(d) { d %= 360; if (d < 0) d += 360; return d; }
function deadReckon(a, dt) {
  if (!Number.isFinite(a.track) || !Number.isFinite(a.gs) || a.gs <= 0) return;
  const speedMps = a.gs * MS_PER_KNOT;
  const w = ((a.turnRateDps || 0) * Math.PI) / 180; // turn rate, rad/s
  const tr = (a.track * Math.PI) / 180;
  let eastM, northM;
  if (Math.abs(w) < 1e-4) {
    eastM = speedMps * Math.sin(tr) * dt;
    northM = speedMps * Math.cos(tr) * dt;
  } else {
    eastM = (speedMps / w) * (Math.cos(tr) - Math.cos(tr + w * dt));
    northM = (speedMps / w) * (Math.sin(tr + w * dt) - Math.sin(tr));
    a.track = norm360(a.track + (a.turnRateDps || 0) * dt);
  }
  a.lat += northM / M_PER_DEG_LAT;
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  a.lon += eastM / (M_PER_DEG_LAT * Math.max(cosLat, 0.2));
}

// Turn-rate estimate from recent REPORTED tracks (audit S2): mean signed
// track change per second over the last few polls. Noise floor 0.4 °/s and
// ±4 °/s clamp keep fix jitter from manufacturing a spin. Only feed samples
// are used — never the turn-evolved a.track the interpolator maintains.
function estimateTurnRateDps(samples) {
  let sum = 0, n = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].tSec - samples[i - 1].tSec;
    if (dt < 2 || dt > 120) continue;
    const d = norm180(samples[i].trackDeg - samples[i - 1].trackDeg);
    if (!Number.isFinite(d)) continue;
    sum += d / dt;
    n++;
  }
  if (!n) return 0;
  const rate = sum / n;
  if (Math.abs(rate) < 0.4) return 0;
  return Math.max(-4, Math.min(4, rate));
}

function upsert(ac, military) {
  const hex = ac.hex;
  if (!hex || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return;
  let a = aircraft.get(hex);
  // P4: prefer geometric altitude (feet → m) for RENDERING — alt_geom is
  // already referenced to the WGS84 ellipsoid, so it needs no MSL offset.
  // The card keeps showing barometric altitude (a.alt, pilot-true MSL).
  const altGeomM = Number(ac.alt_geom) * 0.3048;
  const renderAltM = ac.alt_baro === 'ground' ? 0
    : Number.isFinite(altGeomM) && altGeomM > 0 ? altGeomM
    : Number(ac.alt_baro) * 0.3048 || 0;
  const altM = ac.alt_baro === 'ground' ? 0 : Number(ac.alt_baro) * 0.3048 || 0;
  // F4: unwrap longitude to the nearest ±360° equivalent of the current
  // display position, so antimeridian crossings interpolate the short way
  // instead of sending the follow camera on a 360° sweep.
  // S1: adsb.lol positions are routinely stale (seen_pos = seconds since the
  // last ADS-B update). Advance the reported fix along its track/speed by
  // that age BEFORE storing it, so the baseline isn't behind truth.
  let fixLat = ac.lat, fixLon = ac.lon;
  const refLon = a && Number.isFinite(a.dispLon) ? a.dispLon
    : a && Number.isFinite(a.lon) ? a.lon : fixLon;
  while (fixLon - refLon > 180) fixLon -= 360;
  while (fixLon - refLon < -180) fixLon += 360;
  const fixAgeSec = Number(ac.seen_pos) || 0;
  const reportedTrack = (ac.track == null || ac.track === '') ? NaN : Number(ac.track);
  if (fixAgeSec > 0 && fixAgeSec < 300) {
    const probe = {
      lat: fixLat, lon: fixLon, track: reportedTrack,
      gs: Number(ac.gs), turnRateDps: a ? a.turnRateDps : 0,
    };
    deadReckon(probe, fixAgeSec);
    fixLat = probe.lat;
    fixLon = probe.lon;
  }
  // Per-class silhouette (audit 1.6): classify by ICAO type designator.
  const typeCode = (ac.t || '').trim().toUpperCase();
  const klass = classifyAircraft({ typeCode });
  if (!a) {
    const taggedMil = isTaggedMilitary(hex);
    const bb = billboards.add({
      id: `flight-${hex}`,
      image: aircraftIcon(klass, FLEET_ICON_PX_RETINA),
      scaleByDistance: new Cesium.NearFarScalar(2e5, 1.4, 4e7, 0.35),
      // Depth-test relief only at close range: within 200 km the billboard
      // skips depth testing so grounded aircraft stay visible through
      // terrain (P5). Beyond that the globe depth-occludes normally, so
      // far-side aircraft can never draw through the planet (Joshua
      // 2026-09-30 — INF let opposite-side planes show through the globe).
      disableDepthTestDistance: 200000,
    });
    // Uniform size per layer (Joshua 2026-09-29/30): military 0.5, civilian
    // 0.45 so dense traffic looks less cluttered. Retina ratio keeps it sharp.
    bb.scale = (military ? MIL_SCALE : CIV_SCALE) * (FLEET_ICON_PX / FLEET_ICON_PX_RETINA);
    // Tint: operator-tagged red / military amber / civil blue.
    bb.color = Cesium.Color.fromCssColorString(
      taggedMil ? '#ff6b6b' : military ? '#ffb347' : '#7fd4ff'
    );
    a = { billboard: bb, hex, klass, military: !!military };
    aircraft.set(hex, a);
    // New aircraft: start at the pre-advanced reported position (S1) —
    // no interpolation needed.
    a.lat = fixLat;
    a.lon = fixLon;
    a.dispLat = fixLat;
    a.dispLon = fixLon;
  } else {
    // Existing aircraft: set target, interpolate display position smoothly.
    // This prevents visible jumping when API position differs from dead-reckoned.
    a.lat = fixLat;
    a.lon = fixLon;
    if (!Number.isFinite(a.dispLat)) { a.dispLat = fixLat; a.dispLon = fixLon; }
    // Re-image if the type arrived late (audit 1.6). Re-scale if the
    // military/civil classification changed between feeds.
    if (klass !== a.klass || !!military !== !!a.military) {
      a.klass = klass;
      a.military = !!military;
      a.billboard.image = aircraftIcon(klass, FLEET_ICON_PX_RETINA);
      a.billboard.scale = (military ? MIL_SCALE : CIV_SCALE) * (FLEET_ICON_PX / FLEET_ICON_PX_RETINA);
    }
  }
  // Enrichment fields for richer cards (audit 1.9).
  a.typeCode = typeCode;
  a.vertRateFpm = Number(ac.baro_rate);   // ft/min, NaN when absent
  a.seenSec = Number(ac.seen);            // seconds since last ADS-B update
  a.seenPosSec = Number(ac.seen_pos);     // seconds since last POSITION update (S1)
  a.squawk = ac.squawk || '';
  a.emergency = ac.emergency || 'none';
  a.stale = (a.missedPolls || 0) > 0;
  // Position history for selected-flight trails (audit 1.7).
  // Recorded AFTER altitude assignment so the point carries this poll's altitude.
  a.history = a.history || [];
  a.history.push(toCartesian(a.lat, a.lon, renderAltM));
  if (a.history.length > 120) a.history.shift(); // ~30 min at 15 s polls
  // Track: null/undefined/empty means "unknown" (use movement fallback).
  // Number(null) is 0, which would falsely point the plane north.
  a.track = reportedTrack;
  a.gs = Number(ac.gs);
  // S2: turn-rate estimate from recent reported tracks (see deadReckon).
  const nowSec = performance.now() / 1000;
  a.turnSamples = a.turnSamples || [];
  if (Number.isFinite(a.track)) {
    a.turnSamples.push({ trackDeg: a.track, tSec: nowSec });
    if (a.turnSamples.length > 3) a.turnSamples.shift();
  }
  a.turnRateDps = estimateTurnRateDps(a.turnSamples);
  a.alt = altM;               // baro MSL — card display stays pilot-true (P4)
  a.renderAltM = renderAltM;  // ellipsoidal — what the globe actually draws (P4)
  a.military = military;
  a.label = (ac.flight || '').trim() || ac.r || hex;
  a.lastUpdate = performance.now();
  a.billboard.position = toCartesian(a.lat, a.lon, a.renderAltM);
  // Heading: prefer ADS-B track, else estimate from position delta,
  // else keep last rotation (never snap back to 0).
  let heading = null;
  if (Number.isFinite(a.track)) {
    heading = a.track;
  } else if (Number.isFinite(a.prevLat) && Number.isFinite(a.prevLon) &&
             (a.prevLat !== a.lat || a.prevLon !== a.lon)) {
    const dLon = (a.lon - a.prevLon) * Math.cos((a.lat * Math.PI) / 180);
    const dLat = a.lat - a.prevLat;
    heading = (Math.atan2(dLon, dLat) * 180) / Math.PI;
    if (heading < 0) heading += 360;
  }
  if (heading !== null) {
    // P1: rotation is computed in SCREEN space (camera-basis projection),
    // not raw heading — raw heading is mirrored and camera-blind.
    a.courseDeg = heading;
    const proj = screenProjectedRotation(viewer.scene, a.billboard.position,
      heading, Number.isFinite(a.rotation) ? a.rotation : null);
    if (proj !== null) {
      a.billboard.rotation = proj;
      a.rotation = proj;
    }
  }
  a.prevLat = a.lat;
  a.prevLon = a.lon;
}

function cullHorizon() {
  if (!occluder) return;
  occluder.cameraPosition = viewer.scene.camera.positionWC;
  const fid = followedId();
  for (const a of aircraft.values()) {
    // F7: the tracked aircraft's fleet billboard stays hidden for the whole
    // follow (the tracked entity renders it) — a poll must not un-hide it.
    if (fid === `flight-${a.hex}`) continue;
    // Civilian traffic is zoom-gated (Joshua 2026-09-29); military is not.
    const layerOn = a.military ? milOn : (civOn && civZoomIn);
    const p = toCartesian(a.lat, a.lon, a.renderAltM ?? a.alt);
    a.billboard.show = layerOn && occluder.isPointVisible(p);
  }
}

let pollGen = 0;

async function poll() {
  const gen = ++pollGen;
  const jobs = [];
  if (milOn) jobs.push(
    fetch('/proxy/adsblol/mil').then((r) => r.json())
      .then((d) => ({ d, military: true, ok: true }))
      .catch((err) => ({ military: true, ok: false, err }))
  );
  if (civOn && civZoomIn) {
    const cam = viewer.scene.camera;
    const carto = Cesium.Ellipsoid.WGS84.cartesianToCartographic(cam.positionWC);
    const lat = (carto.latitude * 180) / Math.PI;
    const lon = (carto.longitude * 180) / Math.PI;
    jobs.push(
      fetch(`/proxy/adsblol/near?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&dist=250`)
        .then((r) => r.json())
        .then((d) => ({ d, military: false, ok: true }))
        .catch((err) => ({ military: false, ok: false, err }))
    );
  }
  if (!jobs.length) return;
  const results = await Promise.all(jobs);
  if (gen !== pollGen) return; // stale poll — a newer poll started, discard results
  const seen = new Set();
  let anyOk = false;
  for (const { d, military, ok, err } of results) {
    const key = military ? 'military' : 'civil';
    if (ok) {
      anyOk = true;
      feedStatus[key].lastOk = Date.now();
      feedStatus[key].lastErr = '';
    } else {
      feedStatus[key].lastErr = String((err && err.message) || err || 'fetch failed');
      console.warn(`[flights] ${key} poll failed:`, err);
      continue;
    }
    for (const ac of d.ac || []) {
      if (!ac.hex) continue;
      seen.add(ac.hex);
      upsert(ac, military);
    }
  }
  // If ALL feeds failed (network outage), skip cleanup entirely — don't
  // penalize existing aircraft for a connectivity blip. This prevents the
  // flicker where everything vanishes and reappears.
  if (!anyOk) return;
  // Drop aircraft that vanished from both feeds. Use a grace period of
  // 3 missed polls (~45s) to avoid flickering when the API is inconsistent.
  for (const [hex, a] of aircraft) {
    if (!seen.has(hex)) {
      a.missedPolls = (a.missedPolls || 0) + 1;
      if (a.missedPolls >= 3) {
        // F1: if the camera is following this aircraft, release the follow
        // BEFORE deleting it — otherwise the camera freezes on a ghost.
        if (followedId() === `flight-${hex}`) stopFollow('evicted');
        billboards.remove(a.billboard);
        aircraft.delete(hex);
      }
    } else {
      a.missedPolls = 0;
    }
  }
  cullHorizon();
}

function startLoop() {
  if (pollTimer || !(milOn || civOn)) return;
  ensureBillboards();
  holdContinuousRender('flights'); // keep animating while camera is parked
  let last = performance.now();
  let lastGateCheck = 0;
  let frameNo = 0;
  preRenderRemove = viewer.scene.preRender.addEventListener(() => {
    // The render loop is sacred: a throw here kills rendering app-wide and
    // pops Cesium's "Rendering has stopped" dialog. Never let per-frame work
    // propagate (2026-09-29: a fromDegrees arg-order bug did exactly that).
    try {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1);
      last = now;
      // Zoom gate for civilian traffic: check at 4 Hz, not every frame —
      // positionCartographic allocates and the gate only flips on zoom.
      if (now - lastGateCheck > 250) {
        lastGateCheck = now;
        refreshCivilGate();
      }
      // Interpolation factor: smooth over ~1.5s (frame-rate independent).
      const t = 1 - Math.pow(0.001, dt / 1.5);
      // Adaptive stride: with hundreds of aircraft in frame, updating every
      // plane every frame burns CPU for no visible gain (tiny icons at that
      // range). Update 1/stride of the fleet per frame, rotating which third
      // — motion stays smooth, cost stays flat. (Joshua 2026-09-29: zoomed-out
      // with both filters on bugged out.)
      const n = aircraft.size;
      const stride = n > 700 ? 3 : n > 350 ? 2 : 1;
      const slot = frameNo++ % stride;
      let i = 0;
      for (const a of aircraft.values()) {
        // Cheap true-position advance for everyone: poll-time horizon culling
        // reads a.lat/a.lon, so it must stay honest even for hidden planes.
        deadReckon(a, dt);
        if ((i++ % stride) !== slot) continue;
        // Hidden billboards aren't drawn — skip the trig + position write.
        // On re-show, the exponential smoothing below absorbs the gap in one
        // frame (t ≈ 0.99 after the 1 s dt clamp), so no visible jump.
        if (!a.billboard.show) continue;
        // Smoothly interpolate display position towards target.
        // This eliminates visible jumping when API updates arrive.
        if (Number.isFinite(a.dispLat)) {
          a.dispLat += (a.lat - a.dispLat) * t;
          a.dispLon += (a.lon - a.dispLon) * t;
        } else {
          a.dispLat = a.lat; a.dispLon = a.lon;
        }
        // Scratch position: assigning a fresh Cartesian3 per aircraft per frame
        // is hundreds of allocations/frame of pure GC pressure.
        a.billboard.position = toCartesian(a.dispLat, a.dispLon,
          a.renderAltM ?? a.alt, (a._pos ||= new Cesium.Cartesian3()));
      }
      // P1: screen-space icon orientation pass. Recompute when the camera
      // pose changed (the projection is camera-relative) or 1 s elapsed so
      // course changes still update while parked. Stabilized with a 0.5°
      // deadband; writes only on real change (no per-frame churn).
      const sig = cameraPoseSignature();
      if (sig !== lastCamSig || now - lastRotPass > 1000) {
        lastCamSig = sig;
        lastRotPass = now;
        const scene = viewer.scene;
        for (const a of aircraft.values()) {
          if (!a.billboard.show) continue;
          const prev = Number.isFinite(a.rotation) ? a.rotation : null;
          // S2: a.track is turn-evolved every frame by deadReckon, so the
          // icon follows the arc — not just the last reported heading.
          const course = Number.isFinite(a.track) ? a.track
            : Number.isFinite(a.courseDeg) ? a.courseDeg : 0;
          const next = screenProjectedRotation(scene, a.billboard.position,
            course, prev);
          const stable = stabilizeScreenRotation(prev, next);
          if (stable !== null && stable !== a.rotation) {
            a.billboard.rotation = stable;
            a.rotation = stable;
          }
        }
      }
    } catch (err) {
      console.error('[flights] interpolator error (render loop protected):', err);
    }
  });
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

// Camera-pose signature for the P1 orientation pass: the screen projection
// only needs recomputing when the camera actually moved. Rounded so parked
// sub-pixel jitter doesn't trigger a pass.
let lastCamSig = '';
let lastRotPass = 0;
function cameraPoseSignature() {
  const c = viewer.scene.camera;
  const p = c.positionWC;
  return p.x.toFixed(0) + ',' + p.y.toFixed(0) + ',' + p.z.toFixed(0) + ',' +
    c.heading.toFixed(3) + ',' + c.pitch.toFixed(3) + ',' + c.roll.toFixed(3);
}

function stopLoop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = 0;
  if (preRenderRemove) {
    preRenderRemove();
    preRenderRemove = null;
  }
  releaseContinuousRender('flights');
  // Don't clear aircraft data — keep it cached for instant re-show.
  // Billboards are hidden via show flag in setMilitary/setCivil.
}

export function militaryEnabled() { return milOn; }
export function civilEnabled() { return civOn; }
/** Per-feed aircraft count for the dock (true = military, false = civil). */
export function flightCountBy(military) {
  let n = 0;
  for (const a of aircraft.values()) if (!!a.military === military) n++;
  return n;
}
/** Get aircraft data by hex (for tap-to-info). */
export function getAircraft(hex) { return aircraft.get(hex) || null; }

export async function setMilitary(on) {
  milOn = on;
  if (!viewer) return milOn;
  if (milOn || civOn) startLoop(); else stopLoop();
  // Show/hide existing billboards instantly; only fetch if we have no data.
  let hasMil = false;
  for (const a of aircraft.values()) {
    if (a.military) { hasMil = true; a.billboard.show = on; }
  }
  // F2: layer turned off while tracking a military aircraft — release.
  if (!on) releaseFollowIf((a) => a.military, 'layer-off');
  if (milOn && !hasMil) poll();
  return milOn;
}

export async function setCivil(on) {
  civOn = on;
  if (!viewer) return civOn;
  if (milOn || civOn) startLoop(); else stopLoop();
  const gatePolled = refreshCivilGate(); // sync zoom state + visibility first
  // Show/hide existing billboards instantly; only fetch if we have no data.
  let hasCiv = false;
  for (const a of aircraft.values()) {
    if (!a.military) { hasCiv = true; a.billboard.show = on && civZoomIn; }
  }
  // F2: layer turned off while tracking a civil aircraft — release.
  if (!on) releaseFollowIf((a) => !a.military, 'layer-off');
  if (civOn && civZoomIn && !hasCiv && !gatePolled) poll();
  return civOn;
}

/** Re-apply horizon + layer visibility (restores the fleet billboard after follow release, F7). */
export function refreshAircraftVisibility() { cullHorizon(); }

export function initFlights(v) {
  viewer = v;
}
