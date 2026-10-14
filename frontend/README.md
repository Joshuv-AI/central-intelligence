# Central Intelligence — frontend

The merged Central Intelligence globe: a vendored copy of the God's Eye View
frontend base (MIT, pinned SHA in `VENDOR.md`), scrubbed, rebranded, and
re-pointed at the Central Intelligence backend adapter (`/api/*`).

- Build: `npm ci && npm run build` (Node >=24.14.0 <25).
- Dev: `npm run dev` (Vite, 127.0.0.1:4173).
- Diagnostics overlay (off by default): `?diag=1` or Ctrl+Shift+D.
- Provenance + strip record: `VENDOR.md`. Third-party notices: repo-root
  `THIRD-PARTY-NOTICES.md`. In-app credits: `src/data/dataCredits.js`.
