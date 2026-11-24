import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDicom } from '../src/core/dicom.js';
import { makeDicomImage } from '../tools/fixtures.mjs';

function rampValues(rows, columns) {
  const pixels = new Int16Array(rows * columns);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) pixels[y * columns + x] = x + 10 * y + 1;
  }
  return pixels;
}

test('parses explicit VR little endian images', async () => {
  const pixels = rampValues(4, 6);
  const buffer = makeDicomImage({ rows: 4, columns: 6, pixels, slope: 2, intercept: -100 });
  const parsed = await parseDicom(buffer);

  assert.equal(parsed.pixel.rows, 4);
  assert.equal(parsed.pixel.columns, 6);
  assert.equal(parsed.pixel.slope, 2);
  assert.equal(parsed.pixel.intercept, -100);
  assert.equal(parsed.pixel.data.length, 24);
  assert.equal(parsed.pixel.data[0], 1);
  assert.equal(parsed.pixel.data[23], 5 + 30 + 1);
  assert.equal(parsed.dataset['00080060'].value[0], 'MR');
  assert.equal(parsed.transferSyntax, '1.2.840.10008.1.2.1');
});

test('parses implicit VR little endian images', async () => {
  const pixels = rampValues(3, 3);
  const buffer = makeDicomImage({ rows: 3, columns: 3, pixels, explicit: false });
  const parsed = await parseDicom(buffer);
  assert.equal(parsed.pixel.rows, 3);
  assert.equal(parsed.pixel.columns, 3);
  assert.equal(parsed.pixel.data[4], 1 + 10 + 1);
  assert.equal(parsed.transferSyntax, '1.2.840.10008.1.2');
});

test('reads unsigned pixel data', async () => {
  const pixels = new Uint16Array([0, 1, 4000, 65535]);
  const buffer = makeDicomImage({ rows: 2, columns: 2, pixels, signed: false });
  const parsed = await parseDicom(buffer);
  assert.equal(parsed.pixel.data[3], 65535);
  assert.ok(parsed.pixel.data instanceof Uint16Array);
});

test('reports compressed transfer syntaxes instead of decoding garbage', async () => {
  const buffer = makeDicomImage({
    rows: 2,
    columns: 2,
    pixels: new Int16Array(4),
    transferSyntax: '1.2.840.10008.1.2.4.70',
  });
  await assert.rejects(() => parseDicom(buffer), /Compressed or unsupported transfer syntax/);
});

test('rejects truncated pixel data', async () => {
  const buffer = makeDicomImage({ rows: 4, columns: 4, pixels: new Int16Array(16) });
  const truncated = buffer.slice(0, buffer.byteLength - 10);
  await assert.rejects(() => parseDicom(truncated));
});
