/**
 * 2D contours from a scalar image (marching squares). Used to turn a single
 * scan slice — or any ordinary photo or scan — into printable vector outlines.
 */

import { chainSegments } from './slice.js';
import { simplifyPolyline } from './decimate.js';

/**
 * Chaikin corner cutting: rounds the pixel staircase that marching squares
 * leaves behind, so printed outlines look like anatomy instead of blocks.
 *
 * @param {number[][]} points
 * @param {number} [iterations]
 * @returns {number[][]}
 */
export function chaikin(points, iterations = 2) {
  if (points.length < 3 || iterations <= 0) return points.map((point) => [...point]);
  const closed =
    Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 1e-6;
  let ring = closed ? points.slice(0, -1) : points.map((point) => [...point]);
  if (ring.length < 3) return points.map((point) => [...point]);

  for (let pass = 0; pass < iterations; pass++) {
    const next = [];
    const count = ring.length;
    const limit = closed ? count : count - 1;
    if (!closed) next.push([...ring[0]]);
    for (let i = 0; i < limit; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % count];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) next.push([...ring[count - 1]]);
    ring = next;
  }
  if (closed) ring.push([...ring[0]]);
  return ring;
}

/** Smooth then simplify a contour set for export. */
export function smoothContours(contours, opts = {}) {
  const { iterations = 2, tolerance = 0 } = opts;
  const out = [];
  for (const line of contours) {
    if (line.length < 3) continue;
    const rounded = chaikin(line, iterations);
    const final = tolerance > 0 ? simplifyPolyline(rounded, tolerance) : rounded;
    if (final.length >= 3) out.push(final);
  }
  return out;
}

/**
 * @param {ArrayLike<number>} values row-major image samples
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {number} [opts.level]
 * @param {[number, number]} [opts.spacing] millimetres per pixel
 * @param {number} [opts.tolerance] Douglas-Peucker tolerance in mm
 * @param {number} [opts.minLength] drop contours shorter than this (mm)
 * @returns {number[][][]} polylines in millimetres
 */
export function contour2D(values, width, height, opts = {}) {
  const { level = 0.5, spacing = [1, 1], tolerance = 0, minLength = 0 } = opts;
  /** @type {number[][][]} */
  const segments = [];

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i00 = values[y * width + x];
      const i10 = values[y * width + x + 1];
      const i11 = values[(y + 1) * width + x + 1];
      const i01 = values[(y + 1) * width + x];

      const crossings = [];
      const edge = (ax, ay, va, bx, by, vb) => {
        if (va >= level === vb >= level) return;
        const t = (level - va) / (vb - va || 1e-12);
        crossings.push([(ax + (bx - ax) * t) * spacing[0], (ay + (by - ay) * t) * spacing[1]]);
      };
      edge(x, y, i00, x + 1, y, i10);
      edge(x + 1, y, i10, x + 1, y + 1, i11);
      edge(x + 1, y + 1, i11, x, y + 1, i01);
      edge(x, y + 1, i01, x, y, i00);

      if (crossings.length === 2) {
        segments.push([crossings[0], crossings[1]]);
      } else if (crossings.length === 4) {
        // saddle: split using the cell centre value to decide connectivity
        const centre = (i00 + i10 + i11 + i01) / 4;
        if (centre >= level) {
          segments.push([crossings[0], crossings[1]], [crossings[2], crossings[3]]);
        } else {
          segments.push([crossings[1], crossings[2]], [crossings[3], crossings[0]]);
        }
      }
    }
  }

  const polylines = chainSegments(segments);
  const out = [];
  for (const line of polylines) {
    if (line.length < 3) continue;
    const simplified = tolerance > 0 ? simplifyPolyline(line, tolerance) : line;
    if (minLength > 0 && polylineLengthMm(simplified) < minLength) continue;
    out.push(simplified);
  }
  return out;
}

function polylineLengthMm(line) {
  let length = 0;
  for (let i = 1; i < line.length; i++) length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return length;
}
