/**
 * Classic, dependency-free segmentation used to turn a scan into a printable
 * mask: Otsu threshold, largest connected component, hole filling.
 *
 * This is intentionally a deterministic image-processing pipeline (not a
 * neural network): every step can be inspected, tuned and reproduced.
 */

/**
 * Otsu threshold from a histogram.
 * @param {Float64Array|number[]} counts
 * @param {number} min
 * @param {number} max
 */
export function otsuFromHistogram(counts, min, max) {
  const bins = counts.length;
  const step = (max - min) / (bins - 1 || 1);
  let total = 0;
  let sum = 0;
  for (let i = 0; i < bins; i++) {
    total += counts[i];
    sum += counts[i] * i;
  }
  if (!total) return min;

  let sumB = 0;
  let wB = 0;
  let bestLow = 0;
  let bestHigh = 0;
  let bestVariance = -1;
  for (let i = 0; i < bins; i++) {
    wB += counts[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += counts[i] * i;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > bestVariance + 1e-12) {
      bestVariance = variance;
      bestLow = i;
      bestHigh = i;
    } else if (variance >= bestVariance - 1e-12) {
      bestHigh = i;
    }
  }
  // Bimodal images leave a plateau of equally good splits; take its middle so
  // the threshold sits between the two peaks instead of on the lower one.
  return min + ((bestLow + bestHigh) / 2) * step;
}

/**
 * Threshold a volume in physical units.
 * @param {import('../core/volume.js').Volume} volume
 * @param {number} threshold
 * @param {{invert?: boolean}} [opts]
 * @returns {Uint8Array}
 */
export function thresholdMask(volume, threshold, { invert = false } = {}) {
  const { data, slope, intercept, nx, ny, nz } = volume;
  const mask = new Uint8Array(data.length);
  // compare in raw units to avoid a multiply per voxel
  const rawThreshold = slope !== 0 ? (threshold - intercept) / slope : threshold;
  const above = slope >= 0;
  for (let i = 0; i < data.length; i++) {
    const inside = above ? data[i] >= rawThreshold : data[i] <= rawThreshold;
    mask[i] = inside !== invert ? 1 : 0;
  }
  void nx;
  void ny;
  void nz;
  return mask;
}

/**
 * Keep only the largest 26-connected component.
 * @param {Uint8Array} mask
 * @param {[number, number, number]} dims
 * @returns {Uint8Array}
 */
export function largestComponent(mask, dims) {
  const [nx, ny, nz] = dims;
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  let bestLabel = 0;
  let bestSize = 0;
  let label = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const index = queue[head++];
      const z = Math.floor(index / (nx * ny));
      const rem = index - z * nx * ny;
      const y = Math.floor(rem / nx);
      const x = rem - y * nx;
      for (let dz = -1; dz <= 1; dz++) {
        const kk = z + dz;
        if (kk < 0 || kk >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const jj = y + dy;
          if (jj < 0 || jj >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const ii = x + dx;
            if (ii < 0 || ii >= nx) continue;
            const neighbour = (kk * ny + jj) * nx + ii;
            if (mask[neighbour] && !labels[neighbour]) {
              labels[neighbour] = label;
              queue[tail++] = neighbour;
            }
          }
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      bestLabel = label;
    }
  }

  const out = new Uint8Array(mask.length);
  if (!bestLabel) return out;
  for (let i = 0; i < labels.length; i++) out[i] = labels[i] === bestLabel ? 1 : 0;
  return out;
}

/**
 * Fill enclosed background regions slice by slice (axial).
 * @param {Uint8Array} mask
 * @param {[number, number, number]} dims
 * @returns {Uint8Array}
 */
