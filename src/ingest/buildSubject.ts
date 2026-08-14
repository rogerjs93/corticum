import type { NiftiVolume } from './nifti';
import type { RegionMeta } from '../fields/loader';

/**
 * Build corticum's field payload from a user-supplied FreeSurfer parcellation.
 *
 * This is the browser counterpart of `tools/prep/build_fields.py`, and it has
 * to agree with it: an ingested subject must be indistinguishable from a
 * bundled one, or every gate, territory lookup and staging weight downstream
 * silently means something different. The tissue table below is therefore a
 * transcription of that script's, not an independent invention.
 *
 * THE BUNDLED SUBJECT REMAINS THE DEFAULT. Loading is additive: the app must
 * render on arrival without anyone supplying a file, so nothing here runs
 * unless a user explicitly opens one.
 */

const CSF_VENTRICLE = new Set([4, 5, 14, 15, 24, 31, 43, 44, 63, 72]);
const CEREBRAL_WM = new Set([2, 41, 77, 78, 79, 251, 252, 253, 254, 255]);
const DEEP_GM = new Set([10, 11, 12, 13, 17, 18, 26, 28, 49, 50, 51, 52, 53, 54, 58, 60]);
const CEREBELLAR_GM = new Set([8, 47]);
const CEREBELLAR_WM = new Set([7, 46]);
const BRAINSTEM = new Set([16, 85]);
const VESSEL = new Set([30, 62]);

export function tissueOf(label: number): number {
  if (label === 0) return 0;
  if (CSF_VENTRICLE.has(label)) return 1;
  if ((label >= 1000 && label <= 1035) || (label >= 2000 && label <= 2035)) return 2;
  if (CEREBRAL_WM.has(label)) return 3;
  if (DEEP_GM.has(label)) return 4;
  if (CEREBELLAR_GM.has(label)) return 5;
  if (CEREBELLAR_WM.has(label)) return 6;
  if (BRAINSTEM.has(label)) return 7;
  if (VESSEL.has(label)) return 8;
  return 0;
}

/** Tissue classes that count as parenchyma for the distance field. */
const PARENCHYMA = new Set([2, 3, 4, 5, 6, 7, 8]);

export interface BuiltSubject {
  dim: number;
  halfExtentMm: number;
  rangeMm: number;
  /** Signed distance, encoded exactly as the shipped i8 payload is. */
  sdfBytes: Uint8Array;
  /** Dense region index per voxel. */
  labelBytes: Uint8Array;
  /** Which fsLabels were present but had no slot in the region table. */
  unmappedLabels: number[];
  voxelsInside: number;
  buildMs: number;
}

/**
 * Exact Euclidean distance transform, Felzenszwalb & Huttenlocher (2012).
 *
 * A 1-D squared-distance transform applied along each axis in turn, which is
 * O(n) per row and exact. Chosen over a GPU jump-flood because JFA is
 * APPROXIMATE — it can be off by a voxel near thin structures, and the whole
 * project rests on that field being right — and because 9 M voxels runs in a
 * couple of seconds on the CPU, once, at load.
 */
function edt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}

