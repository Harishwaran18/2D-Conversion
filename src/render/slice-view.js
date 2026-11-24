/**
 * Canvas renderer for a single orthogonal slice, with crosshair, anatomical
 * labels, mask overlay and a 10 mm scale bar.
 */

import { colormap } from './colormaps.js';
import { maskSlice } from '../seg/mask-slice.js';

export class SliceView {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.volume = null;
    this.segmentation = null;
    this.spacing = [1, 1, 1];
    this.axis = 'axial';
    this.index = 0;
    this.center = 0;
    this.width = 1;
    this.lut = colormap('gray');
    this.overlayOpacity = 0.45;
    this.showCrosshair = true;
    this.crosshair = null;
    this._offscreen = document.createElement('canvas');
    this._offscreenCtx = this._offscreen.getContext('2d');
    this._lastSlice = null;
    this._lastImage = null;
  }

  setVolume(volume) {
    this.volume = volume;
    this._lastImage = null;
    this._lastSlice = null;
  }

  setSegmentation(segmentation, spacing) {
    this.segmentation = segmentation;
    if (spacing) this.spacing = spacing;
    this._lastImage = null;
  }

  setWindow(center, width) {
    this.center = center;
    this.width = Math.max(1e-6, width);
    this._lastImage = null;
  }

  setColormap(name) {
    this.lut = colormap(name);
    this._lastImage = null;
  }

  setAxis(axis) {
    if (this.axis === axis) return;
    this.axis = axis;
    this.index = Math.round(this.volume ? this.volume.sliceCount(axis) / 2 : 0);
    this._lastImage = null;
  }

  setIndex(index) {
    const max = this.volume ? this.volume.sliceCount(this.axis) - 1 : 0;
    this.index = Math.max(0, Math.min(max, Math.round(index)));
  }

  /** Convert a canvas-relative point into volume voxel coordinates. */
  pointerToVoxel(clientX, clientY) {
    if (!this.rendered) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) * this.canvas.width) / rect.width;
    const y = ((clientY - rect.top) * this.canvas.height) / rect.height;
    const { x: ox, y: oy, width: dw, height: dh, sliceWidth, sliceHeight } = this.rendered;
    if (x < ox || y < oy || x > ox + dw || y > oy + dh) return null;
    const fx = ((x - ox) / dw) * (sliceWidth - 1);
    const fy = ((y - oy) / dh) * (sliceHeight - 1);
    return { u: Math.round(fx), v: Math.round(fy) };
  }

  /** Physical size of the drawn slice in millimetres. */
  physicalSize() {
    if (!this.volume) return { width: 1, height: 1 };
    const slice = this.volume.slice(this.axis, this.index);
    return { width: slice.width * slice.colSpacing, height: slice.height * slice.rowSpacing };
  }

  /** Rebuild the offscreen pixel buffer for the current slice. */
  buildImage() {
    const slice = this.volume.slice(this.axis, this.index);
    const { width, height, data } = slice;

    if (this._lastSlice !== slice) {
      this._lastSlice = slice;
      this._offscreen.width = width;
      this._offscreen.height = height;
      this._imageData = this._offscreenCtx.createImageData(width, height);
      this._lastImage = null;
    }

    const img = this._imageData;
    const pixels = img.data;
    const low = this.center - this.width / 2;
    const scale = 255 / this.width;
    const lut = this.lut;
    let mask = null;
    if (this.segmentation) {
      mask = maskSlice(this.segmentation, this.axis, this.index, this.spacing).data;
    }

    for (let v = 0; v < height; v++) {
      for (let u = 0; u < width; u++) {
        const pixel = (v * width + u) * 4;
        let t = (data[v * width + u] - low) * scale;
        t = t < 0 ? 0 : t > 255 ? 255 : t | 0;
        pixels[pixel] = lut[t * 3];
        pixels[pixel + 1] = lut[t * 3 + 1];
        pixels[pixel + 2] = lut[t * 3 + 2];
        pixels[pixel + 3] = 255;

        if (mask) {
          if (mask[v * width + u]) {
            const alpha = this.overlayOpacity;
            pixels[pixel] = pixels[pixel] * (1 - alpha) + 255 * alpha * 0.95;
            pixels[pixel + 1] = pixels[pixel + 1] * (1 - alpha) + 90 * alpha;
            pixels[pixel + 2] = pixels[pixel + 2] * (1 - alpha) + 210 * alpha;
          }
        }
      }
    }
    this._offscreenCtx.putImageData(img, 0, 0);
    this._lastImage = this._offscreen;
    return slice;
  }

  draw() {
    if (!this.volume) {
      this.clear();
      return;
    }
    const slice = this.buildImage();
    const ctx = this.ctx;
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 300;
    const cssHeight = canvas.clientHeight || 300;
    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const physical = { width: slice.width * slice.colSpacing, height: slice.height * slice.rowSpacing };
    const padding = 14;
    const scale = Math.min(
      (cssWidth - padding * 2) / physical.width,
      (cssHeight - padding * 2) / physical.height
    );
    const drawWidth = physical.width * scale;
    const drawHeight = physical.height * scale;
    const ox = (cssWidth - drawWidth) / 2;
    const oy = (cssHeight - drawHeight) / 2;

    // bilinear upscaling: matches how radiology viewers present thick slices
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this._lastImage, ox, oy, drawWidth, drawHeight);

    this.rendered = {
      x: ox * dpr,
      y: oy * dpr,
      width: drawWidth * dpr,
      height: drawHeight * dpr,
      sliceWidth: slice.width,
      sliceHeight: slice.height,
      scale,
    };

    // labels
    ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(160, 178, 205, 0.85)';
    ctx.textAlign = 'center';
    ctx.fillText(slice.labels.top, cssWidth / 2, 12);
    ctx.fillText(slice.labels.bottom, cssWidth / 2, cssHeight - 3);
    ctx.textAlign = 'left';
    ctx.fillText(slice.labels.left, 3, cssHeight / 2 + 4);
    ctx.textAlign = 'right';
    ctx.fillText(slice.labels.right, cssWidth - 3, cssHeight / 2 + 4);

    // crosshair
    if (this.showCrosshair && this.crosshair) {
      const { u, v } = this.crosshair.relative(this.axis, slice);
      const cx = ox + ((u + 0.5) / slice.width) * drawWidth;
      const cy = oy + ((v + 0.5) / slice.height) * drawHeight;
      ctx.strokeStyle = 'rgba(88, 210, 255, 0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ox, cy);
      ctx.lineTo(ox + drawWidth, cy);
      ctx.moveTo(cx, oy);
      ctx.lineTo(cx, oy + drawHeight);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(88, 210, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // scale bar (10 mm, shorter if the slice is small)
    const barMm = physical.width > 30 ? 10 : 5;
    const barPx = barMm * scale;
    ctx.strokeStyle = 'rgba(220, 232, 255, 0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ox + 6, oy + drawHeight - 8);
    ctx.lineTo(ox + 6 + barPx, oy + drawHeight - 8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(220, 232, 255, 0.8)';
    ctx.textAlign = 'left';
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`${barMm} mm`, ox + 8, oy + drawHeight - 13);

    // slice index
    ctx.textAlign = 'right';
    ctx.fillText(`${this.axis} ${this.index + 1}/${this.volume.sliceCount(this.axis)}`, ox + drawWidth - 4, oy + 12);
  }

  clear() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
