/**
 * Import orchestration: accept whatever the user drops in (DICOM files, a ZIP
 * of DICOMs, NIfTI, plain images) and produce a {@link Volume}.
 */

import { groupDicomFiles, seriesToVolume } from './dicom-series.js';
import { parseNifti } from './nifti.js';
import { readZip } from './zip.js';
import { buildVolumeFromImages } from './raster.js';

const DICOM_EXT = /\.(dcm|dicom|ima|img)$/i;
const NIFTI_EXT = /\.nii(\.gz)?$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

const hasMagic = (buffer, bytes, offset = 0) => {
  const view = new Uint8Array(buffer);
  if (view.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => view[offset + i] === byte);
};

export const isNifti = (buffer) => hasMagic(buffer, [0x6e, 0x2b, 0x31]) || hasMagic(buffer, [0x6e, 0x2b, 0x32]);
export const isGzip = (buffer) => hasMagic(buffer, [0x1f, 0x8b]);
export const isZip = (buffer) => hasMagic(buffer, [0x50, 0x4b, 0x03, 0x04]);
export const isDicom = (buffer) => hasMagic(buffer, [0x44, 0x49, 0x43, 0x4d], 128);

/**
 * @param {File[]} fileList
 * @param {{onProgress?: (message: string, fraction: number) => void}} [hooks]
 */
export async function loadFiles(fileList, hooks = {}) {
  const report = hooks.onProgress || (() => {});
  const files = [];
  let read = 0;

  for (const file of fileList) {
    report(`Reading ${file.name}`, read / Math.max(1, fileList.length));
    const buffer = await file.arrayBuffer();
    files.push({ name: file.name, buffer });
    read++;
  }

  let expanded = files;
  const zipFiles = files.filter((file) => isZip(file.buffer));
  if (zipFiles.length) {
    report('Unpacking archive', 0.3);
    expanded = [];
    for (const zip of zipFiles) {
      try {
        const entries = await readZip(zip.buffer);
        for (const entry of entries) {
          if (entry.name.startsWith('__MACOSX') || entry.name.endsWith('/')) continue;
          expanded.push({ name: entry.name, buffer: entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength) });
        }
      } catch (error) {
        throw new Error(`Could not read ${zip.name}: ${error.message || error}`);
      }
    }
    for (const file of files) if (!zipFiles.includes(file)) expanded.push(file);
  }

  const warnings = [];
  const prepared = [];
  for (const file of expanded) {
    if (isGzip(file.buffer) && /\.gz$/i.test(file.name)) {
      try {
        prepared.push({ name: file.name.replace(/\.gz$/i, ''), buffer: await gunzip(file.buffer) });
      } catch (error) {
        warnings.push(`${file.name}: ${error.message}`);
      }
    } else {
      prepared.push(file);
    }
  }
  expanded = prepared;

  const dicomFiles = expanded.filter((file) => isDicom(file.buffer) || DICOM_EXT.test(file.name));
  const niftiFiles = expanded.filter((file) => isNifti(file.buffer) || isGzip(file.buffer) || NIFTI_EXT.test(file.name));
  const imageFiles = expanded.filter((file) => IMAGE_EXT.test(file.name) && !isDicom(file.buffer));

  if (dicomFiles.length) {
    report('Parsing DICOM series', 0.5);
    const grouped = await groupDicomFiles(dicomFiles);
    if (!grouped.series.length) {
      const reason = grouped.failures[0]?.reason || 'no readable pixel data';
      throw new Error(`No readable DICOM series found (${reason}).`);
    }
    warnings.push(...grouped.failures.map((failure) => `${failure.name}: ${failure.reason}`));
    const volume = seriesToVolume(grouped.series[0]);
    return {
      volume,
      kind: 'dicom',
      series: grouped.series,
      warnings,
      summary: `${grouped.series[0].description} · ${grouped.series[0].modality} · ${volume.meta.sliceCount} slices`,
    };
  }

  if (niftiFiles.length) {
    report('Parsing NIfTI volume', 0.6);
    const volume = await parseNifti(niftiFiles[0].buffer);
    volume.meta.description = niftiFiles[0].name;
    return { volume, kind: 'nifti', series: [], warnings, summary: niftiFiles[0].name };
  }

  if (imageFiles.length) {
    report('Decoding images', 0.6);
    const images = await buildVolumeFromImages(imageFiles);
    return { volume: images.volume, kind: 'image', series: [], warnings: [...warnings, ...images.warnings], summary: images.volume.meta.description };
  }

  throw new Error(
    'Unsupported file type. Drop DICOM (.dcm), a ZIP of DICOMs, NIfTI (.nii/.nii.gz) or images (PNG/JPEG/WebP).'
  );
}

async function gunzip(buffer) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('this browser cannot decompress gzip; unzip the file first');
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Build a volume from a specific DICOM series (used by the series picker). */
export function loadSeries(series) {
  return seriesToVolume(series);
}
