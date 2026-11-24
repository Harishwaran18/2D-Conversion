/**
 * Minimal PDF 1.4 writer: vector polylines, text and JPEG images.
 *
 * Page geometry is given in millimetres with the origin at the top-left, which
 * matches the contour coordinates produced by the slicer.
 */

const MM_TO_PT = 72 / 25.4;

/**
 * @typedef {object} PolylineElement
 * @property {'polyline'} type
 * @property {number[][]} points
 * @property {boolean} [fill]
 * @property {boolean} [evenOdd]
 * @property {number} [strokeWidthMm]
 * @property {[number, number, number]} [color]
 * @property {[number, number, number]} [fillColor]
 */

/**
 * @typedef {object} TextElement
 * @property {'text'} type
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {number} [sizeMm]
 * @property {[number, number, number]} [color]
 */

/**
 * @typedef {object} ImageElement
 * @property {'image'} type
 * @property {Uint8Array} jpeg JPEG bytes
 * @property {number} pixelWidth
 * @property {number} pixelHeight
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {Array<{widthMm: number, heightMm: number, elements: Array<PolylineElement|TextElement|ImageElement>}>} pages
 * @param {{title?: string, author?: string}} [meta]
 * @returns {Uint8Array}
 */
export function createPdf(pages, meta = {}) {
  const encoder = new TextEncoder();
  const chunks = [];
  let length = 0;
  const offsets = [];

  const append = (chunk) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.length;
  };
  const startObject = (id) => {
    offsets[id] = length;
    append(`${id} 0 obj\n`);
  };
  const endObject = () => append('endobj\n');

  append('%PDF-1.4\n');
  append(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  let nextId = 4;
  const pageIds = [];
  const images = [];

  startObject(1);
  append('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObject();

  startObject(3);
  append('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
  endObject();

  for (const page of pages) {
    const pageId = nextId++;
    const elements = page.elements.map((element) => {
      if (element.type !== 'image') return element;
      const imageId = nextId++;
      images.push({ id: imageId, element });
      return { ...element, imageId };
    });

    const content = buildContentStream(elements, page.heightMm);
    const contentId = nextId++;
    startObject(contentId);
    append(`<< /Length ${encoder.encode(content).length} >>\nstream\n`);
    append(content);
    append('endstream\n');
    endObject();

    const imageRefs = elements
      .filter((element) => element.imageId)
      .map((element) => `/Im${element.imageId} ${element.imageId} 0 R`)
      .join(' ');

    startObject(pageId);
    append(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(page.widthMm)} ${pt(page.heightMm)}]` +
        ` /Resources << /Font << /F1 3 0 R >> /XObject << ${imageRefs} >> >>` +
        ` /Contents ${contentId} 0 R >>\n`
    );
    endObject();
    pageIds.push(pageId);
  }

  startObject(2);
  append(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>\n`);
  endObject();

  for (const { id, element } of images) {
    startObject(id);
    append(
      `<< /Type /XObject /Subtype /Image /Width ${element.pixelWidth} /Height ${element.pixelHeight}` +
        ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${element.jpeg.length} >>\nstream\n`
    );
    append(element.jpeg);
    append('\nendstream\nendobj\n');
  }

  const infoId = nextId++;
  startObject(infoId);
  append(`<< /Producer (Brain2DPrint) /Title (${escapeText(meta.title || 'Brain2DPrint export')})`);
  if (meta.author) append(` /Author (${escapeText(meta.author)})`);
  append(` /CreationDate (D:${timestamp()}) >>\n`);
  endObject();

  const xrefOffset = length;
  append(`xref\n0 ${nextId}\n`);
  append('0000000000 65535 f \n');
  for (let id = 1; id < nextId; id++) append(`${String(offsets[id] || 0).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<< /Size ${nextId} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function buildContentStream(elements, pageHeightMm) {
  const parts = [];
  for (const element of elements) {
    if (element.type === 'polyline') {
      if (!element.points.length) continue;
      const stroke = element.color || [0, 0, 0];
      const fillColor = element.fillColor || stroke;
      parts.push(`${stroke.map(fixed).join(' ')} RG`);
      parts.push(`${fillColor.map(fixed).join(' ')} rg`);
      parts.push(`${((element.strokeWidthMm ?? 0.3) * MM_TO_PT).toFixed(3)} w`);
      parts.push(`${pt(element.points[0][0])} ${pt(pageHeightMm - element.points[0][1])} m`);
      for (let i = 1; i < element.points.length; i++) {
        parts.push(`${pt(element.points[i][0])} ${pt(pageHeightMm - element.points[i][1])} l`);
      }
      parts.push('h');
      parts.push(element.fill ? (element.evenOdd ? 'B*' : 'B') : 'S');
    } else if (element.type === 'text') {
      const color = element.color || [0, 0, 0];
      parts.push('BT');
      parts.push(`${color.map(fixed).join(' ')} rg`);
      parts.push(`/F1 ${((element.sizeMm ?? 3.2) * MM_TO_PT).toFixed(2)} Tf`);
      parts.push(`1 0 0 1 ${pt(element.x)} ${pt(pageHeightMm - element.y)} Tm`);
      parts.push(`(${escapeText(element.text)}) Tj`);
      parts.push('ET');
    } else if (element.type === 'image') {
      parts.push('q');
      parts.push(
        `${pt(element.width)} 0 0 ${pt(element.height)} ${pt(element.x)} ${pt(pageHeightMm - element.y - element.height)} cm`
      );
      parts.push(`/Im${element.imageId} Do`);
      parts.push('Q');
    }
  }
  return `${parts.join('\n')}\n`;
}

const fixed = (value) => Number(value).toFixed(3);
const pt = (mm) => (mm * MM_TO_PT).toFixed(3);

function escapeText(text) {
  return String(text)
    .replace(/([\\()])/g, '\\$1')
    .replace(/[^\x20-\x7e]/g, '?');
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Encode a canvas as JPEG bytes for PDF embedding. */
export async function jpegFromCanvas(canvas, quality = 0.92) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Canvas could not produce a JPEG');
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), pixelWidth: canvas.width, pixelHeight: canvas.height };
}
