/**
 * The end-to-end "scan -> printable model" pipeline:
 *
 *   volume -> mask (Otsu/threshold + cleanup) -> isosurface -> Taubin smoothing
 *          -> vertex-cluster decimation -> hollow shell
 *
 * The resulting mesh keeps millimetre coordinates, so slicing it yields
 * true-scale 2D outlines.
 */

import { segmentVolume } from '../seg/segment.js';
import { maskBounds, cropMask, padMask } from '../seg/segment.js';
import { isosurface } from './isosurface.js';
import { smoothMesh, smoothingIterations } from './smooth.js';
import { clusterDecimate } from './decimate.js';
import { buildInnerSurface, combineShells } from './hollow.js';
import { sliceMesh } from './slice.js';

/**
 * @typedef {object} PrintOptions
 * @property {'auto'|'manual'} [mode]
 * @property {number} [threshold]
 * @property {boolean} [keepLargest]
 * @property {boolean} [fill]
 * @property {number} [smoothing] 0..1
 * @property {number} [simplify] 10..150 (percent dial, higher = more merging)
 * @property {number} [hollow] wall thickness in mm
 * @property {number} [pad] voxels of padding around the mask
 */

/**
 * @param {import('../core/volume.js').Volume} volume
 * @param {PrintOptions} [options]
 * @param {{onStage?: (stage: string, progress: number) => void}} [hooks]
 */
export function buildPrintModel(volume, options = {}, hooks = {}) {
  const report = hooks.onStage || (() => {});
  const {
    mode = 'auto',
    threshold,
    keepLargest = true,
    fill = true,
    smoothing = 0.45,
    simplify = 75,
    hollow = 0,
    pad = 1,
  } = options;

  report('segment', 0.05);
  const segmentation = segmentVolume(volume, { mode, threshold, keepLargest, fill });
  const bounds = maskBounds(segmentation.mask, segmentation.dims);
  if (!bounds) throw new Error('Segmentation produced an empty mask - adjust the threshold.');

  const padded = {
    minX: Math.max(0, bounds.minX - pad),
    minY: Math.max(0, bounds.minY - pad),
    minZ: Math.max(0, bounds.minZ - pad),
    maxX: Math.min(segmentation.dims[0] - 1, bounds.maxX + pad),
    maxY: Math.min(segmentation.dims[1] - 1, bounds.maxY + pad),
    maxZ: Math.min(segmentation.dims[2] - 1, bounds.maxZ + pad),
  };
  // one empty voxel ring guarantees the extracted surface closes everywhere,
  // even when the mask touches the edge of the scan
  const crop = cropMask(segmentation.mask, segmentation.dims, padded);
  const cropped = padMask(crop.mask, crop.dims, 1);

  report('surface', 0.15);
  const origin = [
    (padded.minX - 1) * volume.spacing[0],
    (padded.minY - 1) * volume.spacing[1],
    (padded.minZ - 1) * volume.spacing[2],
  ];
  let mesh = isosurface(cropped.mask, cropped.dims, volume.spacing, {
    level: 0.5,
    origin,
    onProgress: (fraction) => report('surface', 0.15 + fraction * 0.35),
  });

  if (mesh.triangleCount === 0) throw new Error('No surface found - adjust the threshold.');

  report('hollow', 0.5);
  const inner = hollow > 0 ? buildInnerSurface(cropped.mask, cropped.dims, volume.spacing, hollow, origin) : null;

  report('smooth', 0.6);
  const iterations = smoothingIterations(smoothing);
  if (iterations > 0) mesh = smoothMesh(mesh, { iterations });
  let innerMesh = inner;
  if (innerMesh && iterations > 0) innerMesh = smoothMesh(innerMesh, { iterations });

  report('simplify', 0.75);
  const cellSize = (meanSpacing(volume.spacing) * Math.min(150, Math.max(10, simplify))) / 100;
  if (cellSize > 0) {
    mesh = clusterDecimate(mesh, cellSize);
    if (innerMesh) innerMesh = clusterDecimate(innerMesh, cellSize);
  }

  report('hollow', 0.9);
  const shells = combineShells(mesh, innerMesh);
  mesh = shells.mesh;
  const wall = shells.hollowed ? hollow : 0;

  report('done', 1);
  const boundsMm = mesh.bounds();
  return {
    mesh,
    wall,
    segmentation: {
      threshold: segmentation.threshold,
      otsu: segmentation.otsu,
      coverage: segmentation.coverage,
      bounds: padded,
    },
    stats: {
      triangles: mesh.triangleCount,
      vertices: mesh.vertexCount,
      volumeMm3: Math.abs(mesh.signedVolume()),
      boundsMm,
    },
  };
}

/**
 * Slice a print model at physical millimetre positions.
 * @param {import('./mesh.js').Mesh} mesh
 * @param {'axial'|'coronal'|'sagittal'} axis
 * @param {number[]} positions
 * @param {{tolerance?: number, minLength?: number}} [opts]
 * @returns {Array<{position: number, contours: number[][][]}>}
 */
export function slicePrintModel(mesh, axis, positions, opts = {}) {
  const plane = axis === 'axial' ? 'z' : axis === 'coronal' ? 'y' : 'x';
  return positions.map((position) => ({ position, contours: sliceMesh(mesh, plane, position, opts) }));
}

function meanSpacing(spacing) {
  return (Math.abs(spacing[0]) + Math.abs(spacing[1]) + Math.abs(spacing[2])) / 3;
}
