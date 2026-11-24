/**
 * Test fixtures: tiny but valid DICOM Part-10 files and NIfTI volumes.
 * Used by the node tests and by `npm run fixtures` to write sample files.
 */

const textEncoder = new TextEncoder();

function pad(value, padByte) {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
  if (bytes.length % 2 === 1) {
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes);
    out[bytes.length] = padByte;
    return out;
  }
  return bytes;
}

const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UR', 'UT', 'UN']);

function element(group, tag, vr, payload, explicit = true) {
  const header = new Uint8Array(explicit ? (LONG_VR.has(vr) ? 12 : 8) : 8);
  const view = new DataView(header.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, tag, true);
  let cursor;
  if (explicit) {
    header[4] = vr.charCodeAt(0);
    header[5] = vr.charCodeAt(1);
    if (LONG_VR.has(vr)) {
      view.setUint16(6, 0, true);
      view.setUint32(8, payload.length, true);
      cursor = 12;
    } else {
      view.setUint16(6, payload.length, true);
      cursor = 8;
    }
  } else {
    view.setUint32(4, payload.length, true);
    cursor = 8;
  }
  const out = new Uint8Array(cursor + payload.length);
  out.set(header);
  out.set(payload, cursor);
  return out;
}

function us(value) {
  const out = new Uint8Array(value.length * 2);
  const view = new DataView(out.buffer);
  value.forEach((v, i) => view.setUint16(i * 2, v, true));
  return out;
}

function ds(values) {
  return pad(values.map((v) => String(v)).join('\\'), 0x20);
}

function cs(value) {
  return pad(value, 0x20);
}

function ui(value) {
  return pad(value, 0x00);
}

/**
 * Build a single-frame DICOM image.
 *
 * @param {object} opts
 * @param {number} opts.rows
 * @param {number} opts.columns
 * @param {Int16Array|Uint16Array} opts.pixels
 * @param {number} [opts.sliceIndex]
 * @param {number} [opts.z] slice position in mm
 * @param {number[]} [opts.orientation] row/col direction cosines
 * @param {boolean} [opts.explicit] explicit VR LE (default true)
 * @param {number[]} [opts.pixelSpacing] [row, col] mm
 * @param {number} [opts.slope]
 * @param {number} [opts.intercept]
 * @param {string} [opts.seriesUid]
 * @returns {ArrayBuffer}
 */
