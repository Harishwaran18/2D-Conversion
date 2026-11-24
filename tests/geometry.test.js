import test from 'node:test';
import assert from 'node:assert/strict';

import { Mesh } from '../src/geom/mesh.js';
import { isosurface } from '../src/geom/isosurface.js';
import { smoothMesh } from '../src/geom/smooth.js';
import { clusterDecimate, simplifyPolyline, polygonArea } from '../src/geom/decimate.js';
import { buildInnerSurface, combineShells } from '../src/geom/hollow.js';
import { distanceTransform } from '../src/geom/edt.js';
import { sliceMesh } from '../src/geom/slice.js';
import { contour2D, chaikin, smoothContours } from '../src/geom/marching-squares.js';

/** Binary sphere mask in an n^3 grid. */
function sphereMask(n, radius) {
  const field = new Uint8Array(n * n * n);
  const c = (n - 1) / 2;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(i - c, j - c, k - c);
        field[(k * n + j) * n + i] = d <= radius ? 1 : 0;
      }
    }
  }
  return { field, dims: [n, n, n] };
}

function edgeUseCounts(mesh) {
  const counts = new Map();
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e];
      const b = idx[t + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

test('isosurface produces a watertight, outward-facing sphere', () => {
  const { field, dims } = sphereMask(17, 6);
  const mesh = isosurface(field, dims, [1, 1, 1]);
  assert.ok(mesh.triangleCount > 100);
  assert.ok(mesh.signedVolume() > 0);

  const counts = edgeUseCounts(mesh);
  for (const [key, count] of counts) assert.equal(count, 2, `edge ${key} used ${count} times`);

  // volume of a discrete sphere with r=6 is close to 4/3*pi*6^3 = 905
  const volume = mesh.signedVolume();
  assert.ok(Math.abs(volume - 905) / 905 < 0.15, `volume ${volume}`);
});

test('isosurface of an empty field is empty', () => {
  const field = new Uint8Array(64);
  const mesh = isosurface(field, [4, 4, 4], [1, 1, 1]);
  assert.equal(mesh.triangleCount, 0);
});

test('smoothing keeps the shape but removes staircase noise', () => {
  const { field, dims } = sphereMask(17, 6);
  const mesh = isosurface(field, dims, [1, 1, 1]);
  const smoothed = smoothMesh(mesh, { iterations: 10 });
  assert.equal(smoothed.vertexCount, mesh.vertexCount);
  const ratio = smoothed.signedVolume() / mesh.signedVolume();
  assert.ok(ratio > 0.9 && ratio < 1.1, `volume ratio ${ratio}`);
  const counts = edgeUseCounts(smoothed);
  for (const [, count] of counts) assert.equal(count, 2);
});

test('decimation reduces vertices while keeping the volume roughly intact', () => {
  const { field, dims } = sphereMask(21, 8);
  const mesh = isosurface(field, dims, [1, 1, 1]);
  const reduced = clusterDecimate(mesh, 1.5);
  assert.ok(reduced.vertexCount < mesh.vertexCount * 0.6);
  const ratio = Math.abs(reduced.signedVolume()) / mesh.signedVolume();
  assert.ok(ratio > 0.85 && ratio < 1.1, `volume ratio ${ratio}`);
});

test('distance transform measures depth inside the object', () => {
  const n = 11;
  const mask = new Uint8Array(n * n * n);
  for (let k = 1; k < n - 1; k++) {
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) mask[(k * n + j) * n + i] = 1;
    }
  }
  const distance = distanceTransform(mask, [n, n, n], [1, 1, 1]);
  assert.equal(distance[(5 * n + 5) * n + 5], 5);
  // face-adjacent background is 1 mm away
  assert.equal(distance[(1 * n + 1) * n + 1], 1);
  assert.equal(distance[0], 0);
});

