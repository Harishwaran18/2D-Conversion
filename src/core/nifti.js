/**
 * NIfTI-1 / NIfTI-2 reader (plain .nii and gzip .nii.gz).
 */

import { Volume } from './volume.js';
import { orientArray, cross } from './orient.js';

export class NiftiError extends Error {
  constructor(message, code = 'NIFTI_ERROR') {
    super(message);
    this.name = 'NiftiError';
    this.code = code;
  }
}

const NIFTI1_TYPES = {
  2: Uint8Array,
  4: Int16Array,
  8: Int32Array,
  16: Float32Array,
  64: Float64Array,
  256: Int8Array,
  512: Uint16Array,
  768: Uint32Array,
  1024: BigInt64Array,
  1280: BigUint64Array,
};

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Volume>}
 */
export async function parseNifti(buffer) {
  const bytes = new Uint8Array(buffer);
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : buffer;
  const view = new DataView(raw);

  const sizeCheck = view.getInt32(0, true);
  let littleEndian = true;
  let version = 1;
  if (sizeCheck === 348) {
    version = 1;
  } else if (view.getInt32(0, false) === 348) {
    littleEndian = false;
  } else if (sizeCheck === 540) {
    version = 2;
  } else if (view.getInt32(0, false) === 540) {
    version = 2;
    littleEndian = false;
  } else {
    throw new NiftiError('Not a NIfTI file (bad sizeof_hdr)', 'BAD_HEADER');
  }

  const getI16 = (o) => view.getInt16(o, littleEndian);
  const getI32 = (o) => view.getInt32(o, littleEndian);
  const getF32 = (o) => view.getFloat32(o, littleEndian);
  const getF64 = (o) => view.getFloat64(o, littleEndian);
  const getI64 = (o) => Number(view.getBigInt64(o, littleEndian));

  const dims = [1, 1, 1];
  let datatype;
  let bitpix;
  const pixdim = [1, 1, 1, 1];
  let voxOffset;
  let sclSlope;
  let sclInter;
  const srow = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ];
  let qformCode = 0;
  let sformCode = 0;

  if (version === 1) {
    dims[0] = Math.max(1, getI16(40 + 2));
    dims[1] = Math.max(1, getI16(40 + 4));
    dims[2] = Math.max(1, getI16(40 + 6));
    datatype = getI16(70);
    bitpix = getI16(72);
    for (let d = 0; d < 4; d++) pixdim[d] = getF32(76 + d * 4);
    voxOffset = getF32(108);
    sclSlope = getF32(112);
    sclInter = getF32(116);
    qformCode = getI16(252);
    sformCode = getI16(254);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) srow[r][c] = getF32(280 + r * 16 + c * 4);
    const magic = String.fromCharCode(
      view.getUint8(344),
      view.getUint8(345),
      view.getUint8(346)
    );
    if (!magic.startsWith('n+')) throw new NiftiError('Missing NIfTI-1 magic string', 'BAD_MAGIC');
  } else {
    // NIfTI-2: length fields are 8 bytes, then dim is int64[8].
    dims[0] = Math.max(1, getI64(16 + 8));
    dims[1] = Math.max(1, getI64(16 + 16));
    dims[2] = Math.max(1, getI64(16 + 24));
    datatype = getI16(12);
    bitpix = getI16(14);
    for (let d = 0; d < 4; d++) pixdim[d] = getF64(104 + d * 8);
    voxOffset = getI64(168);
    sclSlope = getF64(176);
    sclInter = getF64(184);
    qformCode = getI32(344);
    sformCode = getI32(348);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) srow[r][c] = getF64(400 + r * 32 + c * 8);
    const magic = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6));
    if (!magic.startsWith('n+')) throw new NiftiError('Missing NIfTI-2 magic string', 'BAD_MAGIC');
  }

  const Ctor = NIFTI1_TYPES[datatype];
  if (!Ctor) throw new NiftiError(`Unsupported NIfTI datatype code ${datatype}`, 'UNSUPPORTED_DATATYPE');

  const [nx, ny, nz] = dims;
  const count = nx * ny * nz;
  const bytesPerVoxel = Math.abs(bitpix) / 8;
  if (!voxOffset || voxOffset < 348) voxOffset = version === 1 ? 352 : 544;
  if (voxOffset + count * bytesPerVoxel > raw.byteLength + 1) {
    throw new NiftiError(
      `NIfTI data is truncated: need ${count * bytesPerVoxel} bytes, file has ${raw.byteLength - voxOffset}.`,
      'TRUNCATED'
    );
  }

  const data = new Ctor(count);
  const dataView = new DataView(raw, voxOffset, count * bytesPerVoxel);
  readTypedArray(data, dataView, Ctor, littleEndian);

  const spacing = [Math.abs(pixdim[1]) || 1, Math.abs(pixdim[2]) || 1, Math.abs(pixdim[3]) || 1];
  const slope = Number.isFinite(sclSlope) && sclSlope !== 0 ? sclSlope : 1;
  const intercept = Number.isFinite(sclInter) ? sclInter : 0;

  let oriented = { data, sizes: [nx, ny, nz], spacing, isPermutation: true };
  const hasSform = sformCode > 0 && srow.some((row) => row.some((v) => v !== 0));
  if (hasSform) {
    // NIfTI world space is RAS (+x = RIGHT, +y = ANTERIOR, +z = SUPERIOR);
    // convert to DICOM LPS by negating x and y.
    const col = (c) => [-srow[0][c], -srow[1][c], srow[2][c]];
    const iDir = col(0);
    const jDir = col(1);
    const kDir = col(2);
    oriented = orientArray({
      data,
      sizes: [nx, ny, nz],
      spacing,
      directions: [iDir, jDir, cross(iDir, jDir)],
    });
    void kDir;
  }

  return new Volume({
    data: oriented.data,
    dims: oriented.sizes,
    spacing: oriented.spacing,
    slope,
    intercept,
    meta: {
      source: 'nifti',
      description: 'NIfTI volume',
      modality: 'MR',
      version,
    },
  });
}

function readTypedArray(target, dataView, Ctor, littleEndian) {
  const n = target.length;
  if (Ctor === Uint8Array) {
    target.set(new Uint8Array(dataView.buffer, dataView.byteOffset, n));
    return;
  }
  if (Ctor === Int8Array) {
    for (let i = 0; i < n; i++) target[i] = (dataView.getUint8(i) << 24) >> 24;
    return;
  }
  if (Ctor === Uint16Array) {
    for (let i = 0; i < n; i++) target[i] = dataView.getUint16(i * 2, littleEndian);
    return;
  }
  if (Ctor === Int16Array) {
    for (let i = 0; i < n; i++) target[i] = dataView.getInt16(i * 2, littleEndian);
    return;
  }
  if (Ctor === Uint32Array) {
    for (let i = 0; i < n; i++) target[i] = dataView.getUint32(i * 4, littleEndian);
    return;
  }
  if (Ctor === Int32Array) {
    for (let i = 0; i < n; i++) target[i] = dataView.getInt32(i * 4, littleEndian);
    return;
  }
  if (Ctor === Float32Array) {
    for (let i = 0; i < n; i++) target[i] = dataView.getFloat32(i * 4, littleEndian);
    return;
  }
  if (Ctor === Float64Array) {
    for (let i = 0; i < n; i++) target[i] = dataView.getFloat64(i * 8, littleEndian);
    return;
  }
  throw new NiftiError('Unsupported NIfTI element type', 'UNSUPPORTED_DATATYPE');
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new NiftiError('This browser cannot gunzip .nii.gz files', 'NO_GUNZIP');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
