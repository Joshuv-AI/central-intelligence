/* Floating detail card (marker click) + lightweight hover preview (desktop).
   The card tracks its marker via postRender projection; it never takes a rail. */
import * as Cesium from 'cesium';
import { store, on, emit, DOMAIN_LABELS } from '../data/store.js';
import { getViewer } from '../globe/viewer.js';
import { pickAt, screenPositionOf } from '../globe/markers.js';
import { esc, fmtDateTime, fmtCoords } from '../data/format.js';
import { startFollow, stopFollow } from '../globe/aircraft/followMode.js';
import { getAircraft, refreshAircraftVisibility } from '../globe/flights/index.js';
import { createOrbitRings } from '../globe/satellites/orbitRings.js';
import { renderProximityHTML, setAwarenessSubject, clearAwarenessSubject } from '../globe/awareness/index.js';

let orbitRings = null; // lazy-init on first satellite card (audit 1.14)
let ringedNoradId = null;
let ringTickTimer = null; // 2s Earth-rotation tick while a ring is visible

let cardEl, tipEl;
let openEventId = null;
let anchorCartesian = null;
let postRenderHandler = null;
let hoverRaf = 0;
let lastHover = 0;
// Scratch for the follow-mode position provider (P3): reused every frame,
// never allocated per frame.
const _followPos = new Cesium.Cartesian3();

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

export function isCardOpen() { return openEventId !== null; }

export function openEventCard(eventId, clientX, clientY) {
  const e = store.eventById(eventId);
  if (!e || !cardEl) return;
  openEventId = eventId;
  renderCard(e);
  if (Number.isFinite(e.lat) && Number.isFinite(e.lon)) setAwarenessSubject(e.lon, e.lat, e.title);
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');

  // Anchor: use the click point first, then track the marker each frame.
  const viewer = getViewer();
  anchorCartesian = e && Number.isFinite(e.lon) && Number.isFinite(e.lat)
    ? Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 0)
    : null;
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId });
}

/** Open a detail card for an earthquake (tap on quake marker). */
export function openQuakeCard(q, clientX, clientY) {
  if (!q || !cardEl) return;
  openEventId = `quake-${q.id}`;
  const when = q.time ? fmtDateTime(new Date(q.time)) : 'Unknown time';
  const where = `${q.lat.toFixed(3)}°, ${q.lon.toFixed(3)}°`;
  const depth = q.depthKm != null ? `${Number(q.depthKm).toFixed(1)} km` : '?';
  cardEl.className = 'sev-moderate';
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>EARTHQUAKE</div>
    <h3 class="card-title">M${Number(q.mag).toFixed(1)} — ${esc(q.place || 'unknown location')}</h3>
    <div class="card-fields">
      <div class="card-field"><span class="k">Magnitude</span><span class="v">${Number(q.mag).toFixed(1)}</span></div>
      <div class="card-field"><span class="k">Depth</span><span class="v">${esc(depth)}</span></div>
      <div class="card-field"><span class="k">Location</span><span class="v">${esc(where)}</span></div>
      <div class="card-field"><span class="k">Time</span><span class="v">${esc(when)}</span></div>
      <div class="card-field"><span class="k">Source</span><span class="v">USGS</span></div>
    </div>`;
  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');
  const viewer = getViewer();
  anchorCartesian = Cesium.Cartesian3.fromDegrees(q.lon, q.lat, 0);
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId: openEventId });
}

/** Open a detail card for a public camera (tap on camera marker). */
export function openCameraCard(cam, clientX, clientY) {
  if (!cam || !cardEl) return;
  openEventId = `cam-${cam.id}`;
  const where = `${cam.lat.toFixed(3)}°, ${cam.lon.toFixed(3)}°`;
  const loc = [cam.city, cam.country].filter(Boolean).join(', ');
  // Free-tier term: thumbnails link out to windy.com.
  const thumb = cam.thumbnailUrl
    ? `<a class="card-cam-thumb" href="${esc(cam.windyUrl)}" target="_blank" rel="noopener"><img src="${esc(cam.thumbnailUrl)}" alt="${esc(cam.title || 'Public camera')}" loading="lazy"></a>`
    : '';
  const player = cam.playerEmbedUrl
    ? `<iframe class="card-cam-player" src="${esc(cam.playerEmbedUrl)}" width="300" height="169" allowfullscreen loading="lazy" title="${esc(cam.title || 'Public camera')}"></iframe>`
    : '';
  cardEl.className = 'sev-low';
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>PUBLIC CAMERA</div>
    <h3 class="card-title">${esc(cam.title || 'Public camera')}</h3>
    ${thumb}
    <div class="card-fields">
      ${loc ? `<div class="card-field"><span class="k">Location</span><span class="v">${esc(loc)}</span></div>` : ''}
      <div class="card-field"><span class="k">Coordinates</span><span class="v">${esc(where)}</span></div>
      ${cam.status ? `<div class="card-field"><span class="k">Status</span><span class="v">${esc(cam.status)}</span></div>` : ''}
      <div class="card-field"><span class="k">Source</span><span class="v">Imagery: Windy.com</span></div>
    </div>
    ${player}
    ${cam.windyUrl ? `<a class="card-src" href="${esc(cam.windyUrl)}" target="_blank" rel="noopener">View on Windy →</a>` : ''}`;
  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');
  const viewer = getViewer();
  anchorCartesian = Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, 0);
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId: openEventId });
}

