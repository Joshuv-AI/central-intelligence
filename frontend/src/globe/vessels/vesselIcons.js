/* Type-colored vessel chevron icons as SVG data URIs.
   Ported from God's Eye View src/layers/vessels/rendering.js shipIcon()
   (MIT — bilawalsidhu/gods-eye-view).

   The chevron points north (up) so billboard rotation maps directly to
   heading/course. One icon is generated per color+variant and cached —
   all billboards share instances. */

import { vesselTypeCss } from './vesselTypes.js';

const _iconCache = new Map();
const _b64 = (s) =>
  typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'utf8').toString('base64');

/**
 * Chevron data URI for a vessel type.
 * @param {string|number} type - AIS ship type (text or numeric code).
 * @param {boolean} [selected=false] - white/brighter selected variant.
 * @returns {string} SVG data URI.
 */
export function vesselIcon(type, selected = false) {
  const cssColor = selected ? '#ffffff' : vesselTypeCss(type);
  const key = `${cssColor}:${selected ? 'selected' : 'normal'}`;
  let icon = _iconCache.get(key);
  if (icon) return icon;

  const stroke = selected ? 'rgba(6,26,32,0.95)' : 'rgba(4,18,24,0.9)';
  const strokeWidth = selected ? 1.1 : 0.7;
  // Rasterized at 96px (3x) for retina sharpness — viewBox keeps the
  // artwork identical; billboards pin the display size to 32px.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 32 32">` +
    `<g transform="translate(16,16)">` +
    `<path d="M0,-14 L11,10 L4,7 L0,14 L-4,7 L-11,10 Z" fill="${cssColor}" ` +
    `stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>` +
    `</g></svg>`;
  icon = 'data:image/svg+xml;base64,' + _b64(svg);
  _iconCache.set(key, icon);
  return icon;
}
