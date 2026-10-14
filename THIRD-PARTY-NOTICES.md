# Third-party notices — Central Intelligence (merged system)

Regenerated 2026-10-13 for the GEV-rebuild merged tree (Phase 3, Lane B
scaffold). This file covers the frontend (vendored GEV base, see
`frontend/VENDOR.md`) and the backend. In-app credits live in
`frontend/src/data/dataCredits.js` and must match this file.

## Removal history — TeleGeography submarine cables (CC BY-NC-SA 3.0)

The submarine-cable layer and its bundled TeleGeography dataset were
**removed in full on 2026-10-13** (live CI first, then excluded from the
vendored base — the GEV cables module and data pack were never copied)
because CC BY-NC-SA 3.0 prohibits commercial use and this system is a
commercial showcase. No TeleGeography data ships in the bundle. This note
is the license-history record of the removal, not a credit for current use.

## God's Eye View — frontend base (MIT)

The frontend in `frontend/` is a vendored copy of
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)
(bilawalsidhu/gods-eye-view) at pinned commit
`8b8ccc9a81379e8b40d4be67610570ee5b159512`, used under the MIT License.
Full MIT text: `frontend/GEV-LICENSE` (Copyright © 2026 Bilawal Sidhu).
Provenance, the re-vendor rule, and the scaffold strip/scrub record:
`frontend/VENDOR.md`. The MIT grant covers GEV **code only** — bundled
third-party data and models keep their own licenses (below). No God's Eye
View branding, names, or marks are used in this product.

This wholesale adoption supersedes the earlier per-module port notices
(the 2026-09-29 audit-module ports and the sensor shaders in
`frontend/src/globe/sensors/` — `thermal.js`, `surveillance.js`, `retro.js`,
`noir.js`, adapted from GEV `src/styles/`, MIT © 2026 Bilawal Sidhu — are
part of the vendored base's lineage and remain MIT-covered as above; the
old frontend tree that held them was replaced by the vendored base).

## 3D models (CC BY 4.0, per-model)

All nine bundled GLB models in `frontend/public/models/` are CC BY 4.0
(Sketchfab); credit + license link + modification notes travel with the
models in `frontend/public/models/README.md` and in-app:

- `airplane.glb` — "boeing 747" by zairiq-123
- `jet.glb` — "Private Jet" by Nick the Name
- `ship.glb` — "Low Poly Cargo Ship" by Javier_Fernandez
- `bell206.glb` — "Bell 206 JetRanger" by terran4627
- `c172.glb` — "Cessna 172" by e737
- `citation2.glb` — "1990 Cessna Citation" by BlenderCommunityHead
- `mq9.glb` — "MQ-9" by IProZenoN
- `b789.glb` — "Boeing 787-9" by Nobilis 2
- `atr72.glb` — "ATR 72 - 600" by Oyan3D

## Bundled datasets

- **ODbL 1.0 group** (© OpenStreetMap contributors; derived databases are
  offered under ODbL): datacenters (`frontend/src/data/local_data/datacenters/`),
  dams (`.../dams/`), military area names (`.../osm_military_names/`,
  OSM via Overture Maps Foundation). Runtime ODbL feeds: adsb.lol flights,
  OpenFreeMap/OpenMapTiles vector tiles.
- **Public domain / PDDL**: Natural Earth regions + admin boundaries,
  U.S. Census Bureau counties, DataSF neighborhoods (PDDL 1.0).
- **Excluded at scaffold (never copied)**: TeleGeography cables (above),
  Bhote Koshi event pack + compiled centerline (CC BY-NC 4.0), TomTom test
  fixture (`src/data/fixtures/`, © TomTom), CCTV ground-heights pack
  (license unstated), DelDOT CCTV pack (terms unconfirmed).

## Terrain — Esri Terrain3D (credit corrected)

3D terrain is served by Esri Terrain3D
(`https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer`).
**Correction:** earlier versions of this file credited Re:Earth terrain
(terrain.reearth.land, CC BY 4.0) — the code has used Esri Terrain3D since
2026-10-09 and the merged frontend keeps the Esri host (GEV's retry policy
ported onto it). The Re:Earth credit was stale and is removed. The stale
CARTO basemap credit that lived in the old frontend's `panels.js` is gone
with the old frontend; the vendored tree contains no CARTO basemap
references (verified by grep at scaffold; the only remaining CARTO mention
is this sentence).

## Runtime data providers (credits as displayed in-app)

- **NASA FIRMS** (CC0 / public domain): "We acknowledge the use of data
  and/or imagery from NASA's Fire Information for Resource Management
  System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth
  Observing System Data and Information System (EOSDIS)."
- **ECMWF IFS Open Data** (CC BY 4.0): prescribed ECMWF attribution +
  modification notice + liability disclaimer are shown in-app with the
  wind layer. **NOAA GFS / nowCOAST / NHC**, **USGS**, **NIFC WFIGS**,
  **NASA GIBS** — U.S. public domain.
- **Esri** basemap/imagery services: "Powered by Esri" attribution carried
  by the providers and in-app.
- **CelesTrak** (celestrak.org, Dr. T.S. Kelso) — citation requested, shown
  in-app. **Launch Library 2** (The Space Devs). **Radio Browser**
  directory data (PDDL 1.0). **Mapillary** imagery (CC BY-SA 4.0,
  "© Mapillary contributors") when Street Level is enabled.
- **TomTom** traffic flow data © TomTom, shown in-app when the traffic
  layer runs in live (keyed) mode; tiles are served live and cached only
  transiently (≤120 s), never bundled.

## npm packages with special notices

- `@jtarrio/webrtlsdr` 3.0.6 — Apache-2.0 (browser-local SDR; the SDR
  surface is not shipped in the merged build — package retained in the
  dependency set only if a kept feature imports it; see scaffold log).
- `@jtarrio/signals` 0.10.1 — Apache-2.0.
- `mapillary-js` 4.1.2 — MIT (Street Level viewer, loaded on demand);
  its dependencies `rxjs` 7.8.2 (Apache-2.0) and `three` 0.134.0 (MIT).
- Cesium (Apache-2.0), satellite.js, hls.js, and the remaining resolved
  dependency inventory: `frontend/package-lock.json`.
