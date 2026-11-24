/**
 * Brain2DPrint application controller: import → display → segment → export.
 */

import { loadFiles, loadSeries } from '../core/loader.js';
import { createBrainPhantom } from '../core/phantom.js';
import { segmentVolume } from '../seg/segment.js';
import { maskSlice } from '../seg/mask-slice.js';
import { gaussianBlur2D } from '../seg/filters.js';
import { contour2D, smoothContours } from '../geom/marching-squares.js';
import { buildPrintModel, slicePrintModel } from '../geom/print-model.js';
import { SliceView } from '../render/slice-view.js';
import { MeshViewer } from '../render/mesh-view.js';
import { layoutSlices, layoutSinglePage } from '../export/layout.js';
import { createPdf, jpegFromCanvas } from '../export/pdf.js';
import { pageToSvg } from '../export/svg.js';
import { meshToStlBinary } from '../export/stl.js';
import { writeZip } from '../core/zip.js';
import { sliceToCanvas, canvasToBlob, contactSheet, downloadBlob, downloadText } from '../export/raster.js';

const $ = (id) => document.getElementById(id);

const state = {
  volume: null,
  kind: null,
  series: [],
  warnings: [],
  crosshair: { x: 0, y: 0, z: 0 },
  window: { center: 500, width: 1000 },
  stats: { min: 0, max: 1000, p02: 0, p98: 1000 },
  colormap: 'gray',
  overlayOpacity: 0.45,
  segmentation: null,
  showOverlay: true,
  printModel: null,
  traceLevel: 400,
  sourcePicked: false,
  busy: false,
  focusedAxis: 'axial',
};

const views = {
  axial: new SliceView($('canvas-axial')),
  coronal: new SliceView($('canvas-coronal')),
  sagittal: new SliceView($('canvas-sagittal')),
};
const meshViewer = new MeshViewer($('canvas-3d'));

const crosshair = {
  relative(axis) {
    if (axis === 'axial') return { u: state.crosshair.x, v: state.crosshair.y };
    const nz = state.volume ? state.volume.nz : 1;
    const v = nz - 1 - state.crosshair.z;
    return { u: axis === 'coronal' ? state.crosshair.x : state.crosshair.y, v };
  },
};

/* ------------------------------------------------------------------ status */

let statusTimer = 0;
function setStatus(message, progress = null) {
  $('status-message').textContent = message;
  const bar = $('status-progress');
  if (progress === null) {
    bar.style.width = '0%';
  } else {
    bar.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  }
  clearTimeout(statusTimer);
  if (progress !== null && progress >= 1) {
    statusTimer = setTimeout(() => (bar.style.width = '0%'), 1200);
  }
}

