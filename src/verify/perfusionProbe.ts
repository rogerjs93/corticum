import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField } from '../fields/loader';
import type { OperatorFields } from '../fields/operators';

const GRID = 128;

/** DEFUSE-3 selection thresholds. */
export const DEFUSE3 = {
  maxCoreMl: 70,
  minMismatchRatio: 1.8,
  minMismatchMl: 15,
} as const;

export interface PerfusionResult {
  coreMl: number;
  hypoperfusedMl: number;
  mismatchMl: number;
  /** Hypoperfused / core. Infinite when there is no core at all. */
  mismatchRatio: number;
  parenchymaMl: number;
  /** Core voxels that are NOT hypoperfused. Must be 0 — core is a subset. */
  coreOutsideHypoMl: number;
  /** Whether this pattern meets the DEFUSE-3 imaging criteria. */
  eligible: boolean;
  reasons: string[];
}

/**
 * Integrate the perfusion field into the volumes that select for thrombectomy.
 *
 * A stroke tool that renders the lesion but not its VOLUMES stops one step
 * short of the decision: DEFUSE-3 and DAWN both select on core size and
 * mismatch, not on appearance.
 *
 * Thresholds are the trial definitions (rCBF < 30%, Tmax > 6 s) applied to a
 * synthetic deficit field. The pattern they produce is meaningful; the
 * millilitres are not calibrated against perfusion software.
 */
export class PerfusionProbe {
  private cs: ComputeShader;
  private bins: StorageBuffer;
  private params: UniformBuffer;
  private zero = new Uint32Array(8);

  constructor(
    engine: WebGPUEngine,
    private renderFrame: () => void,
    private field: LoadedField,
    private ops: OperatorFields
  ) {
    this.params = new UniformBuffer(engine, undefined, undefined, 'perfusionParams');
    this.params.addUniform('cfg', 4);
    this.params.addUniform('cfg2', 4);

    this.bins = new StorageBuffer(
      engine,
      8 * 4,
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
      'perfusionBins'
    );

    this.cs = new ComputeShader(
      'verifyPerfusion',
      engine,
      { computeSource: resolveWgsl('compute/verify_perfusion.wgsl') },
      {
        bindingsMapping: {
          strokeTex: { group: 0, binding: 1 },
          sdfTex: { group: 0, binding: 3 },
          bins: { group: 0, binding: 4 },
          params: { group: 0, binding: 5 },
        },
      }
    );
    this.cs.setTexture('strokeTex', ops.stroke);
    this.cs.setTexture('sdfTex', field.sdf);
    this.cs.setStorageBuffer('bins', this.bins);
    this.cs.setUniformBuffer('params', this.params);
  }

  async measure(): Promise<PerfusionResult> {
    const m = this.field.manifest;
    const half = m.grid.halfExtentMm;
    this.params.updateFloat4('cfg', GRID, half, m.grid.dim, m.sdf.rangeMm);
    // Core threshold 0.5 on the model's OWN core channel — the same value the
    // ASPECTS probe uses, so the two readouts cannot disagree about what is
    // infarcted. Hypoperfusion at deficit > 0.35 matches the operator's own
    // penumbra threshold, which is what makes Tmax > 6 s mean the same thing
    // here as it does in the shader that draws it.
    this.params.updateFloat4('cfg2', this.ops.strokeDim, 0.5, 0.35, 0);
    this.params.update();

    const g = Math.ceil(GRID / 4);
    const once = async () => {
      this.bins.update(this.zero);
      await this.cs.dispatchWhenReady(g, g, g);
      this.renderFrame();
      this.renderFrame();
      const raw = await this.bins.read(0, 8 * 4, undefined, true);
      return new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    };

    // Counters start at zero, so "never written" and "genuinely zero" are the
    // same bits; measure twice and require agreement (gotcha #36).
    let c = await once();
    for (let i = 0; i < 3; i++) {
      const d = await once();
      const same = d[0] === c[0] && d[1] === c[1] && d[2] === c[2];
      c = d;
      if (same) break;
    }

    const voxelMl = ((2 * half) / GRID) ** 3 / 1000; // mm^3 -> mL
    const coreMl = c[1] * voxelMl;
    const hypoMl = c[2] * voxelMl;
    const mismatchMl = Math.max(hypoMl - coreMl, 0);
    const ratio = coreMl > 0.01 ? hypoMl / coreMl : Number.POSITIVE_INFINITY;

    const reasons: string[] = [];
    if (coreMl > DEFUSE3.maxCoreMl) reasons.push(`core ${coreMl.toFixed(0)} mL > 70`);
    if (ratio < DEFUSE3.minMismatchRatio) reasons.push(`ratio ${ratio.toFixed(2)} < 1.8`);
    if (mismatchMl < DEFUSE3.minMismatchMl) {
      reasons.push(`mismatch ${mismatchMl.toFixed(0)} mL < 15`);
    }

    return {
      coreMl,
      hypoperfusedMl: hypoMl,
      mismatchMl,
      mismatchRatio: ratio,
      parenchymaMl: c[0] * voxelMl,
      coreOutsideHypoMl: c[4] * voxelMl,
      // No hypoperfusion at all is not "eligible", it is "no target".
      eligible: hypoMl > 0.01 && reasons.length === 0,
      reasons,
    };
  }

  dispose(): void {
    this.bins.dispose();
    this.params.dispose();
  }
}
