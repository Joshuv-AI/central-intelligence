/**
 * Loading-feedback reducer core for the status surface.
 * Ported from God's Eye View (MIT) — src/loadingFeedback.js.
 *
 * Pure logic, no DOM: polled activity samples reduce into UI state, and
 * `presentLoadingFeedback()` turns that state into a render descriptor.
 *
 * Key behaviors:
 * - Loading reveals only after LOADING_REVEAL_DELAY_MS (no flash for fast ops).
 * - Terminal states dwell: success/cancel LOADING_TERMINAL_DWELL_MS,
 *   failures LOADING_FAILURE_DWELL_MS.
 * - Outcomes merge by max severity: complete < cancelled < error.
 * - GUIDANCE_STATUSES (zoom-in, empty, idle, no-results) are user guidance,
 *   not faults — they never render as failures.
 */

/** Loading indicator only appears if work lasts longer than this. */
export const LOADING_REVEAL_DELAY_MS = 160;
/** How long a settled non-failure terminal state stays visible. */
export const LOADING_TERMINAL_DWELL_MS = 2200;
/** How long a failed terminal state stays visible. */
export const LOADING_FAILURE_DWELL_MS = 5000;

/**
 * Layer statuses that are user guidance, not faults. A status of `no-results`
 * means "the sweep ran and found nothing" — normal operation, never a chip red.
 */
export const GUIDANCE_STATUSES = Object.freeze([
  'zoom-in',
  'empty',
  'idle',
  'no-results',
]);

/** True when a participant status is guidance (render as info, never as fault). */
export function isGuidanceStatus(status) {
  return GUIDANCE_STATUSES.includes(String(status || '').toLowerCase());
}

/** Fresh reducer state. */
export function createLoadingFeedbackState() {
  return {
    phase: 'idle',
    visible: false,
    startedAt: 0,
    showAt: 0,
    hideAt: 0,
    activeIds: [],
    batchOutcome: null,
    terminal: null,
    operation: null,
  };
}

function terminalFromEvent(event) {
  const type = String(event?.type || '');
  if (type === 'visibility-failed' || type === 'refresh-failed' || event?.error)
    return 'error';
  if (type === 'visibility-cancelled' || event?.cancelled) return 'cancelled';
  if (type === 'visibility' || type === 'refresh') return 'complete';
  return null;
}

function mergeTerminalOutcome(current, next) {
  const severity = { complete: 1, cancelled: 2, error: 3 };
  if (!next) return current || null;
  if (!current || severity[next] > severity[current]) return next;
  return current;
}

/**
 * Reduce a sampled activity summary into delayed, non-flashing UI state.
 *
 * @param {object} previous - Prior reducer state (or null for fresh).
 * @param {object} summary - `{ active: [], activeIds: [], disabling: bool, refresh: bool }`.
 * @param {number} nowMs - Current timestamp.
 * @param {object|null} event - Optional `{ type, layerId, error, cancelled }`.
 * @returns {object} Next reducer state.
 */
export function reduceLoadingFeedback(previous, summary, nowMs, event = null) {
  const state = previous || createLoadingFeedbackState();
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  const active = summary?.active || [];

  if (active.length) {
    const beginning = state.phase !== 'loading';
    const startedAt = beginning ? now : state.startedAt;
    const priorParticipants = beginning ? [] : state.activeIds;
    const activeIds = [...new Set([...priorParticipants, ...summary.activeIds])];
    const eventLayerId = String(event?.layerId || '');
    const eventParticipates = eventLayerId && activeIds.includes(eventLayerId);
    const batchOutcome = mergeTerminalOutcome(
      beginning ? null : state.batchOutcome,
      eventParticipates ? terminalFromEvent(event) : null,
    );
    return {
      phase: 'loading',
      visible: !beginning && now >= state.showAt,
      startedAt,
      showAt: beginning ? now + LOADING_REVEAL_DELAY_MS : state.showAt,
      hideAt: 0,
      activeIds,
      batchOutcome,
      terminal: null,
      operation: summary.disabling
        ? 'disabling'
        : summary.refresh
          ? 'refresh'
          : 'loading',
    };
  }

  if (state.phase === 'loading') {
    const eventLayerId = String(event?.layerId || '');
    const eventParticipates =
      eventLayerId && state.activeIds.includes(eventLayerId);
    const terminal =
      mergeTerminalOutcome(
        state.batchOutcome,
        eventParticipates ? terminalFromEvent(event) : null,
      ) || 'complete';
    const wasVisible = state.visible || now >= state.showAt;
    // Finished before it ever revealed: skip the chip entirely (no flash).
    if (!wasVisible && terminal === 'complete')
      return createLoadingFeedbackState();
    const dwell =
      terminal === 'error'
        ? LOADING_FAILURE_DWELL_MS
        : LOADING_TERMINAL_DWELL_MS;
    return {
      ...state,
      phase: 'terminal',
      visible: true,
      hideAt: now + dwell,
      batchOutcome: terminal,
      terminal,
    };
  }

  if (state.phase === 'terminal' && now < state.hideAt) return state;
  return createLoadingFeedbackState();
}