/** Open a detail card for a datacenter (tap on datacenter dot). */
export function openDatacenterCard(dc, clientX, clientY) {
  if (!dc || !cardEl) return;
  openEventId = `dc-${dc.idx}`;
  const where = `${dc.lat.toFixed(3)}°, ${dc.lon.toFixed(3)}°`;
  cardEl.className = 'sev-moderate';
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>DATACENTER</div>
    <h3 class="card-title">${esc(dc.name || 'Datacenter')}</h3>
    <div class="card-fields">
      <div class="card-field"><span class="k">Operator</span><span class="v">${esc(dc.operator || 'Unknown')}</span></div>
      <div class="card-field"><span class="k">Location</span><span class="v">${esc(where)}</span></div>
      <div class="card-field"><span class="k">Source</span><span class="v">OpenStreetMap</span></div>
    </div>`;
  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');
  const viewer = getViewer();
  anchorCartesian = Cesium.Cartesian3.fromDegrees(dc.lon, dc.lat, 0);
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId: openEventId });
}

/** Open a detail card for a military installation (tap on marker or footprint). */
export function openInstallationCard(inst, clientX, clientY) {
  if (!inst || !cardEl) return;
  openEventId = `mil-${inst.id}`;
  const where = `${inst.lat.toFixed(3)}°, ${inst.lon.toFixed(3)}°`;
  const area = inst.areaKm2 > 0.01 ? `≈ ${inst.areaKm2.toFixed(1)} km²` : '—';
  cardEl.className = 'sev-moderate';
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>MILITARY INSTALLATION</div>
    <h3 class="card-title">Military installation</h3>
    <div class="card-fields">
      <div class="card-field"><span class="k">Location</span><span class="v">${esc(where)}</span></div>
      <div class="card-field"><span class="k">Footprint</span><span class="v">${esc(area)}</span></div>
      <div class="card-field"><span class="k">Source</span><span class="v">OpenFreeMap / OSM</span></div>
    </div>`;
  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');
  const viewer = getViewer();
  anchorCartesian = Cesium.Cartesian3.fromDegrees(inst.lon, inst.lat, 0);
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId: openEventId });
}