export function makeDicomImage({
  rows = 8,
  columns = 8,
  pixels,
  sliceIndex = 0,
  z = 0,
  orientation = [1, 0, 0, 0, 1, 0],
  explicit = true,
  pixelSpacing = [2, 2],
  slope = 1,
  intercept = 0,
  seriesUid = '1.2.826.0.1.3680043.2.1125.1.1',
  seriesDescription = 'Synthetic T1 axial',
  modality = 'MR',
  signed = true,
  bitsAllocated = 16,
  transferSyntax = null,
}) {
  const uid = `${seriesUid}.${sliceIndex + 1}`;
  const pixelBytes = new Uint8Array(pixels.length * (bitsAllocated / 8));
  const pixelView = new DataView(pixelBytes.buffer);
  pixels.forEach((value, index) => {
    if (bitsAllocated === 16) {
      if (signed) pixelView.setInt16(index * 2, value, true);
      else pixelView.setUint16(index * 2, value, true);
    } else {
      pixelBytes[index] = value & 0xff;
    }
  });

  const dataset = [
    element(0x0008, 0x0016, 'UI', ui('1.2.840.10008.5.1.4.1.1.4'), explicit),
    element(0x0008, 0x0018, 'UI', ui(uid), explicit),
    element(0x0008, 0x0060, 'CS', cs(modality), explicit),
    element(0x0008, 0x0070, 'LO', pad('NeuroTest', 0x20), explicit),
    element(0x0008, 0x103e, 'LO', pad(seriesDescription, 0x20), explicit),
    element(0x0018, 0x0050, 'DS', ds([2]), explicit),
    element(0x0018, 0x0088, 'DS', ds([2]), explicit),
    element(0x0020, 0x000e, 'UI', ui(seriesUid), explicit),
    element(0x0020, 0x0011, 'IS', pad('7', 0x20), explicit),
    element(0x0020, 0x0013, 'IS', pad(String(sliceIndex + 1), 0x20), explicit),
    element(0x0020, 0x0032, 'DS', ds([0, 0, z]), explicit),
    element(0x0020, 0x0037, 'DS', ds(orientation), explicit),
    element(0x0020, 0x1041, 'DS', ds([z]), explicit),
    element(0x0028, 0x0002, 'US', us([1]), explicit),
    element(0x0028, 0x0004, 'CS', cs('MONOCHROME2'), explicit),
    element(0x0028, 0x0010, 'US', us([rows]), explicit),
    element(0x0028, 0x0011, 'US', us([columns]), explicit),
    element(0x0028, 0x0030, 'DS', ds(pixelSpacing), explicit),
    element(0x0028, 0x0100, 'US', us([bitsAllocated]), explicit),
    element(0x0028, 0x0101, 'US', us([bitsAllocated]), explicit),
    element(0x0028, 0x0102, 'US', us([bitsAllocated - 1]), explicit),
    element(0x0028, 0x0103, 'US', us([signed ? 1 : 0]), explicit),
    element(0x0028, 0x1050, 'DS', ds([100]), explicit),
    element(0x0028, 0x1051, 'DS', ds([400]), explicit),
    element(0x0028, 0x1052, 'DS', ds([intercept]), explicit),
    element(0x0028, 0x1053, 'DS', ds([slope]), explicit),
    element(0x7fe0, 0x0010, 'OW', pixelBytes, explicit),
  ];

  const metaParts = [
    element(0x0002, 0x0001, 'OB', new Uint8Array([0, 1])),
    element(0x0002, 0x0002, 'UI', ui('1.2.840.10008.5.1.4.1.1.4')),
    element(0x0002, 0x0003, 'UI', ui(uid)),
    element(0x0002, 0x0010, 'UI', ui(transferSyntax || (explicit ? '1.2.840.10008.1.2.1' : '1.2.840.10008.1.2'))),
    element(0x0002, 0x0012, 'UI', ui('1.2.826.0.1.3680043.2.1125.9')),
  ];
  const metaLength = metaParts.reduce((sum, part) => sum + part.length, 0);
  const groupLength = element(0x0002, 0x0000, 'UL', ul(metaLength));

  const total = 128 + 4 + groupLength.length + metaLength + dataset.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  out.set(textEncoder.encode('DICM'), 128);
  let cursor = 132;
  for (const part of [groupLength, ...metaParts, ...dataset]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out.buffer;
}

function ul(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/**
 * Build a small axial series with a sphere in the middle so orientation and
 * intensity rescaling can be asserted.
 * @param {{slices?: number, rows?: number, columns?: number, explicit?: boolean}} [opts]
 */
export function makeDicomSeries({ slices = 5, rows = 16, columns = 16, explicit = true } = {}) {
  const files = [];
  for (let s = 0; s < slices; s++) {
    const pixels = new Int16Array(rows * columns);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const dx = x - (columns - 1) / 2;
        const dy = y - (rows - 1) / 2;
        const dz = s - (slices - 1) / 2;
        const inside = dx * dx + dy * dy + dz * dz < 9;
        pixels[y * columns + x] = inside ? 1000 + s : 20;
      }
    }
    files.push({
      name: `slice_${String(s).padStart(3, '0')}.dcm`,
      buffer: makeDicomImage({
        rows,
        columns,
        pixels,
        sliceIndex: s,
        z: -2 + s * 2,
        explicit,
      }),
    });
  }
  // deliberately unsorted to exercise position-based ordering
  return files.reverse();
}

/**
 * Build a NIfTI-1 single-file image (optionally gzipped).
 * @param {object} opts
 */
export async function makeNifti({
  dims = [8, 8, 4],
  data,
  spacing = [1, 1, 2],
  datatype = 4,
  gzip = false,
  sform = null,
} = {}) {
  const [nx, ny, nz] = dims;
  const bytesPerVoxel = datatype === 2 ? 1 : datatype === 16 ? 4 : 2;
  const voxels = data || new Int16Array(nx * ny * nz).map((_, i) => (i % 100) + 1);
  const header = new Uint8Array(352);
  const view = new DataView(header.buffer);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, nx, true);
  view.setInt16(44, ny, true);
  view.setInt16(46, nz, true);
  view.setInt16(48, 1, true);
  view.setInt16(70, datatype, true);
  view.setInt16(72, bytesPerVoxel * 8, true);
  view.setFloat32(76, 1, true);
  view.setFloat32(80, spacing[0], true);
  view.setFloat32(84, spacing[1], true);
  view.setFloat32(88, spacing[2], true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setFloat32(116, 0, true);
  view.setInt16(254, sform ? 1 : 0, true);
  if (sform) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) view.setFloat32(280 + r * 16 + c * 4, sform[r][c], true);
  }
  header.set(textEncoder.encode('n+1'), 344);

  const payload = new Uint8Array(voxels.length * bytesPerVoxel);
  const pv = new DataView(payload.buffer);
  for (let i = 0; i < voxels.length; i++) {
    if (datatype === 4) pv.setInt16(i * 2, voxels[i], true);
    else if (datatype === 16) pv.setFloat32(i * 4, voxels[i], true);
    else if (datatype === 512) pv.setUint16(i * 2, voxels[i], true);
    else payload[i] = voxels[i] & 0xff;
  }

  const file = new Uint8Array(header.length + payload.length);
  file.set(header);
  file.set(payload, header.length);

  if (!gzip) return file.buffer;
  const stream = new Blob([file]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
