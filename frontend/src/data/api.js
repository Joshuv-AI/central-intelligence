/* API client — relative paths only (same-origin in prod, Vite proxy in dev).
   Every fetch has a timeout and never throws unhandled. */

const TIMEOUT_MS = 12000;

async function request(path, { timeout = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSnapshot() {
  return request('/api/snapshot');
}

export async function fetchHealth() {
  return request('/api/health');
}
