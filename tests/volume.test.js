import test from 'node:test';
import assert from 'node:assert/strict';

import { Volume, parseMillimetres } from '../src/core/volume.js';
import { createBrainPhantom } from '../src/core/phantom.js';

function tinyVolume() {
  const nx = 4;
  const ny = 3;
  const nz = 2;
  const data = new Int16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) data[(k * ny + j) * nx + i] = i + 10 * j + 100 * k;
    }
  }
  return new Volume({ data, dims: [nx, ny, nz], spacing: [1, 2, 3], slope: 2, intercept: 5 });
}

test('extracts axial slices with anterior at the top', () => {
  const volume = tinyVolume();
  const slice = volume.slice('axial', 1);
  assert.equal(slice.width, 4);
  assert.equal(slice.height, 3);
  assert.equal(slice.labels.top, 'A');
  assert.equal(slice.labels.left, 'R');
  assert.equal(slice.data[0], 100 * 2 + 5);
  assert.equal(slice.data[1], (1 + 100) * 2 + 5);
});

test('extracts coronal and sagittal slices with superior at the top', () => {
  const volume = tinyVolume();
  const coronal = volume.slice('coronal', 0);
  assert.equal(coronal.width, 4);
  assert.equal(coronal.height, 2);
  assert.equal(coronal.labels.top, 'S');
  // top row is the superior slice (k = 1)
  assert.equal(coronal.data[0], 205);
  assert.equal(coronal.data[4], 5);

  const sagittal = volume.slice('sagittal', 0);
  assert.equal(sagittal.width, 3);
  assert.equal(sagittal.height, 2);
  assert.equal(sagittal.data[0], (0 + 100) * 2 + 5);
});

test('clamps out-of-range slice indices', () => {
  const volume = tinyVolume();
  assert.equal(volume.slice('axial', -5).index, 0);
  assert.equal(volume.slice('axial', 99).index, 1);
});

test('computes percentile statistics', () => {
  const volume = tinyVolume();
  const stats = volume.stats();
  assert.equal(stats.min, 5);
  assert.equal(stats.max, 2 * (3 + 20 + 100) + 5);
  assert.ok(stats.p02 <= stats.p98);
});

test('downsamples large volumes within the voxel budget', () => {
  const volume = tinyVolume();
  const { volume: small, factor } = volume.downsample(4);
  assert.ok(factor >= 1);
  assert.ok(small.voxelCount <= volume.voxelCount);
});

test('synthetic phantom looks like a head', () => {
  const volume = createBrainPhantom({ size: [48, 48, 32], spacing: [4, 4, 4] });
  const stats = volume.stats();
  assert.ok(stats.max > 1200, 'skull should be bright');
  const middle = volume.slice('axial', 16);
  // centre of the slice is brain tissue, the corner is air
  const centre = middle.data[24 * 48 + 24];
  assert.ok(centre > 100 && centre < 1400, `unexpected centre value ${centre}`);
  assert.equal(middle.data[0], 0);
});

test('parses millimetre labels', () => {
  assert.equal(parseMillimetres('4mm'), 4);
  assert.equal(parseMillimetres('1.5 mm'), 1.5);
  assert.equal(parseMillimetres('none'), 0);
});