/**
 * Build the user-facing descriptor for the current loading state.
 * Returns null when nothing should render; otherwise `{ state, label, detail }`
 * where state is one of loading|long|refresh|disabling|complete|cancelled|error.
 *
 * @param {object} state - Reducer state from reduceLoadingFeedback().
 * @param {object} summary - Activity summary; participants have `.label`.
 * @param {number} nowMs - Current timestamp.
 */
export function presentLoadingFeedback(state, summary, nowMs) {
  if (!state?.visible) return null;
  if (state.phase === 'terminal') {
    const labels = {
      complete: 'LOAD COMPLETE',
      cancelled: 'LOAD CANCELLED',
      error: 'LOAD FAILED',
    };
    return {
      state: state.terminal,
      label: labels[state.terminal] || 'LOAD COMPLETE',
      detail: '',
    };
  }
  const active = summary?.active || [];
  const names = active
    .slice(0, 2)
    .map((record) => record.label)
    .join(' · ');
  const suffix = active.length > 2 ? ` +${active.length - 2}` : '';
  const elapsed = Math.max(0, nowMs - state.startedAt);
  const label = summary?.disabling
    ? 'TURNING OFF LIVE DATA'
    : summary?.refresh
      ? 'REFRESHING LIVE DATA'
      : 'LOADING LIVE DATA';
  return {
    state:
      elapsed >= 30000
        ? 'long'
        : summary?.disabling
          ? 'disabling'
          : summary?.refresh
            ? 'refresh'
            : 'loading',
    label,
    detail: `${names}${suffix}`,
  };
}

/**
 * Global status-notice controller. Pure except for the render hooks, which the
 * integrator wires to DOM.
 *
 * Usage:
 *   const notice = createStatusNotice({
 *     render: ({ label, detail, kind }) => { /* paint the notice *\/ },
 *     clear: () => { /* remove the notice *\/ },
 *   });
 *   notice.show('Sweep timed out', 'error');
 *   notice.dismiss();
 *   notice.destroy();
 *
 * Non-persistent notices auto-expire after LOADING_FAILURE_DWELL_MS; a finite
 * notice starts its dwell only when it first wins presentation (see GEV note
 * in presentGlobalStatusNotice), so `check(nowMs)` both presents and advances
 * the deadline. The poll loop calls `check()` on every tick.
 *
 * @param {object} [hooks]
 * @param {function} [hooks.render] - Called with `{ label, detail, kind }`.
 * @param {function} [hooks.clear] - Called when the notice should be removed.
 * @returns {{ show(message, kind), dismiss(), destroy(), check(nowMs) }}
 */
export function createStatusNotice({ render, clear } = {}) {
  let current = null;
  const paint = typeof render === 'function' ? render : () => {};
  const wipe = typeof clear === 'function' ? clear : () => {};

  function check(nowMs = Date.now()) {
    if (!current) return null;
    if (!current.persistent && nowMs >= current.hideAt) {
      current = null;
      wipe();
      return null;
    }
    const out = {
      label: current.label,
      detail: current.detail,
      kind: current.kind,
    };
    paint(out);
    return out;
  }

  return {
    /**
     * Show a notice. `kind` is 'error' | 'warn' | 'info'. Non-error notices
     * auto-expire after LOADING_FAILURE_DWELL_MS unless `persistent` is set.
     */
    show(message, kind = 'error', { detail = '', persistent = false } = {}) {
      const label = String(message || '').trim();
      if (!label) return null;
      current = {
        label,
        detail: String(detail || '').trim(),
        kind,
        persistent: !!persistent,
        hideAt: Date.now() + LOADING_FAILURE_DWELL_MS,
      };
      return check();
    },
    dismiss() {
      current = null;
      wipe();
    },
    destroy() {
      current = null;
      wipe();
    },
    check,
  };
}

/**
 * Reconnect notice predicate for the SSE stream. Show when the outage is
 * noticeable: reconnecting for more than 5s, or on the 3rd attempt onward.
 *
 * Suggested message: `RECONNECTING — showing last sweep from {age}` where age
 * is a humanized duration of the last successful snapshot (e.g. "42s",
 * "3m 12s").
 *
 * @param {object} params
 * @param {number} params.attempts - Reconnect attempt count (1-based).
 * @param {number} params.elapsedMs - Ms since the stream dropped.
 */
export function shouldShowReconnectNotice({ attempts = 0, elapsedMs = 0 }) {
  return Number(elapsedMs) > 5000 || Number(attempts) >= 3;
}
