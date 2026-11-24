/**
 * Minimal, dependency-free DICOM Part-10 reader.
 *
 * Supported transfer syntaxes:
 *  1.2.840.10008.1.2      Implicit VR little endian
 *  1.2.840.10008.1.2.1    Explicit VR little endian
 *  1.2.840.10008.1.2.2    Explicit VR big endian
 *  1.2.840.10008.1.2.1.99 Deflated explicit VR little endian
 *
 * Encapsulated (JPEG/JPEG2000/RLE) pixel data is detected and reported with a
 * typed {@link DicomError} instead of producing garbage.
 */

export const TRANSFER_SYNTAX = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  DEFLATED_LE: '1.2.840.10008.1.2.1.99',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
};

const TS_NAMES = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
  '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless SV1',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000 Part 2',
  '1.2.840.10008.1.2.5': 'RLE Lossless',
};

export class DicomError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'DICOM_ERROR') {
    super(message);
    this.name = 'DicomError';
    this.code = code;
  }
}

/** VRs whose explicit encoding uses a 32-bit length field. */
const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UR', 'UT', 'UN']);

/** Minimal implicit-VR dictionary for the attributes this app understands. */
const VR_DICT = {
  '00080016': 'UI', '00080018': 'UI', '00080060': 'CS', '00080070': 'LO',
  '00081090': 'LO', '00081030': 'LO', '0008103e': 'LO', '00100010': 'PN',
  '00100020': 'LO', '00180050': 'DS', '00180088': 'DS', '00181150': 'IS',
  '00181310': 'US', '0020000d': 'UI', '0020000e': 'UI', '00200011': 'IS',
  '00200013': 'IS', '00200020': 'CS', '00200032': 'DS', '00200037': 'DS',
  '00201040': 'LO', '00201041': 'DS', '00280002': 'US', '00280004': 'CS',
  '00280008': 'IS', '00280009': 'AT', '00280010': 'US', '00280011': 'US',
  '00280030': 'DS', '00280100': 'US', '00280101': 'US', '00280102': 'US',
  '00280103': 'US', '00280106': 'US', '00280107': 'US', '00281050': 'DS',
  '00281051': 'DS', '00281052': 'DS', '00281053': 'DS', '00281054': 'LO',
  '00280120': 'US', '7fe00008': 'OF', '7fe00009': 'OD', '7fe00010': 'OW',
};

const TEXT_VR = new Set([
  'AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT',
]);

/**
 * Read a DICOM file.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{dataset: Record<string, any>, transferSyntax: string, transferSyntaxName: string, pixel: object|null}>}
 */
export async function parseDicom(buffer) {
  const bytes = new Uint8Array(buffer);
  const hasPreamble = bytes.length > 132 && String.fromCharCode(...bytes.subarray(128, 132)) === 'DICM';
  let offset = hasPreamble ? 132 : 0;

  const meta = {};
  let littleEndian = true;

  // File meta group is always explicit VR little endian.
  while (offset + 8 <= bytes.length) {
    const view = new DataView(buffer, offset, 8);
    const group = view.getUint16(0, true);
    if (group !== 0x0002) break;
    const el = readElement(buffer, offset, true, meta);
    offset = el.nextOffset;
  }

  const transferSyntax = meta['00020010']?.value?.[0] || (hasPreamble ? TRANSFER_SYNTAX.IMPLICIT_LE : TRANSFER_SYNTAX.IMPLICIT_LE);
  const transferSyntaxName = TS_NAMES[transferSyntax] || `Unknown (${transferSyntax})`;

  const supported =
    transferSyntax === TRANSFER_SYNTAX.IMPLICIT_LE ||
    transferSyntax === TRANSFER_SYNTAX.EXPLICIT_LE ||
    transferSyntax === TRANSFER_SYNTAX.EXPLICIT_BE ||
    transferSyntax === TRANSFER_SYNTAX.DEFLATED_LE;

  if (!supported) {
    throw new DicomError(
      `Compressed or unsupported transfer syntax: ${transferSyntaxName}. ` +
        'Please export the series as uncompressed DICOM (or NIfTI).',
      'UNSUPPORTED_TRANSFER_SYNTAX'
    );
  }

  const explicit = transferSyntax !== TRANSFER_SYNTAX.IMPLICIT_LE;
  littleEndian = transferSyntax !== TRANSFER_SYNTAX.EXPLICIT_BE;

  let datasetBuffer = buffer;
  let datasetOffset = offset;
  let datasetLength = bytes.length - offset;

  if (transferSyntax === TRANSFER_SYNTAX.DEFLATED_LE) {
    const inflated = await inflateRaw(new Uint8Array(buffer, offset, bytes.length - offset));
    datasetBuffer = inflated.buffer;
    datasetOffset = 0;
    datasetLength = inflated.byteLength;
  }

  const dataset = {};
  let pixelElement = null;
  let pos = datasetOffset;
  const end = datasetOffset + datasetLength;

  while (pos + 8 <= end) {
    const element = readElement(datasetBuffer, pos, littleEndian, dataset, { explicit, end });
    if (element.tag === '7fe00010') pixelElement = element;
    if (element.nextOffset <= pos) break;
    pos = element.nextOffset;
    if (element.tag === '7fe00010' && element.undefinedLength) {
      // Encapsulated pixel data: we cannot decode compressed frames.
      throw new DicomError(
        `Encapsulated (compressed) pixel data is not supported (${transferSyntaxName}).`,
        'COMPRESSED_PIXELS'
      );
    }
  }

  return {
    dataset,
    transferSyntax,
    transferSyntaxName,
    pixel: pixelElement ? decodePixels(dataset, pixelElement, littleEndian) : null,
  };
}

