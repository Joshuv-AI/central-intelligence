/* Canvas-generated billboard sprites. Severity colors per DESIGN.md:
   low #7FCEF0 glacier · moderate #FFD166 gold · high #FFB020 amber · critical #FF5A5A ember.
   No external image assets, no Ion.

   Every sprite rasterizes at 3x (SS) so pins stay crisp on DPR-3 phones.
   Drawing code works in base-CSS-pixel coordinates — makeCanvas applies
   ctx.scale(SS, SS) so line widths and radii need no manual scaling. */

import { SEV_COLORS } from '../data/store.js';

const SS = 3; // supersample factor for retina sharpness
const cache = new Map();

function makeCanvas(baseSize) {
  const c = document.createElement('canvas');
  c.width = baseSize * SS;
  c.height = baseSize * SS;
  const ctx = c.getContext('2d');
  ctx.scale(SS, SS);
  return [c, ctx];
}

function withAlpha(cssColor, a) {
  // SEV_COLORS are #rrggbb — append an alpha hex pair.
  const hex = Math.round(a * 255).toString(16).padStart(2, '0');
  return `${cssColor}${hex}`;
}

// Point event marker: glowing dot + crisp outer ring.
function eventSprite(severity) {
  const key = `event-${severity}`;
  if (cache.has(key)) return cache.get(key);
  const color = SEV_COLORS[severity] || SEV_COLORS.low;
  const [c, ctx] = makeCanvas(72);
  const cx = 36;
  const cy = 36;

  // Soft halo behind everything.
  const halo = ctx.createRadialGradient(cx, cy, 2, cx, cy, 32);
  halo.addColorStop(0, withAlpha(color, 0.35));
  halo.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, 72, 72);

  // Outer ring — thin and bright.
  ctx.beginPath();
  ctx.arc(cx, cy, 24, 0, Math.PI * 2);
  ctx.strokeStyle = withAlpha(color, 0.85);
  ctx.lineWidth = 2;
  ctx.stroke();

  // Solid dot with a light-catching gradient (premium feel, still flat).
  const dot = ctx.createRadialGradient(cx - 2.5, cy - 2.5, 1, cx, cy, 9.5);
  dot.addColorStop(0, '#ffffff');
  dot.addColorStop(0.35, color);
  dot.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.fillStyle = dot;
  ctx.fill();

  // Hairline dark edge so the dot reads on bright ocean tiles.
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(3, 8, 16, 0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const img = c.toDataURL('image/png');
  cache.set(key, img);
  return img;
}

// Fusion connection marker: DISTINCT double ring (no dot) — intelligence
// products must read differently from raw events at a glance.
function connectionSprite(severity) {
  const key = `conn-${severity}`;
  if (cache.has(key)) return cache.get(key);
  const color = SEV_COLORS[severity] || SEV_COLORS.low;
  const [c, ctx] = makeCanvas(96);
  const cx = 48;
  const cy = 48;

  const halo = ctx.createRadialGradient(cx, cy, 4, cx, cy, 44);
  halo.addColorStop(0, withAlpha(color, 0.22));
  halo.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, 96, 96);

  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1.75;
  ctx.beginPath();
  ctx.arc(cx, cy, 21, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  const img = c.toDataURL('image/png');
  cache.set(key, img);
  return img;
}

// Expanding pulse ring (animated via scale + alpha, not redrawn).
function pulseSprite(severity) {
  const key = `pulse-${severity}`;
  if (cache.has(key)) return cache.get(key);
  const color = SEV_COLORS[severity] || SEV_COLORS.low;
  const [c, ctx] = makeCanvas(96);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(48, 48, 40, 0, Math.PI * 2);
  ctx.stroke();
  const img = c.toDataURL('image/png');
  cache.set(key, img);
  return img;
}

// Cluster marker: glassy dark disc, severity ring, mono count via label.
function clusterSprite(severity) {
  const key = `cluster-${severity}`;
  if (cache.has(key)) return cache.get(key);
  const color = SEV_COLORS[severity] || SEV_COLORS.low;
  const [c, ctx] = makeCanvas(84);
  const cx = 42;
  const cy = 42;

  // Faint severity halo so clusters lift off the basemap.
  const halo = ctx.createRadialGradient(cx, cy, 10, cx, cy, 40);
  halo.addColorStop(0, withAlpha(color, 0.28));
  halo.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, 84, 84);

  // Glassy disc: subtle vertical gradient.
  const disc = ctx.createLinearGradient(0, cy - 30, 0, cy + 30);
  disc.addColorStop(0, 'rgba(16, 28, 46, 0.94)');
  disc.addColorStop(1, 'rgba(5, 11, 22, 0.94)');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, Math.PI * 2);
  ctx.fill();

  // Crisp severity ring.
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, Math.PI * 2);
  ctx.stroke();

  // Top highlight arc — the glassy catchlight.
  ctx.beginPath();
  ctx.arc(cx, cy, 25, Math.PI * 1.15, Math.PI * 1.85);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 2;
  ctx.stroke();

  const img = c.toDataURL('image/png');
  cache.set(key, img);
  return img;
}

export const Sprites = {
  event: eventSprite,
  connection: connectionSprite,
  pulse: pulseSprite,
  cluster: clusterSprite,
};
