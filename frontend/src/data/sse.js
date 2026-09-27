/* SSE client for /api/stream with backoff reconnect.
   Events: 'snapshot' (full state, applied directly), 'update' (a sweep
   finished — caller re-fetches /api/snapshot). */

const BACKOFFS = [1000, 2000, 5000, 15000, 30000];

export function connectStream({ onSnapshot, onUpdate, onStatus }) {
  let es = null;
  let attempt = 0;
  let closed = false;
  let retryTimer = null;

  const setStatus = (connected, reconnecting) => {
    try { onStatus && onStatus(connected, reconnecting); } catch { /* never break the app */ }
  };

  function open() {
    if (closed) return;
    try {
      es = new EventSource('/api/stream');
    } catch {
      scheduleRetry();
      return;
    }

    es.addEventListener('snapshot', (ev) => {
      attempt = 0;
      setStatus(true, false);
      try {
        onSnapshot && onSnapshot(JSON.parse(ev.data));
      } catch { /* malformed payload: ignore */ }
    });

    es.addEventListener('update', (ev) => {
      try {
        const info = JSON.parse(ev.data);
        onUpdate && onUpdate(info);
      } catch { /* ignore */ }
    });

    es.onerror = () => {
      try { es.close(); } catch { /* noop */ }
      es = null;
      setStatus(false, true);
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (closed) return;
    const wait = BACKOFFS[Math.min(attempt, BACKOFFS.length - 1)];
    attempt += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, wait);
  }

  open();

  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      try { es && es.close(); } catch { /* noop */ }
    },
  };
}
