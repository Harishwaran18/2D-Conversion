/**
 * Cut a closed triangle mesh with an axis-aligned plane and chain the resulting
 * segments into polylines, which is how the 2D print outlines are produced.
 */

import { simplifyPolyline } from './decimate.js';

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/**
 * @param {import('./mesh.js').Mesh} mesh
 * @param {'x'|'y'|'z'} axis
 * @param {number} position plane position in millimetres
 * @param {{tolerance?: number, minLength?: number}} [opts]
 * @returns {number[][][]} list of closed/open polylines in the plane's 2D coordinates
 */
export function sliceMesh(mesh, axis, position, { tolerance = 0, minLength = 0 } = {}) {
  const axisIndex = AXIS_INDEX[axis];
  if (axisIndex === undefined) throw new Error(`Unknown axis ${axis}`);
  const u = (axisIndex + 1) % 3;
  const v = (axisIndex + 2) % 3;

  const p = mesh.positions;
  const idx = mesh.indices;
  const segments = [];
  const eps = 1e-9;
  // Nudge the cutting plane off the isosurface's grid so no vertex lands on it
  // exactly; a vertex sitting on the plane otherwise splits the contour ring.
  const level = position + 1e-3;

  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t] * 3;
    const ib = idx[t + 1] * 3;
    const ic = idx[t + 2] * 3;
    const da = p[ia + axisIndex] - level;
    const db = p[ib + axisIndex] - level;
    const dc = p[ic + axisIndex] - level;

    const points = [];
    const edge = (i0, i1, d0, d1) => {
      if ((d0 > 0 && d1 > 0) || (d0 < 0 && d1 < 0) || (Math.abs(d0) < eps && Math.abs(d1) < eps)) return;
      const denom = d0 - d1;
      const s = Math.abs(denom) < eps ? 0.5 : d0 / denom;
      points.push([p[i0 + u] + (p[i1 + u] - p[i0 + u]) * s, p[i0 + v] + (p[i1 + v] - p[i0 + v]) * s]);
    };
    edge(ia, ib, da, db);
    edge(ib, ic, db, dc);
    edge(ic, ia, dc, da);
    if (points.length === 2) segments.push(points);
  }

  const polylines = chainSegments(segments);
  const out = [];
  for (const line of polylines) {
    if (line.length < 2) continue;
    const simplified = tolerance > 0 ? simplifyPolyline(line, tolerance) : line;
    if (minLength > 0 && polylineLength(simplified) < minLength) continue;
    out.push(simplified);
  }
  return out;
}

/**
 * Join 2D segments that share endpoints into polylines.
 * @param {number[][][]} segments
 * @returns {number[][][]}
 */
export function chainSegments(segments) {
  const scale = 1e5;
  const points = [];
  const lookup = new Map();
  const keyOf = (point) => `${Math.round(point[0] * scale)},${Math.round(point[1] * scale)}`;
  const pointIndex = (point) => {
    const key = keyOf(point);
    let index = lookup.get(key);
    if (index === undefined) {
      index = points.length;
      points.push([point[0], point[1]]);
      lookup.set(key, index);
    }
    return index;
  };

  const edges = segments.map(([a, b]) => [pointIndex(a), pointIndex(b)]);
  /** @type {Map<number, number[]>} */
  const adjacency = new Map();
  edges.forEach(([a, b], id) => {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push(id);
    adjacency.get(b).push(id);
  });

  const used = new Uint8Array(edges.length);
  const polylines = [];

  const extend = (startVertex, chain) => {
    let current = startVertex;
    for (;;) {
      const candidates = adjacency.get(current) || [];
      let nextEdge = -1;
      for (const id of candidates) if (!used[id]) nextEdge = id;
      if (nextEdge < 0) break;
      used[nextEdge] = 1;
      const [a, b] = edges[nextEdge];
      current = a === current ? b : a;
      chain.push(points[current]);
      if (adjacency.get(current)?.length !== 2) break;
    }
  };

  for (let id = 0; id < edges.length; id++) {
    if (used[id]) continue;
    used[id] = 1;
    const [a, b] = edges[id];
    const chain = [points[a], points[b]];
    extend(b, chain);
    const forward = chain.slice();
    const backward = [points[a]];
    extend(a, backward);
    backward.reverse();
    backward.pop();
    polylines.push([...backward, ...forward]);
  }

  return polylines;
}

export function polylineLength(line) {
  let length = 0;
  for (let i = 1; i < line.length; i++) length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return length;
}