/**
 * Read one data element.
 * @param {ArrayBuffer} buffer
 * @param {number} offset
 * @param {boolean} littleEndian
 * @param {Record<string, any>} sink
 * @param {{explicit?: boolean, end?: number}} [opts]
 */
function readElement(buffer, offset, littleEndian, sink, opts = {}) {
  const explicit = opts.explicit !== false;
  const end = opts.end ?? buffer.byteLength;
  const view = new DataView(buffer);
  const group = view.getUint16(offset, littleEndian);
  const element = view.getUint16(offset + 2, littleEndian);
  const tag = hex(group) + hex(element);
  let cursor = offset + 4;
  let vr = null;
  let length;

  if (explicit) {
    vr = String.fromCharCode(view.getUint8(cursor), view.getUint8(cursor + 1));
    if (!/^[A-Z]{2}$/.test(vr)) throw new DicomError(`Invalid VR at offset ${offset} (${JSON.stringify(vr)})`);
    if (LONG_VR.has(vr)) {
      length = view.getUint32(cursor + 4, littleEndian);
      cursor += 8;
    } else {
      length = view.getUint16(cursor + 2, littleEndian);
      cursor += 4;
    }
  } else {
    vr = VR_DICT[tag] || 'UN';
    length = view.getUint32(cursor, littleEndian);
    cursor += 4;
  }

  if (length === 0xffffffff) {
    const nextOffset = skipUndefinedLength(buffer, cursor, littleEndian, explicit);
    return { tag, vr, value: null, nextOffset, undefinedLength: true };
  }

  const valueOffset = cursor;
  let nextOffset = cursor + length;
  if (nextOffset > end) nextOffset = end;

  let value = null;
  if (group !== 0xfffe) {
    if (vr === 'SQ' || (explicit === false && isLikelySequence(buffer, valueOffset, length, littleEndian))) {
      value = null;
    } else {
      value = readValue(buffer, valueOffset, length, vr, littleEndian);
    }
    // Keep only attributes we may use; but retain all small ones for flexibility.
    if (value !== null && !(vr === 'OW' || vr === 'OB' || vr === 'UN' || vr === 'OF' || vr === 'OD')) {
      sink[tag] = { vr, value, offset: valueOffset, length };
    } else if (vr === 'OW' || vr === 'OB' || vr === 'OF' || vr === 'OD' || vr === 'UN') {
      sink[tag] = { vr, value: null, offset: valueOffset, length };
    }
  }

  return { tag, vr, value, offset: valueOffset, length, nextOffset, undefinedLength: false, buffer };
}

