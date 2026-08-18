import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField } from '../fields/loader';
import type { OperatorFields } from '../fields/operators';
import type { DerivedFields } from '../fields/derived';
import { writeNifti, worldVectorsToRas, downloadBlob } from './nifti';

export interface ExportResult {
  dim: number;
  voxelMm: number;
  files: string[];
  /** Fraction of voxels inside the brain, as a sanity figure. */
  insideFraction: number;
  maxDisplacementMm: number;
  bytes: number;
  /** Present when `keep` is set: the emitted file bytes, for verification. */
  buffers?: Array<{ name: string; data: ArrayBuffer }>;
  /** The sidecar contents, so a caller can assert on them without re-reading the file. */
  provenance: Record<string, unknown>;
}

/**
 * SHA-256 of a buffer, as lowercase hex.
 *
 * `crypto.subtle` needs a secure context. localhost and https both qualify, so
 * this works in dev and on Pages — but a `file://` spot-check does not, and a
 * missing hash must not take the whole export down with it. Returns null there
 * instead, which the sidecar records honestly.
 */
async function sha256Hex(data: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const d = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Export the composed field as ground-truth NIfTI volumes.
 *
 * This is the feature that turns corticum from a teaching tool into something
 * a methods researcher can use: the deformation is not estimated here, it IS
 * the operator, so an algorithm's recovered warp can be scored against it
 * exactly. Simul@atrophy does this offline in batch; this does it from a
 * browser with nothing installed.
 */
export class ExportProbe {
  private cs: ComputeShader;
  private params: UniformBuffer;
  private bufSdf: StorageBuffer | null = null;
  private bufT1: StorageBuffer | null = null;
  private bufDisp: StorageBuffer | null = null;
  private allocatedDim = 0;

  constructor(
    private engine: WebGPUEngine,
    private renderFrame: () => void,
    private field: LoadedField,
    private ops: OperatorFields,
    private derived: DerivedFields
  ) {
    this.params = new UniformBuffer(engine, undefined, undefined, 'exportParams');
    this.params.addUniform('cfg', 4);
    this.params.addUniform('cfg2', 4);
    this.params.addUniform('cfg3', 4);

    this.cs = new ComputeShader(
      'exportVolume',
      engine,
      { computeSource: resolveWgsl('compute/export_volume.wgsl') },
      {
        bindingsMapping: {
          sdfTex: { group: 0, binding: 1 },
          offTex: { group: 0, binding: 3 },
          invTex: { group: 0, binding: 5 },
          fwdTex: { group: 0, binding: 7 },
          propTex: { group: 0, binding: 9 },
          outSdf: { group: 0, binding: 10 },
          outT1: { group: 0, binding: 11 },
          outDisp: { group: 0, binding: 12 },
          params: { group: 0, binding: 13 },
        },
      }
    );
    this.cs.setTexture('sdfTex', field.sdf);
    this.cs.setTexture('offTex', ops.offset);
    this.cs.setTexture('invTex', ops.deformInv);
    this.cs.setTexture('fwdTex', ops.deformFwd);
    this.cs.setTexture('propTex', derived.props);
    this.cs.setUniformBuffer('params', this.params);
  }

  private allocate(dim: number): boolean {
    if (this.allocatedDim === dim) return false;
    this.dispose(false);
    const n = dim * dim * dim;
    const flags =
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE;
    this.bufSdf = new StorageBuffer(this.engine, n * 4, flags, 'exSdf');
    this.bufT1 = new StorageBuffer(this.engine, n * 4, flags, 'exT1');
    this.bufDisp = new StorageBuffer(this.engine, n * 3 * 4, flags, 'exDisp');
    this.cs.setStorageBuffer('outSdf', this.bufSdf);
    this.cs.setStorageBuffer('outT1', this.bufT1);
    this.cs.setStorageBuffer('outDisp', this.bufDisp);
    this.allocatedDim = dim;
    return true;
  }

  /**
   * @param dim output grid size. 128 keeps the readback near 40 MB; the shipped
   *   anatomy is 208^3, and asking for that costs ~110 MB of transfer.
   */
  async run(
    dim = 128,
    opts: {
      download?: boolean;
      prefix?: string;
      keep?: boolean;
      /**
       * The disease state and per-region modifiers that produced this export.
       * Recorded verbatim in the provenance sidecar: a result nobody can
       * regenerate is a result nobody can cite, and the parameters are the
       * only thing that distinguishes one export from another.
       */
      provenance?: {
        state?: unknown;
        regions?: Array<{ name: string; vulnerability: number; overrideMm: number }>;
      };
      /**
       * Declare the export in MNI152 rather than subject space. Only the
       * header changes: the samples stay on the subject's grid, so nothing is
       * resampled and the ground-truth displacement stays exact. Downstream
       * tools resample from the sform if they need an MNI voxel grid.
       *
       * Ignored with a warning when the payload carries no MNI block, because
       * silently emitting subject coordinates labelled MNI152 is the worst
       * possible failure here.
       */
      mni?: boolean;
      /**
       * Rician noise standard deviation, in the same 0..1 units as the
       * synthetic intensities (WM sits at 0.78). 0 disables it.
       *
       * Not cosmetic: FSL FAST cannot fit a mixture to this image without it,
       * because half the voxels sit on two exact intensities and a Gaussian
       * fitted to a delta spike has zero variance. See docs/experiment-0.md.
       */
      noiseSigma?: number;
      /** Seed for the noise. Fixed by default so exports stay reproducible. */
      noiseSeed?: number;
    } = {}
  ): Promise<ExportResult> {
    const m = this.field.manifest;
    const half = m.grid.halfExtentMm;
    const fresh = this.allocate(dim);

    this.params.updateFloat4('cfg', dim, half, m.grid.dim, m.sdf.rangeMm);
    this.params.updateFloat4(
      'cfg2',
      this.ops.dim,
      this.ops.active ? 1 : 0,
      this.derived.propDim,
      m.grid.dim
    );
    const noiseSigma = opts.noiseSigma ?? 0;
    const noiseSeed = opts.noiseSeed ?? 1;
    this.params.updateFloat4('cfg3', noiseSigma, noiseSeed, 0, 0);
    this.params.update();

    const g = Math.ceil(dim / 4);

    // Warm the pipeline whenever the buffers were just created. The FIRST
    // dispatch against a newly built bind group does not reliably land before
    // the readback, and because these outputs can legitimately be zero there is
    // no sentinel that could tell "never written" from "genuinely empty" — the
    // symptom was a healthy export reporting that NO voxel was inside the brain
    // while the very next run reported 14%. Cheap to avoid: dispatch once and
    // throw it away rather than doubling a 40 MB readback to compare.
    if (fresh) {
      await this.cs.dispatchWhenReady(g, g, g);
      this.renderFrame();
      this.renderFrame();
    }

    await this.cs.dispatchWhenReady(g, g, g);
    // The dispatch is only RECORDED by dispatchWhenReady; two frames guarantee
    // a submission boundary before the readback (gotcha #12).
    this.renderFrame();
    this.renderFrame();

    const n = dim * dim * dim;
    const readF32 = async (b: StorageBuffer, count: number) => {
      const raw = await b.read(0, count * 4, undefined, true);
      return new Float32Array(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      );
    };
    const sdf = await readF32(this.bufSdf!, n);
    const t1 = await readF32(this.bufT1!, n);
    const disp = await readF32(this.bufDisp!, n * 3);

    let inside = 0;
    for (let i = 0; i < n; i++) if (sdf[i] < 0) inside++;
    let maxDisp = 0;
    for (let i = 0; i < disp.length; i += 3) {
      const d = Math.hypot(disp[i], disp[i + 1], disp[i + 2]);
      if (d > maxDisp) maxDisp = d;
    }

    const voxelMm = (2 * half) / dim;
    // Voxel (0,0,0) centre in RAS. The grid is centred on the world origin, so
    // the first voxel sits half a voxel in from -half on every axis.
    const o = -half + voxelMm / 2;
    const origin: [number, number, number] = [o, o, o];
    const prefix = opts.prefix ?? `corticum_${m.subject}`;

    // The native affine is diagonal: the data is already RAS and the grid is
    // axis-aligned. MNI is that affine left-multiplied by the subject's
    // tkrRAS->MNI152 matrix — one composition, no resampling.
    const nativeAffine = [
      [voxelMm, 0, 0, origin[0]],
      [0, voxelMm, 0, origin[1]],
      [0, 0, voxelMm, origin[2]],
    ];
    const toMni = m.mni?.tkrRasToMni152;
    const wantMni = opts.mni === true;
    if (wantMni && !toMni) {
      console.warn(
        `corticum: no MNI transform in the ${m.subject} payload — exporting in ` +
          'subject space. Run tools/prep/mni_transform.py --write to add one.'
      );
    }
    const useMni = wantMni && !!toMni;
    // Compose only the three rows NIfTI stores; the fourth is [0,0,0,1] by
    // construction for both matrices.
    const affine = useMni
      ? nativeAffine.map((_, r) =>
          [0, 1, 2, 3].map((c) =>
            [0, 1, 2].reduce((s, k) => s + toMni![r][k] * nativeAffine[k][c], toMni![r][3] * (c === 3 ? 1 : 0))
          )
        )
      : nativeAffine;
    const space = useMni ? 'MNI152' : 'RAS (subject tkrRAS)';
    const sformCode = useMni ? 4 : 2;

    const files: { name: string; data: ArrayBuffer }[] = [
      {
        name: `${prefix}_t1.nii`,
        data: writeNifti(t1, dim, {
          voxelMm,
          originMm: origin,
          affine,
          sformCode,
          description: 'corticum synthetic T1 (not a pulse sequence)',
        }),
      },
      {
        name: `${prefix}_sdf.nii`,
        data: writeNifti(sdf, dim, {
          voxelMm,
          originMm: origin,
          affine,
          sformCode,
          description: 'corticum composed signed distance, mm',
        }),
      },
      {
        name: `${prefix}_disp.nii`,
        data: writeNifti(worldVectorsToRas(disp), dim, {
          voxelMm,
          originMm: origin,
          affine,
          sformCode,
          description: 'corticum ground-truth displacement, mm (RAS)',
          intentCode: 1006, // NIFTI_INTENT_DISPVECT
          components: 3,
        }),
      },
    ];

    // Content hashes make the sidecar falsifiable: two runs of one spec must
    // produce identical digests, and a changed parameter must change them.
    // Without this the sidecar is only a claim about what was exported.
    const digests = await Promise.all(files.map((f) => sha256Hex(f.data)));
    const provenance = {
      tool: 'corticum',
      version: __VERSION__,
      build: __BUILD__,
      exportedAt: new Date().toISOString(),
      subject: m.subject,
      grid: { dim, voxelMm, halfExtentMm: half, originMm: origin, space },
      // Part of the parameter set, so two exports differing only in noise get
      // different digests and the sidecar says why.
      acquisition: { noiseModel: noiseSigma > 0 ? 'rician' : 'none', noiseSigma, noiseSeed },
      // Which space this is decides whether the coordinates mean anything
      // standard. Recorded from what was actually written, not from what
      // was requested — an MNI export that silently fell back to subject
      // space must not claim otherwise.
      mni: useMni ? { affine, sform: sformCode, via: m.mni?.via, validation: m.mni?.validation } : null,
      parameters: opts.provenance?.state ?? null,
      regionModifiers: opts.provenance?.regions ?? [],
      files: files.map((f, i) => ({ name: f.name, bytes: f.data.byteLength, sha256: digests[i] })),
      measurements: { insideFraction: inside / n, maxDisplacementMm: maxDisp },
      limitations:
        'Synthetic T1 is a tissue-class mapping, not a pulse-sequence simulation: ' +
        'no noise, no bias field, no partial-volume model, no skull or scalp. ' +
        'Suitable for scoring a method against a known deformation, not for judging ' +
        'behaviour on real clinical images.',
    };
    const sidecar = {
      name: `${prefix}_provenance.json`,
      data: new TextEncoder().encode(JSON.stringify(provenance, null, 2)).buffer as ArrayBuffer,
    };

    if (opts.download !== false) {
      for (const f of files) downloadBlob(f.data, f.name);
      downloadBlob(sidecar.data, sidecar.name);
    }

    return {
      dim,
      voxelMm,
      files: [...files.map((f) => f.name), sidecar.name],
      insideFraction: inside / n,
      maxDisplacementMm: maxDisp,
      bytes: files.reduce((a, f) => a + f.data.byteLength, 0),
      buffers: opts.keep ? [...files, sidecar] : undefined,
      provenance,
    };
  }

  dispose(full = true): void {
    this.bufSdf?.dispose();
    this.bufT1?.dispose();
    this.bufDisp?.dispose();
    this.bufSdf = null;
    this.bufT1 = null;
    this.bufDisp = null;
    this.allocatedDim = 0;
    if (full) this.params.dispose();
  }
}
