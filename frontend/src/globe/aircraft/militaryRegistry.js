/* Operator-curated ICAO registry — add-only, session-scoped.
   Inspired by God's Eye View src/data/tr3bRegistry.js (MIT): the portable
   insight is the ADD-ONLY pattern, not the Easter egg.

   The operator explicitly tags an ICAO hex as military / of-interest.
   The registry is NEVER auto-populated and entries are never deleted
   silently — so a "military" marker on CI always means a human said so.
   CI never auto-labels an airframe military.

   Session-scoped by default; persist to localStorage only via explicit
   operator action (see integration doc §2.8). */

const tagged = new Map(); // hex (lowercase) → { tag, at, note }

export const REGISTRY_TAGS = Object.freeze({
  MILITARY: 'military',
  WATCH: 'watch',
});

/**
 * Tag a hex. Add-only: re-tagging updates the note but never removes.
 * @param {string} hex
 * @param {string} tag - one of REGISTRY_TAGS values
 * @param {string} [note]
 * @returns {boolean} false when the hex/tag is invalid.
 */
export function tagAircraft(hex, tag, note = '') {
  const h = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(h)) return false;
  if (!Object.values(REGISTRY_TAGS).includes(tag)) return false;
  tagged.set(h, { tag, at: Date.now(), note: String(note || '') });
  return true;
}

/** Remove a tag — the ONLY removal path, always explicit. */
export function untagAircraft(hex) {
  return tagged.delete(String(hex || '').trim().toLowerCase());
}

/** Get the tag record for a hex, or null. */
export function getTag(hex) {
  return tagged.get(String(hex || '').trim().toLowerCase()) || null;
}

/** True when the hex carries the military tag. */
export function isTaggedMilitary(hex) {
  return getTag(hex)?.tag === REGISTRY_TAGS.MILITARY;
}

/** All tagged entries, newest first. */
export function listTagged() {
  return [...tagged.entries()]
    .map(([hex, rec]) => ({ hex, ...rec }))
    .sort((a, b) => b.at - a.at);
}

/** Serialize for explicit operator export (never auto-persisted). */
export function exportRegistry() {
  return JSON.stringify(listTagged());
}

/** Restore from an operator-provided export. Add-only: never wipes existing. */
export function importRegistry(json) {
  let arr;
  try { arr = JSON.parse(json); } catch { return 0; }
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const e of arr) {
    if (e && tagAircraft(e.hex, e.tag, e.note)) n++;
  }
  return n;
}
