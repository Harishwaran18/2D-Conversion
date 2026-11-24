/**
 * SVG output for print-ready outlines and single slices.
 */

/**
 * @param {{widthMm: number, heightMm: number, elements: object[]}} page
 * @param {{title?: string, background?: string}} [opts]
 * @returns {string}
 */
export function pageToSvg(page, opts = {}) {
  const { widthMm, heightMm, elements } = page;
  const body = [];
  if (opts.background) {
    body.push(`<rect x="0" y="0" width="${num(widthMm)}" height="${num(heightMm)}" fill="${opts.background}"/>`);
  }
  for (const element of elements) {
    if (element.type === 'polyline') {
      const d = pathData(element.points);
      const stroke = rgb(element.color || [0, 0, 0]);
      const fill = element.fill ? rgb(element.fillColor || element.color || [0, 0, 0]) : 'none';
      body.push(
        `<path d="${d}" fill="${fill}" fill-rule="${element.evenOdd ? 'evenodd' : 'nonzero'}"` +
          ` stroke="${stroke}" stroke-width="${num(element.strokeWidthMm ?? 0.3)}"` +
          ' stroke-linejoin="round" stroke-linecap="round"/>'
      );
    } else if (element.type === 'text') {
      body.push(
        `<text x="${num(element.x)}" y="${num(element.y)}" font-family="Helvetica, Arial, sans-serif"` +
          ` font-size="${num(element.sizeMm ?? 3.2)}" fill="${rgb(element.color || [0, 0, 0])}">${escapeXml(
            element.text
          )}</text>`
      );
    } else if (element.type === 'image-data') {
      body.push(
        `<image x="${num(element.x)}" y="${num(element.y)}" width="${num(element.width)}" height="${num(
          element.height
        )}" href="${element.href}"/>`
      );
    }
  }

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${num(widthMm)}mm" height="${num(
      heightMm
    )}mm" viewBox="0 0 ${num(widthMm)} ${num(heightMm)}">\n` +
    (opts.title ? `<title>${escapeXml(opts.title)}</title>\n` : '') +
    `<!-- 1 user unit = 1 mm; physical size is exact when printed at 100% -->\n` +
    `${body.join('\n')}\n</svg>\n`
  );
}

/**
 * Convenience wrapper for a single slice with automatic page sizing.
 * @param {number[][][]} contours
 * @param {object} [opts]
 */
export function contoursToSvg(contours, opts = {}) {
  const margin = opts.marginMm ?? 10;
  const bounds = boundsOf(contours);
  const width = bounds.width + margin * 2;
  const height = bounds.height + margin * 2;
  const elements = contours
    .filter((line) => line.length > 1)
    .map((line) => ({
      type: 'polyline',
      points: line.map(([x, y]) => [x - bounds.minX + margin, y - bounds.minY + margin]),
      fill: Boolean(opts.fill),
      evenOdd: true,
      strokeWidthMm: opts.lineWidthMm ?? 0.3,
      color: [0.07, 0.09, 0.13],
    }));
  return pageToSvg({ widthMm: width, heightMm: height, elements }, opts);
}

function boundsOf(contours) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of contours) {
    for (const [x, y] of line) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 1, height: 1 };
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function pathData(points) {
  let d = `M ${num(points[0][0])} ${num(points[0][1])}`;
  for (let i = 1; i < points.length; i++) d += ` L ${num(points[i][0])} ${num(points[i][1])}`;
  return `${d} Z`;
}

const num = (value) => Number(value.toFixed(3));
const rgb = ([r, g, b]) =>
  `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, (c) => {
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '&') return '&amp;';
    if (c === '"') return '&quot;';
    return '&apos;';
  });
}
