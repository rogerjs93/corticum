import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField } from '../fields/loader';
import type { OperatorFields } from '../fields/operators';

const SENTINEL = Math.fround(-1e30);
const GRID = 32;

export interface DeformMeasurement {
  samples: number;
  /** Round-trip error of exp(w) o exp(-w), in mm. */
  roundTripMaxMm: number;
  roundTripMeanMm: number;
  roundTripP99Mm: number;
  /** Fraction of sample points exceeding 0.1 mm. */
  roundTripFracOver: number;
  /** Largest tissue displacement anywhere, in mm. */
  maxDisplacementMm: number;
  /** Displacement of midline tissue, i.e. midline shift, in mm. */
  midlineShiftMm: number;
  insideCount: number;
}

export class DeformProbe {
  private cs: ComputeShader;
  private out: StorageBuffer;
  private params: UniformBuffer;
  private sentinel: Float32Array;
  private count = GRID * GRID * GRID;

  constructor(
    engine: WebGPUEngine,
    private renderFrame: () => void,
    private field: LoadedField,
    private ops: OperatorFields
  ) {
    this.sentinel = new Float32Array(this.count * 4).fill(SENTINEL);

    this.params = new UniformBuffer(engine, undefined, undefined, 'verifyDeformParams');
    this.params.addUniform('cfg', 4);
    this.params.addUniform('enc', 4);

    this.out = new StorageBuffer(
      engine,
      this.count * 16,
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
      'deformOut'
    );

    this.cs = new ComputeShader(
      'verifyDeform',
      engine,
      { computeSource: resolveWgsl('compute/verify_deform.wgsl') },
      {
        bindingsMapping: {
          invTex: { group: 0, binding: 1 },
          fwdTex: { group: 0, binding: 3 },
          sdfTex: { group: 0, binding: 5 },
          offTex: { group: 0, binding: 7 },
          outBuf: { group: 0, binding: 8 },
          params: { group: 0, binding: 9 },
        },
      }
    );
    this.cs.setTexture('invTex', ops.deformInv);
    this.cs.setTexture('fwdTex', ops.deformFwd);
    this.cs.setTexture('sdfTex', field.sdf);
    this.cs.setTexture('offTex', ops.offset);
    this.cs.setStorageBuffer('outBuf', this.out);
    this.cs.setUniformBuffer('params', this.params);
  }

  async measure(): Promise<DeformMeasurement> {
    const half = this.field.manifest.grid.halfExtentMm;
    this.params.updateFloat4('cfg', GRID, half, this.ops.dim, this.field.manifest.grid.dim);
    this.params.updateFloat4('enc', this.field.manifest.sdf.rangeMm, 0, 0, 0);
    this.params.update();

    const g = Math.ceil(GRID / 4);
    let values: Float32Array | null = null;

    // Same sentinel-and-retry discipline as the anatomy probe: a dispatch that
    // has been recorded but not submitted returns untouched buffer contents,
    // which here would look like a perfect zero-error result. A verification
    // tool that fails silently in the passing direction is worse than none.
    for (let attempt = 0; attempt < 4; attempt++) {
      this.out.update(this.sentinel);
      await this.cs.dispatchWhenReady(g, g, g);
      this.renderFrame();
      this.renderFrame();

      const raw = await this.out.read(0, this.count * 16, undefined, true);
      const v = new Float32Array(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      );
      let stale = 0;
      for (let i = 0; i < v.length; i++) if (v[i] === SENTINEL) stale++;
      if (stale === 0) {
        values = v;
        break;
      }
    }
    if (!values) throw new Error('deformProbe: dispatch never completed');

    let rtMax = 0;
    let rtSum = 0;
    let maxDisp = 0;
    let midline = 0;
    let inside = 0;
    let over = 0;
    // A bare max is a poor summary when the mean is four orders of magnitude
    // smaller: it cannot distinguish "systematically wrong" from "a handful of
    // outliers at a field discontinuity". Keep the distribution.
    const errs = new Float64Array(this.count);

    const half2 = half;
    for (let i = 0; i < this.count; i++) {
      const err = values[i * 4];
      errs[i] = err;
      if (err > 0.1) over++;
      const dispX = values[i * 4 + 1];
      const sdf = values[i * 4 + 2];

      rtMax = Math.max(rtMax, err);
      rtSum += err;
      maxDisp = Math.max(maxDisp, Math.abs(dispX));

      if (sdf < 0) {
        inside++;
        // Midline shift is the displacement of tissue that sits ON the midline.
        // Reconstruct the sample's world X the same way the shader did.
        const ix = i % GRID;
        const t = (ix + 0.5) / GRID;
        const wx = (t * 1.7 - 0.85) * 2 * half2 * 0.5;
        if (Math.abs(wx) < 4) {
          midline = Math.max(midline, Math.abs(dispX));
        }
      }
    }

    errs.sort();
    return {
      samples: this.count,
      roundTripMaxMm: rtMax,
      roundTripMeanMm: rtSum / this.count,
      roundTripP99Mm: errs[Math.floor(this.count * 0.99)],
      roundTripFracOver: over / this.count,
      maxDisplacementMm: maxDisp,
      midlineShiftMm: midline,
      insideCount: inside,
    };
  }

  dispose(): void {
    this.out.dispose();
    this.params.dispose();
  }
}
