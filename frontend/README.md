# Central Intelligence — frontend

Glacial Calm single-page app: a fullscreen keyless Cesium globe fed by the
Central Intelligence backend API.

## Run

```bash
npm install
npm run dev      # Vite dev server, /api proxied to http://localhost:3001
npm run build    # production bundle → dist/
npm run preview  # serve dist/ on :4321, /api proxied to http://localhost:3001
```

The backend serves this same `dist/` from the same origin in production, so
all API calls use relative paths (`/api/snapshot`, …).

## Structure

- `src/main.js` — boot, orchestration, globe picking, ESC, region menu
- `src/globe/` — Cesium viewer (keyless: Ellipsoid terrain + CartoDB dark),
  canvas marker sprites, entity clustering, camera flights
- `src/data/` — API client, SSE stream, central store + filter state
- `src/ui/` — boot ritual, icon rail, docked panels, status pill, search,
  ticker, detail cards
- `src/styles/` — Glacial Calm tokens + component styles (incl. mobile)

## Design

Per `~/workspace/central-intelligence-system/DESIGN.md` (Glacial Calm) and
`LAYOUT.md`. Public name is **Central Intelligence** everywhere; no parent
project branding appears in the UI or comments.

## License

MIT — see LICENSE.
