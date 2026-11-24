/**
 * Small separable filters used before tracing or measuring.
 */

/**
 * Gaussian blur of a scalar image. Used to suppress film grain before
 * contouring so a photograph traces as shapes instead of noise.
 *
 * @param {ArrayLike<number>} values row-major samples
 * @param {number} width
 * @param {number} height
 * @param {number} [sigma] in pixels
 * @returns {Float32Array}
 */
export function gaussianBlur2D(values, width, height, sigma = 1) {
  if (!(sigma > 0)) return Float32Array.from(values);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = weight;
    sum += weight;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const temp = new Float32Array(values.length);
  const out = new Float32Array(values.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        acc += values[row + sx] * kernel[k + radius];
      }
      temp[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        acc += temp[sy * width + x] * kernel[k + radius];
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}
