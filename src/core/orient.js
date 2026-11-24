/**
 * Patient-orientation helpers shared by the DICOM and NIfTI loaders.
 *
 * Input array axes are (i = columns, j = rows, k = slices). Each axis has a
 * direction vector in DICOM patient space (LPS: +x = LEFT, +y = POSTERIOR,
 * +z = SUPERIOR). The output volume always uses canonical axes
 * x = LEFT, y = POSTERIOR, z = SUPERIOR.
 */

const EPS = 1e-6;

/**
 * Compute how acquisition axes (i, j, k) map onto canonical patient axes.
 *
 * @param {number[]} rowDir direction of increasing i
 * @param {number[]} colDir direction of increasing j
 * @param {number[]} normal direction of increasing k
 * @param {number[]} sizes acquisition sizes [nx, ny, nz]
 */
export function resolveOrientation(rowDir, colDir, normal, sizes) {
  const dirs = [rowDir, colDir, normal].map((vector) => {
    let axis = 0;
    for (let a = 1; a < 3; a++) if (Math.abs(vector[a]) > Math.abs(vector[axis]) + EPS) axis = a;
    return { axis, sign: vector[axis] < 0 ? -1 : 1 };
  });

  const isPermutation = new Set(dirs.map((d) => d.axis)).size === 3;

  // Which acquisition axis fills each canonical (x, y, z) slot.
  const sourceAxes = isPermutation
    ? [0, 1, 2].map((canonical) => dirs.findIndex((d) => d.axis === canonical))
    : [0, 1, 2];

  const flips = sourceAxes.map((srcIndex) => dirs[srcIndex].sign < 0);
  const outDims = sourceAxes.map((srcIndex) => sizes[srcIndex]);

  return { sourceAxes, flips, outDims, isPermutation };
}

/**
 * Reorder / mirror a voxel array into the canonical patient frame.
 *
 * @param {object} opts
 * @param {ArrayBufferView} opts.data flat [(k * ny + j) * nx + i] samples
 * @param {[number, number, number]} opts.sizes [nx, ny, nz]
 * @param {[number, number, number]} opts.spacing
 * @param {[number[], number[], number[]]} opts.directions LPS direction of i, j, k
 * @returns {{data: ArrayBufferView, sizes: [number,number,number], spacing: [number,number,number], isPermutation: boolean}}
 */
export function orientArray({ data, sizes, spacing, directions }) {
  const map = resolveOrientation(directions[0], directions[1], directions[2], sizes);
  const [ox, oy, oz] = sizes;
  const [dx, dy, dz] = map.outDims;
  const [sx, sy, sz] = map.sourceAxes;
  const [fx, fy, fz] = map.flips;
  const out = new data.constructor(dx * dy * dz);

  for (let z = 0; z < dz; z++) {
    const kz = fz ? oz - 1 - z : z;
    for (let y = 0; y < dy; y++) {
      const ky = fy ? oy - 1 - y : y;
      for (let x = 0; x < dx; x++) {
        const kx = fx ? ox - 1 - x : x;
        const src = [0, 0, 0];
        src[sx] = kx;
        src[sy] = ky;
        src[sz] = kz;
        out[(z * dy + y) * dx + x] = data[(src[2] * oy + src[1]) * ox + src[0]];
      }
    }
  }

  return {
    data: out,
    sizes: [dx, dy, dz],
    spacing: map.sourceAxes.map((srcIndex) => Math.abs(spacing[srcIndex])),
    isPermutation: map.isPermutation,
    sourceAxes: map.sourceAxes,
    flips: map.flips,
  };
}

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
