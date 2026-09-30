# Third-party notices

## Re:Earth terrain (CC BY 4.0)

3D terrain tiles are served by [Re:Earth](https://terrain.reearth.land/)
(`https://terrain.reearth.land/cesium-mesh/ellipsoid`, quantized-mesh),
used under the Creative Commons Attribution 4.0 International License.
Terrain data: Re:Earth, Mapterhorn, EGM2008 (NGA), Protomaps,
© OpenStreetMap contributors. Attribution is also shown in the globe's
on-screen credit line.

## God's Eye View sensor shaders (MIT)

The files in `frontend/src/globe/sensors/` named `thermal.js`,
`surveillance.js`, `retro.js`, and `noir.js` are adapted
from [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)
(`src/styles/`), used under the MIT License.

> MIT License
>
> Copyright (c) 2026 Bilawal Sidhu
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.

The sensor manager (`frontend/src/globe/sensors/index.js`) that drives these
shaders inside Central Intelligence is our own code.

## God's Eye View audit modules (MIT)

The following modules in `frontend/src/` were ported from
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)
(bilawalsidhu/gods-eye-view, MIT License, © 2026 Bilawal Sidhu) during the
2026-09-29 audit, adapted for Central Intelligence's architecture:

- `globe/renderGovernor.js` — demand-driven Cesium render loop with named holds
- `globe/generationTokens.js` — stale async generation guards
- `globe/sharpen.js` — restrained unsharp-mask post-process stage
- `globe/eventFraming.js` — angled cinematic event camera framing
- `globe/cameraGuard.js` — camera ground-clearance guard
- `globe/cameraGen.js` — camera generation stamping
- `globe/labelQuotas.js` — shared label budget quotas
- `globe/calloutDecollision.js` — screen-space callout decollision
- `globe/aircraft/` — per-class silhouettes, icons, follow mode, trails, registry
- `globe/vessels/` — AIS vessel layer (needs API key)
- `globe/aircraft/iconOrientation.js` — screen-space icon orientation
  (camera-basis course projection + rotation stabilization), wired into the
  flights/vessels per-frame loops and follow mode
- `globe/weather/` — 3D shells, GPU wind streamlines, cloud imagery
- `globe/satellites/orbitRings.js` — flicker-free orbit rings
- `globe/satellites/launchViz.js` — launch pad zones and ascent replay
- `globe/sensors/scopeMask.js` — NVG/FLIR scope viewport mask
- `globe/sensors/frustum.js` — sensor footprint projection math
- `globe/sensors/cyberSonar.js` — opt-in acquisition sweep (off by default)
- `globe/radio/` — web-radio layer (needs backend proxy for production)
- `globe/annotations/` — analyst mark-up mode
- `globe/gestures/clickGesture.js` — click/drag gesture classifier
- `globe/imageryCompare/` — NASA GIBS date comparison (needs UI wiring)
- `ui/telemetry.js` — camera telemetry readout
- `ui/coordinateParser.js` — coordinate query parser
- `ui/geocoder.js` — geocode cache with proximity bias
- `ui/loadingStates.js` — pipeline loading state machine
- `ui/splitFlap.js` — split-flap status transitions
- `ui/shortcuts.js` — keyboard shortcuts

Each module's header comment notes its GEV provenance. Integration is
incremental — see the audit report at
`~/workspace/central-intelligence-system/audits/gev-comparison-2026-09-29.md`
for the full 72-item matrix and wiring status.
