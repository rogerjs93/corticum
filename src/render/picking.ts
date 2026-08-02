import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';
import type { Vector3 } from '@babylonjs/core/Maths/math';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';
// Side-effect import: scene.createPickingRay is installed by this module, not
// declared with the Scene class. Without it Babylon throws the bare STRING
// "Ray needs to be imported before as it contains a side-effect required by
// your code" — a string, not an Error, so `e.message` is undefined and the
// failure looks like an unhandled GPU fault rather than a missing import.
import '@babylonjs/core/Culling/ray';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField, RegionMeta } from '../fields/loader';
import type { DerivedFields } from '../fields/derived';
import type { OperatorFields } from '../fields/operators';

const SENTINEL = Math.fround(-1e30);

export interface PickResult {
  hit: boolean;
  /** World-space hit position, mm. */
  position: [number, number, number];
  /** Material-space position — where the anatomy actually is. */
  material: [number, number, number];
  distanceMm: number;
  /** Displacement between world and material position, mm. */
  displacementMm: number;
  labelIndex: number;
  tissue: number;
  region: RegionMeta | null;
}

/**
 * Exact picking against the raymarched surface.
 *
 * One compute thread marches the single ray under the cursor using the same
 * shared march the fragment shader uses. Alternatives — colour-buffer ids,
 * a CPU-side mesh approximation — can all drift from what is drawn; this
 * structurally cannot.
 */
export class Picker {
  private cs: ComputeShader;
  private out: StorageBuffer;
  private params: UniformBuffer;
  private sentinel = new Float32Array(12).fill(SENTINEL);

  constructor(
    engine: WebGPUEngine,
    private scene: Scene,
    private field: LoadedField,
    derived: DerivedFields,
    private ops: OperatorFields
  ) {
    this.params = new UniformBuffer(engine, undefined, undefined, 'pickParams');
    this.params.addUniform('origin', 4);
    this.params.addUniform('direction', 4);
    this.params.addUniform('cfg0', 4);
    this.params.addUniform('cfg1', 4);
    this.params.addUniform('cfg2', 4);
    this.params.addUniform('clip', 4);

    this.out = new StorageBuffer(
      engine,
      48,
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
      'pickOut'
    );

    this.cs = new ComputeShader(
      'pick',
      engine,
      { computeSource: resolveWgsl('compute/pick.wgsl') },
      {
        bindingsMapping: {
          sdfTex: { group: 0, binding: 1 },
          defTex: { group: 0, binding: 3 },
          offTex: { group: 0, binding: 5 },
          labTex: { group: 0, binding: 7 },
          propTex: { group: 0, binding: 9 },
          outBuf: { group: 0, binding: 10 },
          params: { group: 0, binding: 11 },
        },
      }
    );
    this.cs.setTexture('sdfTex', field.sdf);
    this.cs.setTexture('defTex', ops.deformInv);
    this.cs.setTexture('offTex', ops.offset);
    this.cs.setTexture('labTex', field.labels);
    this.cs.setTexture('propTex', derived.props);
    this.cs.setStorageBuffer('outBuf', this.out);
    this.cs.setUniformBuffer('params', this.params);

    this.regionByIndex = new Map(field.regions.map((r) => [r.index, r]));
  }

  private regionByIndex: Map<number, RegionMeta>;

  /** Kept in step with the render material so a click matches what is drawn. */
  clip = { enabled: false, normal: [1, 0, 0] as [number, number, number], offsetMm: 0 };

  async pickRay(origin: Vector3, direction: Vector3): Promise<PickResult> {
    const m = this.field.manifest;
    this.params.updateFloat4('origin', origin.x, origin.y, origin.z, 0);
    this.params.updateFloat4('direction', direction.x, direction.y, direction.z, 0);
    this.params.updateFloat4(
      'cfg0',
      m.grid.halfExtentMm,
      m.sdf.rangeMm,
      m.grid.spacingMm,
      m.grid.dim
    );
    this.params.updateFloat4('cfg1', this.ops.dim, this.ops.active ? 1 : 0, 0.9, 256);
    this.params.updateFloat4('cfg2', m.grid.dim, 128, this.clip.enabled ? 1 : 0, 0);
    this.params.updateFloat4(
      'clip',
      this.clip.normal[0],
      this.clip.normal[1],
      this.clip.normal[2],
      this.clip.offsetMm
    );
    this.params.update();

    let v: Float32Array | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      this.out.update(this.sentinel);
      await this.cs.dispatchWhenReady(1, 1, 1);
      // A recorded-but-unsubmitted dispatch returns untouched buffer contents,
      // which here would read as a confident miss. Same discipline as the other
      // probes: poison, submit two frames, refuse stale data.
      this.scene.render();
      this.scene.render();
      const raw = await this.out.read(0, 48, undefined, true);
      const got = new Float32Array(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      );
      if (!got.some((x) => x === SENTINEL)) {
        v = got;
        break;
      }
    }
    if (!v) throw new Error('picker: dispatch never completed');

    const hit = v[3] > 0.5;
    const labelIndex = Math.round(v[4]);
    return {
      hit,
      position: [v[0], v[1], v[2]],
      material: [v[8], v[9], v[10]],
      distanceMm: v[6],
      displacementMm: v[7],
      labelIndex,
      tissue: Math.round(v[5]),
      region: hit ? (this.regionByIndex.get(labelIndex) ?? null) : null,
    };
  }

  /** Pick through a screen pixel, using Babylon's exact picking ray. */
  async pickScreen(x: number, y: number): Promise<PickResult> {
    const ray = this.scene.createPickingRay(x, y, null, this.scene.activeCamera);
    return this.pickRay(ray.origin, ray.direction);
  }

  dispose(): void {
    this.out.dispose();
    this.params.dispose();
  }
}