/** Squared EDT of a binary mask (1 = feature/seed), in place over a 3-D grid. */
function edt3d(mask: Uint8Array, dim: number): Float64Array {
  const n = dim * dim * dim;
  const d = new Float64Array(n);
  const BIG = 1e20;
  for (let i = 0; i < n; i++) d[i] = mask[i] ? 0 : BIG;

  const f = new Float64Array(dim);
  const out = new Float64Array(dim);
  const v = new Int32Array(dim);
  const z = new Float64Array(dim + 1);

  // x
  for (let k = 0; k < dim; k++) {
    for (let j = 0; j < dim; j++) {
      const base = dim * (j + dim * k);
      for (let i = 0; i < dim; i++) f[i] = d[base + i];
      edt1d(f, dim, out, v, z);
      for (let i = 0; i < dim; i++) d[base + i] = out[i];
    }
  }
  // y
  for (let k = 0; k < dim; k++) {
    for (let i = 0; i < dim; i++) {
      for (let j = 0; j < dim; j++) f[j] = d[i + dim * (j + dim * k)];
      edt1d(f, dim, out, v, z);
      for (let j = 0; j < dim; j++) d[i + dim * (j + dim * k)] = out[j];
    }
  }
  // z
  for (let j = 0; j < dim; j++) {
    for (let i = 0; i < dim; i++) {
      for (let k = 0; k < dim; k++) f[k] = d[i + dim * (j + dim * k)];
      edt1d(f, dim, out, v, z);
      for (let k = 0; k < dim; k++) d[i + dim * (j + dim * k)] = out[k];
    }
  }
  return d;
}

/** Invert a row-major 4x4 affine that has no projective row. */
function invertAffine(a: Float32Array): Float32Array {
  const m = [
    [a[0], a[1], a[2]],
    [a[4], a[5], a[6]],
    [a[8], a[9], a[10]],
  ];
  const t = [a[3], a[7], a[11]];
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) < 1e-12) throw new Error('affine is singular; cannot resample');
  const inv = [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det,
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det,
    ],
    [
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det,
    ],
    [
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det,
    ],
  ];
  const out = new Float32Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 4 + c] = inv[r][c];
    out[r * 4 + 3] = -(inv[r][0] * t[0] + inv[r][1] * t[1] + inv[r][2] * t[2]);
  }
  out[15] = 1;
  return out;
}

export interface BuildOptions {
  dim?: number;
  halfExtentMm?: number;
  rangeMm?: number;
  onProgress?: (stage: string, frac: number) => void;
}

/**
 * @param aseg   a FreeSurfer `aparc+aseg` volume, read from NIfTI.
 * @param regions the BUNDLED region table, reused as the canonical
 *   fsLabel -> dense index map. Keeping the indexing identical is what lets
 *   territories, Braak weights, ASPECTS and every other fsLabel-keyed lookup
 *   work on an ingested subject without a single change.
 */
