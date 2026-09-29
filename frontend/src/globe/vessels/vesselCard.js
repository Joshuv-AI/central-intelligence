/* Selected-vessel card content.
   Mirrors God's Eye View src/layers/vessels/cards.js (MIT) in spirit:
   a protected selected-vessel card with type accent, live kinematics,
   and honest "last update" age. Card chrome is owned by ui/cards.js;
   this module builds the field rows. */

import { normalizeVesselType, accentForVesselType } from './vesselTypes.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/**
 * Build the card-field rows HTML for a CI vessel record.
 * @param {object} v - vessel record: { mmsi, name, lat, lon, sog, cog,
 *   heading, type, navStatus, lastUpdate, stale }
 */
export function vesselCardFieldsHtml(v) {
  const typeText = normalizeVesselType(v.type) || 'Unknown type';
  const accent = accentForVesselType(v.type);
  const where = `${Number(v.lat).toFixed(3)}°, ${Number(v.lon).toFixed(3)}°`;
  const sog = Number.isFinite(v.sog) ? `${v.sog.toFixed(1)} kt` : null;
  const cog = Number.isFinite(v.cog) ? `${Math.round(v.cog)}°` : null;
  const hdg = Number.isFinite(v.heading) ? `${Math.round(v.heading)}°` : null;
  const age = Number.isFinite(v.lastUpdate)
    ? `${Math.max(0, Math.round((Date.now() - v.lastUpdate) / 1000))}s ago`
    : null;

  const row = (k, val) =>
    `<div class="card-field"><span class="k">${k}</span><span class="v">${val}</span></div>`;

  let html = `<div class="card-kind"><span class="kind-dot" style="background:rgb(${accent})"></span>VESSEL · ${esc(typeText)}</div>`;
  html += `<h3 class="card-title">${esc(v.name || `MMSI ${v.mmsi}`)}</h3>`;
  html += `<div class="card-fields">`;
  html += row('MMSI', `<span class="mono">${esc(v.mmsi)}</span>`);
  if (v.name) html += row('Name', esc(v.name));
  html += row('Position', esc(where));
  if (sog) html += row('Speed', esc(sog));
  if (cog) html += row('Course', esc(cog));
  if (hdg) html += row('Heading', esc(hdg));
  if (v.navStatus) html += row('Nav status', esc(v.navStatus));
  if (age) html += row('Last update', esc(age) + (v.stale ? ' <span class="stale">· STALE</span>' : ''));
  html += `</div>`;
  return html;
}
