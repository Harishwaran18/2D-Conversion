/**
 * Write the small sample scans used by the demo deep links
 * (`index.html?sample=dicom|nifti|image`).
 *
 * Usage: node tools/make-samples.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBrainPhantom } from '../src/core/phantom.js';
import { writeZip, crc32 } from '../src/core/zip.js';
import { makeDicomImage, makeNifti } from './fixtures.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'samples');
await mkdir(outDir, { recursive: true });

const formatSize = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

/* ------------------------------------------------------------------ DICOM */

async function buildDicomSeries() {
  const volume = createBrainPhantom({ size: [72, 72, 48], spacing: [2.5, 2.5, 2.5] });
  const entries = [];
  for (let k = 0; k < volume.nz; k++) {
    const slice = volume.slice('axial', k);
    const pixels = Int16Array.from(slice.data, (value) => Math.round(value));
    const buffer = makeDicomImage({
      rows: slice.height,
      columns: slice.width,
      pixels,
      sliceIndex: k,
      z: k * volume.spacing[2],
      pixelSpacing: [volume.spacing[0], volume.spacing[1]],
      slope: 1,
      intercept: 0,
      seriesDescription: 'Synthetic T1 axial (demo)',
      modality: 'MR',
      signed: false,
      bitsAllocated: 16,
    });
    entries.push({ name: `axial_${String(k).padStart(3, '0')}.dcm`, data: new Uint8Array(buffer) });
  }
  const zip = await writeZip(entries);
  await writeFile(join(outDir, 'dicom-brain-series.zip'), zip);
  console.log(`dicom-brain-series.zip  ${entries.length} slices  ${formatSize(zip.length)}`);
}

/* ------------------------------------------------------------------ NIfTI */

async function buildNifti() {
  const volume = createBrainPhantom({ size: [72, 72, 48], spacing: [2.5, 2.5, 2.5] });
  const data = Int16Array.from(volume.data, (value) => Math.round(value));
  const raw = await makeNifti({
    dims: [volume.nx, volume.ny, volume.nz],
    data,
    spacing: volume.spacing,
    datatype: 4,
    sform: [
      [-volume.spacing[0], 0, 0, 90],
      [0, volume.spacing[1], 0, 90],
      [0, 0, volume.spacing[2], 0],
    ],
  });
  const gz = gzipSync(Buffer.from(raw), { level: 9 });
  await writeFile(join(outDir, 'brain-phantom.nii.gz'), gz);
  console.log(`brain-phantom.nii.gz    ${formatSize(gz.length)}`);
  void data;
}

/* -------------------------------------------------------------------- PNG */

function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = y * (width * 3 + 1) + 1 + x * 3;
      raw[dst] = rgb[src];
      raw[dst + 1] = rgb[src + 1];
      raw[dst + 2] = rgb[src + 2];
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(new Uint8Array(typeAndData)));
    return Buffer.concat([length, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function buildMicrograph() {
  const width = 640;
  const height = 480;
  const rgb = new Uint8Array(width * height * 3);
  const hash = (x, y, seed) => {
    const value = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
    return value - Math.floor(value);
  };
  const smoothNoise = (x, y, scale, seed) => {
    const gx = x / scale;
    const gy = y / scale;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const lerp = (a, b, t) => a + (b - a) * t;
    const v = lerp(
      lerp(hash(x0, y0, seed), hash(x0 + 1, y0, seed), fx),
      lerp(hash(x0, y0 + 1, seed), hash(x0 + 1, y0 + 1, seed), fx),
      fy
    );
    return v;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - width / 2) / (width * 0.36);
      const dy = (y - height / 2) / (height * 0.46);
      const r = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      let value = 6 + smoothNoise(x, y, 3, 7) * 8;

      if (r < 1.06) value = 196 + smoothNoise(x, y, 2, 3) * 16; // bright rim (bone / scalp)
      if (r < 0.94) value = 22 + smoothNoise(x, y, 2, 5) * 10; // dark CSF gap
      if (r < 0.86) {
        // brain tissue with folded structure
        const fold =
          Math.sin(r * 26 + Math.sin(angle) * 1.6 + dx * 6) * 0.5 +
          Math.cos(dx * 17 + dy * 11) * 0.3 +
          (smoothNoise(x, y, 9, 11) - 0.5) * 1.5;
        value = 138 + fold * 46;
      }
      value += (hash(x, y, 1) - 0.5) * 12; // film grain
      const byte = Math.max(0, Math.min(255, Math.round(value)));
      const index = (y * width + x) * 3;
      rgb[index] = byte;
      rgb[index + 1] = byte;
      rgb[index + 2] = Math.min(255, Math.round(byte * 1.03));
    }
  }
  const png = encodePng(width, height, rgb);
  await writeFile(join(outDir, 'head-scan.png'), png);
  console.log(`head-scan.png           ${width}×${height}  ${formatSize(png.length)}`);
}

await buildDicomSeries();
await buildNifti();
await buildMicrograph();
console.log('\nSamples written to assets/samples/');
