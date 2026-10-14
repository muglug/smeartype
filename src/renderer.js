import initFreeType from '../vendor/freetype/index.mjs';
import * as opentype from '../vendor/opentype.mjs';
import { bitmapCoverage, composite, FILTERS, parseColor, normalizeWeights } from './coverage.js';

/** ClearType-style renderer. All dimensions are backing-store/device pixels.
 * Layout uses OpenType glyph IDs, advances, ligatures and pair kerning.
 * General complex-script shaping requires a HarfBuzz layout adapter.
 */
export class SubpixelRenderer {
  static async create(options) { return new SubpixelRenderer(await initFreeType(options)); }
  constructor(ft) {
    this.ft = ft; this.m = ft.module; this.cache = new Map(); this.face = null;
    this.call = (name, args, types = args.map(() => 'number')) => this.m.ccall(name, 'number', types, args);
    this.capabilities = { version: ft.version().join('.'), nativeFilter: this.call('FT_Library_SetLcdFilter', [ft.library, 1]) === 0 };
    // FreeType 2.14.3 wasm32 ABI: FT_Outline follows bitmap_top (FT_Int).
    // The pinned wrapper omits this field from its generated offsets.
    this.outlineOffset = ft.offsets.FT_GlyphSlotRec.bitmap_top + 4;
    this.scratch = this.m._malloc(40);
    this.m.setValue(this.scratch, 40, 'i32');
    this.capabilities.v40 = this.call('FT_Property_Set', [ft.library, 'truetype', 'interpreter-version', this.scratch], ['number','string','string','number']) === 0;
    this.setGeometry('stripe');
  }
  check(code, operation) { if (code) throw new Error(`${operation}: FreeType error ${code}`); }
  loadFont(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const parsed = opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    const face = this.ft.newFace(data);
    this.face?.destroy(); this.face = face; this.font = parsed; this.cache.clear();
    return face.info();
  }
  setGeometry(geometry) {
    const points = geometry === 'pentile' ? [[-11,16],[-11,-16],[21,0]] : [[-21,0],[0,0],[21,0]];
    points.flat().forEach((v,i) => this.m.setValue(this.scratch+i*4,v,'i32'));
    const code = this.call('FT_Library_SetLcdGeometry', [this.ft.library, this.scratch]);
    this.capabilities.harmony = code === 0;
    if (geometry === 'pentile') this.check(code, 'Harmony geometry');
  }
  readBitmap() {
    const { FT_FaceRec: F, FT_GlyphSlotRec: G, FT_Bitmap: B } = this.ft.offsets;
    const slot = this.m.getValue(this.face.ptr + F.glyph, 'i32');
    const bmp = slot + G.bitmap;
    const get = key => this.m.getValue(bmp + B[key], 'i32');
    const width = get('width'), rows = get('rows'), pitch = get('pitch'), ptr = get('buffer');
    const pixelMode = this.m.getValue(bmp + B.pixel_mode, 'i8');
    if (rows && ![2,5,6].includes(pixelMode)) throw new Error(`Unsupported bitmap pixel mode ${pixelMode}; use an outline font.`);
    const buffer = new Uint8Array(width * rows);
    for (let y=0; y<rows; y++) buffer.set(this.m.HEAPU8.subarray(ptr+y*pitch,ptr+y*pitch+width),y*width);
    return { width, rows, pitch: width, buffer, bitmapLeft: this.m.getValue(slot+G.bitmap_left,'i32'), bitmapTop: this.m.getValue(slot+G.bitmap_top,'i32') };
  }
  glyph(index, phase, options) {
    const { mode, axis, hinting, filter, weights } = options;
    const key = `${index}:${phase}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const lcd = mode !== 'gray';
    const vertical = axis === 'vertical';
    // FT_Set_Transform applies this fractional translation after grid fitting.
    this.m.setValue(this.scratch,phase,'i32'); this.m.setValue(this.scratch+4,0,'i32');
    this.call('FT_Set_Transform',[this.face.ptr,0,this.scratch]);
    const target = lcd ? (vertical ? 4 : 3) : 0;
    const flags = 8 | (hinting ? target << 16 : 2); // NO_BITMAP + target/NO_HINTING
    this.check(this.call('FT_Load_Glyph',[this.face.ptr,index,flags]),'Load glyph');
    const slot = this.m.getValue(this.face.ptr + this.ft.offsets.FT_FaceRec.glyph,'i32');
    if (mode === 'lcd') {
      // Scale the outline AFTER hinting at the requested ppem. This preserves
      // v40's vertical grid fitting instead of hinting a font at 3x the size.
      const matrix = [vertical ? 65536 : 196608, 0, 0, vertical ? 196608 : 65536];
      matrix.forEach((v,i) => this.m.setValue(this.scratch+i*4,v,'i32'));
      this.call('FT_Outline_Transform',[slot+this.outlineOffset,this.scratch]);
    }
    this.check(this.call('FT_Render_Glyph',[slot,mode === 'harmony' ? target : 0]),'Render glyph');
    const bitmap = this.readBitmap();
    const tile = bitmapCoverage(bitmap, { axis: lcd ? axis : 'gray', raw: mode === 'lcd', weights: mode === 'lcd' ? (filter === 'custom' ? weights : FILTERS[filter]) : null });
    this.cache.set(key,tile); return tile;
  }
  render({ text, width, height, size = 18, x = 20, baseline = 36, lineHeight = size * 1.65, mode = 'lcd', axis = 'horizontal', geometry = 'stripe', order = 'rgb', hinting = true, filter = 'default', weights = [8,77,86,77,8], gamma = 2.2, strength = 1, foreground = '#20231f', background = '#ffffff' }) {
    if (!this.face) throw new Error('Load a font before rendering.');
    if (![width,height].every(v => Number.isInteger(v) && v > 0 && v <= 8192) || width*height > 16000000) throw new Error('Canvas dimensions exceed the rendering limit.');
    if (!Number.isFinite(size) || size < 1 || size > 512 || !Number.isFinite(gamma) || gamma <= 0 || !Number.isFinite(strength) || strength < 0) throw new Error('Invalid rendering parameters.');
    if (!['lcd','harmony','gray'].includes(mode) || !['horizontal','vertical'].includes(axis) || !['rgb','bgr'].includes(order) || !['default','light','none','custom'].includes(filter)) throw new Error('Unknown rendering mode.');
    if (mode === 'harmony' && !this.capabilities.harmony) throw new Error('This FreeType build does not support Harmony.');
    const normalized = filter === 'custom' ? normalizeWeights(weights) : weights;
    this.setGeometry(geometry);
    this.face.setCharSize(0,Math.round(size*64),72,72);
    const config = { size, mode, axis, geometry, hinting, filter, weights: normalized };
    const signature = JSON.stringify(config);
    if (signature !== this.signature) { this.cache.clear(); this.signature = signature; }
    const fg = parseColor(foreground), bg = parseColor(background);
    const data = new Uint8ClampedArray(width*height*4);
    for (let i=0;i<data.length;i+=4) { data[i]=bg[0];data[i+1]=bg[1];data[i+2]=bg[2];data[i+3]=255; }
    let count = 0, missing = 0, cursorY = baseline;
    for (const line of text.replace(/\t/g,'    ').split('\n')) {
      let cursorX = x;
      const glyphs = this.font.stringToGlyphs(line);
      for (let i=0;i<glyphs.length;i++) {
        const glyph = glyphs[i];
        const advance = (glyph.advanceWidth || 0) * size / this.font.unitsPerEm;
        // Move a complete word to the next line when it fits there. Long
        // words retain the per-glyph fallback to keep the viewport bounded.
        if (glyph.unicode !== 32 && (i === 0 || glyphs[i-1].unicode === 32)) {
          let wordWidth = 0;
          for (let j=i; j<glyphs.length && glyphs[j].unicode !== 32; j++) {
            wordWidth += (glyphs[j].advanceWidth || 0) * size / this.font.unitsPerEm;
            if (j+1<glyphs.length && glyphs[j+1].unicode !== 32) wordWidth += this.font.getKerningValue(glyphs[j],glyphs[j+1]) * size / this.font.unitsPerEm;
          }
          if (cursorX > x && cursorX+wordWidth > width-x && wordWidth <= width-2*x) { cursorX=x; cursorY+=lineHeight; }
        }
        if (cursorX+advance > width-x && cursorX > x) { cursorX=x; cursorY+=lineHeight; }
        if (cursorY-size > height) break;
        const origin = Math.floor(cursorX);
        const tile = this.glyph(glyph.index,Math.round((cursorX-origin)*64),config);
        composite(data,width,height,tile,origin,Math.round(cursorY),{foreground:fg,gamma,order,strength});
        cursorX += advance;
        if (i+1<glyphs.length) cursorX += this.font.getKerningValue(glyph,glyphs[i+1]) * size / this.font.unitsPerEm;
        count++; if (glyph.index===0) missing++;
      }
      cursorY += lineHeight;
      if (cursorY-size > height) break;
    }
    return { data, width, height, glyphCount:count, missingGlyphs:missing };
  }
  draw(canvas, options) {
    const result = this.render({...options,width:canvas.width,height:canvas.height});
    canvas.getContext('2d').putImageData(new ImageData(result.data,result.width,result.height),0,0);
    return result;
  }
  destroy() { this.face?.destroy(); this.face=null;this.m._free(this.scratch);this.ft.destroy();this.cache.clear(); }
}