/** Open a detail card for a flight (tap on aircraft billboard). */
/** Open a detail card for a rocket launch (tap on the pad marker). */
export function openLaunchCard(l, clientX, clientY) {
  if (!l || !cardEl) return;
  openEventId = `launch-${l.id}`;
  const where = `${l.lat.toFixed(3)}°, ${l.lon.toFixed(3)}°`;
  let net = 'TBD';
  if (l.net) {
    const ms = new Date(l.net).getTime() - Date.now();
    if (Number.isFinite(ms)) {
      if (ms < 0) net = 'Launched';
      else {
        const d = Math.floor(ms / 86400000);
        const h = Math.floor((ms % 86400000) / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        net = d > 0 ? `T-${d}d ${h}h` : `T-${h}h ${m}m`;
      }
    }
  }
  const agencyRow = l.agency ? `<div class="card-field"><span class="k">Agency</span><span class="v">${esc(l.agency)}</span></div>` : '';
  const missionRow = l.mission ? `<div class="card-field"><span class="k">Mission</span><span class="v">${esc(l.mission)}</span></div>` : '';
  const padRow = l.pad ? `<div class="card-field"><span class="k">Pad</span><span class="v">${esc(l.pad)}</span></div>` : '';
  cardEl.className = 'sev-moderate';
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>ROCKET LAUNCH</div>
    <h3 class="card-title">${esc(l.name || 'Launch')}</h3>
    <div class="card-fields">
      <div class="card-field"><span class="k">Countdown</span><span class="v mono">${esc(net)}</span></div>
      <div class="card-field"><span class="k">Rocket</span><span class="v">${esc(l.rocket || 'Unknown')}</span></div>
      ${missionRow}
      ${agencyRow}
      ${padRow}
      <div class="card-field"><span class="k">Status</span><span class="v">${esc(l.status || 'Unknown')}</span></div>
      <div class="card-field"><span class="k">Location</span><span class="v">${esc(where)}</span></div>
      <div class="card-field"><span class="k">Source</span><span class="v">The Space Devs</span></div>
    </div>`;
  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');
  const viewer = getViewer();
  anchorCartesian = Cesium.Cartesian3.fromDegrees(l.lon, l.lat, 0);
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId: openEventId });
}

export function openFlightCard(a, clientX, clientY) {
  if (!a || !cardEl) return;
  // Use a synthetic ID so closeEventCard works.
  openEventId = `flight-${a.hex}`;
  const altFt = a.alt > 0 ? Math.round(a.alt * 3.28084) : 0;
  const spdKt = Number.isFinite(a.gs) ? Math.round(a.gs) : null;
  const hdg = Number.isFinite(a.track) ? Math.round(a.track) : null;
  // F4: a.lon may be antimeridian-unwrapped (±360) for interpolation —
  // normalize back to ±180 for display.
  const dispLon = ((a.lon + 540) % 360) - 180;
  const where = `${a.lat.toFixed(3)}°, ${dispLon.toFixed(3)}°`;
  // Enrichment fields (audit 1.9): type, vertical rate, squawk, emergency, data age.
  const typeRow = a.typeCode ? `<div class="card-field"><span class="k">Type</span><span class="v mono">${esc(a.typeCode)}</span></div>` : '';
  const vsRow = Number.isFinite(a.vertRateFpm) && a.vertRateFpm !== 0
    ? `<div class="card-field"><span class="k">Vert rate</span><span class="v">${a.vertRateFpm > 0 ? '+' : ''}${Math.round(a.vertRateFpm).toLocaleString()} fpm</span></div>` : '';
  const squawkRow = a.squawk ? `<div class="card-field"><span class="k">Squawk</span><span class="v mono">${esc(a.squawk)}${a.emergency && a.emergency !== 'none' ? ' ⚠ ' + esc(a.emergency.toUpperCase()) : ''}</span></div>` : '';
  const ageSec = Number.isFinite(a.seenPosSec) ? a.seenPosSec
    : Number.isFinite(a.seenSec) ? a.seenSec : NaN;
  const ageRow = Number.isFinite(ageSec)
    ? `<div class="card-field"><span class="k">Data age</span><span class="v">${ageSec < 60 ? Math.round(ageSec) + 's' : Math.round(ageSec / 60) + 'm'}${a.stale ? ' · stale' : ''}</span></div>` : '';
  cardEl.className = a.military ? 'sev-high' : 'sev-low';
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>${a.military ? 'MILITARY' : 'CIVIL'} AIRCRAFT</div>
    <h3 class="card-title">${esc(a.label || a.hex)}</h3>
    <div class="card-fields">
      <div class="card-field"><span class="k">Hex</span><span class="v mono">${esc(a.hex)}</span></div>
      <div class="card-field"><span class="k">Position</span><span class="v">${esc(where)}</span></div>
      ${altFt ? `<div class="card-field"><span class="k">Altitude</span><span class="v">${altFt.toLocaleString()} ft</span></div>` : ''}
      ${spdKt !== null ? `<div class="card-field"><span class="k">Speed</span><span class="v">${spdKt} kt</span></div>` : ''}
      ${hdg !== null ? `<div class="card-field"><span class="k">Heading</span><span class="v">${hdg}°</span></div>` : ''}
      ${typeRow}${vsRow}${squawkRow}${ageRow}
    </div>
    <button class="card-track-btn" data-hex="${esc(a.hex)}">TRACK</button>`;
  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  // TRACK button: follow-mode with generation-stamped camera (audit 1.8).
  const trackBtn = cardEl.querySelector('.card-track-btn');
  if (trackBtn) {
    trackBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const viewer = getViewer();
      // Pass the actual aircraft silhouette and tint — without these,
      // follow mode renders a default cyan square (audit 2026-09-29).
      // F7: hide the fleet billboard while tracked so the plane isn't
      // double-rendered; onRelease restores it via refreshAircraftVisibility.
      // P3: the follow position is computed inline from the per-frame
      // dead-reckoned (lat, lon, renderAltM) — not the chased billboard
      // position — so it never lags behind the interpolation stride and
      // keeps working while the fleet billboard is hidden.
      const hex = a.hex;
      const ok = startFollow(`flight-${hex}`, () => {
        const fa = getAircraft(hex);
        if (!fa) { stopFollow('evicted'); return null; }
        return Cesium.Cartesian3.fromDegrees(fa.lon, fa.lat,
          Math.max(fa.renderAltM ?? fa.alt ?? 0, 0), undefined, _followPos);
      }, {
        viewer,
        image: a.billboard.image,
        color: a.billboard.color,
        width: 64,
        altitudeM: a.alt, // meters — calibrates the viewFrom range
        getCourseDeg: () => {
          const fa = getAircraft(hex);
          if (!fa) return NaN;
          // S2: track is turn-evolved per frame; fall back to last known course.
          return Number.isFinite(fa.track) ? fa.track
            : Number.isFinite(fa.courseDeg) ? fa.courseDeg : NaN;
        },
        onRelease: () => { refreshAircraftVisibility(); },
      });
      if (ok) {
        a.billboard.show = false;
        trackBtn.textContent = 'TRACKING…';
      }
    });
  }
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');
  const viewer = getViewer();
  anchorCartesian = Cesium.Cartesian3.fromDegrees(a.lon, a.lat, a.alt || 0);
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId: openEventId });
}

