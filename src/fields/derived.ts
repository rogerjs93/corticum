import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { RawTexture3D } from '@babylonjs/core/Materials/Textures/rawTexture3D';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import type { LoadedField } from './loader';

/** Resolution of the baked normal/curvature field. */
export const WORK_DIM = 256;
/** Resolution of the tissue-property field. */
export const PROP_DIM = 128;

export interface DerivedFields {
  /** RGB = normal*0.5+0.5, A = mean curvature*0.5+0.5. Sampled once per hit. */
  normals: RawTexture3D;
  /** R = myelin, G = tissue/15. Sampled once per hit. */
  props: RawTexture3D;
  workDim: number;
  propDim: number;
  voxelMm: number;
  buildMs: number;
  dispose: () => void;
}

function storage3D(scene: Scene, dim: number, name: string): RawTexture3D {
  // rgba8unorm: the only core WebGPU format that is both storage-writable and
  // linearly filterable. r8unorm would halve the memory but is NOT
  // storage-capable in core WebGPU (only under texture-formats-tier1).
  const t = new RawTexture3D(
    null,
    dim,
    dim,
    dim,
    Constants.TEXTUREFORMAT_RGBA,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    Constants.TEXTURE_CREATIONFLAG_STORAGE
  );
  t.name = name;
  t.wrapU = Texture.CLAMP_ADDRESSMODE;
  t.wrapV = Texture.CLAMP_ADDRESSMODE;
  t.wrapR = Texture.CLAMP_ADDRESSMODE;
  return t;
}

/**
 * Build every derived field on the GPU.
 *
 * This is the "generated at load time" claim made concrete: ~2 MB of quantised
 * distances arrive over the wire, and two compute passes turn them into ~134 MB
 * of tricubically smoothed distance, baked normals, curvature and myelin.
 * Nothing else is fetched and nothing is authored.
 */
