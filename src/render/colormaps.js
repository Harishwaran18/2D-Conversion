/**
 * Intensity colormaps as 256-entry RGB lookup tables.
 */

const build = (fn) => {
  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = fn(i / 255);
    table[i * 3] = clamp(r);
    table[i * 3 + 1] = clamp(g);
    table[i * 3 + 2] = clamp(b);
  }
  return table;
};

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value * 255)));

export const COLORMAPS = {
  gray: build((t) => [t, t, t]),
  bone: build((t) => [Math.min(1, t * 1.08), Math.min(1, t * 1.02), Math.min(1, t * 0.94)]),
  hot: build((t) => [Math.min(1, t * 3), Math.max(0, Math.min(1, t * 3 - 1)), Math.max(0, t * 3 - 2)]),
  viridis: build((t) => [
    0.267 + t * 0.99,
    0.005 + t * 0.72,
    0.329 + t * 0.31,
  ]),
  turbo: build((t) => [
    0.19 + 1.3 * t - 0.6 * t * t,
    0.1 + 1.5 * t - 1.1 * t * t,
    0.4 + 2.2 * t - 3.4 * t * t + 1.2 * t * t * t,
  ]),
};

export function colormap(name) {
  return COLORMAPS[name] || COLORMAPS.gray;
}

/**
 * Map a scalar to an RGB triplet through a window/level.
 * @param {number} value
 * @param {number} center
 * @param {number} width
 * @param {Uint8Array} lut
 */
export function windowToRgb(value, center, width, lut) {
  const low = center - width / 2;
  const t = width === 0 ? 0.5 : (value - low) / width;
  const index = Math.max(0, Math.min(255, Math.round(t * 255)));
  return [lut[index * 3], lut[index * 3 + 1], lut[index * 3 + 2]];
}
