import test from 'node:test';
import assert from 'node:assert/strict';

import { groupDicomFiles, seriesToVolume } from '../src/core/dicom-series.js';
import { makeDicomSeries, makeDicomImage } from '../tools/fixtures.mjs';

test('groups files, orders slices and reports spacing', async () => {
  const files = makeDicomSeries({ slices: 5, rows: 16, columns: 16 });
  const grouped = await groupDicomFiles(files);
  assert.equal(grouped.series.length, 1);
  assert.equal(grouped.failures.length, 0);

  const volume = seriesToVolume(grouped.series[0]);
  assert.deepEqual([volume.nx, volume.ny, volume.nz], [16, 16, 5]);
  assert.deepEqual(volume.spacing, [2, 2, 2]);
  assert.equal(volume.meta.source, 'dicom');

  // centre voxel is inside the sphere, corners are background
  assert.equal(volume.valueAt(8, 8, 2), 1002);
  assert.equal(volume.valueAt(0, 0, 0), 20);
});

test('honours rescale slope and intercept', async () => {
  const files = makeDicomSeries({ slices: 3, rows: 8, columns: 8 });
  const grouped = await groupDicomFiles(files);
  const volume = seriesToVolume(grouped.series[0]);
  assert.equal(volume.slope, 1);
});

test('flips axes so that the canonical frame points LEFT/POSTERIOR/SUPERIOR', async () => {
  const rows = 4;
  const columns = 4;
  const files = [];
  // row direction points to patient RIGHT, col direction to ANTERIOR, so the
  // normal points to INFERIOR: every axis must be mirrored.
  const orientation = [-1, 0, 0, 0, -1, 0];
  for (let s = 0; s < 3; s++) {
    const pixels = new Int16Array(rows * columns);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) pixels[y * columns + x] = x + 10 * y;
    }
    files.push({
      name: `s${s}.dcm`,
      buffer: makeDicomImage({ rows, columns, pixels, sliceIndex: s, z: s, orientation }),
    });
  }
  const grouped = await groupDicomFiles(files);
  const volume = seriesToVolume(grouped.series[0]);
  // output (0,0,0) now maps to source (3,3,2)
  assert.equal(volume.valueAt(0, 0, 0), 3 + 30);
  assert.equal(volume.valueAt(3, 3, 2), 0);
});

test('keeps the largest series when a folder holds several', async () => {
  const axial = makeDicomSeries({ slices: 4, rows: 8, columns: 8 });
  const scout = [
    {
      name: 'scout.dcm',
      buffer: makeDicomImage({ rows: 8, columns: 8, pixels: new Int16Array(64), seriesUid: '1.2.3.4', seriesDescription: 'Scout' }),
    },
  ];
  const grouped = await groupDicomFiles([...axial, ...scout]);
  assert.equal(grouped.series.length, 2);
  assert.equal(grouped.series[0].slices.length, 4);
  assert.equal(grouped.series[1].description, 'Scout');
});
