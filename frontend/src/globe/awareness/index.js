/* Subject-centered proximity awareness (audit L1/T1, adapted from GEV's
   src/layers/awareness/ + militaryAwarenessEngine.js, collapsed to one module
   for CI's simpler architecture).

   Queries ONLY data CI already holds in memory — no new feeds, no network.
   HONESTY RULE: a source layer that is disabled or has never produced data is
   reported as unavailable/unknown — an empty result set is NEVER rendered as
   an "all clear" (GEV's never-answered predicate).
*/

import * as Cesium from 'cesium';
import {
  forEachAircraft,
  flightStatus,
  militaryEnabled,
} from '../flights/index.js';
import {
  forEachVessel,
  getVesselStatus,
  vesselsEnabled,
} from '../vessels/index.js';

/* ------------------------------------------------------------------ */
/* Installations: another worker is building frontend/src/globe/        */
/* installations/index.js with a forEachInstallation(cb) export. Until  */
/* it lands (or if the export is missing), treat installations as        */
/* UNAVAILABLE — never throw, never fake an all-clear.                 */
/* ------------------------------------------------------------------ */

let forEachInstallationFn = null;
let installationsWarm = false;

function warmInstallations() {
  if (installationsWarm) return;
  installationsWarm = true;
  import('../installations/index.js').then(
    (mod) => {
      if (mod && typeof mod.forEachInstallation === 'function') {
        forEachInstallationFn = mod.forEachInstallation;
      }
    },
    () => {
      forEachInstallationFn = null;
    },
  );
}
// Start the warm-up at module load; getProximity also re-kicks it.
warmInstallations();

/* ------------------------------------------------------------------ */
/* Geodesy                                                             */
/* ------------------------------------------------------------------ */

