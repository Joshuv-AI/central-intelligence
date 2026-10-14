# Lane I — perf harness + §I rehearsal apparatus

Measurement apparatus for the §I Final Test. **Everything produced here is
REHEARSAL evidence.** The binding §I run is executed later, on the live
site, by an independent adversarial tester who did not build this
apparatus (see `~/workspace/gev-rebuild/logs/lane-i-verification.md`,
separation note).

## Environment labelling

Every result JSON carries an `env` field. In this VM the environment is:
headless Chromium (Playwright chromium-1243) + SwiftShader software GL,
`--no-proxy-server`, shared VM, external tile/data hosts largely
unreachable. Numbers from this VM are **[ENV]** values: they validate the
apparatus and give regression-relative baselines. They are NOT
production-profile §I measurements.

## Re-running on the production-profile target (unchanged scripts)

1. Build/serve the merged build on the target (or point at a preview URL).
2. `export CI_PERF_BASE_URL=https://<target>` (skip `boot-server.mjs`).
3. Optionally `export CI_PERF_ENV_LABEL='[PROD-PROFILE] <hardware/browser>'`.
4. Run the same scripts below. Viewport, sample lengths and layer settle
   times are env-tunable (`CI_PERF_MOBILE`, `CI_PERF_STRESS_SEC`,
   `CI_PERF_LAYER_SETTLE_MS`, `CI_PERF_SOAK_MIN`).

## Local run (this VM)

```sh
cd ~/workspace/central-intelligence-v2
node perf/boot-server.mjs          # copies frontend/dist -> public/, boots :3116, DATA_DIR=/tmp/ci-v2-data-i
node perf/measure-boot.mjs         # (a) boot latency, desktop + mobile
node perf/measure-heap-layers.mjs  # (b) heap idle + per-layer (diagnostics overlay)
node perf/measure-stress.mjs       # (c) stress fps, desktop (CI_PERF_MOBILE=1 for mobile)
setsid nohup node perf/soak.mjs >> perf/results/soak.out 2>&1 &   # (d) 30-min soak
```

Results land in `perf/results/*.json` (soak: `*.jsonl` progress + summary).

## §I rehearsal scripts (in `~/workspace/gev-rebuild/ux/scripts/`)

```sh
node ~/workspace/gev-rebuild/ux/scripts/rehearsal-newcomer.mjs desktop|mobile
node ~/workspace/gev-rebuild/ux/scripts/rehearsal-console-sweep.mjs desktop|mobile
node ~/workspace/gev-rebuild/ux/scripts/rehearsal-honesty.mjs
```

## Definitions the binding tester must ratify or replace

- **Loader-clear:** `#loading-screen` hidden (class/computed style) AND
  >5 rAF frames rendered AND diagnostics snapshot available.
- **Sustained <30 fps (§I.2 FAIL line):** ≥5 consecutive 1-second rAF
  buckets under 30 fps during the stress sample.
- **Per-layer heap:** marginal `performance.memory.usedJSHeapSize` delta
  vs idle, layer on alone for a settle window, measured through the app's
  own diagnostics overlay (`window.__ciDiagnostics.snapshot()`).
- **Stress scene:** every catalog layer with a toggle ON, camera at a
  metro framing inside the civil-flights gate (Orlando, ~120 km),
  continuous heading rotation + height oscillation.

## Anchors

GEV published (M5/Chrome): settle ~1.86 s; heap ~105 MB idle, ~412 MB
cables, ~872 MB combined stress. The merged build is measured, never
assumed — Stage 1 left heap unmeasured; this harness closes that debt.
