/**
 * Page layout: turn sliced contours into positioned drawing elements with
 * millimetre coordinates (y grows downward, like an image).
 */

export const PAGE_SIZES = {
  A4: [210, 297],
  A5: [148, 210],
  A3: [297, 420],
  Letter: [215.9, 279.4],
};

/** Bounding box of a list of polylines. */
export function boundsOfContours(polylines) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of polylines) {
    for (const [x, y] of line) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * @typedef {object} SliceInput
 * @property {number[][]} contours polylines in millimetres
 * @property {string} [label]
 */

/**
 * Arrange slices into a grid of pages.
 *
 * @param {SliceInput[]} slices
 * @param {object} [opts]
 * @param {'A4'|'A5'|'A3'|'Letter'} [opts.pageSize]
 * @param {'portrait'|'landscape'} [opts.orientation]
 * @param {number} [opts.columns]
 * @param {number} [opts.marginMm]
 * @param {number} [opts.gapMm]
 * @param {boolean} [opts.labels]
 * @param {boolean} [opts.evenOddFill]
 * @param {number} [opts.lineWidthMm]
 * @returns {Array<{widthMm: number, heightMm: number, elements: object[], slices: Array<{label: string, scale: number, cell: number[]}>}>}
 */
export function layoutSlices(slices, opts = {}) {
  const {
    pageSize = 'A4',
    orientation = 'portrait',
    columns = 2,
    marginMm = 12,
    gapMm = 6,
    labels = true,
    evenOddFill = false,
    lineWidthMm = 0.3,
  } = opts;

  const base = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
  const [widthMm, heightMm] = orientation === 'landscape' ? [base[1], base[0]] : base;
  const cols = Math.max(1, Math.min(6, columns));
  const rows = Math.max(1, Math.min(6, opts.rows || cols));

  const cellW = (widthMm - 2 * marginMm - (cols - 1) * gapMm) / cols;
  const cellH = (heightMm - 2 * marginMm - (rows - 1) * gapMm) / rows;
  const perPage = cols * rows;

  const pages = [];
  for (let start = 0; start < slices.length; start += perPage) {
    const chunk = slices.slice(start, start + perPage);
    const elements = [];
    const placed = [];
    chunk.forEach((slice, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const cellX = marginMm + col * (cellW + gapMm);
      const cellY = marginMm + row * (cellH + gapMm);
      const bounds = boundsOfContours(slice.contours);
      const labelSpace = labels ? 6 : 0;
      const availableH = Math.max(1, cellH - labelSpace);
      const scale =
        bounds.width > 0 && bounds.height > 0
          ? Math.min(cellW / bounds.width, availableH / bounds.height)
          : 1;

      const offsetX = cellX + (cellW - bounds.width * scale) / 2 - bounds.minX * scale;
      const offsetY = cellY + (availableH - bounds.height * scale) / 2 - bounds.minY * scale;

      for (const line of slice.contours) {
        if (line.length < 2) continue;
        elements.push({
          type: 'polyline',
          points: line.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY]),
          fill: evenOddFill,
          evenOdd: true,
          strokeWidthMm: lineWidthMm,
          color: [0.07, 0.09, 0.13],
        });
      }
      if (labels && slice.label) {
        elements.push({
          type: 'text',
          text: `${slice.label}  1:${(1 / scale).toFixed(2)}`,
          x: cellX,
          y: cellY + cellH - 1.5,
          sizeMm: 3.2,
          color: [0.35, 0.38, 0.45],
        });
      }
      placed.push({ label: slice.label || '', scale, cell: [cellX, cellY, cellW, cellH] });
    });

    pages.push({ widthMm, heightMm, elements, slices: placed });
  }

  return pages;
}

/** Fit contours onto a single page, keeping the drawing centred. */
export function layoutSinglePage(contours, opts = {}) {
  const [page] = layoutSlices([{ contours, label: opts.label }], { ...opts, columns: 1, rows: 1 });
  return page;
}
