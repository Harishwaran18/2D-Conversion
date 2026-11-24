/**
 * Hollow shells for 3D printing.
 *
 * The inner wall is an isosurface of the Euclidean distance transform, which
 * gives a true offset surface without the self-intersections that pushing
 * vertices along their normals produces on bumpy anatomy.
 */

import { Mesh } from './mesh.js';
import { isosurface } from './isosurface.js';
import { distanceTransform } from './edt.js';

/**
 * Build the inner wall of a mask.
 *
 * @param {Uint8Array} mask
 * @param {[number, number, number]} dims
 * @param {[number, number, number]} spacing
 * @param {number} thickness millimetres
 * @param {[number, number, number]} origin world offset in mm
 * @returns {Mesh|null} inner shell, or null when the structure is thinner than
 *   the requested wall
 */
export function buildInnerSurface(mask, dims, spacing, thickness, origin = [0, 0, 0]) {
  if (!(thickness > 0)) return null;
  const distance = distanceTransform(mask, dims, spacing);
  let maxDistance = 0;
  for (let i = 0; i < distance.length; i++) if (distance[i] > maxDistance) maxDistance = distance[i];
  if (maxDistance <= thickness) return null;
  const mesh = isosurface(distance, dims, spacing, { level: thickness, origin });
  return mesh.triangleCount ? mesh : null;
}

/**
 * Combine an outer shell with its inner wall. The inner wall is flipped so its
 * normals point into the cavity, which is what slicers expect for a hollow part.
 *
 * @param {Mesh} outer
 * @param {Mesh|null} inner
 * @returns {{mesh: Mesh, hollowed: boolean}}
 */
export function combineShells(outer, inner) {
  if (!inner || inner.triangleCount === 0) return { mesh: outer, hollowed: false };
  const flipped = new Mesh(inner.positions, inner.indices).flipWinding();
  return { mesh: outer.merge(flipped), hollowed: true };
}
