/**
 * @module iconFontFallback
 * @description Icon-font failure fallback (Stage-2 hands-on F2; MASTER-CHECKLIST §C).
 *
 * The UI's glyphs come from the Material Symbols webfont (Google Fonts). When
 * that font cannot load, every icon degrades to its raw ligature name
 * ("layers_clear", "radar", …) shouted over the UI. This module detects the
 * failure and flags <html> with `no-icon-font`; CSS then hides the ligature
 * spans, and icon-only buttons render their aria-label as a text label
 * instead — a designed fallback, never raw ligature words.
 *
 * Detection is width-based, not `document.fonts.check()`-based: `check()`
 * returns TRUE for a family the page never managed to @font-face (e.g. the
 * Google Fonts stylesheet itself failed to load), which is exactly the
 * failure we must catch — the check()-based detector never engaged in the
 * sandbox for this reason. Instead we render a ligature sample twice — once
 * with the icon font first in the stack, once with a guaranteed-missing
 * family — and compare widths. Identical widths mean the icon font
 * contributed nothing, so it is unavailable.
 */

const FAMILY = 'Material Symbols Outlined';
// A ligature name the app actually renders; the sample text is never shown.
const SAMPLE = 'layers_clear';
// A family name that can never resolve, so the reference span measures the
// pure fallback rendering.
const MISSING = '__ci_missing_font__';

function measureWidth(doc, fontFamily) {
  const span = doc.createElement('span');
  span.setAttribute(
    'style',
    'position:absolute!important;top:-9999px;left:-9999px;visibility:hidden;' +
      'white-space:nowrap;font-size:100px;font-weight:400;' +
      `font-family:${fontFamily};`,
  );
  span.textContent = SAMPLE;
  doc.body.appendChild(span);
  const w = span.getBoundingClientRect().width;
  span.remove();
  return w;
}

/**
 * True when the icon font renders (or when we cannot tell — never punish
 * the UI for a broken probe).
 */
export function iconFontRenders(doc = document) {
  try {
    if (!doc.body || typeof doc.createElement !== 'function') return true;
    const ref = measureWidth(doc, `"${MISSING}",monospace`);
    const probe = measureWidth(doc, `"${FAMILY}","${MISSING}",monospace`);
    if (!ref || !probe) return true;
    return Math.abs(ref - probe) > 0.5;
  } catch {
    return true;
  }
}

function update(doc = document) {
  doc.documentElement.classList.toggle('no-icon-font', !iconFontRenders(doc));
}

/**
 * Arm the fallback detector. Probes immediately, re-probes a few times (the
 * font may still be in flight on slow networks), and re-probes whenever the
 * font set settles — so the fallback lifts if the font arrives late, and
 * engages if it never does.
 */
export function armIconFontFallback(doc = document) {
  update(doc);
  let tries = 0;
  const retry = () => {
    update(doc);
    if (!iconFontRenders(doc) && ++tries < 4) setTimeout(retry, 4000);
  };
  setTimeout(retry, 3000);
  try {
    doc.fonts.addEventListener('loadingdone', () => update(doc));
  } catch {
    /* FontFaceSet events unavailable — the retries above still apply. */
  }
}

/** Test hook: force the fallback class on/off without a real font failure. */
export function setIconFontFallbackForced(doc = document, on) {
  doc.documentElement.classList.toggle('no-icon-font', Boolean(on));
}
