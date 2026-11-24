/**
 * Small software 3D renderer for the segmented mesh.
 *
 * A z-buffered triangle rasterizer on a 2D canvas: no WebGL context, no shader
 * compilation, works in every browser and headless test environment.
 */

export class MeshViewer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mesh = null;
    this.rotationX = -0.35;
    this.rotationY = 0.6;
    this.zoom = 1;
    this.autoRotate = true;
    this.dragging = false;
    this._buffer = null;
    this._depth = null;
    this._size = [0, 0];
  }

  setMesh(mesh) {
    this.mesh = mesh;
    this._buffer = null;
  }

  setRotation(x, y) {
    this.rotationX = x;
    this.rotationY = y;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this._buffer = null;
    }
    this._size = [width, height];
    this._dpr = dpr;
  }

  draw() {
    this.resize();
    const [width, height] = this._size;
    const ctx = this.ctx;
    if (!this.mesh || this.mesh.triangleCount === 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05070c';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(150, 166, 190, 0.55)';
      ctx.font = `${12 * (this._dpr || 1)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('No mesh yet — run segmentation and create a mesh', width / 2, height / 2);
      return;
    }

    if (!this._buffer || this._buffer.width !== width || this._buffer.height !== height) {
      this._buffer = ctx.createImageData(width, height);
      this._depth = new Float32Array(width * height);
      this._image = new ImageData(width, height);
    }
    const image = this._image || this._buffer;
    const pixels = image.data;
    const depth = this._depth;
    depth.fill(-Infinity);
    pixels.fill(0);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;

    // background gradient
    for (let y = 0; y < height; y++) {
      const t = y / height;
      const r = 6 + 8 * (1 - t);
      const g = 9 + 10 * (1 - t);
      const b = 14 + 18 * (1 - t);
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        pixels[p] = r;
        pixels[p + 1] = g;
        pixels[p + 2] = b;
      }
    }

    const centre = this.meshCentre();
    const scale = (Math.min(width, height) * 0.42 * this.zoom) / this.meshRadius(centre || 1);
    const cx = width / 2;
    const cy = height / 2;

    const cosX = Math.cos(this.rotationX);
    const sinX = Math.sin(this.rotationX);
    const cosY = Math.cos(this.rotationY);
    const sinY = Math.sin(this.rotationY);

    const p = this.mesh.positions;
    const idx = this.mesh.indices;
    const normals = this._normals || (this._normals = this.mesh.computeVertexNormals());
    const light = normalize([0.35, 0.55, 0.75]);

    const project = (i) => {
      let x = p[i] - centre[0];
      let y = p[i + 1] - centre[1];
      let z = p[i + 2] - centre[2];
      // rotate around Y then X
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const y1 = y * cosX - z1 * sinX;
      const z2 = y * sinX + z1 * cosX;
      return [cx + x1 * scale, cy - y1 * scale, z2];
    };

    for (let t = 0; t < idx.length; t += 3) {
      const ia = idx[t];
      const ib = idx[t + 1];
      const ic = idx[t + 2];
      const a = project(ia * 3);
      const b = project(ib * 3);
      const c = project(ic * 3);

      const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (area >= -1e-9) continue; // backface

      // rotate the vertex normal into view space for shading
      const rotateNormal = (i) => {
        const nx = normals[i];
        const ny = normals[i + 1];
        const nz = normals[i + 2];
        const nx1 = nx * cosY + nz * sinY;
        const nz1 = -nx * sinY + nz * cosY;
        const ny1 = ny * cosX - nz1 * sinX;
        const nz2 = ny * sinX + nz1 * cosX;
        return [nx1, ny1, nz2];
      };
      const na = rotateNormal(ia * 3);
      const nb = rotateNormal(ib * 3);
      const nc = rotateNormal(ic * 3);

      const shade = (n) => {
        const lambert = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
        const rim = Math.pow(1 - Math.abs(n[2]), 3) * 0.35;
        return Math.min(1, 0.16 + lambert * 0.82 + rim);
      };
      const sa = shade(na);
      const sb = shade(nb);
      const sc = shade(nc);

      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      if (minX > maxX || minY > maxY) continue;

      const invArea = 1 / area;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const w0 = ((b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y)) * invArea;
          const w1 = ((c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y)) * invArea;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = a[2] * w0 + b[2] * w1 + c[2] * w2;
          const pixelIndex = y * width + x;
          if (z <= depth[pixelIndex]) continue;
          depth[pixelIndex] = z;
          const s = sa * w0 + sb * w1 + sc * w2;
          const fog = Math.min(1, Math.max(0.45, 0.55 + z * 0.05));
          const p4 = pixelIndex * 4;
          pixels[p4] = 235 * s * fog;
          pixels[p4 + 1] = 232 * s * fog;
          pixels[p4 + 2] = 226 * s * fog;
        }
      }
    }

    ctx.putImageData(image, 0, 0);
  }

  meshCentre() {
    const { min, max } = this.mesh.bounds();
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }

  meshRadius(centre) {
    const { min, max } = this.mesh.bounds();
    return (
      Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6) / 2
    );
  }
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
