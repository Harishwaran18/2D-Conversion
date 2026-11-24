# Brain2DPrint

Turn brain scans into **2D drawing sheets and 3D-printable models**, entirely in the browser.

Brain2DPrint reads DICOM series (including zipped folders), NIfTI volumes and ordinary
images, segments the tissue you care about, and produces:

- **true-scale 2D outlines** (SVG / PNG / PDF) for printing, tracing, cutting or plotting,
- **contact sheets** with a slicer grid, page orientation marks and millimetre scale bars,
- **hollow 3D meshes** (STL) ready for a slicer such as PrusaSlicer, Cura or Bambu Studio.

There is no build step, no bundler, no server and no upload: it is plain ES modules served
as static files, and every pixel stays on the machine that runs it.

---

## Quick start

```bash
git clone https://github.com/Harishwaran18/2D-Conversion.git
cd 2D-Conversion
npm run serve          # http://localhost:8080
```

Open the page, click **Open scans**, and pick one or more files. A zip of DICOM files,
a `.nii` / `.nii.gz` volume, or a single PNG / JPEG / BMP all work.

Prefer a guided tour? Open one of the bundled samples:

| URL | What it loads |
| --- | --- |
| `/?sample=dicom` | 48-slice synthetic T1 series inside a zip |
| `/?sample=nifti` | gzip-compressed NIfTI brain phantom |
| `/?sample=image` | single 640×480 head scan (2D tracing mode) |

`/?demo=0` disables the built-in demo brain, `/?demo=1` forces it.

## Features

### Input

- **DICOM**: explicit/implicit VR little endian, multi-frame files, one-file-per-slice, and
  `.zip` archives (nested folders are flattened). Series grouping, slice ordering by
  `ImagePositionPatient` / `InstanceNumber`, rescale slope/intercept, window centre/width,
  pixel spacing and slice thickness are all read from the headers.
- **NIfTI**: `.nii` and `.nii.gz` (gzip is expanded in the browser), single-file volumes;
  4D files use the first frame.
- **Plain images**: `image/*` files become a single-slice volume with 1 mm spacing, which is
  all the 2D tracing path needs.

### Display

Three linked orthogonal views (axial, coronal, sagittal) with crosshair navigation,
window/level presets (Brain, Bone, Full range, Auto percentile window), five colormaps
(grayscale, bone, hot, turbo, viridis) and an adjustable segmentation overlay.

### Segmentation

- Otsu thresholding on a 256-bin histogram, or a manual threshold slider.
- Largest-connected-component filter and hole filling.
- Optional Gaussian pre-blur for noisy micrographs.
- The resulting mask drives the overlay, the contours and the mesh.

### 2D export

- Marching-squares contours at an arbitrary trace level, with Chaikin corner cutting so
  outlines are smooth curves rather than pixel staircases.
- Sources: image isocontour, segmentation mask, or a **print-model section** (the mesh
  sliced at the same height, so the drawing and the physical print agree).
- Island filtering by minimum length, optional even-odd fill.
- Outputs: single PNG slice, SVG outline (1:1 millimetres, `mm` units), multi-page PDF
  sheet (A4/A5/A3/Letter, 1×1 to 3×4 grids, slicer layout), or a zip of everything.

### 3D export

- Marching-tetrahedra isosurface (closed by construction) with Taubin smoothing and
  vertex-cluster decimation.
- Optional hollowing with an EDT-driven inner surface, so a print uses a fraction of the
  filament a solid model would need while keeping a chosen wall thickness.
- Binary STL output in millimetres, plus a preview in a small z-buffered software renderer
  (no WebGL required).

## Units and geometry

Everything downstream of loading is in **millimetres**. DICOM pixel spacing and slice
thickness, or NIfTI `pixdim`, define the voxel grid; coronal and sagittal views are
resampled on the fly, so measurements on any view are true scale. SVG/PDF output uses `mm`
units and STL coordinates are millimetres, so a slicer reports the model at its real
anatomical size.

Axes follow the radiological convention: +x to the patient's left (image right), +y
posterior, +z superior. Labels in the viewer (A/P, L/R, S/I) come from these axes.

## Architecture

```
src/
  core/     file loading and volume model
    dicom.js, dicom-series.js   Part-10 parser, series grouping and ordering
    nifti.js                    NIfTI-1/2 header + data reader (gzip aware)
    zip.js                      minimal zip reader/writer (stored + deflate)
    loader.js                   file -> Volume entry point, warnings
    volume.js                   dims/spacing/voxel access, stats, resampling
    orient.js, raster.js        canvas orientation helpers, image decoding
    phantom.js                  synthetic brain generator used by demos and tests
  seg/      segmentation
    segment.js                  Otsu, threshold, largest component, hole fill, crops
    filters.js                  separable Gaussian blur
    mask-slice.js               mask -> slice extraction for the overlay
  geom/     geometry
    marching-squares.js         contours + Chaikin smoothing
    isosurface.js               marching tetrahedra
    edt.js                      Euclidean distance transform
    hollow.js                   inner surface + shell combination
    smooth.js, decimate.js      Taubin smoothing, vertex clustering
    mesh.js                     mesh container, normals, signed volume, bounds
    slice.js                    plane/mesh intersection
    print-model.js              volume -> printable mesh pipeline
  render/   on-screen rendering
    slice-view.js               canvas slice view, bilinear upscaling
    mesh-view.js                z-buffered triangle rasterizer
    colormaps.js                colour lookup tables
  export/   file writers
    svg.js, pdf.js, stl.js      SVG page, PDF sheet, binary STL
    raster.js, layout.js        PNG slices, contact sheets, page layout
  ui/app.js                     app controller (state, wiring, downloads)
tools/
  serve.mjs                     static file server for local use
  fixtures.mjs                  tiny DICOM/NIfTI fixtures for the tests
  make-samples.mjs              builds assets/samples/* (zip, nii.gz, png)
```

The pipeline is pure functions over typed arrays, which is why it runs in Node for tests
without a DOM.

## Testing

```bash
npm test              # node --test tests/
npm run samples       # regenerate assets/samples/*
npm run fixtures      # sanity-check fixture builders
```

The suite covers the DICOM parser (explicit and implicit VR), series ordering, zip
reading/writing, NIfTI decoding, the volume model, segmentation (Otsu, components, hole
filling, crops), marching squares, PDF/SVG/STL writers, and the print pipeline — including a
regression test that a mask which fills the entire volume still produces a **closed**,
outward-facing surface.

## Loading your own data

De-identification is not performed by this tool; strip patient identifiers before sharing
exports. Very large series (500+ slices at 512²) work but are slow in the coronal and
sagittal views because of the on-the-fly resampling; downsample first if the browser
struggles.

## Medical disclaimer

Brain2DPrint is a visualisation and fabrication aid. It is **not** a medical device, it does
not perform diagnostic segmentation, and its output must not be used for diagnosis or
treatment planning. Check scale and anatomy against the source study before printing or
cutting anything a patient will wear or a clinician will rely on.

## Licence

MIT — see [LICENSE](LICENSE).

`archive/brainchop-partial/` holds unmodified upstream [BrainChop](https://github.com/neuroneural/brainchop)
sources (also MIT) kept for reference only; they are not loaded by the app.
