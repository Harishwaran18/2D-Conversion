/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
 *
 * Returns the distance, in millimetres, from every foreground voxel to the
 * nearest background voxel (background is 0). Voxels outside the array count as
 * background.
 */

/**
 * @param {Uint8Array} mask
 * @param {[number, number, number]} dims
 * @param {[number, number, number]} spacing
 * @returns {Float32Array}
 */
export function distanceTransform(mask, dims, spacing) {
  const [nx, ny, nz] = dims;
  const INF = 1e20;
  const grid = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) grid[i] = mask[i] ? INF : 0;

  const line = new Float64Array(Math.max(nx, ny, nz));
  const out = new Float64Array(Math.max(nx, ny, nz));
  const stride = nx * ny;

  // x
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const base = z * stride + y * nx;
      for (let x = 0; x < nx; x++) line[x] = grid[base + x];
      distance1d(line, nx, spacing[0], out);
      for (let x = 0; x < nx; x++) grid[base + x] = out[x];
    }
  }
  // y
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const base = z * stride + x;
      for (let y = 0; y < ny; y++) line[y] = grid[base + y * nx];
      distance1d(line, ny, spacing[1], out);
      for (let y = 0; y < ny; y++) grid[base + y * nx] = out[y];
    }
  }
  // z
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const base = y * nx + x;
      for (let z = 0; z < nz; z++) line[z] = grid[base + z * stride];
      distance1d(line, nz, spacing[2], out);
      for (let z = 0; z < nz; z++) grid[base + z * stride] = out[z];
    }
  }

  const result = new Float32Array(mask.length);
  for (let i = 0; i < grid.length; i++) result[i] = Math.sqrt(Math.max(0, grid[i]));
  return result;
}

/** Squared 1-D distance transform of `f` into `out`. */
function distance1d(f, n, weight, out) {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const w2 = weight * weight;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + w2 * q * q - (f[v[k]] + w2 * v[k] * v[k])) / (2 * w2 * (q - v[k]));
    while (s <= z[k]) {
      k--;
      s = (f[q] + w2 * q * q - (f[v[k]] + w2 * v[k] * v[k])) / (2 * w2 * (q - v[k]));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    out[q] = w2 * dq * dq + f[v[k]];
  }
}
