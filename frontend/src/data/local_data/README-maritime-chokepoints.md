# Maritime chokepoints pack (J4-30, Wave 3)

`maritime_chokepoints.json` — 12 named strategic waterways (Strait of Hormuz,
Malacca, Bab el-Mandeb, Suez, Panama, Gibraltar, Taiwan Strait, Bosphorus,
Dardanelles, Dover, Korea Strait, Lombok) with representative centerline
coordinates and a one-line plain-language context each.

License: public domain. Coordinates of well-known geographic features are
facts, curated from public geographic knowledge — not copied from any
dataset, and no Natural Earth vectors are reproduced here. The loader is
`frontend/src/data/bundledJson.js` (lazy, cached); the consumer is the
`chokepoints` layer (`frontend/src/layers/chokepoints/`).

The region-name substrate for J4-03 (pinned places) and J4-23 lives in the
existing packs: `natural_earth/{regions,marine,countries,states_provinces}.json`
(via `frontend/src/data/naturalEarthRegions.js`) and
`us_census_counties/counties.json` (via `frontend/src/data/adminBoundaries.js`).
