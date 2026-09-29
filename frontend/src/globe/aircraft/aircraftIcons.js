/* Nose-up aircraft silhouettes, one per classifyAircraft() kind, as SVG data
   URIs for Cesium billboards.
   Ported from God's Eye View src/data/aircraftIcons.js (MIT — bilawalsidhu/gods-eye-view).
   The tr3b Easter-egg glyphs were intentionally dropped (not a CI feature).

   Contract: 96x96 viewBox, glyph centered, nose toward -Y at rotation 0.
   Fill is white with a dark hairline stroke so the tint pipeline
   (billboard.color = fleet tint / military amber) keeps working — no
   per-glyph hardcoded colors.
   Raster at 64px by default (near display size: the browser's SVG AA does the
   work instead of GPU minification); 192px for the tracked billboard. */

const VIEW = 96;
const C = VIEW / 2; // 48 — glyph centre
const STROKE = 'stroke="rgba(0,0,0,0.32)" stroke-width="1.4" stroke-linejoin="round"';
const STROKE_BOLD = 'stroke="rgba(0,0,0,0.38)" stroke-width="2" stroke-linejoin="round"';
const DISC = 'fill="white" fill-opacity="0.5"';

// Bodies drawn in a centred coordinate frame (origin = glyph centre), nose -Y.
const BODIES = {
  airliner: `
    <path d="M0,-42 C 3.8,-40 4.6,-34 4.6,-26 L 4.6,-14
             L 32,4 L 34,6 L 34,10 L 31.4,9.2 L 4.6,2.4
             L 4.2,20
             L 14,28 L 14,32 L 0,28.6 L -14,32 L -14,28 L -4.2,20
             L -4.6,2.4 L -31.4,9.2 L -34,10 L -34,6 L -32,4 L -4.6,-14
             L -4.6,-26 C -4.6,-34 -3.8,-40 0,-42 Z" fill="white" ${STROKE}/>
    <path d="M-15.5,-1.5 l3,7.6 4,-1.4 -1.5,-8.4 Z" fill="white"/>
    <path d="M15.5,-1.5 l-3,7.6 -4,-1.4 1.5,-8.4 Z" fill="white"/>
    <path d="M-1.6,33.5 L 1.6,33.5 L 1.6,40 L -1.6,40 Z" fill="white"/>`,

  widebody: `
    <path d="M0,-45 C 5.6,-43 6.8,-36 6.8,-27 L 6.8,-12
             L 38,9 L 41.5,12.4 L 41.5,16.6 L 37.6,15 L 6.8,6
             L 6.3,21
             L 17,30 L 17,34.6 L 0,30.4 L -17,34.6 L -17,30 L -6.3,21
             L -6.8,6 L -37.6,15 L -41.5,16.6 L -41.5,12.4 L -38,9 L -6.8,-12
             L -6.8,-27 C -6.8,-36 -5.6,-43 0,-45 Z" fill="white" ${STROKE}/>
    <path d="M-19,2 l3.6,9 4.8,-1.7 -1.8,-10 Z" fill="white"/>
    <path d="M19,2 l-3.6,9 -4.8,-1.7 1.8,-10 Z" fill="white"/>
    <path d="M-2,35.5 L 2,35.5 L 2,42.5 L -2,42.5 Z" fill="white"/>`,

  quadjet: `
    <path d="M0,-45 C 7,-42 9,-34 9,-25 L 9,-11
             L 46,12 L 46,21 L 9,11.5
             L 8.4,21 L 20,31 L 20,37.5 L 0,32 L -20,37.5 L -20,31 L -8.4,21
             L -9,11.5 L -46,21 L -46,12 L -9,-11
             L -9,-25 C -9,-34 -7,-42 0,-45 Z" fill="white" ${STROKE_BOLD}/>
    <rect x="-31" y="9" width="7" height="12" rx="2" fill="white"/>
    <rect x="-17" y="4.5" width="7" height="12" rx="2" fill="white"/>
    <rect x="10" y="4.5" width="7" height="12" rx="2" fill="white"/>
    <rect x="24" y="9" width="7" height="12" rx="2" fill="white"/>`,

  turboprop: `
    <path d="M0,-40 C 3.4,-38.5 4.2,-33 4.2,-26 L 4.2,-18
             L 36,-15.5 L 36,-7.5 L 4.2,-8
             L 3.8,22
             L 13,27.5 L 13,31.5 L 0,28.6 L -13,31.5 L -13,27.5 L -3.8,22
             L -4.2,-8 L -36,-7.5 L -36,-15.5 L -4.2,-18
             L -4.2,-26 C -4.2,-33 -3.4,-38.5 0,-40 Z" fill="white" ${STROKE}/>
    <circle cx="-17.5" cy="-16.5" r="7.5" fill="white" fill-opacity="0.5"/>
    <circle cx="17.5" cy="-16.5" r="7.5" fill="white" fill-opacity="0.5"/>
    <path d="M-19.5,-19 h4 v5 h-4 Z" fill="white"/>
    <path d="M15.5,-19 h4 v5 h-4 Z" fill="white"/>
    <path d="M-1.7,31.5 L 1.7,31.5 L 1.7,38.5 L -1.7,38.5 Z" fill="white"/>`,

  light: `
    <path d="M0,-27
             C 4,-25 5.2,-20 5.2,-13
             L 5.2,-9
             L 27,-9 L 27,6 L 5.2,6
             L 5.2,16
             L 11.5,23 L 11.5,27 L 0,23.5 L -11.5,27 L -11.5,23 L -5.2,16
             L -5.2,6
             L -27,6 L -27,-9 L -5.2,-9
             L -5.2,-13
             C -5.2,-20 -4,-25 0,-27 Z" fill="white" ${STROKE}/>
    <ellipse cx="0" cy="-29" rx="12" ry="3.8" ${DISC}/>`,

  glider: `
    <path d="M0,-35 C 2.4,-33 3,-29 3,-25 L 3,-14
             L 45,-10.5 L 45,-3.5 L 2.9,-6
             L 2.2,32 L -2.2,32 L -2.9,-6
             L -45,-3.5 L -45,-10.5 L -3,-14
             L -3,-25 C -3,-29 -2.4,-33 0,-35 Z" fill="white" ${STROKE_BOLD}/>
    <rect x="-10.5" y="32.5" width="21" height="5" rx="1.5" fill="white" ${STROKE_BOLD}/>`,

  helicopter: `
    <circle cx="0" cy="-6" r="31" fill="white" fill-opacity="0.22"/>
    <g transform="rotate(45 0 -6)">
      <rect x="-30.5" y="-8.2" width="61" height="4.4" rx="2.2" fill="white" fill-opacity="0.9"/>
      <rect x="-30.5" y="-8.2" width="61" height="4.4" rx="2.2" fill="white" fill-opacity="0.9" transform="rotate(90 0 -6)"/>
    </g>
    <path d="M0,-22 C 8,-20 10.5,-13 10.5,-6 C 10.5,2 7.5,7 0,8.5
             C -7.5,7 -10.5,2 -10.5,-6 C -10.5,-13 -8,-20 0,-22 Z" fill="white" ${STROKE}/>
    <path d="M-2.6,8 L 2.6,8 L 1.8,32 L -1.8,32 Z" fill="white" ${STROKE}/>
    <path d="M-8,27 L 8,27 L 8,30.6 L -8,30.6 Z" fill="white"/>
    <circle cx="5.6" cy="35" r="6" fill="white" fill-opacity="0.6"/>
    <circle cx="5.6" cy="35" r="2.1" fill="white"/>`,

  fastjet: `
    <path d="M0,-43
             L 3.5,-30
             C 4,-24 4.6,-16 5,-8
             L 27,20 L 27,26 L 6,16
             L 8,30 L 8,34 L 3,31
             L 3,38 L 6.5,42 L 6.5,44 L 0,41.5
             L -6.5,44 L -6.5,42 L -3,38
             L -3,31 L -8,34 L -8,30 L -6,16
             L -27,26 L -27,20 L -5,-8
             C -4.6,-16 -4,-24 -3.5,-30 Z" fill="white" ${STROKE}/>`,

  bizjet: `
    <path d="M0,-42
             L 2.6,-36 L 3.4,-26 L 3.4,-8
             L 27,8 L 27,13 L 3.6,6
             L 3.6,16
             L 8,18 L 8,26 L 3.8,25
             L 3.2,30 L 15,34 L 15,38 L 2.4,36
             L 0,40
             L -2.4,36 L -15,38 L -15,34 L -3.2,30
             L -3.8,25 L -8,26 L -8,18 L -3.6,16
             L -3.6,6 L -27,13 L -27,8 L -3.4,-8
             L -3.4,-26 L -2.6,-36 Z" fill="white" ${STROKE}/>`,

  uav: `
    <path d="M0,-40
             C 3.6,-40 4.6,-35 4.4,-30
             L 2.4,-12
             L 43,-7 L 43,-2.5 L 2.3,0
             L 2.1,24
             L 13,32 L 13,36 L 1.6,30
             L 0,38
             L -1.6,30 L -13,36 L -13,32 L -2.1,24
             L -2.3,0 L -43,-2.5 L -43,-7 L -2.4,-12
             L -4.4,-30 C -4.6,-35 -3.6,-40 0,-40 Z" fill="white" ${STROKE}/>`,
};

const _iconCache = new Map();
const _b64 = (s) =>
  typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'utf8').toString('base64');

/** Fleet raster: near display size so the browser's SVG AA does the work. */
export const FLEET_ICON_PX = 64;
/** Tracked raster: larger source so the selected aircraft stays crisp zoomed in. */
export const TRACKED_ICON_PX = 192;

/**
 * Data URI for a class silhouette (lazily built, cached per kind+size).
 * @param {string} kind - classifyAircraft() class key; unknown → 'airliner'.
 * @param {number} [px=64] - raster size.
 */
export function aircraftIcon(kind, px = FLEET_ICON_PX) {
  const k = BODIES[kind] ? kind : 'airliner';
  const key = `${k}@${px}`;
  let uri = _iconCache.get(key);
  if (!uri) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VIEW} ${VIEW}"><g transform="translate(${C},${C})">${BODIES[k]}</g></svg>`;
    uri = 'data:image/svg+xml;base64,' + _b64(svg);
    _iconCache.set(key, uri);
  }
  return uri;
}
