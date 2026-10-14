# VENDOR.md — GEV frontend base provenance

- **Upstream:** bilawalsidhu/gods-eye-view (God's Eye View), MIT License
  (full text: `GEV-LICENSE` in this directory; copyright © 2026 Bilawal Sidhu).
- **Pinned commit:** `8b8ccc9a81379e8b40d4be67610570ee5b159512` (2026-10-12).
- **Vendor date:** 2026-10-13 (Phase 3, Lane B scaffold).
- **Re-vendor rule:** upstream updates arrive ONLY as deliberate re-vendor
  diffs reviewed against this file's strip record — never auto-merge, never
  a submodule, never a live dependency on the upstream repo.
- **What was copied:** `src/`, `index.html`, `style.css`, `public/` assets
  that survived the license scrub, `config/cctv_sources.*.json`, and the
  client halves of `build/` (`vite.js`, `application-html.js`, `panel.js`,
  `allowedHosts.js`).
- **Never copied:** `server/` (all of it), `pinokio/`, `tools/`, `scripts/`,
  `docs/`, `.env*` examples, GEV branding assets, `src/data/fixtures/`
  (excluded wholesale, S10).
- **License scrub + strip record:** deletions were executed IN this copy at
  scaffold time (ARCH §9.1 — deletions, not disables). The full file-by-file
  record, grep-gate output, and the two lane handoffs (cockpit chrome →
  Lane H; satellite follow → Lane C) are in the Lane B scaffold log:
  `~/workspace/gev-rebuild/logs/lane-b-scaffold.md`.
- **Registry seams (frozen at scaffold):** layer catalog registry =
  `src/app/constructCatalog.js` (`createApplicationCatalog`, layers array +
  `src/data/layerState.js` `LAYER_STATE_REGISTRY` metadata; both must list
  the same ids or `createLayerCatalog` throws) and panel registry =
  `src/ui/templates/*.html` expanded by `build/application-html.js`
  (`APPLICATION_TEMPLATES`) + panel construction in `src/ui/`. Lanes C–H
  register into these; they do not edit chrome to add a layer.