export async function buildDerived(
  engine: WebGPUEngine,
  scene: Scene,
  field: LoadedField
): Promise<DerivedFields> {
  const t0 = performance.now();

  // Submit recorded GPU work without drawing anything.
  //
  // scene.render() would also flush, but it needs a camera and a ready
  // material - neither of which exists yet, and neither of which this has any
  // business depending on. beginFrame/endFrame opens and closes the command
  // encoder, which is all a compute dispatch needs to actually execute.
  const submit = () => {
    engine.beginFrame();
    engine.endFrame();
  };

  const srcDim = field.manifest.grid.dim;
  const range = field.manifest.sdf.rangeMm;
  const halfMm = field.manifest.grid.halfExtentMm;
  const voxelMm = (2 * halfMm) / WORK_DIM;

  // `work` is a BUILD-TIME TEMPORARY and is disposed before this returns.
  //
  // The first version kept it and marched it, which was a mistake worth
  // recording: it moved every distance fetch from a 9 MB r8unorm texture to a
  // 67 MB rgba8unorm one — 4x the bytes per sample with far worse cache
  // locality — and frame time went from 15 ms to ~1000 ms. A ray takes ~40
  // distance samples and exactly one normal sample, so the *march* must read
  // the compact payload and only the shading may touch the big baked field.
  const work = storage3D(scene, WORK_DIM, 'workField');
  const normals = storage3D(scene, WORK_DIM, 'normalField');
  const props = storage3D(scene, PROP_DIM, 'propsField');

  // ---- pass 1: tricubic inflate + tissue/myelin --------------------------
  const inflateParams = new UniformBuffer(engine, undefined, undefined, 'inflateParams');
  inflateParams.addUniform('cfg', 4);
  inflateParams.addUniform('tissueLut', 4, 64);

  // Region index -> tissue class, packed four per vec4. Sending a LUT beats
  // uploading a second full-resolution tissue volume.
  const lut = new Float32Array(256);
  for (const r of field.regions) {
    if (r.index < 256) lut[r.index] = r.tissue;
  }
  inflateParams.updateFloat4('cfg', srcDim, WORK_DIM, 0, 0);
  inflateParams.updateFloatArray('tissueLut', lut);
  inflateParams.update();

  const inflate = new ComputeShader(
    'inflate',
    engine,
    { computeSource: resolveWgsl('compute/inflate.wgsl') },
    {
      bindingsMapping: {
        // setTexture binds the sampler immediately before the texture index.
        srcSdf: { group: 0, binding: 1 },
        srcLab: { group: 0, binding: 3 },
        dst: { group: 0, binding: 4 },
        params: { group: 0, binding: 5 },
      },
    }
  );
  inflate.setTexture('srcSdf', field.sdf);
  inflate.setTexture('srcLab', field.labels);
  inflate.setStorageTexture('dst', work);
  inflate.setUniformBuffer('params', inflateParams);

  const g = Math.ceil(WORK_DIM / 4);
  await inflate.dispatchWhenReady(g, g, g);
  submit();

  // ---- pass 2: normals + curvature ---------------------------------------
  const normalParams = new UniformBuffer(engine, undefined, undefined, 'normalParams');
  normalParams.addUniform('cfg', 4);
  // Curvature scale: sulcal fundi have radii of a couple of millimetres, so a
  // Laplacian of order 1/mm maps to a useful [-1,1] with this factor. Larger
  // than before because the wide (3-voxel) stencil the curvature now uses
  // returns a correspondingly smaller second difference.
  normalParams.updateFloat4('cfg', WORK_DIM, range, voxelMm, 9.0);
  normalParams.update();

  const normalPass = new ComputeShader(
    'normals',
    engine,
    { computeSource: resolveWgsl('compute/normals.wgsl') },
    {
      bindingsMapping: {
        field: { group: 0, binding: 1 },
        dst: { group: 0, binding: 2 },
        params: { group: 0, binding: 3 },
      },
    }
  );
  normalPass.setTexture('field', work);
  normalPass.setStorageTexture('dst', normals);
  normalPass.setUniformBuffer('params', normalParams);
  await normalPass.dispatchWhenReady(g, g, g);
  submit();

  // ---- pass 3: tissue properties at 128^3 --------------------------------
  const propsParams = new UniformBuffer(engine, undefined, undefined, 'propsParams');
  propsParams.addUniform('cfg', 4);
  propsParams.addUniform('tissueLut', 4, 64);
  propsParams.updateFloat4('cfg', srcDim, PROP_DIM, 0, 0);
  propsParams.updateFloatArray('tissueLut', lut);
  propsParams.update();

  const propsPass = new ComputeShader(
    'props',
    engine,
    { computeSource: resolveWgsl('compute/props.wgsl') },
    {
      bindingsMapping: {
        srcLab: { group: 0, binding: 1 },
        dst: { group: 0, binding: 2 },
        params: { group: 0, binding: 3 },
      },
    }
  );
  propsPass.setTexture('srcLab', field.labels);
  propsPass.setStorageTexture('dst', props);
  propsPass.setUniformBuffer('params', propsParams);
  const pg = Math.ceil(PROP_DIM / 4);
  await propsPass.dispatchWhenReady(pg, pg, pg);
  submit();

  // The 67 MB working field has done its job; hand the memory back.
  work.dispose();
  inflateParams.dispose();

  // No occupancy pass, deliberately.
  //
  // The obvious plan was a min-distance-per-block grid for empty-space
  // skipping. Working the numbers first killed it: the shipped field is
  // clipped at +-16 mm, so sphere tracing already takes ~14 mm steps through
  // air, whereas an 8-voxel block is only 6.5 mm across. A block grid at this
  // scale would make marching *slower*.
  //
  // The version that would actually help is a coarse distance field that is not
  // clipped at 16 mm - e.g. 64^3 over +-104 mm, which gives ~57 mm steps and
  // gzips to a few tens of kilobytes. Worth adding only if measurement says the
  // march (rather than the shading) is the bottleneck; see CLAUDE.md.
  submit();

  return {
    normals,
    props,
    workDim: WORK_DIM,
    propDim: PROP_DIM,
    voxelMm,
    buildMs: performance.now() - t0,
    dispose: () => {
      normals.dispose();
      props.dispose();
      normalParams.dispose();
      propsParams.dispose();
    },
  };
}
