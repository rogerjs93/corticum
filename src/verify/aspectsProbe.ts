import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField } from '../fields/loader';
import type { OperatorFields } from '../fields/operators';
import { territoryOf } from '../disease/territories';
import {
  ASPECTS_REGIONS,
  deriveAspectsGeometry,
  scoreAspects,
  structOf,
  type AspectsGeometry,
} from '../disease/aspects';

const GRID = 128;

export interface AspectsResult {
  score: number;
  lost: string[];
  regions: Array<{ key: string; name: string; kind: string; fraction: number; voxels: number }>;
  geometry: AspectsGeometry;
}

/**
 * Score ASPECTS from the composed field.
 *
 * Reports an involved FRACTION per region rather than a voxel count: the scale
 * weights all ten regions equally, so a raw count would let the large cortical
 * thirds swamp the small deep structures and the score would drift with region
 * size rather than with the infarct.
 */
export class AspectsProbe {
  private cs: ComputeShader;
  private bins: StorageBuffer;
  private params: UniformBuffer;
  private zero = new Uint32Array(32);
  private territoryLut = new Float32Array(256);
  private structLut = new Float32Array(256);
  private geom: AspectsGeometry;

  constructor(
    engine: WebGPUEngine,
    private renderFrame: () => void,
    private field: LoadedField,
    private ops: OperatorFields
  ) {
    for (const r of field.regions) {
      if (r.index < 256) {
        this.territoryLut[r.index] = territoryOf(r.fsLabel);
        this.structLut[r.index] = structOf(r.fsLabel);
      }
    }
    // Derived from this subject's own labels — hard-coded millimetre cut-offs
    // would be wrong for any other brain.
    this.geom = deriveAspectsGeometry(field);

    this.params = new UniformBuffer(engine, undefined, undefined, 'verifyAspectsParams');
    this.params.addUniform('cfg', 4);
    this.params.addUniform('cfg2', 4);
    this.params.addUniform('geom', 4);
    this.params.addUniform('icCentre', 4);
    this.params.addUniform('icRadii', 4);
    this.params.addUniform('territoryLut', 4, 64);
    this.params.addUniform('structLut', 4, 64);

    this.bins = new StorageBuffer(
      engine,
      32 * 4,
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
      'aspectsBins'
    );

    this.cs = new ComputeShader(
      'verifyAspects',
      engine,
      { computeSource: resolveWgsl('compute/verify_aspects.wgsl') },
      {
        bindingsMapping: {
          labTex: { group: 0, binding: 1 },
          strokeTex: { group: 0, binding: 3 },
          sdfTex: { group: 0, binding: 5 },
          bins: { group: 0, binding: 6 },
          params: { group: 0, binding: 7 },
        },
      }
    );
    this.cs.setTexture('labTex', field.labels);
    this.cs.setTexture('strokeTex', ops.stroke);
    this.cs.setTexture('sdfTex', field.sdf);
    this.cs.setStorageBuffer('bins', this.bins);
    this.cs.setUniformBuffer('params', this.params);
  }

  async measure(side: 'left' | 'right' = 'left', coreThreshold = 0.5): Promise<AspectsResult> {
    const m = this.field.manifest;
    const sign = side === 'right' ? 1 : -1;

    this.params.updateFloat4('cfg', GRID, m.grid.halfExtentMm, m.grid.dim, this.ops.strokeDim);
    this.params.updateFloat4('cfg2', m.grid.dim, m.sdf.rangeMm, coreThreshold, sign);
    this.params.updateFloat4(
      'geom',
      this.geom.ganglionicTopMm,
      this.geom.mcaAnteriorMm,
      this.geom.mcaPosteriorMm,
      0
    );
    this.params.updateFloat4('icCentre', ...this.geom.icCentreMm, 0);
    this.params.updateFloat4('icRadii', ...this.geom.icRadiiMm, 0);
    this.params.updateFloatArray('territoryLut', this.territoryLut);
    this.params.updateFloatArray('structLut', this.structLut);
    this.params.update();

    // Measure twice and require agreement: counters start at zero, so "never
    // written" and "genuinely zero" are the same bits and the sentinel trick
    // used elsewhere cannot work here.
    const once = async () => {
      this.bins.update(this.zero);
      const g = Math.ceil(GRID / 4);
      await this.cs.dispatchWhenReady(g, g, g);
      this.renderFrame();
      this.renderFrame();
      const raw = await this.bins.read(0, 32 * 4, undefined, true);
      return new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    };

    let c = await once();
    for (let i = 0; i < 3; i++) {
      const d = await once();
      const same = d[0] === c[0] && d[8] === c[8] && d[1] === c[1];
      c = d;
      if (same) break;
    }

    const fractions: number[] = [];
    const regions = ASPECTS_REGIONS.map((r) => {
      const total = c[r.id * 2];
      const core = c[r.id * 2 + 1];
      const fraction = total > 0 ? core / total : 0;
      fractions[r.id] = fraction;
      return {
        key: r.key,
        name: r.name,
        kind: r.kind as string,
        fraction: +fraction.toFixed(3),
        voxels: total,
      };
    });

    return { ...scoreAspects(fractions), regions, geometry: this.geom };
  }

  dispose(): void {
    this.bins.dispose();
    this.params.dispose();
  }
}
