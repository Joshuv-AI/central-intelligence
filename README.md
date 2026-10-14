# Central Intelligence

A central intelligence dashboard for global events, threats, and major
things happening around the globe: a tiered intel pipeline (REST + SSE API)
driving a 3D globe frontend with live contact layers (flights, vessels,
satellites, cameras), earth/environment layers, ground services, and intel
surfaces (ranked events, changes, pinned places, proximity).

One repo, one container, one process. No database — the pipeline keeps a
JSON state store; no alerting, no bots, no LLM calls.

**License: AGPL-3.0-only** (`LICENSE`) — network use requires offering
source. The frontend base is a vendored MIT copy of God's Eye View
(`frontend/VENDOR.md`, `frontend/GEV-LICENSE`); third-party notices live in
`THIRD-PARTY-NOTICES.md` and in-app at the credits surface.

## Layout

```
src/
  index.js            entry: Express + scheduler + SSE + static frontend
  config.js           env-driven config
  api/routes.js       intel API: /api/health|snapshot|events|stream|changes
  api/gev.js          adapter: /api/capabilities|flights|vessels|cyclones|
                      firms|tomtom|gbfs|transit|route|geocode|overpass|
                      radio|cameras/catalog|celestrak|launches (ARCH §4.2)
  api/cameras.js      camera catalog + Windy-backed camera search
  api/proxy.js        /proxy/* upstream forwarder (cached, honest errors)
  ais/                AISStream hub → /api/vessels/stream (SSE)
  pipeline/
    scheduler.js      tiered sweeps, isolated per-source timeouts
    adapters/         35 sources: tier1/ (15) + tier2/ (16) + tier3/ (4)
    normalize.js      canonical event schema + validation
    store.js          atomic JSON state store (data/*.json)
frontend/             vendored GEV base, scrubbed + rebranded (VENDOR.md)
  src/                layers/, intel/, ui/, data/, app/ …
  scripts/            dev tooling (layer-state token ledger checker)
```

## Run locally

Requires Node >=24.14.0 <25.

```bash
npm ci && npm start                       # backend on :3001
cd frontend && npm ci && npm run build     # frontend → frontend/dist
```

The backend serves the built frontend from `./public` (the Docker image
copies `frontend/dist` there at build time; locally, copy `frontend/dist`
to `./public` to serve both from one process).

Environment overrides: `PORT`, `DATA_DIR`, `TIER1_MS`, `TIER2_MS`,
`TIER3_MS`, `FETCH_TIMEOUT_MS`, `FEED_LIMIT`, and the optional provider
keys (server-side only, never in chat): `AISSTREAM_KEY` (vessels),
`WINDY_API_KEY` (camera search), `TOMTOM_API_KEY` (traffic flow tiles),
`FIRMS_MAP_KEY` (NASA fire detections). Every dependent layer ships with
an honest unkeyed state until its key is provisioned.

## Tests

```bash
npm test                                   # backend: 7 suites
cd frontend && node --test "src/**/*.test.mjs"   # frontend suite
```

## Deploy

`Dockerfile` is multi-stage (`node:24-alpine`): builds the frontend, then
copies `frontend/dist` to `./public` in the runtime image.

Production host: GCP e2-micro (`us-east1-b`). Deploy flow: push to `main`
→ the VM's `ci-pull` cron (5 min) → `ci-deploy` build + health gate.
The `gev-rebuild` branch carries the merged-system build; cutover is a
single ref move of `main` to the branch head (pre-cutover `main` SHA is
recorded first; rollback is one ref reset). Never push the rebuild to
`main` directly — `bin/gh-push-branch.py` (in `central-intelligence-system/`)
pushes the branch via the Git Data API; `bin/gh-push.py` is hardcoded to
`main` and must never point at this tree.

## API (core intel contract)

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Source health: total / healthy / stale, last sweep, deploy SHA |
| `GET /api/snapshot` | First-load bundle: markers + connections + feed + meta |
| `GET /api/events?domain=&region=&since=` | Filtered events |
| `GET /api/stream` | SSE: `snapshot` on connect, `update` ping per sweep |
| `GET /api/changes?window=` | 1h/6h/24h change log for the Changes view |
| `GET /api/capabilities` | Feature/key capability flags (drives honest UI states) |
| `GET /api/vessels/stream` | SSE vessel positions (AISStream hub, server-owned key) |
| `/proxy/*` | Cached upstream forwarder with `X-Data-Age` / `X-Data-Stale` |

Adapter JSON responses carry `{fetchedAt, stale, ttlMs}`; key-unset is
`503 {error:"no_key"}` (or the feature's documented honest state) — never
fabricated data, never silent failure.