/** Heuristic guard for implicit VR: an item tag at the start means a sequence. */
function isLikelySequence(buffer, offset, length, littleEndian) {
  if (length < 8) return false;
  const view = new DataView(buffer);
  return view.getUint16(offset, littleEndian) === 0xfffe && view.getUint16(offset + 2, littleEndian) === 0xe000;
}

/**
 * Skip a sequence / encapsulated value with undefined length.
 * @returns {number} offset just past the sequence delimitation item
 */
function skipUndefinedLength(buffer, offset, littleEndian, explicit) {
  const view = new DataView(buffer);
  let pos = offset;
  while (pos + 8 <= buffer.byteLength) {
    const group = view.getUint16(pos, littleEndian);
    const element = view.getUint16(pos + 2, littleEndian);
    if (group === 0xfffe && element === 0xe0dd) return pos + 8;
    if (group === 0xfffe && element === 0xe000) {
      const itemLength = view.getUint32(pos + 4, littleEndian);
      if (itemLength === 0xffffffff) {
        pos = skipItemUndefined(buffer, pos + 8, littleEndian, explicit);
      } else {
        pos += 8 + itemLength;
      }
      continue;
    }
    return pos + 8; // malformed; bail out defensively
  }
  return pos;
}

function skipItemUndefined(buffer, offset, littleEndian, explicit) {
  const view = new DataView(buffer);
  let pos = offset;
  while (pos + 8 <= buffer.byteLength) {
    const group = view.getUint16(pos, littleEndian);
    const element = view.getUint16(pos + 2, littleEndian);
    if (group === 0xfffe && element === 0xe00d) return pos + 8;
    if (group === 0xfffe && element === 0xe0dd) return pos + 8;
    const sub = readElement(buffer, pos, littleEndian, {}, { explicit });
    pos = sub.nextOffset;
    if (sub.undefinedLength) pos = skipUndefinedLength(buffer, pos, littleEndian, explicit);
  }
  return pos;
}

function readValue(buffer, offset, length, vr, littleEndian) {
  if (length === 0) return [];
  if (TEXT_VR.has(vr)) {
    const raw = new Uint8Array(buffer, offset, length);
    let text = '';
    for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i]);
    return [text.replace(/[\0 ]+$/, '')];
  }
  const view = new DataView(buffer);
  const out = [];
  if (vr === 'US') {
    for (let p = 0; p + 2 <= length; p += 2) out.push(view.getUint16(offset + p, littleEndian));
    return out;
  }
  if (vr === 'SS') {
    for (let p = 0; p + 2 <= length; p += 2) out.push(view.getInt16(offset + p, littleEndian));
    return out;
  }
  if (vr === 'UL' || vr === 'AT') {
    for (let p = 0; p + 4 <= length; p += 4) out.push(view.getUint32(offset + p, littleEndian));
    return out;
  }
  if (vr === 'SL') {
    for (let p = 0; p + 4 <= length; p += 4) out.push(view.getInt32(offset + p, littleEndian));
    return out;
  }
  if (vr === 'FL') {
    for (let p = 0; p + 4 <= length; p += 4) out.push(view.getFloat32(offset + p, littleEndian));
    return out;
  }
  if (vr === 'FD') {
    for (let p = 0; p + 8 <= length; p += 8) out.push(view.getFloat64(offset + p, littleEndian));
    return out;
  }
  return null;
}

