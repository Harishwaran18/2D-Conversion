/**
 * Indexed triangle mesh helpers (positions in millimetres).
 */

export class Mesh {
  /**
   * @param {ArrayLike<number>} positions flat xyz triplets
   * @param {ArrayLike<number>} indices flat triangle indices
   */
  constructor(positions = [], indices = []) {
    this.positions = positions instanceof Float64Array ? positions : Float64Array.from(positions);
    this.indices = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  }

  get vertexCount() {
    return this.positions.length / 3;
  }

  get triangleCount() {
    return this.indices.length / 3;
  }

  /** @returns {{min: number[], max: number[]}} */
  bounds() {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = this.positions[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
    return { min, max };
  }

  /** Signed volume; positive when triangles wind counter-clockwise seen from outside. */
  signedVolume() {
    const p = this.positions;
    const idx = this.indices;
    let volume = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3;
      const b = idx[t + 1] * 3;
      const c = idx[t + 2] * 3;
      volume +=
        p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return volume / 6;
  }

  /** @returns {this} */
  flipWinding() {
    for (let t = 0; t < this.indices.length; t += 3) {
      const tmp = this.indices[t + 1];
      this.indices[t + 1] = this.indices[t + 2];
      this.indices[t + 2] = tmp;
    }
    return this;
  }

  /** Area-weighted smooth vertex normals. */
  computeVertexNormals() {
    const normals = new Float32Array(this.positions.length);
    const p = this.positions;
    const idx = this.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const ai = idx[t] * 3;
      const bi = idx[t + 1] * 3;
      const ci = idx[t + 2] * 3;
      const abx = p[bi] - p[ai];
      const aby = p[bi + 1] - p[ai + 1];
      const abz = p[bi + 2] - p[ai + 2];
      const acx = p[ci] - p[ai];
      const acy = p[ci + 1] - p[ai + 1];
      const acz = p[ci + 2] - p[ai + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      normals[ai] += nx;
      normals[ai + 1] += ny;
      normals[ai + 2] += nz;
      normals[bi] += nx;
      normals[bi + 1] += ny;
      normals[bi + 2] += nz;
      normals[ci] += nx;
      normals[ci + 1] += ny;
      normals[ci + 2] += nz;
    }
    for (let i = 0; i < normals.length; i += 3) {
      const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    }
    return normals;
  }

  /**
   * @param {Mesh} other
   * @returns {Mesh}
   */
  merge(other) {
    const positions = new Float64Array(this.positions.length + other.positions.length);
    positions.set(this.positions, 0);
    positions.set(other.positions, this.positions.length);
    const offset = this.vertexCount;
    const indices = new Uint32Array(this.indices.length + other.indices.length);
    indices.set(this.indices, 0);
    for (let i = 0; i < other.indices.length; i++) indices[this.indices.length + i] = other.indices[i] + offset;
    return new Mesh(positions, indices);
  }

  /** Apply a per-vertex callback returning [x, y, z]. */
  mapPositions(fn) {
    const p = Float64Array.from(this.positions);
    for (let i = 0; i < p.length; i += 3) {
      const [x, y, z] = fn(p[i], p[i + 1], p[i + 2], i / 3);
      p[i] = x;
      p[i + 1] = y;
      p[i + 2] = z;
    }
    return new Mesh(p, this.indices);
  }
}

/** Group triangle edges into an adjacency list (undirected). */
export function buildAdjacency(mesh) {
  const n = mesh.vertexCount;
  const counts = new Uint32Array(n + 1);
  const idx = mesh.indices;
  const edges = [];
  const seen = new Set();
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e];
      const b = idx[t + ((e + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(a, b);
      counts[a + 1]++;
      counts[b + 1]++;
    }
  }
  for (let i = 0; i < n; i++) counts[i + 1] += counts[i];
  const offsets = counts;
  const neighbours = new Uint32Array(edges.length);
  const cursor = Uint32Array.from(counts.subarray(0, n));
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i];
    const b = edges[i + 1];
    neighbours[cursor[a]++] = b;
    neighbours[cursor[b]++] = a;
  }
  return { offsets, neighbours };
}
