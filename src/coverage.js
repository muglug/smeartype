/** Convert FreeType sample lattices into independent R/G/B coverage planes.
 * Origins are in sample units; bearings are handled before decimation.
 * Filtering crosses pixel boundaries, with zero coverage outside the bitmap.
 */
export const FILTERS = {
  default: [8, 77, 86, 77, 8],
  light: [0, 85, 86, 85, 0],
  none: null,
};
export function bitmapCoverage(bitmap, { axis = 'gray', raw = false, weights = null } = {}) {
  const sx = axis === 'horizontal' ? 3 : 1;
  const sy = axis === 'vertical' ? 3 : 1;
  const ox = bitmap.bitmapLeft * (raw ? 1 : sx);
  const oy = -bitmap.bitmapTop * (raw ? 1 : sy);
  const pad = weights ? 2 : 0;
  const left = Math.floor((ox - (sx === 3 ? pad : 0)) / sx);
  const top = Math.floor((oy - (sy === 3 ? pad : 0)) / sy);
  const width = Math.ceil((ox + bitmap.width + (sx === 3 ? pad : 0)) / sx) - left;
  const height = Math.ceil((oy + bitmap.rows + (sy === 3 ? pad : 0)) / sy) - top;
  const coverage = new Float32Array(width * height * 3);
  function sample(x, y) {
    x -= ox; y -= oy;
    if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.rows) return 0;
    // The reader normalizes rows to top-down positive pitch.
    return bitmap.buffer[y * bitmap.pitch + x] / 255;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    const px = (left + x) * sx + (sx === 3 ? c : 0);
    const py = (top + y) * sy + (sy === 3 ? c : 0);
    let value = sample(px, py);
    if (weights) {
      value = 0;
      for (let k = 0; k < 5; k++) value += weights[k] / 256 * sample(px + (sx === 3 ? k - 2 : 0), py + (sy === 3 ? k - 2 : 0));
    }
    coverage[(y * width + x) * 3 + c] = Math.min(1, value);
  }
  return { left, top, width, height, coverage };
}
export function normalizeWeights(values) {
  if (values.length !== 5 || values.some(v => !Number.isFinite(v) || v < 0) || !values.some(v => v > 0)) throw new Error('Enter five nonnegative weights with a positive sum.');
  const sum = values.reduce((a,b) => a+b, 0);
  return values.map(v => v / sum * 256);
}
export function parseColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Colors must use #RRGGBB.');
  return [1,3,5].map(i => parseInt(hex.slice(i, i+2), 16));
}
export function composite(target, width, height, tile, x, y, { foreground, gamma = 2.2, order = 'rgb', strength = 1 }) {
  for (let ty = 0; ty < tile.height; ty++) for (let tx = 0; tx < tile.width; tx++) {
    const dx = x + tile.left + tx, dy = y + tile.top + ty;
    if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
    const dest = (dy * width + dx) * 4, src = (ty * tile.width + tx) * 3;
    for (let c = 0; c < 3; c++) {
      const alpha = Math.min(1, tile.coverage[src + (order === 'bgr' ? 2-c : c)] * strength);
      const bg = (target[dest+c] / 255) ** gamma;
      const fg = (foreground[c] / 255) ** gamma;
      target[dest+c] = Math.round(255 * (fg * alpha + bg * (1-alpha)) ** (1/gamma));
    }
  }
}
