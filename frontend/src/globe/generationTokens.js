/* Generation tokens + live-count ceilings.
   Pattern adapted from bilawalsidhu/gods-eye-view (MIT, © 2026 Bilawal
   Sidhu — see THIRD-PARTY-NOTICES.md): src/annotations/annotationEngine.js
   (generation/in-flight guards, MAX_LIVE_ANNOTATIONS).

   Two problems this solves:

   1. STALE ASYNC — anywhere CI does async-then-mutate (scene-share restore
      in globe/share.js, fly-to chains in globe/camera.js, layer data loads),
      a slow resolve belonging to a superseded operation can overwrite newer
      state. The fix: bump a generation counter on every supersede; stale
      completions compare their token and bail out.

   2. UNBOUNDED LIVE ENTITIES — markers billboards live/die with snapshot
      data today with no caps; a flood of events can tank frame rate. The fix:
      configurable ceilings per entity kind; callers check
      `liveCountBelow(kind)` before adding.

   Usage:

     import { createGeneration, liveCountBelow, setLiveCount } from './generationTokens.js';

     // 1. Stale-async guard
     const gen = createGeneration();
     async function flyToChain(target) {
       const myToken = gen.bump();       // invalidate everything before
       await animate(target);
       if (gen.isStale(myToken)) return; // superseded — don't touch the camera
       ...
     }

     // 2. Live-count ceilings
     if (liveCountBelow('events')) addEventBillboard(...);
     // when removing: setLiveCount('events', current - 1);

   Default ceilings live in DEFAULT_CEILINGS; override per kind with
   setCeiling(kind, n). */

const DEFAULT_CEILINGS = {
  events: 4000,
  flights: 2500,
  satellites: 3000,
  vessels: 1500,
  annotations: 120,
};

const _ceilings = { ...DEFAULT_CEILINGS };
const _counts = new Map();

/**
 * Create a generation counter for one async workflow (one per feature:
 * share-restore, fly-to, a layer loader…).
 * @returns {{bump(): number, isStale(token: number): boolean, current(): number}}
 */
export function createGeneration() {
  let gen = 0;
  return {
    /** Invalidate all in-flight work; returns the new token. */
    bump() {
      gen += 1;
      return gen;
    },
    /** True if `token` was superseded by a later bump. */
    isStale(token) {
      return token !== gen;
    },
    /** The current generation value. */
    current() {
      return gen;
    },
  };
}

/**
 * Shared singleton generation for quick ad-hoc use when a module doesn't
 * need its own counter. Prefer createGeneration() for distinct workflows.
 */
const _shared = createGeneration();
export const sharedGeneration = _shared;

/** Override the ceiling for an entity kind (pass Infinity to uncap). */
export function setCeiling(kind, n) {
  _ceilings[kind] = n;
}

/** The effective ceiling for an entity kind. */
export function getCeiling(kind) {
  return kind in _ceilings ? _ceilings[kind] : DEFAULT_CEILINGS.events;
}

/** Set the current live count for a kind (call on add/remove/rebuild). */
export function setLiveCount(kind, n) {
  _counts.set(kind, Math.max(0, n));
}

/** Current live count for a kind (0 if never set). */
export function getLiveCount(kind) {
  return _counts.get(kind) ?? 0;
}

/**
 * True when adding one more entity of `kind` stays within its ceiling.
 * Check BEFORE creating the billboard/primitive.
 */
export function liveCountBelow(kind) {
  return getLiveCount(kind) < getCeiling(kind);
}

/** Reset all counts and ceilings to defaults (tests / full rebuild). */
export function resetGenerationTokens() {
  _counts.clear();
  Object.assign(_ceilings, DEFAULT_CEILINGS);
}
