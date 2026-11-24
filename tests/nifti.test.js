import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNifti } from '../src/core/nifti.js';
import { makeNifti } from '../tools/fixtures.mjs';

test('reads a NIfTI-1 volume with dimensions and spacing', async () => {
  const buffer = await makeNifti({ dims: [8, 9, 5], spacing: [1, 1.5, 2.5] });
  const volume = await parseNifti(buffer);
  assert.deepEqual([volume.nx, volume.ny, volume.nz], [8, 9, 5]);
  assert.deepEqual(volume.spacing, [1, 1.5, 2.5]);
  assert.equal(volume.valueAt(0, 0, 0), 1);
});

test('reads gzipped NIfTI files', async () => {
  const buffer = await makeNifti({ dims: [6, 6, 3], gzip: true });
  const volume = await parseNifti(buffer);
  assert.deepEqual([volume.nx, volume.ny, volume.nz], [6, 6, 3]);
});

test('reads float32 NIfTI data', async () => {
  const data = new Float32Array(4 * 4 * 2).map((_, i) => i * 0.5);
  const buffer = await makeNifti({ dims: [4, 4, 2], data, datatype: 16 });
  const volume = await parseNifti(buffer);
  assert.equal(volume.valueAt(1, 1, 0), 5 * 0.5);
});

test('applies the sform to re-orient axes', async () => {
  // i -> world -z (inferior), j -> world +x (right), k -> world -y (posterior)
  const sform = [
    [0, 3, 0, 0],
    [0, 0, -3, 0],
    [-2, 0, 0, 0],
  ];
  const buffer = await makeNifti({ dims: [5, 6, 7], sform });
  const volume = await parseNifti(buffer);
  assert.deepEqual([volume.nx, volume.ny, volume.nz], [6, 7, 5]);
});

test('rejects non-NIfTI data', async () => {
  const bogus = new Uint8Array(400).buffer;
  await assert.rejects(() => parseNifti(bogus), /Not a NIfTI file/);
});