export function fillHoles(mask, dims) {
  const [nx, ny, nz] = dims;
  const out = Uint8Array.from(mask);
  const sliceSize = nx * ny;
  const queue = new Int32Array(sliceSize);
  const seen = new Uint8Array(sliceSize);

  for (let z = 0; z < nz; z++) {
    const base = z * sliceSize;
    seen.fill(0);
    let head = 0;
    let tail = 0;
    const push = (index) => {
      if (out[base + index] || seen[index]) return;
      seen[index] = 1;
      queue[tail++] = index;
    };
    for (let x = 0; x < nx; x++) {
      push(x);
      push((ny - 1) * nx + x);
    }
    for (let y = 0; y < ny; y++) {
      push(y * nx);
      push(y * nx + nx - 1);
    }
    while (head < tail) {
      const index = queue[head++];
      const y = Math.floor(index / nx);
      const x = index - y * nx;
      if (x > 0) push(index - 1);
      if (x < nx - 1) push(index + 1);
      if (y > 0) push(index - nx);
      if (y < ny - 1) push(index + nx);
    }
    for (let i = 0; i < sliceSize; i++) if (!seen[i] && !out[base + i]) out[base + i] = 1;
  }
  return out;
}

/** Tight bounding box of a mask, inclusive. */
export function maskBounds(mask, dims) {
  const [nx, ny, nz] = dims;
  let minX = nx;
  let minY = ny;
  let minZ = nz;
  let maxX = -1;
  let maxY = -1;
  let maxZ = -1;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const row = (z * ny + y) * nx;
      for (let x = 0; x < nx; x++) {
        if (!mask[row + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** Crop a mask to the bounds returned by {@link maskBounds}. */
export function cropMask(mask, dims, bounds) {
  const [nx, ny] = dims;
  const w = bounds.maxX - bounds.minX + 1;
  const h = bounds.maxY - bounds.minY + 1;
  const d = bounds.maxZ - bounds.minZ + 1;
  const out = new Uint8Array(w * h * d);
  for (let z = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      const srcRow = ((bounds.minZ + z) * ny + (bounds.minY + y)) * nx + bounds.minX;
      out.set(mask.subarray(srcRow, srcRow + w), (z * h + y) * w);
    }
  }
  return { mask: out, dims: [w, h, d] };
}

/**
 * Full pipeline: threshold (auto Otsu or manual) + cleanup.
 *
 * @param {import('../core/volume.js').Volume} volume
 * @param {object} [opts]
 * @param {'auto'|'manual'} [opts.mode]
 * @param {number} [opts.threshold] used when mode is 'manual'
 * @param {boolean} [opts.keepLargest]
 * @param {boolean} [opts.fill]
 * @returns {{mask: Uint8Array, dims: [number,number,number], threshold: number, otsu: number, coverage: number}}
 */
export function segmentVolume(volume, opts = {}) {
  const { mode = 'auto', threshold, keepLargest = true, fill = true } = opts;
  const { counts, min, max } = volume.histogram(512);
  const otsu = otsuFromHistogram(counts, min, max);
  const level = mode === 'manual' && Number.isFinite(threshold) ? threshold : otsu;

  let mask = thresholdMask(volume, level);
  const dims = [volume.nx, volume.ny, volume.nz];
  if (keepLargest) mask = largestComponent(mask, dims);
  if (fill) mask = fillHoles(mask, dims);

  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];

  return { mask, dims, threshold: level, otsu, coverage: count / mask.length };
}

/**
 * Copy a mask into a larger array with one empty voxel on every side.
 *
 * Marching tetrahedra can only close a surface where an "outside" sample
 * exists, so a mask that touches the volume border would otherwise produce an
 * open shell. Print pipelines always route masks through here.
 *
 * @param {Uint8Array} mask
 * @param {[number, number, number]} dims
 * @param {number} [border] voxels of empty padding
 * @returns {{mask: Uint8Array, dims: [number, number, number]}}
 */
export function padMask(mask, dims, border = 1) {
  const [nx, ny, nz] = dims;
  const w = nx + border * 2;
  const h = ny + border * 2;
  const d = nz + border * 2;
  const out = new Uint8Array(w * h * d);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const src = (z * ny + y) * nx;
      const dst = ((z + border) * h + (y + border)) * w + border;
      out.set(mask.subarray(src, src + nx), dst);
    }
  }
  return { mask: out, dims: [w, h, d] };
}
