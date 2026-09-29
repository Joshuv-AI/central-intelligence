/* Shared Radio playback — ported from bilawalsidhu/gods-eye-view (MIT),
   src/layers/radio/playback.js (single shared Audio element, generation-
   guarded installAudio so a stale stream can never play after the user
   moved on).

   No autoplay: playStation() is only ever called from an explicit user
   click/gesture path (tuner commit, station button). Browsers gate HTMLAudio
   playback on user activation; a NotAllowedError surfaces as state 'error'.
*/
import { createRadioSource } from './source.js';

let audio = null;
let generation = 0;
let state = 'stopped'; // stopped|loading|playing|buffering|paused|error
let stationId = null;
let stationName = '';
let volume = 0.8;
let error = null;
let fadeRaf = 0;

let clickReporter = null;
const listeners = new Set();

/**
 * Wire an optional click reporter (createRadioSource().recordClick).
 * Called once by index.js; playback stays usable without it.
 */
export function initPlayback({ source } = {}) {
  clickReporter = source || createRadioSource();
}

function ensureAudio() {
  if (typeof Audio === 'undefined') return null;
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  audio.volume = volume;
  audio.addEventListener('playing', () => {
    if (state === 'loading' || state === 'buffering') {
      state = 'playing';
      error = null;
      emit();
    }
  });
  audio.addEventListener('waiting', () => {
    if (state === 'loading' || state === 'playing') {
      state = 'buffering';
      emit();
    }
  });
  audio.addEventListener('pause', () => {
    if (state === 'playing' || state === 'buffering') {
      state = 'paused';
      emit();
    }
  });
  audio.addEventListener('error', () => {
    if (state === 'loading' || state === 'buffering' || state === 'playing') {
      state = 'error';
      error = 'Broadcaster stream is unavailable or blocked by the browser.';
      emit();
    }
  });
  return audio;
}

function emit() {
  const snapshot = getPlaybackState();
  for (const fn of listeners) {
    try { fn(snapshot); } catch { /* listener failure must not break audio */ }
  }
}

/** Subscribe to playback state changes; returns an unsubscribe function. */
export function subscribePlayback(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function stopFade() {
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  fadeRaf = 0;
}

/**
 * Start the given station. Generation-guarded: every call bumps the
 * generation, and the async play() resolution below is ignored when a newer
 * call has superseded it — a stale stream can never take over the element.
 * Never called without an explicit user gesture.
 * @param {object} station normalized station (needs streamUrl)
 * @param {object} [opts]
 * @param {number} [opts.fadeInMs] ramp 0→volume over this many ms (default 0)
 * @returns {Promise<boolean>} true when playback actually started
 */
export async function playStation(station, { fadeInMs = 0 } = {}) {
  const el = ensureAudio();
  const url = String(station?.streamUrl || '').trim();
  if (!el || !url) return false;
  stopFade();
  const gen = ++generation;
  stationId = station.id || station.uuid || null;
  stationName = station.name || 'Unknown station';
  error = null;
  state = 'loading';
  emit();
  if (el.src !== url) {
    try { el.pause(); } catch { /* already stopped */ }
    el.src = url;
  }
  el.volume = fadeInMs > 0 ? 0 : volume;
  try {
    const attempt = el.play();
    if (attempt?.then) await attempt;
  } catch (err) {
    if (gen !== generation) return false;
    state = 'error';
    error =
      err?.name === 'NotAllowedError'
        ? 'Playback requires a direct click or tap.'
        : 'Broadcaster stream could not be started.';
    emit();
    return false;
  }
  if (gen !== generation) return false; // superseded while buffering
  state = 'playing';
  emit();
  // Fade the real stream in (used by the tuner handoff, static fades out).
  if (fadeInMs > 0) {
    const t0 = performance.now();
    const ramp = () => {
      if (gen !== generation) return;
      const p = Math.min(1, (performance.now() - t0) / fadeInMs);
      el.volume = volume * p;
      if (p < 1) fadeRaf = requestAnimationFrame(ramp);
      else fadeRaf = 0;
    };
    fadeRaf = requestAnimationFrame(ramp);
  }
  // Count the play with Radio Browser (fire and forget, never breaks audio).
  if (clickReporter && stationId) {
    Promise.resolve()
      .then(() => clickReporter.recordClick(stationId))
      .catch(() => {});
  }
  return true;
}

/** Pause without releasing the stream (resume via playStation). */
export function pausePlayback() {
  if (!['loading', 'playing', 'buffering'].includes(state)) return false;
  generation += 1;
  stopFade();
  try { audio?.pause(); } catch { /* noop */ }
  state = 'paused';
  emit();
  return true;
}

/** Stop playback and release the stream's network resource. */
export function stopPlayback() {
  generation += 1;
  stopFade();
  if (audio) {
    try { audio.pause(); } catch { /* noop */ }
    try { audio.removeAttribute('src'); } catch { /* noop */ }
    try { audio.load(); } catch { /* detached media */ }
  }
  stationId = null;
  stationName = '';
  state = 'stopped';
  error = null;
  emit();
  return true;
}

/** @param {number} v 0..1 */
export function setVolume(v) {
  volume = Math.min(1, Math.max(0, Number(v) || 0));
  if (audio) audio.volume = volume;
  emit();
}

/** @returns {{state:string,stationId:string|null,stationName:string,volume:number,error:string|null}} */
export function getPlaybackState() {
  return { state, stationId, stationName, volume, error };
}
