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
