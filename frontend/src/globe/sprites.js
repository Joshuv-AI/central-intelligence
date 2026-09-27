/* Canvas-generated billboard sprites. Severity colors per DESIGN.md:
   low #7FCEF0 glacier · moderate #FFD166 gold · high #FFB020 amber · critical #FF5A5A ember.
   No external image assets, no Ion. */

import { SEV_COLORS } from '../data/store.js';

const cache = new Map();

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return [c, c.getContext('2d')];
}

// Point event marker: solid dot + thin outer ring.
function eventSprite(severity) {
  const key = `event-${severity}`;
  if (cache.has(key)) return cache.get(key);
  const color = SEV_COLORS[severity] || SEV_COLORS.low;
  const [c, ctx] = makeCanvas(72);
  const cx = 36;
  const cy = 36;
  // Outer ring.
  ctx.beginPath();
  ctx.arc(cx, cy, 24, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 2;
  ctx.stroke();
  // Solid dot.
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  // Soft glow.
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 5;
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
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 21, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
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
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(48, 48, 40, 0, Math.PI * 2);
  ctx.stroke();
  const img = c.toDataURL('image/png');
  cache.set(key, img);
  return img;
}

// Cluster marker: filled dot + mono count handled by the label.
function clusterSprite(severity) {
  const key = `cluster-${severity}`;
  if (cache.has(key)) return cache.get(key);
  const color = SEV_COLORS[severity] || SEV_COLORS.low;
  const [c, ctx] = makeCanvas(84);
  ctx.fillStyle = 'rgba(5, 11, 22, 0.82)';
  ctx.beginPath();
  ctx.arc(42, 42, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(42, 42, 30, 0, Math.PI * 2);
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
