/**
 * Mesh decimation by vertex clustering and polyline simplification by
 * Douglas-Peucker.
 */

import { Mesh } from './mesh.js';

/**
 * Merge vertices that fall into the same grid cell. Fast, and good enough for
 * print preparation because the input is already smoothed.
 *
 * @param {Mesh} mesh
 * @param {number} cellSize millimetres
 * @returns {Mesh}
 */
export function clusterDecimate(mesh, cellSize) {
  if (mesh.vertexCount === 0 || cellSize <= 0) return mesh;
  const { min, max } = mesh.bounds();
  const gx = Math.max(1, Math.ceil((max[0] - min[0]) / cellSize) + 2);
  const gy = Math.max(1, Math.ceil((max[1] - min[1]) / cellSize) + 2);

  const cellOf = new Int32Array(mesh.vertexCount);
  const sums = new Map();
  const positions = mesh.positions;

  for (let v = 0; v < mesh.vertexCount; v++) {
    const ix = Math.floor((positions[v * 3] - min[0]) / cellSize) + 1;
    const iy = Math.floor((positions[v * 3 + 1] - min[1]) / cellSize) + 1;
    const iz = Math.floor((positions[v * 3 + 2] - min[2]) / cellSize) + 1;
    const key = ix + iy * gx + iz * gx * gy;
    cellOf[v] = key;
    let acc = sums.get(key);
    if (!acc) {
      acc = [0, 0, 0, 0];
      sums.set(key, acc);
    }
    acc[0] += positions[v * 3];
    acc[1] += positions[v * 3 + 1];
    acc[2] += positions[v * 3 + 2];
    acc[3] += 1;
  }

  const indexOfCell = new Map();
  const outPositions = new Float64Array(sums.size * 3);
  let cursor = 0;
  for (const [key, [sx, sy, sz, count]] of sums) {
    indexOfCell.set(key, cursor / 3);
    outPositions[cursor++] = sx / count;
    outPositions[cursor++] = sy / count;
    outPositions[cursor++] = sz / count;
  }

  const indices = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = indexOfCell.get(cellOf[mesh.indices[t]]);
    const b = indexOfCell.get(cellOf[mesh.indices[t + 1]]);
    const c = indexOfCell.get(cellOf[mesh.indices[t + 2]]);
    if (a === b || b === c || a === c) continue;
    indices.push(a, b, c);
  }

  return new Mesh(outPositions, indices);
}

/**
 * Douglas-Peucker simplification of a closed or open polyline.
 * @param {number[][]} points
 * @param {number} tolerance
 */
export function simplifyPolyline(points, tolerance) {
  if (points.length < 3 || tolerance <= 0) return points;
  const closed = samePoint(points[0], points[points.length - 1]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const dist = pointSegmentDistance(points[i], points[first], points[last]);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (maxDist > tolerance && index > -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  if (closed && out.length > 1 && !samePoint(out[0], out[out.length - 1])) out.push(out[0]);
  return out;
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Signed area of a closed polygon (positive = counter-clockwise). */
export function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return area / 2;
}
