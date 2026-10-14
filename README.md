# Smeartype

An HTML Canvas ClearType-style renderer and interactive type lab. Uses **OpenType.js 2.0.0** for glyph selection, ligatures, font metrics and kerning, and **FreeType WASM 2.14.3** for hinting and rasterization. No runtime CDN requests or uploaded-font transmission.

Live demo: [muglug.github.io/smeartype](https://muglug.github.io/smeartype/).

## Deployment

Pushes to `main` run the rendering tests, build the static app, and deploy `dist/` to GitHub Pages using `.github/workflows/pages.yml`. All asset URLs are relative, including the WASM module and font, so the app supports the `/smeartype/` project path.

## Run

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. Node 17.4+ works; a maintained Node LTS is recommended. `npm test` runs pixel-level checks using the actual WASM engine. `npm run build` creates a self-contained static `dist/`; `npm run preview` serves that build. Serve through HTTP, not `file://`. The included server is for local development only.

## Renderer API

After `node scripts/prepare.mjs`, import the browser module:

```js
import { SubpixelRenderer } from './src/renderer.js';

const renderer = await SubpixelRenderer.create();
renderer.loadFont(await (await fetch('./public/fonts/Lato-Regular.ttf')).arrayBuffer());
const canvas = document.querySelector('canvas');
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(640 * dpr);
canvas.height = Math.round(160 * dpr);
canvas.style.width = `${canvas.width / dpr}px`;
canvas.style.height = `${canvas.height / dpr}px`;
renderer.draw(canvas, {
  text: 'Hamburgefontsiv',
  size: 18 * dpr,
  x: 20 * dpr,
  baseline: 36 * dpr,
  mode: 'lcd',                 // lcd | harmony | gray
  axis: 'horizontal',         // horizontal | vertical
  order: 'rgb',               // rgb | bgr
  filter: 'default',          // default | light | none | custom
  weights: [8, 77, 86, 77, 8], // custom, normalized to sum to 256
  hinting: true,
  gamma: 2.2,
  strength: 1,
  foreground: '#20231f',
  background: '#ffffff',
});
// renderer.render(options) returns RGBA bytes without accessing the DOM.
// Call renderer.destroy() when finished to release native resources.
```

All API lengths are **backing-store pixels**, including font size and baseline. The demo converts CSS pixels using devicePixelRatio and rerenders on resize. The core exposes `capabilities` with `version`, `v40`, `harmony`, and `nativeFilter`.

## Rendering paths

- **LCD:** load a glyph with `FT_LOAD_TARGET_LCD` or `LCD_V` and no embedded bitmap. FreeType runs hinting at the requested ppem. Scale the resulting outline 3× along the stripe axis using `FT_Outline_Transform`, rasterize it in grayscale, then apply a five-tap FIR across sample boundaries. Decode samples into R/G/B coverage and composite channels independently. Default weights are `[8,77,86,77,8]/256`; Light is `[0,85,86,85,0]/256`. Custom weights are floating-point normalized and may intentionally break symmetry or color balance.
- **Harmony:** native `FT_RENDER_MODE_LCD` / `LCD_V` with `FT_Library_SetLcdGeometry`. Geometry choices use 26.6 stripe offsets or the experimental PenTile-style example from FreeType's documentation. BGR swaps output channels.
- **Grayscale:** native FreeType grayscale rasterization, with equal coverage in all three channels.

The pinned WASM release is compiled with **Harmony**, not native ClearType-style filtering. `FT_Library_SetLcdFilter` returns error 7 (unimplemented). The separate JavaScript-filtered LCD path is intentional; no native filter availability is claimed. FreeType's TrueType interpreter is explicitly configured to version 40 via `FT_Property_Set`. This does not turn CFF fonts into TrueType fonts, nor guarantee identical Windows hinting/layout.

The wrapper omits the glyph slot outline offset. For the pinned FreeType 2.14.3 wasm32 ABI, the renderer derives it as `bitmap_top + sizeof(FT_Int)` (108). Review this assumption when upgrading the WASM build. Bitmap rows are copied using signed native pitch before filtering; glyph bearings and fractional horizontal offsets are preserved.

The gamma slider uses a power-law transfer function: decode each channel as `(value/255)^gamma`, blend in that space, then encode. This is an adjustable approximation, not the exact sRGB piecewise transfer function. Opaque output is required because RGBA alpha cannot represent three independent channel alphas.

## Limits

This mimics ClearType's subpixel mechanism; it is not Microsoft's proprietary renderer or an implementation of Platt's optimization algorithm. Physical panel geometry, browser compositing, OS scaling, zoom, and display orientation affect the result. Inspect at 100% zoom and native resolution. Export retains backing-store pixels; scaling the export can destroy subpixel alignment.

TTF, OTF and WOFF outline fonts are accepted when both libraries support them. General complex-script shaping, bidirectional layout, color glyphs, WOFF2 decompression and variable-font axis controls are not provided. The UI is a fixed-height specimen viewport, so long samples can be clipped; the API lets callers choose dimensions. Word wrapping uses OpenType advances, with per-glyph breaks for oversized words. Fractional horizontal positioning is supported; baselines are snapped to integer pixels. Text size, canvas dimensions and upload size are bounded in the demo/API.

## References and notices

- [OpenType.js](https://github.com/opentypejs/opentype.js)
- [FreeType WASM](https://github.com/zkl2333/freetype-wasm)
- [FreeType subpixel rendering](https://freetype.org/freetype2/docs/reference/ft2-lcd_rendering.html)
- [Pinned FreeType glyph slot definition](https://github.com/freetype/freetype/blob/VER-2-14-3/include/freetype/freetype.h)

Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.

Bundled native dependency notices are copied to `vendor/freetype/licenses/`. OpenType.js's MIT license is copied to `vendor/OPENTYPE-LICENSE`. Lato is distributed under the SIL Open Font License, included in `public/fonts/OFL.txt`.