test('hollowing creates an inner wall with the requested thickness', () => {
  const { field, dims } = sphereMask(21, 8);
  const outer = isosurface(field, dims, [1, 1, 1]);
  const inner = buildInnerSurface(field, dims, [1, 1, 1], 2);
  assert.ok(inner);
  const counts = edgeUseCounts(inner);
  for (const [, count] of counts) assert.equal(count, 2);

  const { mesh: hollow, hollowed } = combineShells(outer, inner);
  assert.equal(hollowed, true);
  const shellVolume = Math.abs(hollow.signedVolume());
  const ratio = shellVolume / outer.signedVolume();
  assert.ok(ratio > 0.4 && ratio < 0.8, `shell ratio ${ratio}`);
});

test('a wall thicker than the object is refused instead of inverting it', () => {
  const { field, dims } = sphereMask(9, 2);
  assert.equal(buildInnerSurface(field, dims, [1, 1, 1], 10), null);
});

test('slicing a sphere at its equator yields a closed circle', () => {
  const { field, dims } = sphereMask(21, 8);
  const mesh = isosurface(field, dims, [1, 1, 1]);
  const contours = sliceMesh(mesh, 'z', 8);
  assert.equal(contours.length, 1);
  const loop = contours[0];
  assert.ok(Math.hypot(loop[0][0] - loop[loop.length - 1][0], loop[0][1] - loop[loop.length - 1][1]) < 1e-6);

  // sphere radius 8 centred at index 10; slicing at z = 8 gives radius sqrt(60)
  const area = Math.abs(polygonArea(loop));
  const expected = Math.PI * 60;
  assert.ok(Math.abs(area - expected) / expected < 0.1, `area ${area} vs ${expected}`);
});

test('slicing far from the surface is empty', () => {
  const { field, dims } = sphereMask(17, 6);
  const mesh = isosurface(field, dims, [1, 1, 1]);
  assert.deepEqual(sliceMesh(mesh, 'z', 100), []);
});

test('marching squares finds the outline of a 2D disc', () => {
  const w = 41;
  const h = 41;
  const values = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      values[y * w + x] = Math.hypot(x - 20, y - 20) <= 10 ? 1 : 0;
    }
  }
  const contours = contour2D(values, w, h, { level: 0.5, spacing: [1, 1] });
  assert.equal(contours.length, 1);
  const area = Math.abs(polygonArea(contours[0]));
  const expected = Math.PI * 100;
  assert.ok(Math.abs(area - expected) / expected < 0.1, `area ${area}`);
});

test('polylines simplify within tolerance', () => {
  const line = [];
  for (let i = 0; i <= 100; i++) line.push([i, 0]);
  const simplified = simplifyPolyline(line, 0.01);
  assert.equal(simplified.length, 2);
});

test('polygonArea reports counter-clockwise as positive', () => {
  assert.ok(polygonArea([[0, 0], [1, 0], [1, 1], [0, 1]]) > 0);
  assert.ok(polygonArea([[0, 0], [0, 1], [1, 1], [1, 0]]) < 0);
});

test('mesh merge keeps both parts and offsets indices', () => {
  const tri = new Mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
  const merged = tri.merge(tri);
  assert.equal(merged.vertexCount, 6);
  assert.equal(merged.triangleCount, 2);
  assert.deepEqual([...merged.indices], [0, 1, 2, 3, 4, 5]);
});

test('chaikin rounds corners while keeping a closed ring closed', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const rounded = chaikin(square, 2);
  assert.ok(rounded.length > square.length);
  const first = rounded[0];
  const last = rounded[rounded.length - 1];
  assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9);
  // corner cutting rounds sharp 90 degree corners, which costs some area
  const area = Math.abs(polygonArea(rounded));
  assert.ok(area > 80 && area < 100, `area ${area}`);
});

test('chaikin keeps the endpoints of an open polyline', () => {
  const line = [[0, 0], [10, 0], [10, 10]];
  const rounded = chaikin(line, 2);
  assert.deepEqual(rounded[0], [0, 0]);
  assert.deepEqual(rounded[rounded.length - 1], [10, 10]);
});

test('smoothContours drops degenerate input and keeps real rings', () => {
  const out = smoothContours([[[0, 0]], [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]], { iterations: 1 });
  assert.equal(out.length, 1);
  assert.ok(out[0].length >= 4);
});
