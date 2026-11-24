import test from 'node:test';
import assert from 'node:assert/strict';

import { otsuFromHistogram, thresholdMask, largestComponent, fillHoles, maskBounds, cropMask, segmentVolume } from '../src/seg/segment.js';
import { Volume } from '../src/core/volume.js';

function synthetic({ width = 32, height = 24, depth = 8, inside = 200, outside = 10 } = {}) {
  const data = new Float32Array(width * height * depth);
  for (let k = 0; k < depth; k++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = (x - width / 2) / (width * 0.28);
        const dy = (y - height / 2) / (height * 0.28);
        const dz = (k - depth / 2) / (depth * 0.35);
        data[(k * height + y) * width + x] = dx * dx + dy * dy + dz * dz < 1 ? inside : outside;
      }
    }
  }
  return new Volume({ data, dims: [width, height, depth], spacing: [1, 1, 2], meta: {} });
}

test('otsu picks a split between two intensity modes', () => {
  const counts = new Float64Array(256);
  counts[0] = 500; // value 0
  counts[255] = 500; // value 255
  const threshold = otsuFromHistogram(counts, 0, 255);
  assert.ok(threshold > 100 && threshold < 155, `threshold ${threshold}`);
});

test('otsu handles a single-valued volume without dividing by zero', () => {
  const counts = new Float64Array(16);
  counts[4] = 100;
  const threshold = otsuFromHistogram(counts, 0, 15);
  assert.ok(Number.isFinite(threshold));
});

test('thresholdMask applies slope and intercept before comparing', () => {
  const volume = synthetic({ inside: 300, outside: 100 });
  volume.slope = 2;
  volume.intercept = -1000;
  // stored 300 -> 300*2-1000 = -400 ; stored 100 -> -800
  const mask = thresholdMask(volume, -600);
  assert.equal(mask[0], 0, 'outside voxel stays background');
  const centre = ((4 * volume.ny + 12) * volume.nx) + 16;
  assert.equal(mask[centre], 1, 'inside voxel becomes foreground');
});

test('largestComponent drops isolated blobs', () => {
  const dims = [10, 10, 1];
  const mask = new Uint8Array(100);
  mask[11] = 1; // single stray voxel
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) mask[y * 10 + x] = 1;
  const out = largestComponent(mask, dims);
  assert.equal(out[11], 0);
  assert.equal(out[5 * 10 + 5], 1);
  assert.equal(out.reduce((sum, value) => sum + value, 0), 16);
});

test('fillHoles fills the interior of a closed ring', () => {
  const dims = [9, 9, 1];
  const mask = new Uint8Array(81);
  for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) if (y === 1 || y === 7 || x === 1 || x === 7) mask[y * 9 + x] = 1;
  const filled = fillHoles(mask, dims);
  assert.equal(filled[4 * 9 + 4], 1, 'centre becomes foreground');
  assert.equal(filled[0], 0, 'outside stays background');
});

test('maskBounds and cropMask agree on the tight box', () => {
  const dims = [8, 8, 4];
  const mask = new Uint8Array(8 * 8 * 4);
  for (let k = 1; k < 3; k++) for (let y = 2; y < 6; y++) for (let x = 3; x < 5; x++) mask[(k * 8 + y) * 8 + x] = 1;
  const bounds = maskBounds(mask, dims);
  assert.deepEqual([bounds.minX, bounds.minY, bounds.minZ], [3, 2, 1]);
  assert.deepEqual([bounds.maxX, bounds.maxY, bounds.maxZ], [4, 5, 2]);
  const crop = cropMask(mask, dims, bounds);
  assert.deepEqual(crop.dims, [2, 4, 2]);
  assert.equal(crop.mask.reduce((sum, value) => sum + value, 0), 16);
});

test('segmentVolume measures coverage and returns a clean mask', () => {
  const volume = synthetic();
  const result = segmentVolume(volume, { mode: 'auto', keepLargest: true, fill: true });
  assert.ok(result.threshold > 10 && result.threshold < 200, `threshold ${result.threshold}`);
  assert.ok(result.coverage > 0.01 && result.coverage < 0.6, `coverage ${result.coverage}`);
  assert.ok(result.mask.length === volume.voxelCount);
  const centre = ((Math.floor(volume.nz / 2) * volume.ny + Math.floor(volume.ny / 2)) * volume.nx) + Math.floor(volume.nx / 2);
  assert.equal(result.mask[centre], 1);
});

test('manual mode honours the provided threshold', () => {
  const volume = synthetic({ inside: 900, outside: 100 });
  const result = segmentVolume(volume, { mode: 'manual', threshold: 500 });
  assert.equal(result.threshold, 500);
  assert.ok(result.coverage > 0.01);
});
