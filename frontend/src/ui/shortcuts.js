/**
 * Application keyboard shortcuts.
 * Ported from God's Eye View (MIT) — src/ui/applicationShortcuts.js.
 *
 * INTEGRATION NOTE (main.js coordination): main.js already has initEsc() —
 * `keydown` Escape → close card, else close panel, else close search. This
 * module's Escape handler calls actions.dismiss() ONLY if the integrator
 * provides it. Two ways to wire, pick one, not both:
 *   1. Preferred: pass actions.dismiss = the SAME dismissal chain initEsc
 *      uses (card → panel → search), then REMOVE main.js's initEsc listener
 *      so one owner controls Escape and search.js's own Escape path stays.
 *   2. Leave initEsc untouched and do not pass actions.dismiss — initEsc keeps
 *      owning Escape, and bindShortcuts binds only '/' and 'h'.
 * Do not modify main.js from here; the wiring choice is a few-line call-site
 * edit for the integrator.
 */

/**
 * Bind the application's bubbling keyboard shortcuts.
 * Capture-phase surfaces keep first refusal. The caller owns each action;
 * form controls keep native typing except for Escape.
 *
 * @param {object} options
 * @param {Document} options.documentRef - Keyboard event target.
 * @param {HTMLElement} options.searchInput - Editing target exempt from the form-control guard.
 * @param {object} options.actions - Existing application operations.
 * @param {Function} options.actions.focusSearch - Focus the search input.
 * @param {Function} options.actions.toggleHudMeta - Toggle the HUD meta line.
 * @param {Function} [options.actions.dismiss] - Escape dismissal chain (see note above).
 * @returns {{ destroy: Function }} Synchronous, idempotent listener cleanup.
 */
export function bindShortcuts({ documentRef, searchInput, actions }) {
  const ops = actions || {};
  const onKeyDown = (event) => {
    if (event.defaultPrevented) return;
    // Guard: form controls keep native typing. Escape still dismisses.
    const isFormControl =
      event.target?.matches?.('select, input, textarea') ||
      event.target === searchInput;
    if (isFormControl && event.key !== 'Escape') return;
    if (event.key === 'Escape') {
      if (typeof ops.dismiss === 'function') ops.dismiss();
      return;
    }
    // Modifier combos (browser/OS land) are out of scope.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === '/') {
      event.preventDefault(); // don't type the slash into the focused input
      if (typeof ops.focusSearch === 'function') ops.focusSearch();
      return;
    }
    if (key === 'h') {
      if (typeof ops.toggleHudMeta === 'function') ops.toggleHudMeta();
      return;
    }
  };
  documentRef.addEventListener('keydown', onKeyDown);
  return {
    destroy() {
      documentRef.removeEventListener('keydown', onKeyDown);
    },
  };
}
