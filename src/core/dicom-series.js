/**
 * Turn a bag of DICOM files into a patient-oriented {@link Volume}.
 *
 * Series are grouped by SeriesInstanceUID, ordered along the slice normal taken
 * from ImageOrientationPatient, and re-oriented so the array axes follow
 * patient LEFT / POSTERIOR / SUPERIOR.
 */

import { Volume } from './volume.js';
import { parseDicom, numbers, text, DicomError } from './dicom.js';
import { orientArray, cross } from './orient.js';

const EPS = 1e-6;

/**
 * @typedef {object} DicomSlice
 * @property {string} name
 * @property {object} parsed
 * @property {number[]|null} position
 * @property {number} instanceNumber
 */

/**
 * Group parsed DICOM files into series, largest series first.
 * @param {Array<{name: string, buffer: ArrayBuffer}>} files
 */
export async function groupDicomFiles(files) {
  const slices = [];
  const failures = [];
  for (const file of files) {
    try {
      const parsed = await parseDicom(file.buffer);
      if (!parsed.pixel) {
        failures.push({ name: file.name, reason: 'No pixel data' });
        continue;
      }
      slices.push({
        name: file.name,
        parsed,
        position: numbers(parsed.dataset, '00200032'),
        instanceNumber: numbers(parsed.dataset, '00200013')?.[0] ?? 0,
      });
    } catch (error) {
      failures.push({ name: file.name, reason: error instanceof DicomError ? error.message : String(error) });
    }
  }

  /** @type {Map<string, DicomSlice[]>} */
  const groups = new Map();
  for (const slice of slices) {
    const uid = text(slice.parsed.dataset, '0020000e') || 'no-series-uid';
    if (!groups.has(uid)) groups.set(uid, []);
    groups.get(uid).push(slice);
  }

  const series = [...groups.entries()]
    .map(([uid, list]) => ({
      uid,
      description:
        text(list[0].parsed.dataset, '0008103e') || text(list[0].parsed.dataset, '00081030') || 'DICOM series',
      modality: text(list[0].parsed.dataset, '00080060') || 'MR',
      slices: list,
    }))
    .sort((a, b) => b.slices.length - a.slices.length);

  return { series, failures, totalFiles: files.length };
}

/**
 * Build a canonical volume from one series.
 * @param {{uid: string, description: string, slices: DicomSlice[]}} series
 * @returns {Volume}
 */
export function seriesToVolume(series) {
  if (!series.slices.length) throw new DicomError('Series is empty', 'EMPTY_SERIES');
  const pixel0 = series.slices[0].parsed.pixel;
  const { rows, columns } = pixel0;

  const iop = numbers(series.slices[0].parsed.dataset, '00200037');
  const rowDir = iop ? iop.slice(0, 3) : [1, 0, 0];
  const colDir = iop ? iop.slice(3, 6) : [0, 1, 0];
  const normal = cross(rowDir, colDir);

  const multiFrame = pixel0.frames > 1;
  if (multiFrame && series.slices.length > 1) {
    throw new DicomError('Multi-frame DICOM mixed with extra files in one series is not supported', 'MULTIFRAME_SERIES');
  }
  const ordered = multiFrame ? series.slices : sortSlicesAlong(series.slices, normal);
  const nz = multiFrame ? pixel0.frames : ordered.length;
  const sizes = [columns, rows, nz];

  const [colSpacing, rowSpacing] = pixelSpacingMm(series.slices[0].parsed.dataset);
  const sliceSpacing = multiFrame
    ? numbers(series.slices[0].parsed.dataset, '00180088')?.[0] ??
      numbers(series.slices[0].parsed.dataset, '00180050')?.[0] ??
      1
    : estimateSliceSpacing(ordered, series.slices[0].parsed.dataset);

  const oriented = orientArray({
    data: multiFrame ? pixel0.data : stackSlices(ordered, columns, rows),
    sizes,
    spacing: [colSpacing, rowSpacing, Math.max(0.01, Math.abs(sliceSpacing))],
    directions: [rowDir, colDir, normal],
  });

  const dataset = series.slices[0].parsed.dataset;

  return new Volume({
    data: oriented.data,
    dims: oriented.sizes,
    spacing: oriented.spacing,
    slope: pixel0.slope,
    intercept: pixel0.intercept,
    meta: {
      source: 'dicom',
      seriesUid: series.uid,
      description: series.description,
      modality: series.modality,
      transferSyntax: series.slices[0].parsed.transferSyntaxName,
      sliceCount: oriented.sizes[2],
      windowCenter: pixel0.windowCenter,
      windowWidth: pixel0.windowWidth,
      seriesNumber: text(dataset, '00200011'),
      manufacturer: text(dataset, '00080070'),
      oblique: !oriented.isPermutation,
    },
  });
}

/** Sort slices by their projection on the acquisition normal (handles reverse order). */
function sortSlicesAlong(slices, normal) {
  const hasPositions = slices.every((slice) => slice.position);
  if (hasPositions) {
    const keyed = slices.map((slice) => ({
      slice,
      dot: slice.position[0] * normal[0] + slice.position[1] * normal[1] + slice.position[2] * normal[2],
    }));
    const distinct = new Set(keyed.map((entry) => entry.dot.toFixed(3)));
    if (distinct.size > 1) return keyed.sort((a, b) => a.dot - b.dot).map((entry) => entry.slice);
  }
  return [...slices].sort((a, b) => a.instanceNumber - b.instanceNumber);
}

function estimateSliceSpacing(ordered, dataset) {
  const fallback = numbers(dataset, '00180088')?.[0] ?? numbers(dataset, '00180050')?.[0] ?? null;
  if (ordered.length < 2) return fallback ?? 1;
  const diffs = [];
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1].position;
    const b = ordered[i].position;
    if (!a || !b) continue;
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (dist > EPS) diffs.push(dist);
  }
  if (!diffs.length) return fallback ?? 1;
  diffs.sort((x, y) => x - y);
  return diffs[Math.floor(diffs.length / 2)];
}

/** PixelSpacing is [row spacing, column spacing] = [along j, along i]. */
function pixelSpacingMm(dataset) {
  const ps = numbers(dataset, '00280030');
  if (ps && ps.length >= 2 && ps[0] > 0 && ps[1] > 0) return [ps[1], ps[0]];
  return [1, 1];
}

/** Stack individually loaded slice arrays into one flat array. */
function stackSlices(ordered, columns, rows) {
  const ctor = pickArrayType(ordered);
  const frameSize = columns * rows;
  const out = new ctor(frameSize * ordered.length);
  for (let z = 0; z < ordered.length; z++) {
    const pixel = ordered[z].parsed.pixel;
    if (pixel.rows !== rows || pixel.columns !== columns) {
      throw new DicomError(
        `Series contains slices with different matrix sizes (${pixel.columns}x${pixel.rows} vs ${columns}x${rows}).`,
        'INCONSISTENT_MATRIX'
      );
    }
    out.set(pixel.data.subarray(0, frameSize), z * frameSize);
  }
  return out;
}

function pickArrayType(slices) {
  const ctor = Object.getPrototypeOf(slices[0].parsed.pixel.data).constructor;
  const uniform = slices.every((s) => Object.getPrototypeOf(s.parsed.pixel.data).constructor === ctor);
  return uniform ? ctor : Float32Array;
}
