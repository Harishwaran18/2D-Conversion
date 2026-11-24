/**
 * Browser-only raster loader: PNG / JPEG / WebP / BMP / GIF, single images or
 * image sequences (which are stacked into a volume).
 */

import { Volume } from './volume.js';

/**
 * @typedef {object} RasterInput
 * @property {string} name
 * @property {ArrayBuffer} buffer
 */

/**
 * @param {RasterInput[]} files
 * @returns {Promise<{volume: Volume, warnings: string[]}>}
 */
export async function buildVolumeFromImages(files) {
  const warnings = [];
  if (typeof createImageBitmap !== 'function') {
    throw new Error('Image decoding is not available in this environment');
  }

  const decoded = [];
  for (const file of files) {
    try {
      const blob = new Blob([file.buffer]);
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      decoded.push({ name: file.name, bitmap });
    } catch (error) {
      warnings.push(`Could not decode ${file.name}: ${error.message || error}`);
    }
  }
  if (!decoded.length) throw new Error('No decodable images found');

  decoded.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const width = decoded[0].bitmap.width;
  const height = decoded[0].bitmap.height;
  const depth = decoded.length;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let samples = null;
  const data = new Float32Array(width * height * depth);
  for (let z = 0; z < depth; z++) {
    const { bitmap } = decoded[z];
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < width * height; i++) {
      const r = image[i * 4];
      const g = image[i * 4 + 1];
      const b = image[i * 4 + 2];
      const a = image[i * 4 + 3] / 255;
      // luminance, composited over white so transparent areas stay light
      const value = (0.2126 * r + 0.7152 * g + 0.0722 * b) * a + 255 * (1 - a);
      data[z * width * height + i] = value;
    }
    bitmap.close?.();
  }
  void samples;

  return {
    volume: new Volume({
      data,
      dims: [width, height, depth],
      spacing: [1, 1, 1],
      meta: {
        source: 'image',
        description: depth > 1 ? `Image sequence (${depth} frames)` : 'Image',
        modality: 'IMG',
        windowCenter: 128,
        windowWidth: 256,
      },
    }),
    warnings,
  };
}
