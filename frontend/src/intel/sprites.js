/* Lane G — canvas sprites for intel markers (adapted from the old CI
   frontend's sprites.js, same product): glowing severity dots, double-ring
   connection nodes, pulse rings, cluster discs. Rasterized at 3x. */
import { SEV_COLORS } from './model.js';

const SS = 3;
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
  const hex = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
  return `${cssColor}${hex}`;
}
function paintGlowDot(ctx, cx, cy, color, dotR, haloR, haloAlpha) {
  const halo = ctx.createRadialGradient(cx, cy, 2, cx, cy, haloR);
  halo.addColorStop(0, withAlpha(color, haloAlpha));
  halo.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);
  const dot = ctx.createRadialGradient(cx - dotR * 0.28, cy - dotR * 0.28, 1, cx, cy, dotR);
  dot.addColorStop(0, '#ffffff');
  dot.addColorStop(0.35, color);
  dot.addColorStop(1, color);
  ctx.beginPath();
  ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
  ctx.fillStyle = dot;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(3, 8, 16, 0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

export const Sprites = {
  event(severity) {
    const key = `event-${severity}`;
    if (cache.has(key)) return cache.get(key);
    const color = SEV_COLORS[severity] || SEV_COLORS.low;
    const [c, ctx] = makeCanvas(72);
    paintGlowDot(ctx, 36, 36, color, 11, 32, 0.25);
    const img = c.toDataURL('image/png');
    cache.set(key, img);
    return img;
  },
  connection(severity) {
    const key = `conn-${severity}`;
    if (cache.has(key)) return cache.get(key);
    const color = SEV_COLORS[severity] || SEV_COLORS.low;
    const [c, ctx] = makeCanvas(96);
    paintGlowDot(ctx, 48, 48, color, 13, 42, 0.25);
    // Double ring: the connection grammar from the Guide — a fused link
    // reads differently from a raw event on purpose.
    ctx.strokeStyle = withAlpha(color, 0.9);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(48, 48, 24, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = withAlpha(color, 0.5);
    ctx.beginPath(); ctx.arc(48, 48, 31, 0, Math.PI * 2); ctx.stroke();
    const img = c.toDataURL('image/png');
    cache.set(key, img);
    return img;
  },
  pulse(severity) {
    const key = `pulse-${severity}`;
    if (cache.has(key)) return cache.get(key);
    const color = SEV_COLORS[severity] || SEV_COLORS.low;
    const [c, ctx] = makeCanvas(96);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.arc(48, 48, 40, 0, Math.PI * 2); ctx.stroke();
    const img = c.toDataURL('image/png');
    cache.set(key, img);
    return img;
  },
  cluster(severity) {
    const key = `cluster-${severity}`;
    if (cache.has(key)) return cache.get(key);
    const color = SEV_COLORS[severity] || SEV_COLORS.low;
    const [c, ctx] = makeCanvas(84);
    const halo = ctx.createRadialGradient(42, 42, 10, 42, 42, 40);
    halo.addColorStop(0, withAlpha(color, 0.28));
    halo.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, 84, 84);
    const disc = ctx.createLinearGradient(0, 14, 0, 70);
    disc.addColorStop(0, 'rgba(16, 30, 48, 0.92)');
    disc.addColorStop(1, 'rgba(6, 12, 22, 0.92)');
    ctx.beginPath(); ctx.arc(42, 42, 27, 0, Math.PI * 2);
    ctx.fillStyle = disc; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    const img = c.toDataURL('image/png');
    cache.set(key, img);
    return img;
  },
};
