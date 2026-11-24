/**
 * Canonical volume model used by every part of the app.
 *
 * Voxel storage is `data[(k * ny + j) * nx + i]`, where i, j, k are the
 * column, row and slice indices. After loading, the volume is normalised to a
 * patient-oriented frame:
 *
 *   i -> increases toward patient  LEFT
 *   j -> increases toward patient  POSTERIOR
 *   k -> increases toward patient  SUPERIOR
 *
 * Physical values are `raw * slope + intercept` (DICOM rescale / NIfTI scaling).
 */

export const AXES = ['axial', 'coronal', 'sagittal'];

/** Opposite anatomical direction, used for the edge labels of each view. */
const OPPOSITE = { L: 'R', R: 'L', A: 'P', P: 'A', S: 'I', I: 'S' };

/** Direction each canonical array axis points to. */
const AXIS_DIRECTION = { i: 'L', j: 'P', k: 'S' };

/**
 * @param {string} dir
 * @returns {string}
 */
function opposite(dir) {
  return OPPOSITE[dir] || dir;
}

export class Volume {
  /**
   * @param {object} opts
   * @param {ArrayBufferView} opts.data raw samples
   * @param {[number, number, number]} opts.dims [nx, ny, nz]
   * @param {[number, number, number]} opts.spacing voxel size in millimetres
   * @param {number} [opts.slope]
   * @param {number} [opts.intercept]
   * @param {object} [opts.meta] free-form loader metadata
   */
  constructor({ data, dims, spacing, slope = 1, intercept = 0, meta = {} }) {
    const [nx, ny, nz] = dims;
    if (!nx || !ny || !nz) throw new Error('Volume dimensions must be positive');
    if (data.length !== nx * ny * nz) {
      throw new Error(`Volume data size ${data.length} does not match dims ${dims.join('x')}`);
    }
    this.data = data;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.spacing = spacing;
    this.slope = slope;
    this.intercept = intercept;
    this.meta = meta;
    /** @type {{min:number,max:number,p02:number,p98:number,mean:number}|null} */
    this._stats = null;
  }

  get voxelCount() {
    return this.nx * this.ny * this.nz;
  }

  /** Physical value at a voxel. */
  valueAt(i, j, k) {
    return this.data[(k * this.ny + j) * this.nx + i] * this.slope + this.intercept;
  }

  /** Approximate histogram (physical units) over a strided sample of the volume. */
  histogram(bins = 1024, maxSamples = 2_000_000) {
    const total = this.voxelCount;
    const step = Math.max(1, Math.floor(total / maxSamples));
    let lo = Infinity;
    let hi = -Infinity;
    for (let v = 0; v < total; v += step) {
      const x = this.data[v] * this.slope + this.intercept;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) {
      return { counts: new Float64Array(bins).fill(0), min: 0, max: 1 };
    }
    const counts = new Float64Array(bins);
    const scale = (bins - 1) / (hi - lo);
    for (let v = 0; v < total; v += step) {
      const x = this.data[v] * this.slope + this.intercept;
      counts[Math.min(bins - 1, Math.max(0, Math.round((x - lo) * scale)))]++;
    }
    return { counts, min: lo, max: hi };
  }

  /** Percentile-based intensity statistics, cached. */
  stats() {
    if (this._stats) return this._stats;
    const { counts, min, max } = this.histogram();
    const n = counts.reduce((a, b) => a + b, 0);
    const at = (q) => {
      const target = q * n;
      let acc = 0;
      for (let b = 0; b < counts.length; b++) {
        acc += counts[b];
        if (acc >= target) return min + (b / (counts.length - 1)) * (max - min);
      }
      return max;
    };
    let sum = 0;
    for (let b = 0; b < counts.length; b++) {
      const value = min + (b / (counts.length - 1)) * (max - min);
      sum += value * counts[b];
    }
    this._stats = {
      min,
      max,
      mean: n ? sum / n : 0,
      p02: at(0.02),
      p98: at(0.98),
    };
    return this._stats;
  }

