import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField } from '../fields/loader';
import type { OperatorFields } from '../fields/operators';
import { occlusionById, territoryOf } from '../disease/territories';

const GRID = 128;

export interface StrokeMeasurement {
  /** Voxels in the occluded territory per the LUT. */
  territoryVoxels: number;
  coreVoxels: number;
  /** Dice of core against the hand-authored territory. */
  dice: number;
  /** Fraction of territory-bearing core lying outside the occluded territory. */
  spillFraction: number;
  /** Core voxels in tissue with no territory of its own (mostly white matter). */
  nonTerritorialCore: number;
  /** Core fraction within 8 mm of the pial surface. */
  rimCoreFraction: number;
  /** Core fraction deeper than 8 mm. */
  deepCoreFraction: number;
  /**
   * Core fraction in the MIRROR of the occluded territory — same parcels, other
   * hemisphere. A unilateral occlusion must leave this near zero.
   */
  contralateralCoreFraction: number;
}

/**
 * Measure the infarct against the territory it is supposed to occupy.
 *
 * The rim/deep split matters as much as the Dice: a model that simply scaled
 * the whole deficit down with collateral grade would produce a smaller infarct
 * and pass a naive test, while getting the physiology backwards. Collaterals
 * arrive over the pial surface, so they must spare the RIM preferentially.
 */
export class StrokeProbe {
  private cs: ComputeShader;
  private bins: StorageBuffer;
  private params: UniformBuffer;
  private zero = new Uint32Array(16);
  private territoryLut = new Float32Array(256);
  private occludedLut = new Float32Array(16);

  constructor(
    engine: WebGPUEngine,
    private renderFrame: () => void,
    private field: LoadedField,
    private ops: OperatorFields
  ) {
    for (const r of field.regions) {
      if (r.index < 256) this.territoryLut[r.index] = territoryOf(r.fsLabel);
    }

    this.params = new UniformBuffer(engine, undefined, undefined, 'verifyStrokeParams');
    this.params.addUniform('cfg', 4);
    this.params.addUniform('cfg2', 4);
    this.params.addUniform('territoryLut', 4, 64);
    this.params.addUniform('occludedLut', 4, 4);

    this.bins = new StorageBuffer(
      engine,
      16 * 4,
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
      'strokeBins'
    );

    this.cs = new ComputeShader(
      'verifyStroke',
      engine,
      { computeSource: resolveWgsl('compute/verify_stroke.wgsl') },
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

  async measure(
    siteId: string,
    coreThreshold = 0.5,
    side: 'left' | 'right' = 'left'
  ): Promise<StrokeMeasurement> {
    const m = this.field.manifest;
    const site = occlusionById(siteId);
    this.occludedLut.fill(0);
    for (const a of site?.affects ?? []) {
      this.occludedLut[a.territory] = a.severity;
    }
    const sideSign = site?.bilateral ? 0 : side === 'right' ? 1 : -1;

    this.params.updateFloat4('cfg', GRID, m.grid.halfExtentMm, m.grid.dim, this.ops.strokeDim);
    this.params.updateFloat4('cfg2', m.grid.dim, m.sdf.rangeMm, coreThreshold, sideSign);
    this.params.updateFloatArray('territoryLut', this.territoryLut);
    this.params.updateFloatArray('occludedLut', this.occludedLut);
    this.params.update();

    // Measure twice and require agreement — counters starting at zero make the
    // sentinel trick impossible, same as VolumeProbe.
    const once = async () => {
      this.bins.update(this.zero);
      const g = Math.ceil(GRID / 4);
      await this.cs.dispatchWhenReady(g, g, g);
      this.renderFrame();
      this.renderFrame();
      const raw = await this.bins.read(0, 16 * 4, undefined, true);
      return new Uint32Array(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      );
    };

    let c = await once();
    for (let i = 0; i < 3; i++) {
      const d = await once();
      if (d[0] === c[0] && d[1] === c[1] && d[2] === c[2]) {
        c = d;
        break;
      }
      c = d;
    }

    const territory = c[0];
    const core = c[1];
    const inter = c[2];
    const spill = c[3];
    const rimTotal = c[4];
    const rimCore = c[5];
    const deepTotal = c[6];
    const deepCore = c[7];

    return {
      territoryVoxels: territory,
      coreVoxels: core,
      dice: territory + core > 0 ? (2 * inter) / (territory + core) : 0,
      spillFraction: core > 0 ? spill / core : 0,
      nonTerritorialCore: c[8],
      rimCoreFraction: rimTotal > 0 ? rimCore / rimTotal : 0,
      deepCoreFraction: deepTotal > 0 ? deepCore / deepTotal : 0,
      contralateralCoreFraction: c[9] > 0 ? c[10] / c[9] : 0,
    };
  }

  dispose(): void {
    this.bins.dispose();
    this.params.dispose();
  }
}
