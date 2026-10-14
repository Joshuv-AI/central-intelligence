// Lane I perf harness — local backend boot for measurement runs.
// Boots the merged build exactly as tasked: backend on port 3116 with
// DATA_DIR=/tmp/ci-v2-data-i, after copying the frontend dist into public/.
// On a production-profile target, skip this and set CI_PERF_BASE_URL instead.
// Usage: node perf/boot-server.mjs [--restart]
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.CI_PERF_PORT || '3116';
const DATA_DIR = process.env.CI_PERF_DATA_DIR || '/tmp/ci-v2-data-i';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

if (await healthy()) {
  console.log(`backend already healthy on :${PORT} (leaving it running)`);
  process.exit(0);
}
// Frontend dist -> public/ immediately before the run (tasked procedure).
if (!existsSync(path.join(ROOT, 'frontend/dist/index.html'))) {
  console.error('frontend/dist missing — build the frontend first (cd frontend && npm run build)');
  process.exit(1);
}
execSync(`cp -a frontend/dist/. public/`, { cwd: ROOT, stdio: 'inherit' });
execSync(`mkdir -p ${DATA_DIR}`, { stdio: 'inherit' });
import { openSync } from 'node:fs';
const logFd = openSync('/tmp/ci-v2-server-i.log', 'a');
const child = spawn('node', ['src/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT, DATA_DIR },
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
child.unref();
console.log(`backend spawned pid=${child.pid} port=${PORT} DATA_DIR=${DATA_DIR}`);
for (let i = 0; i < 60; i++) {
  const h = await healthy();
  if (h) {
    console.log(`health ok: sources ${h.sourcesHealthy}/${h.sourcesTotal} healthy, deploySha=${h.deploySha}`);
    process.exit(0);
  }
  await sleep(1000);
}
console.error('backend did not become healthy within 60 s');
process.exit(1);
