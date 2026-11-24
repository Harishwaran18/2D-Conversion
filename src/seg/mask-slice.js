/**
 * Extract a segmentation mask in the same orientation and layout as
 * {@link Volume.slice} so the two can be compared pixel by pixel.
 */

/**
 * @param {{mask: Uint8Array, dims: [number, number, number]}} segmentation
 * @param {'axial'|'coronal'|'sagittal'} axis
 * @param {number} index
 * @param {[number, number, number]} spacing
 */
export function maskSlice(segmentation, axis, index, spacing) {
  const [nx, ny, nz] = segmentation.dims;
  const mask = segmentation.mask;
  if (axis === 'axial') {
    const k = clamp(index, nz);
    const width = nx;
    const height = ny;
    const out = new Uint8Array(width * height);
    out.set(mask.subarray(k * width * height, (k + 1) * width * height));
    return { data: out, width, height, colSpacing: spacing[0], rowSpacing: spacing[1], index: k };
  }
  if (axis === 'coronal') {
    const j = clamp(index, ny);
    const width = nx;
    const height = nz;
    const out = new Uint8Array(width * height);
    for (let k = 0; k < height; k++) {
      const dst = (height - 1 - k) * width;
      const row = (k * ny + j) * nx;
      out.set(mask.subarray(row, row + width), dst);
    }
    return { data: out, width, height, colSpacing: spacing[0], rowSpacing: spacing[2], index: j };
  }
  const i = clamp(index, nx);
  const width = ny;
  const height = nz;
  const out = new Uint8Array(width * height);
  for (let k = 0; k < height; k++) {
    const dst = (height - 1 - k) * width;
    for (let j = 0; j < width; j++) out[dst + j] = mask[(k * ny + j) * nx + i];
  }
  return { data: out, width, height, colSpacing: spacing[1], rowSpacing: spacing[2], index: i };
}

function clamp(value, size) {
  return Math.min(size - 1, Math.max(0, Math.round(value)));
}
