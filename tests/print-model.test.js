import test from 'node:test';
import assert from 'node:assert/strict';

import { padMask } from '../src/seg/segment.js';
import { buildPrintModel, slicePrintModel } from '../src/geom/print-model.js';
import { Volume } from '../src/core/volume.js';

/** Edge histogram: every edge of a closed manifold should be shared twice. */
function edgeSupport(mesh) {
  const histogram = new Map();
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e];
      const b = idx[t + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      histogram.set(key, (histogram.get(key) || 0) + 1);
    }
  }
  let boundary = 0;
  for (const count of histogram.values()) if (count === 1) boundary++;
  return { edges: histogram.size, boundary };
}

/** A block that fills the volume completely - the worst case for closing. */
function fullBlock(size = [24, 24, 16], spacing = [2, 2, 2]) {
  const [nx, ny, nz] = size;
  const data = new Float32Array(nx * ny * nz).fill(900);
  return new Volume({ data, dims: size, spacing, meta: {} });
}

function sphere(size = [40, 40, 40], spacing = [2, 2, 2], radius = 26) {
  const [nx, ny, nz] = size;
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = (i - (nx - 1) / 2) * spacing[0];
        const y = (j - (ny - 1) / 2) * spacing[1];
        const z = (k - (nz - 1) / 2) * spacing[2];
        data[(k * ny + j) * nx + i] = Math.hypot(x, y, z) < radius ? 900 : 60;
      }
    }
  }
  return new Volume({ data, dims: size, spacing, meta: {} });
}

test('padMask adds an empty ring without moving voxels', () => {
  const mask = new Uint8Array([1, 0, 1, 1, 0, 1]); // 3x2x1
  const { mask: padded, dims } = padMask(mask, [3, 2, 1], 1);
  assert.deepEqual(dims, [5, 4, 3]);
  assert.equal(padded[((1 * 4) + 1) * 5 + 1], 1);
  let sum = 0;
  for (const value of padded) sum += value;
  assert.equal(sum, 4);
});

test('a mask that fills the whole volume still yields a closed surface', () => {
  const model = buildPrintModel(fullBlock(), { hollow: 0, smoothing: 0.3, simplify: 20 });
  const { boundary } = edgeSupport(model.mesh);
  assert.equal(boundary, 0, 'surface must not have open edges');
  assert.ok(model.mesh.signedVolume() > 0, 'normals must point outwards');
  assert.ok(model.stats.triangles > 100);
});

test('solid print model volume matches the measured mask volume', () => {
  const volume = sphere();
  const model = buildPrintModel(volume, { hollow: 0, smoothing: 0.2, simplify: 20 });
  const { boundary } = edgeSupport(model.mesh);
  assert.equal(boundary, 0);
  const measured = Math.abs(model.mesh.signedVolume());
  assert.ok(Math.abs(measured - model.stats.volumeMm3) < 1e-6);
  const ideal = (4 / 3) * Math.PI * 26 ** 3;
  assert.ok(measured > ideal * 0.9 && measured < ideal * 1.1, `measured ${measured} vs ${ideal}`);
});

test('hollow model removes the interior but keeps the wall', () => {
  const volume = sphere();
  const solid = buildPrintModel(volume, { hollow: 0, smoothing: 0.2, simplify: 20 });
  const hollowed = buildPrintModel(volume, { hollow: 4, smoothing: 0.2, simplify: 20 });
  const { boundary } = edgeSupport(hollowed.mesh);
  assert.equal(boundary, 0, 'hollow shell must also be closed');
  assert.equal(hollowed.wall, 4);
  const ratio = Math.abs(hollowed.mesh.signedVolume()) / Math.abs(solid.mesh.signedVolume());
  assert.ok(ratio > 0.25 && ratio < 0.75, `wall ratio ${ratio}`);
});

test('slicePrintModel returns millimetre contours with the wall visible', () => {
  const volume = sphere();
  const model = buildPrintModel(volume, { hollow: 4, smoothing: 0.2, simplify: 20 });
  const [slice] = slicePrintModel(model.mesh, 'axial', [40], { minLength: 1 });
  assert.ok(slice.contours.length >= 1);
  // a hollow sphere sliced through the middle gives an outer and an inner ring
  assert.ok(slice.contours.length >= 2, `contours ${slice.contours.length}`);
  for (const contour of slice.contours) {
    for (const [x, y] of contour) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
    }
  }
});
