# Central Intelligence — Backend

The intel-pipeline API for the Central Intelligence system: a tiered source
sweeper, a JSON state store, and a small REST + SSE API. One Docker container
on one VM. No database, no alerting, no briefings, no bots, no LLM calls.

**License: AGPL-3.0-only** (`LICENSE`). This backend will reuse adapters from
the Crucix codebase, which is AGPL-3.0 — network use requires offering source.

## Run locally

Requires Node 20+.

```bash
npm install
npm start          # listens on :3001
```

Environment overrides: `PORT`, `DATA_DIR`, `TIER1_MS`, `TIER2_MS`, `TIER3_MS`,
`FETCH_TIMEOUT_MS`, `FEED_LIMIT`.

## Run with Docker (the VM path)

```bash
docker compose up -d --build
docker compose logs -f
```

State lives in `./data/` (mounted volume) and survives rebuilds.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Source health: total / healthy / stale, last sweep, per-source status |
| `GET /api/snapshot` | First-load bundle: markers + connections + feed + meta |
| `GET /api/events?domain=&region=&since=` | Filtered events (e.g. `?domain=conflict&region=middle%20east`) |
| `GET /api/stream` | SSE: `snapshot` on connect, `update` after every sweep |
| `/proxy/*` | Live-layer forwarder stub — 501 until Phase 2 wires it |

## Layout

```
src/
  index.js            entry point: Express + scheduler + SSE wiring
  config.js           env-driven config
  api/routes.js       /api/* endpoints
  api/proxy.js        /proxy/* stub
  lib/sse.js          SSE client registry + broadcast
  pipeline/
    scheduler.js      tiered sweeps, isolated per-source timeouts
    normalize.js      canonical event schema + validation
    store.js          atomic JSON state store (data/*.json)
    adapters/
      index.js        registry: 37 sources across 3 tiers
      tier1/          13 stubs — ~15 min (conflict, disasters, cyber KEV, space wx…)
      tier2/          18 stubs — ~30–60 min (sanctions, health, social, environment…)
      tier3/          6 stubs  — daily (economic: BLS, Treasury…)
```

## Pipeline (Phase 1 skeleton)

```
tier scheduler (staggered) → parallel fetch (25s timeout, isolated failures)
  → normalize → replace per-source events → JSON store → SSE broadcast
```

Adapters are stubs returning `[]` until Phase 2 ports the real fetchers.
Phase 2 adds: intelligence layer (cascades, anomalies, clustering), delta
engine, rule-based fusion → `connections` + `feed`.

## Normalized event schema

```json
{
  "id": "acled-12345",
  "source": "acled",
  "domain": "conflict",
  "title": "…",
  "summary": "…",
  "lat": 33.5, "lon": 44.4,
  "region": "Middle East",
  "time": "2026-09-27T12:00:00Z",
  "severity": "high",
  "url": "https://…",
  "attribution": "ACLED"
}
```

`severity` is one of `low | moderate | high | critical`.
