# AGENTS notes

## Commands

- `npm test` — `node --test "tests/*.test.js"`. The glob form is required; passing the bare
  `tests/` directory fails on Node 22+.
- `npm run serve` — static server on port 8080 (used as the browser dev server).
- `npm run samples` — regenerates `assets/samples/` (DICOM zip, NIfTI gz, PNG).

## Conventions

- Plain ES modules, no build step, no dependencies. Keep `src/` DOM-free except `src/render/`
  and `src/ui/`; everything else must run under `node --test`.
- Units are millimetres everywhere after loading (`src/core/volume.js`).
- Volume arrays are `Float32Array` in `[x + nx*(y + ny*z)]` order; masks are `Uint8Array`
  with the same indexing.

## Pitfalls found the hard way

- Marching tetrahedra cannot close a surface against the volume border, so masks are padded
  with one empty voxel ring (`padMask` in `src/seg/segment.js`) before meshing. Without it,
  a mask that touches the last slice produces an open "bowl" that renders inside-out.
- `MeshViewer` culls back faces using the signed area in screen space (y is flipped), so the
  test is `area < 0` for front faces; depth buffer keeps the larger z (camera on +z).
- Vertex-cluster decimation welds vertices and can leave edges shared by 4+ triangles. That
  is benign for printing; the invariant worth testing is "no edge is used only once".
- The demo phantom fills the last axial slice, which is exactly the border case above.
