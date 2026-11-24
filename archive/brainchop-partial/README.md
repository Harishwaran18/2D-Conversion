# Archived: partial BrainChop sources

These four files are an **incomplete** snapshot of the upstream
[BrainChop](https://github.com/neuroneural/brainchop) browser segmentation app.
They are kept for reference only and are **not** loaded by Brain2DPrint.

Why they cannot run as-is:

| File | Problem |
| --- | --- |
| `brainchop-mainthread.js` | imports `./bwlabels.js`, `@tensorflow/tfjs` |
| `brainchop-webworker.js` | imports `./tensor-utils.js`, `@tensorflow/tfjs` |
| `brainchop-parameters.js` | model paths under `./models/` (hundreds of MB, not present) |
| `brainchop-telemetry.js` | standalone helper, unused here |

The real application in this repository (`/index.html`, `/src`) is an
independent, dependency-free implementation.

## Attribution

BrainChop is MIT licensed — see <https://github.com/neuroneural/brainchop>.
The files in this directory are unmodified upstream sources kept only as
reference; they are not part of the built application.