function toast(title, message = '', kind = '') {
  const element = document.createElement('div');
  element.className = `toast${kind ? ` toast--${kind}` : ''}`;
  const body = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = title;
  body.appendChild(heading);
  if (message) body.appendChild(document.createTextNode(message));
  element.appendChild(body);
  $('toasts').appendChild(element);
  setTimeout(() => {
    element.style.opacity = '0';
    element.style.transform = 'translateY(6px)';
    element.style.transition = 'opacity .25s ease, transform .25s ease';
    setTimeout(() => element.remove(), 260);
  }, kind === 'error' ? 7000 : 3800);
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const formatNumber = (value) => new Intl.NumberFormat().format(Math.round(value));
const formatMm = (value) => `${Number(value).toFixed(1)} mm`;

/* ------------------------------------------------------------------ import */

async function importFiles(fileList) {
  if (!fileList || !fileList.length || state.busy) return;
  state.busy = true;
  setStatus('Reading files…', 0.05);
  try {
    const result = await loadFiles(Array.from(fileList), {
      onProgress: (message, fraction) => setStatus(message, fraction),
    });
    applyVolume(result.volume, result);
    if (result.warnings?.length) {
      toast('Some files were skipped', result.warnings.slice(0, 3).join(' · '), 'error');
    }
    toast('Scan loaded', result.summary || '', 'ok');
  } catch (error) {
    console.error(error);
    setStatus('Could not load the scan');
    toast('Import failed', error.message || String(error), 'error');
  } finally {
    state.busy = false;
    refreshButtons();
  }
}

function applyVolume(volume, result = {}) {
  state.volume = volume;
  state.kind = result.kind || volume.meta.source;
  state.series = result.series || [];
  state.warnings = result.warnings || [];
  state.segmentation = null;
  state.printModel = null;
  state.showOverlay = $('chk-overlay').checked;

  const stats = volume.stats();
  state.stats = stats;
  const pad = (stats.p98 - stats.p02) * 0.05 || 1;
  state.window = {
    center: (stats.p02 + stats.p98) / 2,
    width: Math.max(1, stats.p98 - stats.p02 + pad * 2),
  };
  state.traceLevel = Math.round(volume.meta.windowCenter ?? (stats.p02 + stats.p98) / 2);

  state.crosshair = {
    x: Math.floor(volume.nx / 2),
    y: Math.floor(volume.ny / 2),
    z: Math.floor(volume.nz / 2),
  };

  const isTwoD = volume.nz === 1;
  document.querySelector('.viewers').classList.toggle('viewers--single', isTwoD);
  document.querySelectorAll('.viewer').forEach((element) => {
    const axis = element.dataset.axis;
    if (axis && axis !== 'axial') element.hidden = isTwoD;
    if (axis === undefined) element.hidden = isTwoD;
  });

  for (const [axis, view] of Object.entries(views)) {
    view.setVolume(volume);
    view.crosshair = crosshair;
    view.showCrosshair = !isTwoD;
    view.axis = axis;
    view.index = axis === 'axial' ? state.crosshair.z : axis === 'coronal' ? state.crosshair.y : state.crosshair.x;
    view.setWindow(state.window.center, state.window.width);
    view.setColormap(state.colormap);
    view.setSegmentation(null, volume.spacing);
    view.overlayOpacity = state.overlayOpacity;
    const slider = $(`slider-${axis}`);
    slider.min = 1;
    slider.max = view.volume.sliceCount(axis);
    slider.value = view.index + 1;
  }

  meshViewer.setMesh(null);
  meshViewer.draw();

  renderSourceInfo(volume, result);
  configureSliders(volume);
  syncViews();
  refreshButtons();
  $('segment-status').textContent = 'Ready. Run segmentation to build a mask and print model.';
  setStatus(
    `${volume.meta.description || 'Scan'} · ${volume.nx}×${volume.ny}×${volume.nz} voxels · ${volume.spacing
      .map((value) => value.toFixed(2))
      .join(' × ')} mm`,
    1
  );
}

function renderSourceInfo(volume, result) {
  const container = $('source-info');
  const meta = volume.meta;
  const rows = [];
  rows.push(`<strong>${escapeHtml(meta.description || 'Scan')}</strong>`);
  rows.push(
    `<span>${meta.modality || volume.meta.source} · ${volume.nx}×${volume.ny}×${volume.nz} · ${volume.spacing
      .map((value) => value.toFixed(2))
      .join(' × ')} mm</span>`
  );
  if (meta.transferSyntax) rows.push(`<span>${escapeHtml(meta.transferSyntax)}</span>`);
  if (meta.manufacturer) rows.push(`<span>${escapeHtml(meta.manufacturer)}</span>`);
  if (volume.voxelCount > 2_000_000) {
    rows.push(`<span>${formatNumber(volume.voxelCount)} voxels · ${(volume.voxelCount * 2 / 1048576).toFixed(0)} MB in memory</span>`);
  }
  if (meta.oblique) rows.push('<span>Oblique acquisition — axis labels are approximate</span>');
  container.innerHTML = rows.join('');

  const seriesField = $('series-field');
  if ((result.series || []).length > 1) {
    seriesField.hidden = false;
    const select = $('series-select');
    select.innerHTML = '';
    result.series.forEach((entry, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${entry.description} · ${entry.slices.length} slices · ${entry.modality}`;
      select.appendChild(option);
    });
    select.onchange = () => {
      try {
        applyVolume(loadSeries(result.series[Number(select.value)]), { kind: 'dicom', series: result.series });
        toast('Series loaded', result.series[Number(select.value)].description, 'ok');
      } catch (error) {
        toast('Could not open series', error.message, 'error');
      }
    };
  } else {
    seriesField.hidden = true;
  }
}

function configureSliders(volume) {
  const { min, max } = state.stats;
  const span = Math.max(1, max - min);
  for (const [id, value, lo, hi, step] of [
    ['input-center', state.window.center, min, max, span / 500],
    ['input-width', state.window.width, 1, span, span / 500],
    ['input-threshold', state.traceLevel, min, max, span / 500],
    ['input-trace', state.traceLevel, min, max, span / 500],
  ]) {
    const input = $(id);
    input.disabled = id === 'input-threshold' && $('segment-mode').value !== 'manual';
    input.min = String(lo);
    input.max = String(hi);
    input.step = String(Math.max(step, 0.01));
    input.value = String(value);
  }
  $('out-center').textContent = formatNumber(state.window.center);
  $('out-width').textContent = formatNumber(state.window.width);
  $('out-threshold').textContent = formatNumber(state.traceLevel);
  $('out-trace').textContent = formatNumber(state.traceLevel);

  const axis = $('export-axis').value;
  const count = volume.sliceCount(axis);
  $('export-from').value = '1';
  $('export-from').max = String(count);
  $('export-to').value = String(count);
  $('export-to').max = String(count);
  $('export-step').value = String(Math.max(1, Math.round(count / 16)));

  const slice = volume.slice('axial', state.crosshair.z);
  $('meta-axial').textContent = `${(slice.data.length ? '' : '') + (state.crosshair.z * volume.spacing[2]).toFixed(1)} mm`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ----------------------------------------------------------------- display */

let drawScheduled = false;
function drawAll() {
  if (drawScheduled) return;
  drawScheduled = true;
  requestAnimationFrame(() => {
    drawScheduled = false;
    for (const view of Object.values(views)) {
      if (!view.canvas.closest('.viewer')?.hidden) view.draw();
    }
    updateMetas();
  });
}

function updateMetas() {
  const volume = state.volume;
  if (!volume) return;
  $('meta-axial').textContent = formatMm(state.crosshair.z * volume.spacing[2]);
  $('meta-coronal').textContent = formatMm(state.crosshair.y * volume.spacing[1]);
  $('meta-sagittal').textContent = formatMm(state.crosshair.x * volume.spacing[0]);
}

function syncViews() {
  if (!state.volume) return;
  const { x, y, z } = state.crosshair;
  views.axial.setIndex(z);
  views.coronal.setIndex(y);
  views.sagittal.setIndex(x);
  const sliders = { axial: z, coronal: y, sagittal: x };
  for (const [axis, value] of Object.entries(sliders)) {
    const slider = $(`slider-${axis}`);
    slider.max = views[axis].volume.sliceCount(axis);
    slider.value = String(value + 1);
  }
  drawAll();
}

function setWindow(center, width) {
  state.window = { center, width: Math.max(1e-6, width) };
  for (const view of Object.values(views)) view.setWindow(state.window.center, state.window.width);
  $('input-center').value = String(center);
  $('input-width').value = String(Math.min(Number($('input-width').max), width));
  $('out-center').textContent = formatNumber(center);
  $('out-width').textContent = formatNumber(width);
  drawAll();
}

function applyPreset(name) {
  const { min, max, p02, p98 } = state.stats;
  const span = Math.max(1, p98 - p02);
  if (name === 'full') setWindow((min + max) / 2, max - min);
  else if (name === 'auto') setWindow((p02 + p98) / 2, span);
  else if (name === 'brain') setWindow(p02 + span * 0.55, span * 0.8);
  else if (name === 'bone') setWindow(p98 + (max - p98) * 0.35, Math.max(1, max - p98 + span * 0.25));
}

/* ------------------------------------------------------------- interaction */

function wireViewer(axis) {
  const view = views[axis];
  const canvas = view.canvas;
  let dragging = false;

  const move = (event) => {
    if (!state.volume) return;
    const hit = view.pointerToVoxel(event.clientX, event.clientY);
    if (!hit) return;
    const { nz } = state.volume;
    if (axis === 'axial') {
      state.crosshair.x = hit.u;
      state.crosshair.y = hit.v;
    } else if (axis === 'coronal') {
      state.crosshair.x = hit.u;
      state.crosshair.z = nz - 1 - hit.v;
    } else {
      state.crosshair.y = hit.u;
      state.crosshair.z = nz - 1 - hit.v;
    }
    state.focusedAxis = axis;
    syncViews();
  };

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    move(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (dragging) move(event);
  });
  canvas.addEventListener('pointerup', (event) => {
    dragging = false;
    canvas.releasePointerCapture?.(event.pointerId);
  });
  canvas.addEventListener('pointercancel', () => (dragging = false));

  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!state.volume) return;
      event.preventDefault();
      state.focusedAxis = axis;
      const step = event.deltaY > 0 ? 1 : -1;
      const view = views[axis];
      view.setIndex(view.index + step);
      if (axis === 'axial') state.crosshair.z = view.index;
      else if (axis === 'coronal') state.crosshair.y = view.index;
      else state.crosshair.x = view.index;
      syncViews();
    },
    { passive: false }
  );

  $(`slider-${axis}`).addEventListener('input', (event) => {
    const value = Number(event.target.value) - 1;
    views[axis].setIndex(value);
    if (axis === 'axial') state.crosshair.z = views[axis].index;
    else if (axis === 'coronal') state.crosshair.y = views[axis].index;
    else state.crosshair.x = views[axis].index;
    syncViews();
  });
}

function wireMeshViewer() {
  const canvas = $('canvas-3d');
  let dragging = false;
  let last = { x: 0, y: 0 };

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    last = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    last = { x: event.clientX, y: event.clientY };
    meshViewer.setRotation(meshViewer.rotationX - dy * 0.008, meshViewer.rotationY + dx * 0.008);
    meshViewer.draw();
  });
  canvas.addEventListener('pointerup', (event) => {
    dragging = false;
    canvas.releasePointerCapture?.(event.pointerId);
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      meshViewer.zoom = Math.min(4, Math.max(0.4, meshViewer.zoom * (event.deltaY > 0 ? 0.94 : 1.06)));
      meshViewer.draw();
    },
    { passive: false }
  );

  let spinning = true;
  const loop = () => {
    if (spinning && meshViewer.mesh && !dragging) {
      meshViewer.setRotation(meshViewer.rotationX, meshViewer.rotationY + 0.006);
      meshViewer.draw();
    }
    requestAnimationFrame(loop);
  };
  $('chk-spin').addEventListener('change', (event) => {
    spinning = event.target.checked;
  });
  requestAnimationFrame(loop);
}

/* -------------------------------------------------------------- segmentation */

async function runSegmentation() {
  if (!state.volume || state.busy) return;
  const mode = $('segment-mode').value;
  const threshold = Number($('input-threshold').value);
  state.busy = true;
  setStatus('Segmenting…', 0.3);
  await nextFrame();
  try {
    const result = segmentVolume(state.volume, {
      mode,
      threshold,
      keepLargest: $('chk-largest').checked,
      fill: $('chk-fill').checked,
    });
    state.segmentation = result;
    state.traceLevel = Math.round(result.threshold);
    $('out-threshold').textContent = formatNumber(result.threshold);
    $('input-threshold').value = String(result.threshold);
    for (const view of Object.values(views)) view.setSegmentation(state.segmentation, state.volume.spacing);
    $('segment-status').textContent = `Mask covers ${(result.coverage * 100).toFixed(1)}% of the volume · threshold ${formatNumber(
      result.threshold
    )} (Otsu ${formatNumber(result.otsu)})`;
    setStatus('Segmentation finished', 1);
    toast('Segmentation finished', `${(result.coverage * 100).toFixed(1)}% of the volume`, 'ok');
    drawAll();
    refreshButtons();
  } catch (error) {
    toast('Segmentation failed', error.message, 'error');
  } finally {
    state.busy = false;
  }
}

/* --------------------------------------------------------------------- mesh */

function openMeshDialog() {
  if (!state.volume) return;
  if (!state.segmentation) {
    toast('Segment first', 'Create a mask before building a mesh.', 'error');
    return;
  }
  $('mesh-dialog').showModal();
}

async function buildMesh() {
  if (!state.volume || !state.segmentation) return;
  const hollow = Number($('mesh-hollow').value);
  const smoothing = Number($('mesh-smoothing').value) / 100;
  const simplify = Number($('mesh-simplify').value);
  state.busy = true;
  setStatus('Building surface…', 0.1);
  await nextFrame();
  try {
    const { volume: meshVolume, factor } = state.volume.downsample(12_000_000);
    const model = buildPrintModel(
      meshVolume,
      {
        mode: $('segment-mode').value,
        threshold: state.segmentation.threshold,
        keepLargest: $('chk-largest').checked,
        fill: $('chk-fill').checked,
        smoothing,
        simplify,
        hollow,
      },
      {
        onStage: (stage, progress) => {
          const names = {
            segment: 'Segmenting…',
            surface: 'Extracting surface…',
            hollow: 'Offsetting inner wall…',
            smooth: 'Smoothing…',
            simplify: 'Simplifying…',
            done: 'Finishing…',
          };
          setStatus(names[stage] || stage, progress);
        },
      }
    );

    state.printModel = model;
    meshViewer.setMesh(model.mesh);
    meshViewer.draw();

    $('mesh-stats').hidden = false;
    $('stat-triangles').textContent = formatNumber(model.stats.triangles);
    $('stat-vertices').textContent = formatNumber(model.stats.vertices);
    $('stat-volume').textContent = `${(model.stats.volumeMm3 / 1000).toFixed(1)} cm³`;
    $('stat-wall').textContent = model.wall > 0 ? formatMm(model.wall) : 'solid';

    const note = factor > 1 ? ` (sampled at ${factor}× for speed)` : '';
    setStatus(`Mesh ready · ${formatNumber(model.stats.triangles)} triangles${note}`, 1);
    toast('Mesh ready', `${formatNumber(model.stats.triangles)} triangles`, 'ok');
    refreshButtons();
  } catch (error) {
    console.error(error);
    toast('Mesh failed', error.message, 'error');
    setStatus('Mesh generation failed');
  } finally {
    state.busy = false;
  }
}

/* ------------------------------------------------------------------- export */

function sliceIndices(axis) {
  const volume = state.volume;
  if (!volume) return [];
  const count = volume.sliceCount(axis);
  const from = Math.max(1, Math.min(count, Number($('export-from').value) || 1));
  const to = Math.max(from, Math.min(count, Number($('export-to').value) || count));
  const step = Math.max(1, Number($('export-step').value) || 1);
  const indices = [];
  for (let i = from - 1; i <= to - 1; i += step) indices.push(i);
  return indices;
}

function spacingFor(axis) {
  const volume = state.volume;
  if (axis === 'axial') return volume.spacing[2];
  if (axis === 'coronal') return volume.spacing[1];
  return volume.spacing[0];
}

function contoursForSlice(axis, index) {
  const volume = state.volume;
  const minLength = Number($('export-minlength').value) || 0;
  const source = $('export-source').value;

  if (source === 'model') {
    if (!state.printModel) throw new Error('Create a mesh first (3D print panel).');
    const position = index * spacingFor(axis);
    const [slice] = slicePrintModel(state.printModel.mesh, axis, [position], { minLength });
    return smoothContours(slice.contours, { iterations: 1, tolerance: 0.1 });
  }

  if (source === 'mask') {
    if (!state.segmentation) throw new Error('Run segmentation first.');
    const slice = maskSlice(state.segmentation, axis, index, volume.spacing);
    return smoothContours(
      contour2D(slice.data, slice.width, slice.height, {
        level: 0.5,
        spacing: [slice.colSpacing, slice.rowSpacing],
        minLength,
      }),
      { iterations: 3, tolerance: 0.12 }
    );
  }

  const slice = volume.slice(axis, index);
  // a light blur keeps film grain and MR noise from turning into thousands of
  // hairline contours
  const blurred = gaussianBlur2D(slice.data, slice.width, slice.height, 1.2);
  return smoothContours(
    contour2D(blurred, slice.width, slice.height, {
      level: state.traceLevel,
      spacing: [slice.colSpacing, slice.rowSpacing],
      minLength,
    }),
    { iterations: 3, tolerance: 0.12 }
  );
}

function layoutOptions() {
  const grid = Number($('export-grid').value);
  const rows = grid === 6 ? 4 : grid;
  return {
    pageSize: $('export-page').value,
    columns: grid === 6 ? 3 : grid,
    rows,
    labels: true,
    evenOddFill: $('export-fill').checked,
    lineWidthMm: Number($('export-line').value) || 0.3,
    marginMm: 12,
    gapMm: 6,
  };
}

async function exportPng() {
  if (!state.volume) return;
  const axis = $('export-axis').value;
  const [index] = sliceIndices(axis);
  const { canvas } = sliceToCanvas(state.volume, axis, index, {
    center: state.window.center,
    width: state.window.width,
    colormap: state.colormap,
    scale: 1,
  });
  const blob = await canvasToBlob(canvas, 'image/png');
  downloadBlob(blob, `brain2dprint_${axis}_${String(index + 1).padStart(3, '0')}.png`);
  setStatus(`Saved ${axis} slice ${index + 1} as PNG`, 1);
}

async function exportSvg() {
  if (!state.volume) return;
  const axis = $('export-axis').value;
  const indices = sliceIndices(axis);
  setStatus('Tracing outlines…', 0.4);
  await nextFrame();
  try {
    const slices = indices.map((index) => ({ contours: contoursForSlice(axis, index), label: `${axis} ${index + 1}` }));
    const pages = layoutSlices(slices, layoutOptions());
    const svg = pages.map((page) => pageToSvg(page, { title: `Brain2DPrint ${axis}` })).join('\n');
    downloadText(svg, `brain2dprint_${axis}_outlines.svg`, 'image/svg+xml');
    const total = slices.reduce((sum, slice) => sum + slice.contours.length, 0);
    setStatus(`SVG saved (${total} contours across ${indices.length} slices)`, 1);
    toast('SVG saved', `${total} contours`, 'ok');
  } catch (error) {
    toast('Export failed', error.message, 'error');
    setStatus('Export failed');
  }
}

async function exportPdf() {
  if (!state.volume) return;
  const axis = $('export-axis').value;
  const indices = sliceIndices(axis);
  setStatus('Building PDF…', 0.3);
  await nextFrame();
  try {
    const slices = indices.map((index) => ({ contours: contoursForSlice(axis, index), label: `${axis} ${index + 1}` }));
    const pages = layoutSlices(slices, layoutOptions());
    const pdf = createPdf(pages, { title: `Brain2DPrint ${axis} outlines` });
    downloadBlob(new Blob([pdf], { type: 'application/pdf' }), `brain2dprint_${axis}_outlines.pdf`);
    setStatus(`PDF saved · ${pages.length} page${pages.length > 1 ? 's' : ''}`, 1);
    toast('PDF saved', `${pages.length} page${pages.length > 1 ? 's' : ''}`, 'ok');
  } catch (error) {
    toast('Export failed', error.message, 'error');
    setStatus('Export failed');
  }
}

async function exportZip() {
  if (!state.volume) return;
  const axis = $('export-axis').value;
  const indices = sliceIndices(axis);
  setStatus('Packing archive…', 0.2);
  await nextFrame();
  try {
    const entries = [];
    const options = layoutOptions();
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      const name = `${axis}_${String(index + 1).padStart(3, '0')}`;
      const { canvas } = sliceToCanvas(state.volume, axis, index, {
        center: state.window.center,
        width: state.window.width,
        colormap: state.colormap,
      });
      entries.push({ name: `png/${name}.png`, data: new Uint8Array(await (await canvasToBlob(canvas, 'image/png')).arrayBuffer()) });

      try {
        const contours = contoursForSlice(axis, index);
        if (contours.length) {
          const page = layoutSinglePage(contours, { ...options, label: `${axis} ${index + 1}` });
          const svg = pageToSvg(page, { title: `${axis} ${index + 1}` });
          entries.push({ name: `svg/${name}.svg`, data: new TextEncoder().encode(svg) });
        }
      } catch {
        /* outlines are optional for the archive */
      }
      setStatus(`Packing ${i + 1}/${indices.length}`, 0.2 + (0.7 * (i + 1)) / indices.length);
    }

    if (state.segmentation) {
      const page = layoutSinglePage(contoursForSlice('axial', state.crosshair.z), { ...options });
      const sheet = contactSheet(
        indices.slice(0, 24).map((index) => sliceToCanvas(state.volume, axis, index, {
          center: state.window.center,
          width: state.window.width,
          colormap: state.colormap,
        })),
        { columns: 4 }
      );
      entries.push({ name: 'contact_sheet.png', data: new Uint8Array(await (await canvasToBlob(sheet, 'image/png')).arrayBuffer()) });
      void page;
    }

    const manifest = {
      app: 'Brain2DPrint',
      axis,
      slices: indices.length,
      window: state.window,
      segmentation: state.segmentation
        ? { threshold: state.segmentation.threshold, coverage: state.segmentation.coverage }
        : null,
      created: new Date().toISOString(),
    };
    entries.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });

    const zip = await writeZip(entries);
    downloadBlob(new Blob([zip], { type: 'application/zip' }), `brain2dprint_${axis}.zip`);
    setStatus(`Archive saved · ${entries.length} files`, 1);
    toast('ZIP saved', `${entries.length} files`, 'ok');
  } catch (error) {
    toast('Export failed', error.message, 'error');
    setStatus('Export failed');
  }
}

function exportStl() {
  if (!state.printModel) return;
  const bytes = meshToStlBinary(state.printModel.mesh, 'Brain2DPrint');
  downloadBlob(new Blob([bytes], { type: 'model/stl' }), 'brain2dprint_model.stl');
  setStatus(`STL saved · ${formatNumber(state.printModel.stats.triangles)} triangles`, 1);
  toast('STL saved', `${formatNumber(state.printModel.stats.triangles)} triangles`, 'ok');
}

async function exportSections() {
  if (!state.printModel) return;
  const axis = $('export-axis').value;
  const indices = sliceIndices(axis);
  try {
    const slices = indices.map((index) => {
      const position = index * spacingFor(axis);
      const [slice] = slicePrintModel(state.printModel.mesh, axis, [position], {
        minLength: Number($('export-minlength').value) || 0,
      });
      return { contours: slice.contours, label: `${axis} ${index + 1} · ${position.toFixed(1)} mm` };
    });
    const pages = layoutSlices(slices, layoutOptions());
    if (pages.length === 1) {
      downloadText(
        pageToSvg(pages[0], { title: `Brain2DPrint ${axis} sections` }),
        `brain2dprint_sections_${axis}.svg`,
        'image/svg+xml'
      );
    } else {
      const entries = pages.map((page, index) => ({
        name: `sections_${axis}_page${index + 1}.svg`,
        data: new TextEncoder().encode(pageToSvg(page, { title: `Brain2DPrint ${axis} sections` })),
      }));
      const zip = await writeZip(entries);
      downloadBlob(new Blob([zip], { type: 'application/zip' }), `brain2dprint_sections_${axis}.zip`);
    }
    setStatus(`Sections saved · ${indices.length} slices`, 1);
    toast('Sections saved', `${indices.length} slices`, 'ok');
  } catch (error) {
    toast('Export failed', error.message, 'error');
  }
}

/* ------------------------------------------------------------------- wiring */

function refreshButtons() {
  const hasVolume = Boolean(state.volume);
  const hasSegmentation = Boolean(state.segmentation);
  const hasModel = Boolean(state.printModel);
  for (const id of ['btn-export-png', 'btn-export-svg', 'btn-export-pdf', 'btn-export-zip']) $(id).disabled = !hasVolume;
  $('btn-segment').disabled = !hasVolume || state.busy;
  $('btn-mesh').disabled = !hasVolume;
  $('btn-export-stl').disabled = !hasModel;
  $('btn-export-sections').disabled = !hasModel;
  $('export-source').querySelector('option[value="mask"]').disabled = !hasSegmentation;
  $('export-source').querySelector('option[value="model"]').disabled = !hasModel;
  if ($('export-source').value === 'mask' && !hasSegmentation) $('export-source').value = 'trace';
  if ($('export-source').value === 'model' && !hasModel) $('export-source').value = 'trace';
  // once a mask exists, offer its clean outlines rather than a raw trace
  if (!state.sourcePicked) $('export-source').value = hasSegmentation ? 'mask' : 'trace';
}

function wireUi() {
  $('file-input').addEventListener('change', (event) => {
    importFiles(event.target.files);
    event.target.value = '';
  });

  $('btn-demo').addEventListener('click', () => {
    if (state.busy) return;
    setStatus('Building demo phantom…', 0.4);
    setTimeout(() => {
      const volume = createBrainPhantom({ size: [128, 128, 96], spacing: [1.5, 1.5, 1.5] });
      applyVolume(volume, { kind: 'demo', series: [] });
      toast('Demo loaded', 'Synthetic T1 brain phantom', 'ok');
    }, 30);
  });

  $('btn-help').addEventListener('click', () => $('help-dialog').showModal());
  $('btn-clear').addEventListener('click', () => {
    state.volume = null;
    state.segmentation = null;
    state.printModel = null;
    meshViewer.setMesh(null);
    meshViewer.draw();
    $('source-info').innerHTML = '<p class="muted">No scan loaded yet.</p>';
    $('mesh-stats').hidden = true;
    $('series-field').hidden = true;
    for (const view of Object.values(views)) {
      view.setVolume(null);
      view.clear();
    }
    refreshButtons();
    setStatus('Cleared. Drop a scan or load the demo.', null);
  });

  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.volume) return;
      applyPreset(button.dataset.preset);
      document.querySelectorAll('[data-preset]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
    });
  });

  $('input-center').addEventListener('input', (event) => {
    setWindow(Number(event.target.value), state.window.width);
  });
  $('input-width').addEventListener('input', (event) => {
    setWindow(state.window.center, Number(event.target.value));
  });
  $('colormap-select').addEventListener('change', (event) => {
    state.colormap = event.target.value;
    for (const view of Object.values(views)) view.setColormap(state.colormap);
    drawAll();
  });
  $('input-overlay').addEventListener('input', (event) => {
    state.overlayOpacity = Number(event.target.value) / 100;
    $('out-overlay').textContent = `${event.target.value}%`;
    for (const view of Object.values(views)) view.overlayOpacity = state.overlayOpacity;
    drawAll();
  });

  $('segment-mode').addEventListener('change', (event) => {
    $('input-threshold').disabled = event.target.value !== 'manual';
  });
  $('input-threshold').addEventListener('input', (event) => {
    state.traceLevel = Number(event.target.value);
    $('out-threshold').textContent = formatNumber(state.traceLevel);
  });
  $('btn-segment').addEventListener('click', runSegmentation);
  $('chk-overlay').addEventListener('change', (event) => {
    state.showOverlay = event.target.checked;
    for (const view of Object.values(views)) view.setSegmentation(state.showOverlay ? state.segmentation : null, state.volume?.spacing);
    drawAll();
  });

  $('input-trace').addEventListener('input', (event) => {
    state.traceLevel = Number(event.target.value);
    $('out-trace').textContent = formatNumber(state.traceLevel);
  });

  $('export-source').addEventListener('change', () => {
    state.sourcePicked = true;
  });

  $('export-axis').addEventListener('change', () => {
    if (!state.volume) return;
    const count = state.volume.sliceCount($('export-axis').value);
    $('export-from').max = String(count);
    $('export-to').max = String(count);
    $('export-to').value = String(count);
    $('export-step').value = String(Math.max(1, Math.round(count / 16)));
  });

  $('btn-export-png').addEventListener('click', () => guard(exportPng));
  $('btn-export-svg').addEventListener('click', () => guard(exportSvg));
  $('btn-export-pdf').addEventListener('click', () => guard(exportPdf));
  $('btn-export-zip').addEventListener('click', () => guard(exportZip));

  $('btn-mesh').addEventListener('click', openMeshDialog);
  $('mesh-smoothing').addEventListener('input', (event) => {
    $('out-smoothing').textContent = `${event.target.value}%`;
  });
  $('mesh-dialog').addEventListener('close', () => {
    if ($('mesh-dialog').returnValue === 'apply') guard(buildMesh);
  });

  $('btn-export-stl').addEventListener('click', exportStl);
  $('btn-export-sections').addEventListener('click', () => guard(exportSections));

  for (const axis of ['axial', 'coronal', 'sagittal']) wireViewer(axis);
  wireMeshViewer();

  window.addEventListener('resize', () => {
    drawAll();
    meshViewer.draw();
  });

  // drag and drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    $('drop-overlay').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-overlay').hidden = true;
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    $('drop-overlay').hidden = true;
    if (event.dataTransfer?.files?.length) importFiles(event.dataTransfer.files);
  });

  document.addEventListener('keydown', (event) => {
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || $('mesh-dialog').open || $('help-dialog').open) return;
    if (!state.volume) return;
    if (event.key === '1') state.focusedAxis = 'axial';
    else if (event.key === '2') state.focusedAxis = 'coronal';
    else if (event.key === '3') state.focusedAxis = 'sagittal';
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const axis = state.focusedAxis;
      const view = views[axis];
      view.setIndex(view.index + (event.key === 'ArrowDown' ? 1 : -1));
      if (axis === 'axial') state.crosshair.z = view.index;
      else if (axis === 'coronal') state.crosshair.y = view.index;
      else state.crosshair.x = view.index;
      syncViews();
      event.preventDefault();
    } else if (event.key === 'k' || event.key === 'K') runSegmentation();
    else if (event.key === 'm' || event.key === 'M') openMeshDialog();
    else if (event.key === '?') $('help-dialog').showModal();
    else return;
    document.querySelectorAll('.viewer').forEach((element) => {
      element.classList.toggle('viewer--focused', element.dataset.axis === state.focusedAxis);
    });
  });
}

function guard(fn) {
  Promise.resolve()
    .then(fn)
    .catch((error) => {
      console.error(error);
      toast('Something went wrong', error.message || String(error), 'error');
    });
}

/* --------------------------------------------------------------------- boot */

function boot() {
  wireUi();
  refreshButtons();
  for (const view of Object.values(views)) {
    view.overlayOpacity = state.overlayOpacity;
  }
  const params = new URLSearchParams(location.search);
  const sample = params.get('sample');
  if (sample) {
    const samples = {
      dicom: ['assets/samples/dicom-brain-series.zip', 'dicom-brain-series.zip'],
      nifti: ['assets/samples/brain-phantom.nii.gz', 'brain-phantom.nii.gz'],
      image: ['assets/samples/head-scan.png', 'head-scan.png'],
    };
    const entry = samples[sample];
    if (entry) {
      fetch(entry[0])
        .then((response) => {
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          return response.blob();
        })
        .then((blob) => importFiles([new File([blob], entry[1], { type: blob.type })]))
        .catch((error) => toast('Sample not available', error.message, 'error'));
    }
  } else if (params.get('demo') !== '0') {
    const volume = createBrainPhantom({ size: [128, 128, 96], spacing: [1.5, 1.5, 1.5] });
    applyVolume(volume, { kind: 'demo', series: [] });
    setStatus('Demo brain loaded — press Run segmentation, or drop your own DICOM files.', null);
  }
  requestAnimationFrame(() => {
    drawAll();
    meshViewer.draw();
  });
}

boot();
