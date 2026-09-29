/**
 * Annotation persistence: hand-drawn marks saved across sessions.
 * Backed by localStorage, namespaced `ci.annotations.v1`.
 *
 * Mark shape:
 *   { id, kind: 'area'|'line'|'pin', vertices: [[lon,lat],...],
 *     label, color, createdAt }
 *
 * Validation is strict on load: malformed marks are dropped, corrupt storage
 * never crashes (it reads back as empty). Cap is 120 marks (GEV's
 * MAX_LIVE_ANNOTATIONS); past the cap the oldest are evicted.
 */
import { MAX_VERTICES, MIN_VERTICES, normalizeShape } from './drawSession.js';

export const STORE_KEY = 'ci.annotations.v1';
export const MAX_STORED_ANNOTATIONS = 120;

const KINDS = new Set(['area', 'line', 'pin']);

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** @returns {string} a fresh mark id */
export function newAnnotationId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID)
      return `anno-${crypto.randomUUID()}`;
  } catch {
    /* fall through */
  }
  return `anno-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function isFinitePair(pair) {
  return (
    Array.isArray(pair) &&
    Number.isFinite(pair[0]) &&
    Number.isFinite(pair[1]) &&
    Math.abs(pair[0]) <= 180 &&
    Math.abs(pair[1]) <= 90
  );
}

/**
 * Validate a mark; returns a cleaned copy or null when malformed.
 * Tolerates the drawTool's plain {lon,lat} vertices as well as [[lon,lat]] pairs.
 */
export function validateAnnotation(mark) {
  if (!mark || typeof mark !== 'object') return null;
  const kind = KINDS.has(mark.kind) ? mark.kind : normalizeShape(mark.kind);
  if (!KINDS.has(kind)) return null;
  const raw = Array.isArray(mark.vertices) ? mark.vertices : [];
  const vertices = [];
  for (const v of raw) {
    if (vertices.length >= MAX_VERTICES) break;
    if (isFinitePair(v)) vertices.push([v[0], v[1]]);
    else if (v && Number.isFinite(v.lon) && Number.isFinite(v.lat))
      vertices.push([v.lon, v.lat]);
  }
  if (vertices.length < (MIN_VERTICES[kind] || 1)) return null;
  if (kind === 'pin') vertices.length = 1; // a pin is one point, never a trail
  const createdAt = Number.isFinite(mark.createdAt)
    ? mark.createdAt
    : Date.now();
  return {
    id: typeof mark.id === 'string' && mark.id ? mark.id : newAnnotationId(),
    kind,
    vertices,
    label: typeof mark.label === 'string' ? mark.label.slice(0, 200) : '',
    color: typeof mark.color === 'string' ? mark.color.slice(0, 32) : 'primary',
    createdAt,
  };
}

/** Read and validate everything in storage. Never throws. */
function readAll() {
  const store = storage();
  if (!store) return [];
  let raw;
  try {
    raw = store.getItem(STORE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // corrupt JSON reads back as empty, never crashes
  }
  if (!Array.isArray(parsed)) return [];
  const marks = [];
  const seen = new Set();
  for (const mark of parsed) {
    const clean = validateAnnotation(mark);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    marks.push(clean);
  }
  marks.sort((a, b) => a.createdAt - b.createdAt);
  return marks;
}

function writeAll(marks) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(STORE_KEY, JSON.stringify(marks));
    return true;
  } catch {
    return false; // quota exceeded etc. — the mark is lost, not the app
  }
}

/**
 * Persist a mark (validates first; evicts oldest past the cap).
 * @param {object} mark
 * @returns {object|null} the stored mark, or null when invalid
 */
export function saveAnnotation(mark) {
  const clean = validateAnnotation(mark);
  if (!clean) return null;
  const marks = readAll().filter((m) => m.id !== clean.id);
  marks.push(clean);
  // Oldest evicted past the cap.
  while (marks.length > MAX_STORED_ANNOTATIONS) marks.shift();
  writeAll(marks);
  return clean;
}

/** @returns {Array<object>} all stored marks, oldest first */
export function listAnnotations() {
  return readAll();
}

/** @returns {boolean} whether a mark was removed */
export function deleteAnnotation(id) {
  const marks = readAll();
  const next = marks.filter((m) => m.id !== id);
  if (next.length === marks.length) return false;
  writeAll(next);
  return true;
}

/** Remove every stored mark. */
export function clearAnnotations() {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORE_KEY);
  } catch {
    /* noop */
  }
}