export function buildSubject(
  aseg: NiftiVolume,
  regions: RegionMeta[],
  opts: BuildOptions = {}
): BuiltSubject {
  const t0 = performance.now();
  const dim = opts.dim ?? 208;
  const half = opts.halfExtentMm ?? 104;
  const range = opts.rangeMm ?? 16;
  const report = opts.onProgress ?? (() => {});

  const indexOfLabel = new Int32Array(4096).fill(-1);
  for (const r of regions) {
    if (r.fsLabel >= 0 && r.fsLabel < 4096) indexOfLabel[r.fsLabel] = r.index;
  }

  const inv = invertAffine(aseg.affine);
  const [nx, ny, nz] = aseg.dims;

  // The output grid is centred on the world point that the INPUT volume's
  // centre voxel maps to. For a conformed FreeSurfer volume that is the tkrRAS
  // origin, which is what build_fields.py centres on; for anything else it is
  // the best available guess and the caller is warned.
  const a = aseg.affine;
  const cx = Math.floor(nx / 2);
  const cy = Math.floor(ny / 2);
  const cz = Math.floor(nz / 2);
  const originR = a[0] * cx + a[1] * cy + a[2] * cz + a[3];
  const originA = a[4] * cx + a[5] * cy + a[6] * cz + a[7];
  const originS = a[8] * cx + a[9] * cy + a[10] * cz + a[11];

  const n = dim * dim * dim;
  const labelBytes = new Uint8Array(n);
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  const unmapped = new Set<number>();
  let insideCount = 0;

  report('resampling', 0);
  for (let kz = 0; kz < dim; kz++) {
    // corticum world axes are X=Right, Y=Superior, Z=Anterior; NIfTI is RAS
    // (x=R, y=A, z=S). The Y/Z swap below is that difference, and getting it
    // backwards yields a brain that looks plausible from most angles — the
    // exact failure Dice caught during Phase 1.
    // Grid position is (i - dim/2) * voxel, NOT (i + 0.5) / dim * extent.
    //
    // build_fields.py does not resample — it CROPS a 208^3 block out of the
    // conformed 256^3 volume centred on voxel 128, so its texel i holds the
    // value from input voxel (i + 128 - dim/2), sitting at integer world
    // offset (i - dim/2). Sampling at half-voxel centres instead put this grid
    // 0.5 mm off the shipped one: label agreement 96.3% and 0.74 mm of mean
    // distance error, both small enough to look like rounding rather than a
    // systematic shift.
    const voxel = (2 * half) / dim;
    const wz = (kz - dim / 2) * voxel; // anterior
    for (let jy = 0; jy < dim; jy++) {
      const wy = (jy - dim / 2) * voxel; // superior
      for (let ix = 0; ix < dim; ix++) {
        const wx = (ix - dim / 2) * voxel; // right

        const R = wx + originR;
        const A = wz + originA;
        const S = wy + originS;

        const fi = inv[0] * R + inv[1] * A + inv[2] * S + inv[3];
        const fj = inv[4] * R + inv[5] * A + inv[6] * S + inv[7];
        const fk = inv[8] * R + inv[9] * A + inv[10] * S + inv[11];

        const si = Math.round(fi);
        const sj = Math.round(fj);
        const sk = Math.round(fk);

        const o = ix + dim * (jy + dim * kz);
        if (si < 0 || sj < 0 || sk < 0 || si >= nx || sj >= ny || sk >= nz) {
          outside[o] = 1;
          continue;
        }
        // NEAREST neighbour, never interpolation: a label is a class, and
        // halfway between two structures is not a third one (gotcha #18).
        const lab = aseg.data[si + nx * (sj + ny * sk)] | 0;
        const idx = lab >= 0 && lab < 4096 ? indexOfLabel[lab] : -1;
        if (idx < 0) {
          if (lab !== 0) unmapped.add(lab);
        } else {
          labelBytes[o] = idx;
        }
        if (PARENCHYMA.has(tissueOf(lab))) {
          inside[o] = 1;
          insideCount++;
        } else {
          outside[o] = 1;
        }
      }
    }
    if ((kz & 31) === 0) report('resampling', kz / dim);
  }

  // Signed distance: outside-EDT minus inside-EDT, both seeded on the opposite
  // set, which is the standard construction and puts the zero crossing exactly
  // on the boundary.
  report('distance transform', 0);
  const dOut = edt3d(inside, dim);
  report('distance transform', 0.5);
  const dIn = edt3d(outside, dim);

  report('encoding', 0);
  const sdfBytes = new Uint8Array(n);
  const voxelMm = (2 * half) / dim;
  for (let i = 0; i < n; i++) {
    const dist = inside[i]
      ? -Math.sqrt(dIn[i]) * voxelMm
      : Math.sqrt(dOut[i]) * voxelMm;
    const clamped = Math.max(-range, Math.min(range, dist));
    // SIGNED int8, exactly as the shipped .i8 payload stores it — negative
    // inside. The loader converts to offset-binary (+128) when it builds the
    // r8unorm upload; emitting texture-ready bytes here instead would look
    // correct on screen while silently inverting the field for every CPU
    // consumer of `sdfBytes`, which is how the vascular tree finds the cortex.
    const v = Math.max(-127, Math.min(127, Math.round((clamped / range) * 127)));
    sdfBytes[i] = v & 0xff;
  }
  report('done', 1);

  return {
    dim,
    halfExtentMm: half,
    rangeMm: range,
    sdfBytes,
    labelBytes,
    unmappedLabels: [...unmapped].sort((x, y) => x - y),
    voxelsInside: insideCount,
    buildMs: performance.now() - t0,
  };
}
