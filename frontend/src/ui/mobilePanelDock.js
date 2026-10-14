/**
 * F12 — mobile panel docking (§L.1).
 *
 * At ≤720px the default state keeps the globe usable: both panel rails
 * (#left-panel-stack, #right-context-rail) dock off (display:none via the
 * `mobile-panels-docked` body class — see shell-lane-h.css) and the INTEL
 * panel starts collapsed behind its "Intel feed" pill (see src/intel/ui.js).
 * A single PANELS toggle opens the rails as an overlay sheet; Escape or the
 * toggle re-docks. While the sheet is open the HUD top-left block is hidden
 * (it collided with the SCENES panel header).
 *
 * The adaptive rail layout (PanelLayoutController) already backs off at
 * ≤720px and re-runs on resize, so toggling only flips body classes and
 * nudges a resize event for re-measurement.
 */
export const MOBILE_DOCK_QUERY = '(max-width: 720px)';
export const DOCKED_CLASS = 'mobile-panels-docked';
export const OPEN_CLASS = 'mobile-panels-open';

/**
 * Pure state applier (unit-testable): flips the body classes and the toggle
 * button's accessible state. `open=true` shows the rails as a sheet.
 */
export function applyMobileDockState({ body, toggle, open }) {
  body.classList.toggle(OPEN_CLASS, open);
  body.classList.toggle(DOCKED_CLASS, !open);
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(open));
    const label = open ? 'Close panels' : 'Open panels';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
    const text = toggle.querySelector('.mobile-panels-toggle-label');
    if (text) text.textContent = open ? 'CLOSE' : 'PANELS';
  }
}

function isFirstRunVisible(doc) {
  const m = doc.getElementById('first-run-launcher');
  return !!m && !m.hidden && m.offsetParent !== null;
}

function isSearchTakeoverOpen(doc) {
  const t = doc.getElementById('dock-search-takeover');
  return !!t && !t.hidden;
}

export function initMobilePanelDock() {
  const toggle = document.getElementById('mobile-panels-toggle');
  if (!toggle) return;
  const mq = window.matchMedia(MOBILE_DOCK_QUERY);
  const isOpen = () => document.body.classList.contains(OPEN_CLASS);
  const setOpen = (open) => {
    applyMobileDockState({ body: document.body, toggle, open });
    // Let the adaptive rail layout re-measure now the rails are (in)visible.
    window.dispatchEvent(new Event('resize'));
  };

  toggle.addEventListener('click', () => setOpen(!isOpen()));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;
    // The first-run modal and the search takeover own their own Escape.
    if (isFirstRunVisible(document) || isSearchTakeoverOpen(document)) return;
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    setOpen(false);
  });

  const apply = () => {
    if (mq.matches) {
      if (!isOpen()) applyMobileDockState({ body: document.body, toggle, open: false });
    } else {
      document.body.classList.remove(DOCKED_CLASS, OPEN_CLASS);
      toggle.setAttribute('aria-expanded', 'false');
    }
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
  apply();
}
