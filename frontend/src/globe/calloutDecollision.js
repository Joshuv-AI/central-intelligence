/**
 * Callout de-collision: pure screen-space layout for CI's marker callouts.
 *
 * Ported from God's Eye View (MIT) `src/annotations/screenAnnotationRenderer.js`
 * (the decollideCallouts core and the generation-aware height cache), adapted
 * for CI's marker callouts. Pure logic — no Cesium, no DOM.
 *
 * INTENDED WIRING (integrator's job, not this module's): each postRender (or on
 * governorRequestRender), project each visible marker's world position to
 * screen, measure its callout rect (x, y, width, height), run
 * `decollideCallouts()`, then position the DOM callouts at the returned y and
 * stretch each leader line by `leaderExtension`. Use `capCallouts()` first on
 * small screens so clustered markers collapse to a "+N more" aggregate.
 */

/**
 * Generation-aware height cache.
 * Marks must sit on the real surface, not at sea level; ground heights are
 * sampled once (expensive) and cached. Each projection frame bumps the
 * generation via `nextFrame()`; entries touched this frame are "hot" and
 * survive trimming first, so one large area cannot churn its OWN active
 * heights out of cache and force a re-sample every frame.
 * @param {{ softCap?: number, hardCap?: number }} [opts]
 * @returns {{ get: Function, set: Function, nextFrame: Function, trim: Function, size: Function }}
 */
export function createHeightCache({ softCap = 600, hardCap = 8000 } = {}) {
  const cache = new Map(); // key -> { h, settled, gen }
  let generation = 0;

  /** Bump the generation: call once per projection frame before touching entries. */
  function nextFrame() {
    generation += 1;
  }

  /** Read a height; marks the entry hot for this frame and MRU. */
  function get(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    entry.gen = generation;
    cache.delete(key); // re-insert: most-recently-used ordering
    cache.set(key, entry);
    return entry;
  }

  /** Store a height. `settled: false` = tile not loaded yet, retry later. */
  function set(key, h, { settled = true } = {}) {
    cache.set(key, { h, settled, gen: generation });
    trim();
  }

  /** Evict cold entries down to the soft cap; the hard cap is absolute. */
  function trim() {
    if (cache.size <= softCap) return;
    // Cold keys first (not touched this frame) — live marks never evict
    // their own heights.
    for (const [key, entry] of cache) {
      if (cache.size <= softCap) break;
      if (entry.gen !== generation) cache.delete(key);
    }
    // Backstop: a single frame legitimately needing more than the soft cap.
    while (cache.size > hardCap) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  return {
    get,
    set,
    nextFrame,
    trim,
    size: () => cache.size,
    /** Test seam: read the current generation. */
    generation: () => generation,
  };
}

/**
 * Nudge overlapping callout cards apart so labels stay readable when several
 * markers cluster on screen. Simple top-down sweep: each card that overlaps an
 * earlier (higher) one is pushed just below it.
 *
 * Pure: inputs are not mutated. Returns new objects with adjusted `y` and
 * `leaderExtension` (pixels the card moved down — how far its leader line must
 * stretch to stay attached).
 * @param {Array<{ id: any, x: number, y: number, width: number, height: number }>} callouts
 * @returns {Array<{ id: any, x: number, y: number, width: number, height: number, leaderExtension: number }>}
 */
export function decollideCallouts(callouts) {
  if (!Array.isArray(callouts)) return [];
  const GUTTER = 6;
  const STEP = 5;
  const placed = callouts
    .filter(
      (c) =>
        c &&
        Number.isFinite(c.x) &&
        Number.isFinite(c.y) &&
        Number.isFinite(c.width) &&
        Number.isFinite(c.height),
    )
    .map((c) => ({ ...c, _origY: c.y, leaderExtension: 0 }));
  placed.sort((a, b) => a.y - b.y);
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i];
    for (let j = 0; j < i; j++) {
      const b = placed[j];
      const overlapX = a.x < b.x + b.width + GUTTER && a.x + a.width + GUTTER > b.x;
      const overlapY = a.y < b.y + b.height && a.y + a.height > b.y;
      if (overlapX && overlapY) {
        a.y = b.y + b.height + STEP;
      }
    }
  }
  // leaderExtension is measured against the ORIGINAL y.
  for (const a of placed) {
    a.leaderExtension = Math.max(0, a.y - a._origY);
    delete a._origY;
  }
  return placed;
}

/**
 * Cap concurrent callouts on small screens: extras collapse to a "+N more"
 * aggregate suggestion the integrator can render as a single chip.
 * @param {Array<object>} callouts
 * @param {number} [maxVisible=8]
 * @returns {{ visible: Array<object>, overflowCount: number }}
 */
export function capCallouts(callouts, maxVisible = 8) {
  const list = Array.isArray(callouts) ? callouts : [];
  const max = Number.isFinite(maxVisible) && maxVisible >= 0 ? maxVisible : 8;
  return {
    visible: list.slice(0, max),
    overflowCount: Math.max(0, list.length - max),
  };
}
