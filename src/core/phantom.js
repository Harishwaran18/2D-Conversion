/**
 * Synthetic brain phantom used for the "Load demo" button and for tests.
 *
 * The shape is analytic (a head ellipsoid, a skull shell, a brain with folded
 * "gyri" from value noise) so it is reproducible without any data files.
 */

import { Volume } from './volume.js';

/**
 * @param {object} [opts]
 * @param {[number, number, number]} [opts.size] voxels
 * @param {[number, number, number]} [opts.spacing] mm
 * @param {number} [opts.seed]
 * @returns {Volume}
 */
export function createBrainPhantom({ size = [128, 128, 96], spacing = [1.5, 1.5, 1.5], seed = 2024 } = {}) {
  const [nx, ny, nz] = size;
  const data = new Int16Array(nx * ny * nz);
  const noise = makeValueNoise(seed);

  const cx = (nx * spacing[0]) / 2;
  const cy = (ny * spacing[1]) / 2;
  const cz = (nz * spacing[2]) / 2;
  const head = [70, 88, 92];
  const brain = [56, 74, 68];
  const csf = 4.5;
  const skull = 6.5;
  const scalp = 3;

  for (let k = 0; k < nz; k++) {
    const z = k * spacing[2] - cz;
    for (let j = 0; j < ny; j++) {
      const y = j * spacing[1] - cy;
      for (let i = 0; i < nx; i++) {
        const x = i * spacing[0] - cx;
        const rh = ellipsoid(x, y, z, head);
        let value = 30 + noise(x * 0.5, y * 0.5, z * 0.5) * 12;
        if (rh > 0.99) {
          value = 0;
        } else if (rh > 0.94) {
          value = 120 + noise(x, y, z) * 60; // scalp / fat
        } else if (rh > 0.885) {
          value = 1650 + noise(x * 2, y * 2, z * 2) * 500; // skull
        } else {
          const rb = ellipsoidBrain(x, y, z, brain);
          if (rb < 1) {
            const fine = noise(x * 0.35, y * 0.35, z * 0.35) * 2 - 1;
            const fold = gyri(x, y, z);
            const csfGap = 1 - rb;
            if (csfGap < 0.06) {
              value = 260 + fine * 90; // CSF / subarachnoid space
            } else if (fold < -0.55) {
              value = 320 + fine * 120; // sulcus
            } else {
              value = 960 + fold * 110 + fine * 70; // grey / white matter mix
            }
          } else if (rb < 1 + (csf + skull) / brain[1]) {
            value = rb < 1 + csf / brain[1] ? 240 : 1500 + noise(x * 2, y * 2, z * 2) * 400;
          } else {
            value = 200 + noise(x, y, z) * 80;
          }
        }
        data[(k * ny + j) * nx + i] = Math.max(0, Math.min(4095, Math.round(value)));
      }
    }
  }

  return new Volume({
    data,
    dims: [nx, ny, nz],
    spacing,
    slope: 1,
    intercept: 0,
    meta: {
      source: 'demo',
      description: 'Synthetic T1 brain phantom',
      modality: 'MR',
      windowCenter: 900,
      windowWidth: 1400,
    },
  });
}

/** Folded "gyri" pattern: a wavy 3D field in [-1, 1]. */
function gyri(x, y, z) {
  return (
    Math.sin(x * 0.21 + 2.4 * Math.sin(y * 0.11)) *
    Math.cos(y * 0.17 + 2.1 * Math.sin(z * 0.13)) *
    Math.sin(z * 0.19 + 1.8 * Math.cos(x * 0.09))
  );
}

function ellipsoid(x, y, z, radii) {
  return (x / radii[0]) ** 2 + (y / radii[1]) ** 2 + (z / radii[2]) ** 2;
}

/** Slightly narrower than the outer brain for a more brain-like silhouette. */
function ellipsoidBrain(x, y, z, radii) {
  const wobble = 1 + 0.04 * Math.sin(Math.atan2(y, x) * 5) * Math.cos(z / 30);
  return (x / radii[0]) ** 2 + (y / (radii[1] * wobble)) ** 2 + (z / radii[2]) ** 2;
}

/** Deterministic 3-octave value noise in [0, 1]. */
function makeValueNoise(seed) {
  const hash = (ix, iy, iz) => {
    let h = ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1442695040888963407;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967295;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sample = (x, y, z) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const fz = smooth(z - iz);
    const c00 = lerp(hash(ix, iy, iz), hash(ix + 1, iy, iz), fx);
    const c10 = lerp(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), fx);
    const c01 = lerp(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), fx);
    const c11 = lerp(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), fx);
    return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
  };
  return (x, y, z) => (sample(x, y, z) + 0.5 * sample(x * 2, y * 2, z * 2) + 0.25 * sample(x * 4, y * 4, z * 4)) / 1.75;
}
