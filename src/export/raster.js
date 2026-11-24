/**
 * Browser raster helpers: PNG slice rendering, contact sheets and downloads.
 */

import { colormap } from '../render/colormaps.js';

/**
 * Render one slice to a canvas at native resolution (optionally upscaled).
 *
 * @param {import('../core/volume.js').Volume} volume
 * @param {'axial'|'coronal'|'sagittal'} axis
 * @param {number} index
 * @param {object} opts
 * @param {number} opts.center
 * @param {number} opts.width
 * @param {string} [opts.colormap]
 * @param {number} [opts.scale]
 * @param {string} [opts.background]
 * @returns {{canvas: HTMLCanvasElement, label: string}}
 */
export function sliceToCanvas(volume, axis, index, opts) {
  const slice = volume.slice(axis, index);
  const scale = Math.max(1, opts.scale || 1);
  const canvas = document.createElement('canvas');
  canvas.width = slice.width * scale;
  canvas.height = slice.height * scale;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(slice.width, slice.height);
  const lut = colormap(opts.colormap || 'gray');
  const low = opts.center - opts.width / 2;
  const step = 255 / Math.max(1e-9, opts.width);
  for (let i = 0; i < slice.data.length; i++) {
    let t = (slice.data[i] - low) * step;
    t = t < 0 ? 0 : t > 255 ? 255 : t | 0;
    image.data[i * 4] = lut[t * 3];
    image.data[i * 4 + 1] = lut[t * 3 + 1];
    image.data[i * 4 + 2] = lut[t * 3 + 2];
    image.data[i * 4 + 3] = 255;
  }
  const buffer = document.createElement('canvas');
  buffer.width = slice.width;
  buffer.height = slice.height;
  buffer.getContext('2d').putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(buffer, 0, 0, canvas.width, canvas.height);
  return { canvas, label: `${axis} ${index + 1}` };
}

/** Render many slices into a grid contact sheet. */
export function contactSheet(items, { columns = 4, gap = 6, background = '#05070c', labelColor = '#9fb0c9' } = {}) {
  const cellW = Math.max(...items.map((item) => item.canvas.width));
  const cellH = Math.max(...items.map((item) => item.canvas.height));
  const rows = Math.ceil(items.length / columns);
  const labelHeight = 16;
  const canvas = document.createElement('canvas');
  canvas.width = columns * cellW + (columns + 1) * gap;
  canvas.height = rows * (cellH + labelHeight) + (rows + 1) * gap;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = labelColor;
  items.forEach((item, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = gap + col * (cellW + gap);
    const y = gap + row * (cellH + labelHeight + gap);
    const dx = x + (cellW - item.canvas.width) / 2;
    ctx.drawImage(item.canvas, dx, y);
    ctx.fillText(item.label, x, y + cellH + 12);
  });
  return canvas;
}

/** @returns {Promise<Blob>} */
export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas encoding failed'))), type, quality);
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text, filename, mime = 'text/plain') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
