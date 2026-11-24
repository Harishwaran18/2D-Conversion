import test from 'node:test';
import assert from 'node:assert/strict';

import { createPdf } from '../src/export/pdf.js';
import { pageToSvg, contoursToSvg } from '../src/export/svg.js';
import { meshToStlBinary, stlBinaryToMesh } from '../src/export/stl.js';
import { layoutSlices, layoutSinglePage, boundsOfContours } from '../src/export/layout.js';
import { Mesh } from '../src/geom/mesh.js';
import { gaussianBlur2D } from '../src/seg/filters.js';

const circle = (cx, cy, r, n = 48) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });

test('PDF has valid structure and xref offsets', () => {
  const pages = layoutSlices([{ contours: [circle(0, 0, 20)], label: 'Slice 1' }], { labels: true });
  const pdf = createPdf(pages, { title: 'test' });
  const text = new TextDecoder('latin1').decode(pdf);

  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Type \/Pages \/Count 1/);
  assert.match(text, /\/MediaBox \[0 0 595\.276 841\.890\]/);

  const xrefIndex = text.lastIndexOf('xref');
  const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.equal(text.slice(xrefIndex, xrefIndex + 4), 'xref');
  assert.ok(startxref > 0 && startxref < pdf.length);

  // every xref entry must point at "<id> 0 obj"
  const lines = text.slice(xrefIndex).split('\n');
  const count = Number(lines[1].split(' ')[1]);
  for (let id = 1; id < count; id++) {
    const offset = Number(lines[2 + id].slice(0, 10));
    assert.equal(text.slice(offset, offset + `${id} 0 obj`.length), `${id} 0 obj`, `object ${id}`);
  }
});

test('PDF handles multiple pages and images', () => {
  const pages = layoutSlices(
    Array.from({ length: 5 }, (_, i) => ({ contours: [circle(0, 0, 10 + i)], label: `S${i}` })),
    { columns: 2, rows: 2 }
  );
  assert.equal(pages.length, 2);
  const pdf = createPdf(pages);
  const text = new TextDecoder('latin1').decode(pdf);
  assert.match(text, /\/Count 2/);
});

test('SVG is in millimetres with a closed path', () => {
  const page = layoutSinglePage([circle(10, 10, 5)], { labels: false, marginMm: 5 });
  const svg = pageToSvg(page, { title: 'brain' });
  assert.match(svg, /width="\d+(\.\d+)?mm"/);
  assert.match(svg, /viewBox="0 0 /);
  assert.match(svg, /<path d="M [\d.]+ [\d.]+ L /);
  assert.match(svg, /Z"/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test('contoursToSvg sizes the page around the drawing', () => {
  const svg = contoursToSvg([circle(0, 0, 10)], { marginMm: 4, fill: true });
  assert.match(svg, /width="28mm"/);
  assert.match(svg, /height="28mm"/);
  assert.match(svg, /fill-rule="evenodd"/);
});

test('layout keeps every point inside the page', () => {
  const slices = Array.from({ length: 3 }, (_, i) => ({ contours: [circle(0, 0, 30)], label: `S${i}` }));
  const pages = layoutSlices(slices, { pageSize: 'A4', columns: 2, rows: 2, marginMm: 10, gapMm: 5 });
  assert.equal(pages.length, 1);
  for (const element of pages[0].elements) {
    if (element.type !== 'polyline') continue;
    for (const [x, y] of element.points) {
      assert.ok(x >= 0 && x <= pages[0].widthMm, `x ${x}`);
      assert.ok(y >= 0 && y <= pages[0].heightMm, `y ${y}`);
    }
  }
});

test('layout splits many slices across pages', () => {
  const slices = Array.from({ length: 10 }, (_, i) => ({ contours: [circle(0, 0, 5)], label: `S${i}` }));
  const pages = layoutSlices(slices, { columns: 2, rows: 2 });
  assert.equal(pages.length, 3);
  assert.equal(pages[0].elements.filter((e) => e.type === 'polyline').length, 4);
  assert.equal(pages[2].elements.filter((e) => e.type === 'polyline').length, 2);
});

test('boundsOfContours reports the extents', () => {
  const bounds = boundsOfContours([[[0, 0], [10, 5]]]);
  assert.equal(bounds.minX, 0);
  assert.equal(bounds.maxY, 5);
  assert.equal(bounds.width, 10);
  assert.equal(bounds.height, 5);
});

test('binary STL round-trips vertices and normals', () => {
  const mesh = new Mesh([0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 1, 2]);
  const bytes = meshToStlBinary(mesh, 'unit test');
  assert.equal(new DataView(bytes.buffer).getUint32(80, true), 1);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 9)), 'unit test');

  const back = stlBinaryToMesh(bytes);
  assert.equal(back.triangleCount, 1);
  assert.deepEqual([...back.positions], [0, 0, 0, 10, 0, 0, 0, 10, 0]);
  const normal = new DataView(bytes.buffer).getFloat32(84, true);
  assert.equal(normal, 0);
  assert.equal(new DataView(bytes.buffer).getFloat32(92, true), 1);
});

test('gaussian blur reduces noise but keeps the mean level', () => {
  const width = 32;
  const height = 32;
  const noisy = new Float32Array(width * height);
  for (let i = 0; i < noisy.length; i++) noisy[i] = 100 + (i % 2 === 0 ? 40 : -40);
  const blurred = gaussianBlur2D(noisy, width, height, 1);
  let sumRaw = 0;
  let sumBlur = 0;
  let variance = 0;
  for (let i = 0; i < noisy.length; i++) {
    sumRaw += noisy[i];
    sumBlur += blurred[i];
  }
  const mean = sumBlur / blurred.length;
  for (let i = 0; i < blurred.length; i++) variance += (blurred[i] - mean) ** 2;
  assert.ok(Math.abs(sumRaw - sumBlur) / sumRaw < 1e-6);
  assert.ok(Math.sqrt(variance / blurred.length) < 20, 'noise should be damped');
});
