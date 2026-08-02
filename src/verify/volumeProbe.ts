import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField } from '../fields/loader';
import type { OperatorFields } from '../fields/operators';

/**
 * Default sampling grid for the verification gate.
 *
 * The live UI readout uses a coarser grid: it runs on every slider release and
 * a GPU readback at 192^3 is far heavier than the ~2 ms operator evaluation
 * that drives the sliders themselves.
 */
const DEFAULT_GRID = 192;

export interface RegionVolumes {
  /** Volume in mm^3, keyed by FreeSurfer label id. */
  byLabel: Map<number, number>;
  totalMm3: number;
  voxelMm3: number;
}

/**
 * Integrate the composed field and bin the result by region.
 *
 * This is what turns "the brain looks atrophied" into a number that can be
 * checked against the literature.
 */
export class VolumeProbe {
  private cs: ComputeShader;
  private bins: StorageBuffer;
  private params: UniformBuffer;
  private zero = new Uint32Array(256);

  constructor(
    engine: WebGPUEngine,
    private renderFrame: () => void,
    private field: LoadedField,
    private ops: OperatorFields,
    private grid: number = DEFAULT_GRID
  ) {
    this.params = new UniformBuffer(engine, undefined, undefined, 'volParams');
    this.params.addUniform('cfg0', 4);
    this.params.addUniform('cfg1', 4);

    this.bins = new StorageBuffer(
      engine,
      256 * 4,
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
      'volBins'
    );

    this.cs = new ComputeShader(
      'verifyVolume',
      engine,
      { computeSource: resolveWgsl('compute/verify_volume.wgsl') },
      {
        bindingsMapping: {
          sdfTex: { group: 0, binding: 1 },
          defTex: { group: 0, binding: 3 },
          offTex: { group: 0, binding: 5 },
          labTex: { group: 0, binding: 7 },
          bins: { group: 0, binding: 8 },
          params: { group: 0, binding: 9 },
        },
      }
    );
    this.cs.setTexture('sdfTex', field.sdf);
    this.cs.setTexture('defTex', ops.deformInv);
    this.cs.setTexture('offTex', ops.offset);
    this.cs.setTexture('labTex', field.labels);
    this.cs.setStorageBuffer('bins', this.bins);
    this.cs.setUniformBuffer('params', this.params);

    this.indexToLabel = new Map(field.regions.map((r) => [r.index, r.fsLabel]));
  }

  private indexToLabel: Map<number, number>;

  /**
   * Measure, then measure again and require agreement.
   *
   * The other probes poison their output buffer with a sentinel so a
   * recorded-but-unsubmitted dispatch is detectable. That trick does not work
   * here: these are counters starting at zero, so "never written" and
   * "genuinely zero" are the same bit pattern. Running twice and comparing
   * totals catches the same race — and it is not theoretical, it produced two
   * spurious gate failures when this ran immediately after another probe.
   */
  async measure(): Promise<RegionVolumes> {
    let last: RegionVolumes | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const a = await this.measureOnce();
      const b = await this.measureOnce();
      const rel = Math.abs(a.totalMm3 - b.totalMm3) / Math.max(b.totalMm3, 1);
      if (a.totalMm3 > 0 && rel < 1e-6) {
        return b;
      }
      last = b;
      console.warn(
        `[volumeProbe] unstable measurement (rel diff ${rel.toExponential(2)}), retrying`
      );
    }
    if (!last) throw new Error('volumeProbe: no measurement');
    return last;
  }

  private async measureOnce(): Promise<RegionVolumes> {
    const m = this.field.manifest;
    const half = m.grid.halfExtentMm;
    this.params.updateFloat4('cfg0', this.grid, half, this.ops.dim, m.grid.dim);
    this.params.updateFloat4(
      'cfg1',
      m.sdf.rangeMm,
      this.ops.active ? 1 : 0,
      m.grid.dim,
      0.9
    );
    this.params.update();

    // Explicit zero upload, not clear(): clear() is a recorded command whose
    // ordering against the dispatch is not the caller's to control.
    this.bins.update(this.zero);

    const g = Math.ceil(this.grid / 4);
    await this.cs.dispatchWhenReady(g, g, g);
    this.renderFrame();
    this.renderFrame();

    const raw = await this.bins.read(0, 256 * 4, undefined, true);
    const counts = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

    const spacing = (2 * half) / this.grid;
    const voxelMm3 = spacing ** 3;
    const byLabel = new Map<number, number>();
    let total = 0;
    for (let i = 0; i < 256; i++) {
      if (counts[i] === 0) continue;
      const label = this.indexToLabel.get(i);
      if (label === undefined || label === 0) continue;
      byLabel.set(label, counts[i] * voxelMm3);
      total += counts[i] * voxelMm3;
    }
    return { byLabel, totalMm3: total, voxelMm3 };
  }

  dispose(): void {
    this.bins.dispose();
    this.params.dispose();
  }
}