/** @param {Record<string, any>} dataset @param {object} element @param {boolean} littleEndian */
function decodePixels(dataset, element, littleEndian) {
  const rows = num(dataset, '00280010');
  const columns = num(dataset, '00280011');
  const samplesPerPixel = num(dataset, '00280002') ?? 1;
  const bitsAllocated = num(dataset, '00280100') ?? 16;
  const bitsStored = num(dataset, '00280101') ?? bitsAllocated;
  const highBit = num(dataset, '00280102') ?? bitsStored - 1;
  const pixelRepresentation = num(dataset, '00280103') ?? 0;
  const frames = Math.max(1, num(dataset, '00280008') ?? 1);
  const photometric = dataset['00280004']?.value?.[0] || 'MONOCHROME2';

  if (!rows || !columns) throw new DicomError('Pixel data present but Rows/Columns missing', 'MISSING_GEOMETRY');

  const expected = rows * columns * frames * samplesPerPixel;
  const byteLength = bitsAllocated === 1 ? Math.ceil(expected / 8) : (expected * bitsAllocated) / 8;
  if (element.length < byteLength) {
    throw new DicomError(
      `Pixel data is truncated (${element.length} of ${byteLength} bytes).`,
      'TRUNCATED_PIXELS'
    );
  }

  let data;
  if (bitsAllocated === 8) {
    const view = new Uint8Array(element.buffer, element.offset, expected);
    if (pixelRepresentation === 1) {
      data = new Int8Array(expected);
      for (let i = 0; i < expected; i++) data[i] = (view[i] << 24) >> 24;
    } else {
      data = new Uint8Array(view);
    }
  } else if (bitsAllocated === 16) {
    data = pixelRepresentation === 1 ? new Int16Array(expected) : new Uint16Array(expected);
    const view = new DataView(element.buffer, element.offset, expected * 2);
    for (let i = 0; i < expected; i++) {
      data[i] = pixelRepresentation === 1 ? view.getInt16(i * 2, littleEndian) : view.getUint16(i * 2, littleEndian);
    }
  } else if (bitsAllocated === 32) {
    data = pixelRepresentation === 1 ? new Int32Array(expected) : new Uint32Array(expected);
    const view = new DataView(element.buffer, element.offset, expected * 4);
    for (let i = 0; i < expected; i++) {
      data[i] = pixelRepresentation === 1 ? view.getInt32(i * 4, littleEndian) : view.getUint32(i * 4, littleEndian);
    }
  } else {
    throw new DicomError(`Unsupported BitsAllocated: ${bitsAllocated}`, 'UNSUPPORTED_BITS');
  }

  if (bitsAllocated > 8 && bitsStored < bitsAllocated) applyBitsStored(data, bitsStored, highBit, pixelRepresentation);

  return {
    rows,
    columns,
    frames,
    samplesPerPixel,
    bitsAllocated,
    bitsStored,
    pixelRepresentation,
    photometric,
    data,
    slope: num(dataset, '00281053') ?? 1,
    intercept: num(dataset, '00281052') ?? 0,
    windowCenter: num(dataset, '00281050') ?? null,
    windowWidth: num(dataset, '00281051') ?? null,
  };
}

function applyBitsStored(data, bitsStored, highBit, pixelRepresentation) {
  const shift = highBit + 1 - bitsStored;
  const mask = bitsStored >= 32 ? 0xffffffff : (1 << bitsStored) - 1;
  const sign = 1 << (bitsStored - 1);
  for (let i = 0; i < data.length; i++) {
    let v = (data[i] >> shift) & mask;
    if (pixelRepresentation === 1 && bitsStored < 32 && (v & sign) !== 0) v -= 1 << bitsStored;
    data[i] = v;
  }
}

/** @param {Record<string, any>} dataset @param {string} tag */
function num(dataset, tag) {
  const value = dataset[tag]?.value;
  if (value === null || value === undefined) return null;
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'string') {
    const parsed = parseFloat(first);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return typeof first === 'number' ? first : null;
}

/** Read a DS/IS multi-valued attribute as an array of numbers. */
export function numbers(dataset, tag) {
  const value = dataset[tag]?.value;
  if (!value) return null;
  const list = Array.isArray(value) ? value : [value];
  const out = list
    .flatMap((v) => (typeof v === 'string' ? v.split('\\') : [v]))
    .map((v) => (typeof v === 'string' ? parseFloat(v) : v))
    .filter((v) => Number.isFinite(v));
  return out.length ? out : null;
}

/** Read a single text attribute. */
export function text(dataset, tag) {
  const value = dataset[tag]?.value;
  if (!value) return null;
  const raw = Array.isArray(value) ? value.join('\\') : String(value);
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

const hex = (n) => n.toString(16).padStart(4, '0');

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new DicomError('Deflated DICOM requires DecompressionStream support', 'NO_INFLATE');
  }
  for (const format of ['deflate-raw', 'deflate']) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* try the next format */
    }
  }
  throw new DicomError('Could not inflate deflated DICOM dataset', 'INFLATE_FAILED');
}

export { num as dicomNumber, hex as toHexTag };
