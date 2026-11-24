/**
 * Small ZIP reader/writer.
 *
 * Reading supports the two compression methods that matter in practice:
 * stored (0) and deflate (8, raw). Writing can use either.
 */

export class ZipError extends Error {
  constructor(message, code = 'ZIP_ERROR') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<{name: string, data: Uint8Array}>>}
 */
export async function readZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new ZipError('Not a ZIP archive (no end-of-central-directory record)', 'BAD_ZIP');

  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported', 'ZIP64');

  const entries = [];
  let pos = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(pos, true) !== SIG_CENTRAL) throw new ZipError('Corrupt ZIP central directory', 'BAD_ZIP');
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLength);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'utf-8').decode(nameBytes);
    pos += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new ZipError(`Corrupt local header for ${name}`, 'BAD_ZIP');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = await inflateRaw(raw);
    } else {
      throw new ZipError(`Unsupported ZIP compression method ${method} for ${name}`, 'UNSUPPORTED_METHOD');
    }
    if (uncompressedSize && data.length !== uncompressedSize && method === 0) {
      throw new ZipError(`Size mismatch for ${name}`, 'BAD_ZIP');
    }
    entries.push({ name, data });
  }
  return entries;
}

function findEocd(view) {
  const min = Math.max(0, view.byteLength - 65557);
  for (let pos = view.byteLength - 22; pos >= min; pos--) {
    if (view.getUint32(pos, true) === SIG_EOCD) return pos;
  }
  return -1;
}

async function inflateRaw(raw) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('DecompressionStream is not available in this environment', 'NO_DEFLATE');
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive. When `compress` is true, entries are deflated.
 * @param {Array<{name: string, data: Uint8Array}>} entries
 * @param {{compress?: boolean}} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function writeZip(entries, { compress = true } = {}) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    let payload = entry.data;
    let method = 0;
    if (compress && entry.data.length > 64 && typeof CompressionStream !== 'undefined') {
      try {
        payload = await deflateRaw(entry.data);
        method = 8;
        if (payload.length >= entry.data.length) {
          payload = entry.data;
          method = 0;
        }
      } catch {
        payload = entry.data;
      }
    }

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, payload);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + payload.length;
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

async function deflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
