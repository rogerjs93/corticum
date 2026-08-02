import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField } from '../fields/loader';

/**
 * A value the shader can never produce, so "not written" is detectable.
 *
 * Rounded through Math.fround because the buffer is Float32: an unrounded
 * literal like -1e30 is not exactly representable, so `readValue === SENTINEL`
 * compares a float32 against a float64 and is never true. The sentinel then
 * survives undetected — and since it is negative, it packs as "inside" and
 * reports a slice that is entirely brain. Exactly the silent failure the
 * sentinel exists to prevent.
 */
const SENTINEL = Math.fround(-1e30);

export interface SliceResult {
  axis: 0 | 1 | 2;
  posMm: number;
  res: number;
  /** Signed distance in mm at each grid point, row-major [y][x]. */
  values: Float32Array;
}

/**
 * Sample the uploaded field on a regular grid via compute, for comparison
 * against the source volume in Python.
 */
export class SliceProbe {
  private cs: ComputeShader;
  private out: StorageBuffer;
  private params: UniformBuffer;
  private res: number;
  private sentinel: Float32Array;

  constructor(
    engine: WebGPUEngine,
    private scene: Scene,
    private field: LoadedField
  ) {
    this.res = field.manifest.grid.dim;
    this.sentinel = new Float32Array(this.res * this.res).fill(SENTINEL);

    this.params = new UniformBuffer(engine, undefined, undefined, 'sliceParams');
    this.params.addUniform('cfg', 4);
    this.params.addUniform('enc', 4);

    this.out = new StorageBuffer(
      engine,
      this.res * this.res * 4,
      // READWRITE, not READ: Babylon maps READ to COPY_SRC only, and a buffer
      // without COPY_DST cannot be cleared — the resulting validation error
      // poisons the whole frame's command buffer. See CLAUDE.md gotcha #2.
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
      'sliceOut'
    );

    this.cs = new ComputeShader(
      'verifySlice',
      engine,
      { computeSource: resolveWgsl('compute/verify_slice.wgsl') },
      {
        bindingsMapping: {
          // setTexture binds the sampler immediately before the texture.
          sdfTex: { group: 0, binding: 1 },
          outBuf: { group: 0, binding: 2 },
          params: { group: 0, binding: 3 },
        },
      }
    );
    this.cs.setTexture('sdfTex', field.sdf);
    this.cs.setStorageBuffer('outBuf', this.out);
    this.cs.setUniformBuffer('params', this.params);
  }

  /**
   * Sample one slice.
   *
   * `dispatchWhenReady` only guarantees the dispatch was *recorded*; which
   * command encoder it lands in, and therefore which `scene.render()` submits
   * it, is not something the caller controls. With a render loop running this
   * races: most slices come back correct and the occasional one comes back as
   * untouched buffer contents — silently, as a plausible-looking all-zero
   * result. That is the worst kind of bug in a verification tool, because it
   * makes the *checker* lie.
   *
   * So: poison the buffer with a sentinel first, submit two frames, and refuse
   * to return until every element has actually been overwritten.
   */
  async sample(axis: 0 | 1 | 2, posMm: number): Promise<SliceResult> {
    const half = this.field.manifest.grid.halfExtentMm;
    const count = this.res * this.res;
    const bytes = count * 4;
    const groups = Math.ceil(this.res / 8);

    this.params.updateFloat4('cfg', axis, posMm, this.res, half);
    this.params.updateFloat4('enc', this.field.manifest.sdf.rangeMm, this.res, 0, 0);
    this.params.update();

    for (let attempt = 0; attempt < 4; attempt++) {
      this.out.update(this.sentinel);

      await this.cs.dispatchWhenReady(groups, groups, 1);
      // Two frames: the first closes whichever encoder the dispatch was
      // recorded into, the second guarantees it was submitted.
      this.scene.render();
      this.scene.render();

      const raw = await this.out.read(0, bytes, undefined, true);
      const values = new Float32Array(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      );

      let stale = 0;
      for (let i = 0; i < count; i++) {
        if (values[i] === SENTINEL) stale++;
      }
      if (stale === 0) {
        return { axis, posMm, res: this.res, values };
      }
      console.warn(
        `[sliceProbe] axis=${axis} pos=${posMm}: ${stale}/${count} samples not written ` +
          `(attempt ${attempt + 1}) — dispatch had not been submitted, retrying`
      );
    }

    throw new Error(
      `sliceProbe: axis=${axis} pos=${posMm} never completed after 4 attempts`
    );
  }

  dispose(): void {
    this.out.dispose();
    this.params.dispose();
  }
}
