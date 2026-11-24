/**
 * Taubin (λ/μ) smoothing: removes the voxel staircase of isosurfaces without
 * the shrinkage that plain Laplacian smoothing causes.
 */

import { Mesh, buildAdjacency } from './mesh.js';

/**
 * @param {Mesh} mesh
 * @param {object} [opts]
 * @param {number} [opts.iterations]
 * @param {number} [opts.lambda]
 * @param {number} [opts.mu]
 * @returns {Mesh}
 */
export function smoothMesh(mesh, { iterations = 10, lambda = 0.5, mu = -0.53 } = {}) {
  const positions = Float64Array.from(mesh.positions);
  if (mesh.vertexCount === 0) return mesh;
  const { offsets, neighbours } = buildAdjacency(mesh);
  const temp = new Float64Array(positions.length);

  const pass = (factor) => {
    for (let v = 0; v < mesh.vertexCount; v++) {
      const start = offsets[v];
      const end = offsets[v + 1];
      const count = end - start;
      if (count === 0) {
        temp[v * 3] = positions[v * 3];
        temp[v * 3 + 1] = positions[v * 3 + 1];
        temp[v * 3 + 2] = positions[v * 3 + 2];
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let n = start; n < end; n++) {
        const nb = neighbours[n] * 3;
        sx += positions[nb];
        sy += positions[nb + 1];
        sz += positions[nb + 2];
      }
      const ix = v * 3;
      temp[ix] = positions[ix] + factor * (sx / count - positions[ix]);
      temp[ix + 1] = positions[ix + 1] + factor * (sy / count - positions[ix + 1]);
      temp[ix + 2] = positions[ix + 2] + factor * (sz / count - positions[ix + 2]);
    }
    positions.set(temp);
  };

  for (let it = 0; it < iterations; it++) {
    pass(lambda);
    pass(mu);
  }

  return new Mesh(positions, mesh.indices);
}

/**
 * Map a 0..1 "smoothing" control value to Taubin iterations.
 * @param {number} strength
 */
export function smoothingIterations(strength) {
  const s = Math.min(1, Math.max(0, strength));
  return Math.round(s * 40);
}