/** Open a detail card for a vessel (tap on vessel billboard). */
export function openVesselCard(v, clientX, clientY) {
  if (!v || !cardEl) return;
  // Use a synthetic ID so closeEventCard works.
  openEventId = `vessel-${v.mmsi}`;
  const sog = Number.isFinite(v.sog) ? `${v.sog.toFixed(1)} kt` : '—';
  const cog = Number.isFinite(v.cog) ? `${Math.round(v.cog)}°` : '—';
  const hdg = Number.isFinite(v.heading) ? `${Math.round(v.heading)}°` : '—';
  const ageMs = Number.isFinite(v.lastUpdate) ? Date.now() - v.lastUpdate : NaN;
  const age = Number.isFinite(ageMs)
    ? (ageMs < 60000
      ? `${Math.max(0, Math.round(ageMs / 1000))}s ago`
      : `${Math.round(ageMs / 60000)}m ago`)
    : '—';
  const lat = Number.isFinite(v.dispLat) ? v.dispLat : v.lat;
  const lon = Number.isFinite(v.dispLon) ? v.dispLon : v.lon;
  cardEl.className = 'sev-low';
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>VESSEL · AIS</div>
    <h3 class="card-title">${esc(v.name || `MMSI ${v.mmsi}`)}</h3>
    <div class="card-fields">
      <div class="card-field"><span class="k">MMSI</span><span class="v mono">${esc(String(v.mmsi))}</span></div>
      <div class="card-field"><span class="k">Position</span><span class="v">${esc(fmtCoords(lat, lon))}</span></div>
      ${v.type ? `<div class="card-field"><span class="k">Type</span><span class="v">${esc(v.type)}</span></div>` : ''}
      <div class="card-field"><span class="k">SOG</span><span class="v">${esc(sog)}</span></div>
      <div class="card-field"><span class="k">COG</span><span class="v">${esc(cog)}</span></div>
      ${hdg !== '—' ? `<div class="card-field"><span class="k">Heading</span><span class="v">${esc(hdg)}</span></div>` : ''}
      ${v.navStatus ? `<div class="card-field"><span class="k">Nav status</span><span class="v">${esc(v.navStatus)}</span></div>` : ''}
      <div class="card-field"><span class="k">Data age</span><span class="v">${esc(age)}</span></div>
      <div class="card-field"><span class="k">Source</span><span class="v">AISStream via server hub</span></div>
    </div>`;
  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');
  const viewer = getViewer();
  anchorCartesian = (Number.isFinite(lat) && Number.isFinite(lon))
    ? Cesium.Cartesian3.fromDegrees(lon, lat, 0)
    : null;
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId: openEventId });
}

export function openSatelliteCard(s, clientX, clientY) {
  if (!s || !cardEl) return;
  openEventId = `sat-${s.noradId}`;
  // Get current position from billboard.
  let where = '—';
  let altKm = null;
  if (s.billboard && s.billboard.position) {
    try {
      const carto = Cesium.Cartographic.fromCartesian(s.billboard.position);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      where = `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
      altKm = Math.round(carto.height / 1000);
      anchorCartesian = s.billboard.position;
    } catch { /* ignore */ }
  }
  cardEl.className = 'sev-low';
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>SATELLITE</div>
    <h3 class="card-title">${esc(s.name)}</h3>
    <div class="card-fields">
      <div class="card-field"><span class="k">NORAD ID</span><span class="v mono">${esc(String(s.noradId))}</span></div>
      <div class="card-field"><span class="k">Group</span><span class="v">${esc(s.group)}</span></div>
      <div class="card-field"><span class="k">Position</span><span class="v">${esc(where)}</span></div>
      ${altKm !== null ? `<div class="card-field"><span class="k">Altitude</span><span class="v">${altKm.toLocaleString()} km</span></div>` : ''}
      <div class="card-field"><span class="k">Inclination</span><span class="v">${esc(s.inclination)}</span></div>
      <div class="card-field"><span class="k">Source</span><span class="v">CelesTrak TLE</span></div>
    </div>`;
  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  // Flicker-free orbit ring (audit 1.14): show on card open, hide on close.
  const viewer = getViewer();
  if (s.satrec && viewer) {
    if (!orbitRings) orbitRings = createOrbitRings(viewer);
    if (ringedNoradId && ringedNoradId !== String(s.noradId)) {
      orbitRings.hide(ringedNoradId);
    }
    orbitRings.show(String(s.noradId), s.satrec, { color: '#67e8f9' });
    ringedNoradId = String(s.noradId);
    // Keep the ring aligned with Earth's rotation while visible (audit 1.14).
    if (!ringTickTimer) {
      ringTickTimer = setInterval(() => {
        try { orbitRings.tick(new Date()); } catch { /* ring torn down */ }
      }, 2000);
    }
  }
  cardEl.classList.remove('hidden');
  void cardEl.offsetWidth;
  cardEl.classList.add('open');
  if (!isMobile()) {
    placeCard(clientX, clientY);
    startTracking();
  }
  emit('card-opened', { eventId: openEventId });
}

export function closeEventCard() {
  if (!openEventId) return;
  // Hide the orbit ring if a satellite card was open (audit 1.14).
  if (openEventId.startsWith('sat-') && orbitRings && ringedNoradId) {
    orbitRings.hide(ringedNoradId);
    ringedNoradId = null;
    // No rings visible — stop the rotation tick (audit 1.14).
    if (ringTickTimer) {
      clearInterval(ringTickTimer);
      ringTickTimer = null;
    }
  }
  // Stop follow mode if a flight card was open (audit 1.8).
  if (openEventId.startsWith('flight-')) {
    stopFollow('card-closed');
  }
  openEventId = null;
  anchorCartesian = null;
  stopTracking();
  clearAwarenessSubject();
  if (cardEl) {
    cardEl.classList.remove('open');
    setTimeout(() => { if (!openEventId) cardEl.classList.add('hidden'); }, 220);
  }
  emit('card-closed', null);
}

function renderCard(e) {
  const severity = e.severity || 'low';
  const conns = store.connectionsForEvent(e.id);
  const where = [e.region, fmtCoords(e.lat, e.lon)].filter((v) => v && v !== '—').join(' · ') || '—';
  cardEl.className = `sev-${severity}`;
  cardEl.innerHTML = `
    <button class="card-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="card-kind"><span class="kind-dot"></span>${esc((DOMAIN_LABELS[e.domain] || e.domain || 'SIGNAL').toUpperCase())} · ${esc(severity.toUpperCase())}</div>
    <h3 class="card-title">${esc(e.title)}</h3>
    <div class="card-fields">
      <div class="card-field"><span class="k">Where</span><span class="v">${esc(where)}</span></div>
      <div class="card-field"><span class="k">When</span><span class="v">${esc(fmtDateTime(e.time))}</span></div>
      <div class="card-field"><span class="k">Source</span><span class="v">${esc(e.source || '—')}</span></div>
      ${e.attribution ? `<div class="card-field"><span class="k">Credit</span><span class="v dim">${esc(e.attribution)}</span></div>` : ''}
    </div>
    ${e.summary ? `<p class="card-summary">${esc(e.summary)}</p>` : ''}
    ${conns.length ? `
      <div class="card-links">
        <span class="micro">LINKED CONNECTIONS</span>
        ${conns.map((c) => `<button class="card-conn" data-conn-id="${esc(c.id)}">${esc(c.title)}</button>`).join('')}
      </div>` : ''}
    ${Number.isFinite(e.lat) && Number.isFinite(e.lon) ? renderProximityHTML(e.lon, e.lat) : ''}
    ${e.url ? `<a class="card-src" href="${esc(e.url)}" target="_blank" rel="noopener">SOURCE →</a>` : ''}`;

  cardEl.querySelector('.card-close').addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeEventCard();
  });
  cardEl.querySelectorAll('.card-conn').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeEventCard();
      emit('focus-connection', { connectionId: btn.dataset.connId });
    });
  });
}

function placeCard(x, y) {
  const pad = 16;
  const w = cardEl.offsetWidth || 300;
  const h = cardEl.offsetHeight || 200;
  let left = x + 18;
  let top = y - h / 2;
  if (left + w > window.innerWidth - pad) left = x - w - 18;
  if (top < pad) top = pad;
  if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
  cardEl.style.left = `${Math.max(pad, left)}px`;
  cardEl.style.top = `${Math.max(pad, top)}px`;
}

function startTracking() {
  stopTracking();
  const viewer = getViewer();
  if (!viewer) return;
  postRenderHandler = () => {
    if (!openEventId || !anchorCartesian) return;
    const p = screenPositionOf(anchorCartesian);
    if (!p) {
      cardEl.style.opacity = '0';
      return;
    }
    cardEl.style.opacity = '';
    placeCard(p.x, p.y);
  };
  viewer.scene.postRender.addEventListener(postRenderHandler);
}

function stopTracking() {
  const viewer = getViewer();
  if (viewer && postRenderHandler) {
    viewer.scene.postRender.removeEventListener(postRenderHandler);
  }
  postRenderHandler = null;
}

/* ——— hover preview (desktop, throttled, lightweight) ——— */
function onMouseMove(ev) {
  if (isMobile() || openEventId) { hideTip(); return; }
  const now = performance.now();
  if (now - lastHover < 90 || hoverRaf) return;
  lastHover = now;
  const { clientX, clientY } = ev;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    try {
      const hit = pickAt(clientX, clientY);
      if (!hit || hit.type === 'cluster') { hideTip(); return; }
      const e = hit.type === 'event'
        ? store.eventById(hit.eventId)
        : null;
      if (hit.type === 'connection') {
        const c = store.connectionById(hit.connectionId);
        if (c) showTip(clientX, clientY, c.title, `CORRELATION · ${c.severity || ''}`, c.severity);
        else hideTip();
        return;
      }
      if (e) showTip(clientX, clientY, e.title, `${e.domain || ''} · ${e.severity || ''}`, e.severity);
      else hideTip();
    } catch { hideTip(); }
  });
}

function showTip(x, y, title, sub, severity) {
  tipEl.className = `sev-${severity || 'low'} open`;
  tipEl.innerHTML = `<div class="tip-title">${esc(title)}</div><div class="tip-sub">${esc(sub)}</div>`;
  const w = 260;
  let left = x + 16;
  if (left + w > window.innerWidth - 12) left = x - w - 16;
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${Math.min(window.innerHeight - 90, y + 14)}px`;
}

function hideTip() {
  if (tipEl) tipEl.classList.remove('open');
}

export function initCards() {
  cardEl = document.getElementById('detail-card');
  tipEl = document.getElementById('hover-tip');
  if (!cardEl) return;

  const globe = document.getElementById('globe-container');
  if (globe && window.matchMedia('(pointer: fine)').matches) {
    globe.addEventListener('mousemove', onMouseMove);
    globe.addEventListener('mouseleave', hideTip);
  }

  on('close-panels', closeEventCard);
  on('data', () => {
    // If the open event vanished from state, close quietly.
    // (Flight and vessel cards use synthetic 'flight-<hex>' / 'vessel-<mmsi>'
    // IDs — leave them alone.)
    const idStr = String(openEventId);
    if (openEventId && !idStr.startsWith('flight-') && !idStr.startsWith('vessel-') && !store.eventById(openEventId)) closeEventCard();
  });
}