const R_KM = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from (lat1, lon1) to (lat2, lon2), degrees 0-360. */
export function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 8-wind compass label for a bearing in degrees. */
export function compassDir(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

const MAX_PER_CATEGORY = 20;

function sourceHonesty(enabled, lastOk) {
  // never-answered predicate: a layer that has never produced data has no
  // evidence to offer — report unavailable, never an empty all-clear.
  return enabled && lastOk > 0 ? 'ok' : 'unavailable';
}

function contactPos(c) {
  const lat = Number.isFinite(c.dispLat) ? c.dispLat : c.lat;
  const lon = Number.isFinite(c.dispLon) ? c.dispLon : c.lon;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/* ------------------------------------------------------------------ */
/* Query API                                                           */
/* ------------------------------------------------------------------ */

/**
 * Proximity cohorts around a subject point. Sorted by distKm, capped at 20
 * per category. `installations` is null when the installations module/export
 * is missing or has no data contract — check `states` for honesty.
 */
export function getProximity(lon, lat, radiusKm = 250) {
  warmInstallations();

  const flights = [];
  const fstat = (flightStatus() || {}).military || {};
  const flightsState = sourceHonesty(militaryEnabled(), fstat.lastOk);
  if (flightsState === 'ok') {
    forEachAircraft((a) => {
      if (!a.military) return;
      const p = contactPos(a);
      if (!p) return;
      const d = haversineKm(lat, lon, p.lat, p.lon);
      if (d > radiusKm) return;
      flights.push({
        hex: a.hex,
        label: a.label || a.hex,
        distKm: Math.round(d * 10) / 10,
        bearingDeg: Math.round(initialBearingDeg(lat, lon, p.lat, p.lon) * 10) / 10,
        military: true,
      });
    });
  }

  const vessels = [];
  const vstat = getVesselStatus() || {};
  const vesselsState = sourceHonesty(vesselsEnabled(), vstat.lastOk);
  if (vesselsState === 'ok') {
    forEachVessel((v) => {
      const p = contactPos(v);
      if (!p) return;
      const d = haversineKm(lat, lon, p.lat, p.lon);
      if (d > radiusKm) return;
      vessels.push({
        mmsi: v.mmsi,
        name: v.name || v.mmsi,
        distKm: Math.round(d * 10) / 10,
        bearingDeg: Math.round(initialBearingDeg(lat, lon, p.lat, p.lon) * 10) / 10,
      });
    });
  }

  let installations = null;
  let installationsState = 'unavailable';
  if (forEachInstallationFn) {
    installations = [];
    try {
      forEachInstallationFn((i) => {
        const ilat = Number(i.lat);
        const ilon = Number(i.lon);
        if (!Number.isFinite(ilat) || !Number.isFinite(ilon)) return;
        const d = haversineKm(lat, lon, ilat, ilon);
        if (d > radiusKm) return;
        installations.push({
          name: i.name || i.label || 'Installation',
          distKm: Math.round(d * 10) / 10,
          bearingDeg: Math.round(initialBearingDeg(lat, lon, ilat, ilon) * 10) / 10,
        });
      });
      installationsState = 'ok';
    } catch (e) {
      installations = null;
      installationsState = 'unavailable';
    }
  }

  flights.sort((x, y) => x.distKm - y.distKm);
  vessels.sort((x, y) => x.distKm - y.distKm);
  if (installations) installations.sort((x, y) => x.distKm - y.distKm);

  return {
    flights: flights.slice(0, MAX_PER_CATEGORY),
    vessels: vessels.slice(0, MAX_PER_CATEGORY),
    installations: installations ? installations.slice(0, MAX_PER_CATEGORY) : null,
    states: {
      flights: flightsState,
      vessels: vesselsState,
      installations: installationsState,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Card HTML                                                           */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? '').replace(
    /[&<>'"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]),
  );
}

const PAGE_SIZE = 3;
let htmlUid = 0;

function categorySection(title, entries, state, formatRow) {
  const uid = `awr-${++htmlUid}`;
  let body;
  if (state !== 'ok') {
    body = `<p class="awr-unavail">Data unavailable — not a clear area.</p>`;
  } else if (!entries.length) {
    body = `<p class="awr-none">None within 250 km.</p>`;
  } else {
    const rowHtml = (e) =>
      `<li><b>${esc(formatRow(e).label)}</b> <span>${esc(formatRow(e).dist)}</span></li>`;
    const first = entries.slice(0, PAGE_SIZE).map(rowHtml).join('');
    const rest = entries.slice(PAGE_SIZE).map(rowHtml).join('');
    const more = rest
      ? `<details class="awr-more"><summary>Show all ${entries.length} ▸</summary><ul class="awr-list">${rest}</ul></details>`
      : '';
    body = `<ul class="awr-list">${first}</ul>${more}`;
  }
  return `<section class="awr-section" id="${uid}">
    <h4>${esc(title)}${state === 'ok' && entries.length ? ` <span class="awr-count">${entries.length}</span>` : ''}</h4>
    ${body}
  </section>`;
}

const fmtDist = (e) =>
  `${e.distKm < 10 ? e.distKm.toFixed(1) : Math.round(e.distKm)} km ${compassDir(e.bearingDeg)}`;

/**
 * HTML string for the event card: a "NEARBY ASSETS" section with the 3
 * nearest contacts per category (distance + compass direction), plus a
 * native "Show all N" expander per category. Unavailable sources are labeled
 * as such — never rendered as "all clear". No JS: safe to inject via
 * innerHTML (<details> needs none).
 */
export function renderProximityHTML(lon, lat) {
  const p = getProximity(lon, lat);
  const row = (labelOf) => (e) => ({ label: labelOf(e), dist: fmtDist(e) });
  const html = `<div class="awr">
  <h3>NEARBY ASSETS</h3>
  <p class="awr-sub">within 250 km of subject</p>
  ${categorySection('MILITARY FLIGHTS', p.flights, p.states.flights, row((e) => e.label))}
  ${categorySection('VESSELS', p.vessels, p.states.vessels, row((e) => e.name))}
  ${categorySection('MILITARY INSTALLATIONS', p.installations || [], p.states.installations, row((e) => e.name))}
  <p class="awr-note">Missing broadcasts, unloaded map areas, or unmapped sites are not evidence of absence.</p>
</div>`;
  return html;
}

/* ------------------------------------------------------------------ */
/* Screen-space direction arrows                                       */
/* ------------------------------------------------------------------ */

let viewer = null;
let subject = null;
let cameraListener = null;
let lastArrowUpdateMs = 0;
let overlayRoot = null;
const ARROW_CHIPS = 3;
const ARROW_THROTTLE_MS = 200;

function ensureOverlay() {
  if (overlayRoot) return overlayRoot;
  const root = document.createElement('div');
  root.className = 'awr-overlay';
  root.setAttribute('aria-hidden', 'true');
  root.hidden = true;
  root.style.cssText =
    'position:absolute;inset:0;pointer-events:none;z-index:5;overflow:hidden;';
  const chips = [];
  for (let i = 0; i < ARROW_CHIPS; i++) {
    const chip = document.createElement('div');
    chip.style.cssText =
      'position:absolute;left:0;top:0;transform:translate(-50%,-50%);' +
      'background:rgba(10,14,20,0.78);border:1px solid rgba(255,179,71,0.65);' +
      'border-radius:4px;padding:2px 6px;font:10px/1.5 system-ui,sans-serif;' +
      'color:#ffd9a0;white-space:nowrap;';
    const arrow = document.createElement('span');
    arrow.textContent = '➤';
    arrow.style.display = 'inline-block';
    arrow.style.marginRight = '4px';
    const text = document.createElement('span');
    chip.append(arrow, text);
    chip.hidden = true;
    root.appendChild(chip);
    chips.push({ chip, arrow, text });
  }
  viewer.container.appendChild(root);
  overlayRoot = root;
  overlayRoot._chips = chips;
  return root;
}

/** 3 nearest military contacts (military flights + installations). */
function nearestMilitaryContacts() {
  if (!subject) return [];
  const p = getProximity(subject.lon, subject.lat);
  const out = [];
  for (const e of p.flights) {
    out.push({ label: e.label, distKm: e.distKm, bearingDeg: e.bearingDeg });
  }
  if (p.installations) {
    for (const e of p.installations) {
      out.push({ label: e.name, distKm: e.distKm, bearingDeg: e.bearingDeg });
    }
  }
  out.sort((a, b) => a.distKm - b.distKm);
  return out.slice(0, ARROW_CHIPS);
}

function updateArrows() {
  const root = ensureOverlay();
  if (!viewer || !subject) {
    root.hidden = true;
    return;
  }
  const contacts = nearestMilitaryContacts();
  const w = viewer.container.clientWidth || 1;
  const h = viewer.container.clientHeight || 1;
  const cx = w / 2;
  const cy = h / 2;
  const rim = Math.min(w, h) * 0.38;
  const cam = viewer.camera;
  const chips = root._chips;
  root.hidden = false;
  for (let i = 0; i < chips.length; i++) {
    const { chip, arrow, text } = chips[i];
    const c = contacts[i];
    if (!c) {
      chip.hidden = true;
      continue;
    }
    // Screen-space direction from the subject toward the contact, projected
    // onto the camera's right/up axes — valid whether the contact is
    // on-screen or far off it.
    const subCart = Cesium.Cartesian3.fromDegrees(subject.lon, subject.lat);
    const brg = Cesium.Math.toRadians(c.bearingDeg);
    const contactCart = Cesium.Cartesian3.fromDegrees(
      subject.lon + Math.sin(brg) * (c.distKm / 111.32),
      subject.lat + Math.cos(brg) * (c.distKm / 110.57),
    );
    const dir = Cesium.Cartesian3.subtract(contactCart, subCart, new Cesium.Cartesian3());
    Cesium.Cartesian3.normalize(dir, dir);
    const x = Cesium.Cartesian3.dot(dir, cam.rightWC);
    const y = Cesium.Cartesian3.dot(dir, cam.upWC);
    const ang = Math.atan2(-y, x); // screen space: y is down
    const px = cx + Math.cos(ang) * rim;
    const py = cy + Math.sin(ang) * rim;
    chip.style.left = `${px}px`;
    chip.style.top = `${py}px`;
    arrow.style.transform = `rotate(${ang}rad)`;
    text.textContent = `${c.label} · ${c.distKm < 10 ? c.distKm.toFixed(1) : Math.round(c.distKm)} km`;
    chip.hidden = false;
  }
}

/** Store the viewer ref; no-op otherwise. */
export function initAwareness(v) {
  viewer = v || null;
  warmInstallations();
}

/**
 * Point the 3 direction arrows at the 3 nearest military contacts around the
 * subject. Registers one throttled camera.changed listener; call
 * clearAwarenessSubject() to remove it.
 */
export function setAwarenessSubject(lon, lat, label) {
  clearAwarenessSubject();
  if (!viewer || !Number.isFinite(lon) || !Number.isFinite(lat)) return;
  subject = { lon, lat, label: label || '' };
  ensureOverlay();
  const onChange = () => {
    const now = performance.now();
    if (now - lastArrowUpdateMs < ARROW_THROTTLE_MS) return;
    lastArrowUpdateMs = now;
    updateArrows();
  };
  viewer.camera.changed.addEventListener(onChange);
  cameraListener = onChange;
  updateArrows();
}

/** Remove the arrows and their camera listener (no leaks). */
export function clearAwarenessSubject() {
  if (viewer && cameraListener) {
    try {
      viewer.camera.changed.removeEventListener(cameraListener);
    } catch (e) {
      /* listener already gone */
    }
  }
  cameraListener = null;
  subject = null;
  lastArrowUpdateMs = 0;
  if (overlayRoot) overlayRoot.hidden = true;
}