  /**
   * Extract one orthogonal slice, already flipped so that it reads correctly on
   * screen, with the anatomical edge labels for the renderer.
   *
   * @param {'axial'|'coronal'|'sagittal'} axis
   * @param {number} index slice index within that axis
   */
  slice(axis, index) {
    if (axis === 'axial') {
      const k = clampIndex(index, this.nz);
      const width = this.nx;
      const height = this.ny;
      const out = new Float32Array(width * height);
      const base = k * this.ny * this.nx;
      for (let j = 0; j < height; j++) {
        const row = base + j * this.nx;
        for (let i = 0; i < width; i++) {
          out[j * width + i] = this.data[row + i] * this.slope + this.intercept;
        }
      }
      return {
        data: out,
        width,
        height,
        colSpacing: this.spacing[0],
        rowSpacing: this.spacing[1],
        index: k,
        labels: { top: 'A', bottom: 'P', left: 'R', right: 'L' },
      };
    }

    if (axis === 'coronal') {
      const j = clampIndex(index, this.ny);
      const width = this.nx;
      const height = this.nz;
      const out = new Float32Array(width * height);
      for (let k = 0; k < height; k++) {
        // k grows superior, screen rows grow downward => flip vertically
        const dstRow = (height - 1 - k) * width;
        const row = (k * this.ny + j) * this.nx;
        for (let i = 0; i < width; i++) {
          out[dstRow + i] = this.data[row + i] * this.slope + this.intercept;
        }
      }
      return {
        data: out,
        width,
        height,
        colSpacing: this.spacing[0],
        rowSpacing: this.spacing[2],
        index: j,
        labels: { top: 'S', bottom: 'I', left: 'R', right: 'L' },
      };
    }

    if (axis === 'sagittal') {
      const i = clampIndex(index, this.nx);
      const width = this.ny;
      const height = this.nz;
      const out = new Float32Array(width * height);
      for (let k = 0; k < height; k++) {
        const dstRow = (height - 1 - k) * width;
        for (let j = 0; j < width; j++) {
          out[dstRow + j] = this.valueAt(i, j, k);
        }
      }
      return {
        data: out,
        width,
        height,
        colSpacing: this.spacing[1],
        rowSpacing: this.spacing[2],
        index: i,
        labels: { top: 'S', bottom: 'I', left: 'A', right: 'P' },
      };
    }

    throw new Error(`Unknown axis ${axis}`);
  }

  sliceCount(axis) {
    if (axis === 'axial') return this.nz;
    if (axis === 'coronal') return this.ny;
    if (axis === 'sagittal') return this.nx;
    throw new Error(`Unknown axis ${axis}`);
  }

  /** Average-pooled copy, used to keep mesh generation inside a memory budget. */
  downsample(maxVoxels = 6_000_000) {
    const factor = Math.ceil(Math.cbrt(this.voxelCount / maxVoxels));
    if (factor <= 1) return { volume: this, factor: 1 };
    const nx = Math.max(2, Math.floor(this.nx / factor));
    const ny = Math.max(2, Math.floor(this.ny / factor));
    const nz = Math.max(2, Math.floor(this.nz / factor));
    const out = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          let sum = 0;
          for (let dk = 0; dk < factor; dk++) {
            const kk = Math.min(this.nz - 1, k * factor + dk);
            for (let dj = 0; dj < factor; dj++) {
              const jj = Math.min(this.ny - 1, j * factor + dj);
              const row = (kk * this.ny + jj) * this.nx;
              for (let di = 0; di < factor; di++) {
                sum += this.data[row + Math.min(this.nx - 1, i * factor + di)];
              }
            }
          }
          out[(k * ny + j) * nx + i] = sum / (factor * factor * factor);
        }
      }
    }
    const scaled = new Volume({
      data: out,
      dims: [nx, ny, nz],
      spacing: [this.spacing[0] * factor, this.spacing[1] * factor, this.spacing[2] * factor],
      meta: { ...this.meta, downsampledBy: factor },
    });
    return { volume: scaled, factor };
  }
}

/**
 * @param {number} value
 * @param {number} size
 */
function clampIndex(value, size) {
  return Math.min(size - 1, Math.max(0, Math.round(value)));
}

/**
 * Convert a tailor-friendly size selection to millimetres of wall thickness.
 * @param {string} label e.g. "4mm", "1.5 mm"
 * @returns {number}
 */
export function parseMillimetres(label) {
  const match = /([\d.]+)\s*mm/i.exec(String(label));
  return match ? parseFloat(match[1]) : 0;
}

export { AXIS_DIRECTION, opposite };
