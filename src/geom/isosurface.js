/**
 * Isosurface extraction with marching tetrahedra.
 *
 * Chosen over marching cubes because it needs no 256-entry lookup table, is
 * always watertight, and produces triangles that share vertices (so smoothing
 * and normal estimation behave well).
 *
 * The six tetrahedra are the Kuhn subdivision of a cube along its 0-7 diagonal,
 * which keeps every diagonal consistent between neighbouring cells.
 */

import { Mesh } from './mesh.js';

/** Cube corner offsets, index = x + 2y + 4z. */
const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
];

/** Kuhn decomposition: all tetrahedra share the 0-7 diagonal. */
const TETS = [
  [0, 1, 3, 7],
  [0, 1, 5, 7],
  [0, 2, 3, 7],
  [0, 2, 6, 7],
  [0, 4, 5, 7],
  [0, 4, 6, 7],
];

/**
 * @param {ArrayLike<number>} field scalar field, indexed [(k * ny + j) * nx + i]
 * @param {[number, number, number]} dims
 * @param {[number, number, number]} spacing millimetres per voxel
 * @param {object} [opts]
 * @param {number} [opts.level] isovalue (default 0.5 for binary masks)
 * @param {[number, number, number]} [opts.origin] world offset in mm
 * @param {(fraction: number) => void} [opts.onProgress]
 * @returns {Mesh}
 */
export function isosurface(field, dims, spacing, opts = {}) {
  const { level = 0.5, origin = [0, 0, 0], onProgress } = opts;
  const [nx, ny, nz] = dims;
  const positions = [];
  const indices = [];
  /** @type {Map<number, number>} */
  const vertexCache = new Map();
  const stride = nx * ny;
  const voxels = nx * ny * nz;

  const pointFor = (voxelA, voxelB) => {
    const key = voxelA < voxelB ? voxelA * voxels + voxelB : voxelB * voxels + voxelA;
    const cached = vertexCache.get(key);
    if (cached !== undefined) return cached;

    const valueA = field[voxelA];
    const valueB = field[voxelB];
    const denom = valueB - valueA;
    const t = denom === 0 ? 0.5 : (level - valueA) / denom;
    const ax = voxelA % nx;
    const ay = Math.floor((voxelA % stride) / nx);
    const az = Math.floor(voxelA / stride);
    const bx = voxelB % nx;
    const by = Math.floor((voxelB % stride) / nx);
    const bz = Math.floor(voxelB / stride);
    const index = positions.length / 3;
    positions.push(
      (ax + (bx - ax) * t) * spacing[0] + origin[0],
      (ay + (by - ay) * t) * spacing[1] + origin[1],
      (az + (bz - az) * t) * spacing[2] + origin[2]
    );
    vertexCache.set(key, index);
    return index;
  };

  const cornerValue = new Float64Array(8);
  const cornerIndex = new Int32Array(8);
  const ctx = { cornerIndex, cornerValue, level, positions, indices, pointFor, spacing, origin, nx, stride };

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let insideCount = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNERS[c];
          const index = (k + dz) * stride + (j + dy) * nx + (i + dx);
          cornerIndex[c] = index;
          cornerValue[c] = field[index];
          if (cornerValue[c] >= level) insideCount++;
        }
        if (insideCount === 0 || insideCount === 8) continue;

        for (const tet of TETS) emitTet(tet, ctx);
      }
    }
    if (onProgress) onProgress((k + 1) / Math.max(1, nz - 1));
  }

  const mesh = new Mesh(positions, indices);
  if (mesh.signedVolume() < 0) mesh.flipWinding();
  return mesh;
}

/**
 * Emit the triangles produced by one tetrahedron.
 *
 * A tetrahedron has 6 edges, so the crossing ring is built from the mixed
 * inside/outside pairs directly. Winding is then fixed per triangle with the
 * inside -> outside direction.
 *
 * @param {number[]} tet four cube-corner ids
 * @param {object} ctx
 */
function emitTet(tet, ctx) {
  const { cornerIndex, cornerValue, level, positions, indices, pointFor, spacing, origin } = ctx;
  const inside = [];
  const outside = [];
  for (const c of tet) (cornerValue[c] >= level ? inside : outside).push(c);
  if (inside.length === 0 || inside.length === 4) return;

  const crossPoint = (a, b) => pointFor(cornerIndex[a], cornerIndex[b]);
  let ring;
  if (inside.length === 1) {
    const [a] = inside;
    ring = outside.map((o) => crossPoint(a, o));
  } else if (inside.length === 3) {
    const [d] = outside;
    ring = inside.map((i) => crossPoint(d, i));
  } else {
    const [a, b] = inside;
    const [x, y] = outside;
    ring = [crossPoint(a, x), crossPoint(b, x), crossPoint(b, y), crossPoint(a, y)];
  }

  const world = (c) => {
    const voxel = cornerIndex[c];
    return [
      (voxel % ctx.nx) * spacing[0] + origin[0],
      Math.floor((voxel % ctx.stride) / ctx.nx) * spacing[1] + origin[1],
      Math.floor(voxel / ctx.stride) * spacing[2] + origin[2],
    ];
  };

  const insideCentre = [0, 0, 0];
  const outsideCentre = [0, 0, 0];
  for (const c of inside) {
    const p = world(c);
    insideCentre[0] += p[0];
    insideCentre[1] += p[1];
    insideCentre[2] += p[2];
  }
  for (const c of outside) {
    const p = world(c);
    outsideCentre[0] += p[0];
    outsideCentre[1] += p[1];
    outsideCentre[2] += p[2];
  }

  const direction = [
    outsideCentre[0] / outside.length - insideCentre[0] / inside.length,
    outsideCentre[1] / outside.length - insideCentre[1] / inside.length,
    outsideCentre[2] / outside.length - insideCentre[2] / inside.length,
  ];

  const triangles =
    ring.length === 3
      ? [[ring[0], ring[1], ring[2]]]
      : [
          [ring[0], ring[1], ring[2]],
          [ring[0], ring[2], ring[3]],
        ];

  for (const [ia, ib, ic] of triangles) {
    if (ia === ib || ib === ic || ia === ic) continue;
    const ax = positions[ia * 3];
    const ay = positions[ia * 3 + 1];
    const az = positions[ia * 3 + 2];
    const ux = positions[ib * 3] - ax;
    const uy = positions[ib * 3 + 1] - ay;
    const uz = positions[ib * 3 + 2] - az;
    const vx = positions[ic * 3] - ax;
    const vy = positions[ic * 3 + 1] - ay;
    const vz = positions[ic * 3 + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const dot = nx * direction[0] + ny * direction[1] + nz * direction[2];
    if (dot >= 0) indices.push(ia, ib, ic);
    else indices.push(ia, ic, ib);
  }
}
