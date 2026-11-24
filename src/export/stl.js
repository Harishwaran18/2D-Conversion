/**
 * Vector STL export (binary STL). Used for 3D printing the segmented scan.
 */

import { Mesh } from '../geom/mesh.js';

/**
 * @param {Mesh} mesh
 * @param {string} [header]
 * @returns {Uint8Array}
 */
export function meshToStlBinary(mesh, header = 'Brain2DPrint') {
  const triangles = mesh.triangleCount;
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const name = header.slice(0, 79);
  for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i);
  view.setUint32(80, triangles, true);

  const p = mesh.positions;
  const idx = mesh.indices;
  let cursor = 84;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    const values = [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]];
    for (const value of values) {
      view.setFloat32(cursor, value, true);
      cursor += 4;
    }
    view.setUint16(cursor, 0, true);
    cursor += 2;
  }

  return bytes;
}

/** Parse a binary STL back into a mesh (used by tests and the 3D preview). */
export function stlBinaryToMesh(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  const positions = new Float64Array(triangles * 9);
  const indices = new Uint32Array(triangles * 3);
  let cursor = 84;
  for (let t = 0; t < triangles; t++) {
    cursor += 12; // skip the normal, it is recomputed
    for (let v = 0; v < 3; v++) {
      positions[t * 9 + v * 3] = view.getFloat32(cursor, true);
      positions[t * 9 + v * 3 + 1] = view.getFloat32(cursor + 4, true);
      positions[t * 9 + v * 3 + 2] = view.getFloat32(cursor + 8, true);
      indices[t * 3 + v] = t * 3 + v;
      cursor += 12;
    }
    cursor += 2;
  }
  return new Mesh(positions, indices);
}
