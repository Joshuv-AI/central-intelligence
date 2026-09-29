/* Camera generation stamping — stale in-flight moves abort instead of
   fighting the user.
   Adapted from bilawalsidhu/gods-eye-view (MIT, © 2026 Bilawal Sidhu — see
   THIRD-PARTY-NOTICES.md): src/sharelink.js (_restoreGeneration,
   claimRestoreLane) and src/ui/navigationController.js.

   Every programmatic flight captures the generation at start and checks it
   before applying corrections; user pointer-down bumps the generation so a
   slow flight can never fight fresh input. Required groundwork for flight
   tracking and any tour work.
*/
let cameraGeneration = 0;
let installedViewer = null;

/** The current camera generation. */
export function currentGeneration() {
  return cameraGeneration;
}

/** Capture the generation at flight start; pass the token through the flight. */
export function captureGeneration() {
  return cameraGeneration;
}

/** True when `gen` is no longer the live generation (a newer move won). */
export function isStaleGeneration(gen) {
  return gen !== cameraGeneration;
}

/**
 * Bump the generation — call on user takeover (pointerdown/wheel on the
 * canvas). Every programmatic flight should capture the generation first.
 */
export function bumpGeneration() {
  cameraGeneration += 1;
  return cameraGeneration;
}

/**
 * Wire user-takeover bumps onto a viewer's canvas. Idempotent per viewer.
 * Programmatic flights call captureGeneration() at start and
 * isStaleGeneration(gen) before any late correction.
 */
export function installGenerationBumps(viewer) {
  if (!viewer || installedViewer === viewer) return;
  installedViewer = viewer;
  const canvas = viewer.scene.canvas;
  canvas.addEventListener('pointerdown', bumpGeneration, { passive: true });
  canvas.addEventListener('wheel', bumpGeneration, { passive: true });
}
