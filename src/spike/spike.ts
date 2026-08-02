/**
 * Phase 0 de-risking spike.
 *
 * The riskiest part of corticum is not the neuroanatomy — it is whether
 * Babylon's WGSL surface actually does what its docs imply. Eight APIs were
 * flagged as unconfirmed during planning. Each gate below tests exactly one of
 * them and records pass/fail, so a workaround is discovered on day two rather
 * than in week six.
 *
 * Nothing else in the project may be built until these are green.
 */

import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import { RawTexture3D } from '@babylonjs/core/Materials/Textures/rawTexture3D';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh';

// Side-effect import: this is what patches createComputeContext (and friends)
// onto the WebGPU engine prototype. Without it every ComputeShader dispatch
// dies with "engine.createComputeContext is not a function" — and nothing in
// the typings hints at the dependency, because the methods are declared on the
// engine interface regardless of whether the extension was loaded.
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';
import { readCaps } from '../engine/engine';
import { readFrame, captureFrame } from '../verify/frame';

/**
 * Force any recorded-but-unsubmitted GPU work to the queue.
 *
 * Babylon records compute dispatches into the current frame's command encoder
 * and submits at the frame boundary. Outside the render loop there is no such
 * boundary, so a dispatch followed immediately by a readback returns zeros —
 * silently, with no error. Rendering one frame closes the encoder and submits.
 *
 * Phase 1+ does its field builds at load time, before the loop starts, so this
 * is load-bearing rather than a spike-only workaround.
 */
async function submitPendingWork(scene: Scene): Promise<void> {
  scene.render();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export type GateStatus = 'pass' | 'fail' | 'skip';

export interface GateResult {
  id: string;
  what: string;
  status: GateStatus;
  detail: string;
}

const FIELD_DIM = 128;
const HALF_EXTENT = 1.0; // world units; the real field uses 96 mm
const RING_SEGMENTS = 96;

export interface DepthProbeResult {
  nearVisible: number;
  farVisible: number;
  pass: boolean;
  note: string;
}

export interface SpikeOutcome {
  gates: GateResult[];
  scene: Scene;
  frameMs: () => number;
  /** Renders a frame and counts probe pixels — the numeric form of gate S5. */
  verifyDepth: () => Promise<DepthProbeResult>;
  /** Renders a frame and POSTs it to the dev server's screenshot sink. */
  capture: (name: string) => Promise<string>;
}

// Frame readback lives in ../verify/frame.ts — shared with the brain scene.

export async function runSpike(
  engine: WebGPUEngine,
  canvas: HTMLCanvasElement
): Promise<SpikeOutcome> {
  const gates: GateResult[] = [];
  const add = (id: string, what: string, status: GateStatus, detail: string) => {
    gates.push({ id, what, status, detail });
  };

  // ---- S1: engine + compute caps -----------------------------------------
  const caps = readCaps(engine);
  add(
    'S1',
    'WebGPUEngine + compute caps',
    caps.supportComputeShaders ? 'pass' : 'fail',
    `compute=${caps.supportComputeShaders} fragDepth=${caps.fragmentDepthSupported} maxTex=${caps.maxTextureSize} · ${caps.adapterInfo}`
  );

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.043, 0.051, 0.063, 1);

  // Babylon clears depth+stencil BETWEEN rendering groups by default. That
  // silently defeats the entire hybrid design: the raymarch (group 0) writes
  // correct per-fragment depth, then group 1 wipes it and every rasterized
  // mesh draws on top regardless of where it actually sits in the volume.
  // Turning the auto-clear off is what makes raymarch and raster share one
  // depth buffer — the foundation Phase 4's mesh layer is built on.
  for (const group of [1, 2, 3]) {
    scene.setRenderingAutoClearDepthStencil(group, false);
  }

  const camera = new ArcRotateCamera(
    'cam',
    -Math.PI / 2.4,
    Math.PI / 2.6,
    4.2,
    Vector3.Zero(),
    scene
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 1.6;
  camera.upperRadiusLimit = 12;
  camera.wheelDeltaPercentage = 0.02;

  const light = new HemisphericLight('l', new Vector3(0.4, 1, 0.25), scene);
  light.intensity = 0.9;

  // ---- S2: 3D storage texture --------------------------------------------
  // RawTexture3D's 11th argument (creationFlags) exists in the typings; what
  // was unverified is whether TEXTURE_CREATIONFLAG_STORAGE actually yields a
  // bindable texture_storage_3d at runtime.
  let field: RawTexture3D | null = null;
  try {
    field = new RawTexture3D(
      null,
      FIELD_DIM,
      FIELD_DIM,
      FIELD_DIM,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      false, // no mips
      false, // no invertY
      Texture.BILINEAR_SAMPLINGMODE, // linear filtering; TRILINEAR would need mips
      Constants.TEXTURETYPE_UNSIGNED_BYTE, // -> rgba8unorm
      Constants.TEXTURE_CREATIONFLAG_STORAGE
    );
    field.wrapU = Texture.CLAMP_ADDRESSMODE;
    field.wrapV = Texture.CLAMP_ADDRESSMODE;
    field.wrapR = Texture.CLAMP_ADDRESSMODE;
    add(
      'S2',
      '3D storage texture (rgba8unorm)',
      'pass',
      `${FIELD_DIM}³ created, ${((FIELD_DIM ** 3 * 4) / 1e6).toFixed(1)} MB`
    );
  } catch (e) {
    add('S2', '3D storage texture (rgba8unorm)', 'fail', String(e));
  }

  // ---- S3: compute shader writes the 3D storage texture ------------------
  if (field) {
    try {
      const fillParams = new UniformBuffer(engine, undefined, undefined, 'fillParams');
      fillParams.addUniform('dim', 4);
      fillParams.addUniform('blend', 4);
      fillParams.updateFloat4('dim', FIELD_DIM, FIELD_DIM, FIELD_DIM, HALF_EXTENT);
      fillParams.updateFloat4('blend', 0.25, 0, 0, 0);
      fillParams.update();

      const fill = new ComputeShader(
        'spikeFill',
        engine,
        { computeSource: resolveWgsl('compute/spike_fill3d.wgsl') },
        {
          bindingsMapping: {
            dst: { group: 0, binding: 0 },
            params: { group: 0, binding: 1 },
          },
        }
      );
      fill.setStorageTexture('dst', field);
      fill.setUniformBuffer('params', fillParams);

      const groups = Math.ceil(FIELD_DIM / 4);
      await fill.dispatchWhenReady(groups, groups, groups);
      add(
        'S3',
        'ComputeShader -> texture_storage_3d',
        'pass',
        `dispatched ${groups}³ workgroups @ 4³`
      );
    } catch (e) {
      add('S3', 'ComputeShader -> texture_storage_3d', 'fail', String(e));
    }
  } else {
    add('S3', 'ComputeShader -> texture_storage_3d', 'skip', 'S2 failed');
  }

  // ---- S4 + S5: WGSL ShaderMaterial samples it, and writes fragDepth -----
  let volumeMesh: Mesh | null = null;
  if (field) {
    try {
      const mat = new ShaderMaterial(
        'raymarch',
        scene,
        {
          vertexSource: resolveWgsl('render/spike_raymarch.vertex.wgsl'),
          fragmentSource: resolveWgsl('render/spike_raymarch.fragment.wgsl'),
        },
        {
          attributes: ['position'],
          uniformBuffers: ['Scene', 'Mesh'],
          uniforms: ['uCamPos', 'uHalfExtent', 'uStepScale'],
          samplers: ['fieldTex'],
          shaderLanguage: ShaderLanguage.WGSL,
        }
      );
      mat.setTexture('fieldTex', field);
      mat.setFloat('uHalfExtent', HALF_EXTENT);
      mat.setFloat('uStepScale', 0.65);
      // Draw both faces so the march still has a fragment once the camera
      // moves inside the bounding cube.
      mat.backFaceCulling = false;

      volumeMesh = CreateBox('volume', { size: HALF_EXTENT * 2 }, scene);
      volumeMesh.material = mat;
      volumeMesh.renderingGroupId = 0;

      scene.onBeforeRenderObservable.add(() => {
        mat.setVector3('uCamPos', camera.position);
      });

      add('S4', 'WGSL ShaderMaterial samples 3D texture', 'pass', 'material compiled + bound');
      add(
        'S5',
        'fragmentOutputs.fragDepth vs raster',
        'pass',
        'depth written; confirm sphere is half-buried on screen'
      );
    } catch (e) {
      add('S4', 'WGSL ShaderMaterial samples 3D texture', 'fail', String(e));
      add('S5', 'fragmentOutputs.fragDepth vs raster', 'skip', 'S4 failed');
    }
  } else {
    add('S4', 'WGSL ShaderMaterial samples 3D texture', 'skip', 'S2 failed');
    add('S5', 'fragmentOutputs.fragDepth vs raster', 'skip', 'S2 failed');
  }

  // ---- The S5 probes -----------------------------------------------------
  //
  // Two ordinary rasterized spheres, placed on the camera axis and repositioned
  // every frame so the test holds at any orbit angle:
  //
  //   NEAR probe, 0.7 from origin toward the camera. The blob's isosurface is
  //   only ~0.45 out, and the raymarch box's face is at 1.0, so this sphere
  //   sits strictly BETWEEN them. It must be VISIBLE — which is only true if
  //   fragDepth reports the isosurface depth. If the depth buffer instead got
  //   the box's geometry depth (the failure mode), the box face would be
  //   nearer and this probe would vanish.
  //
  //   FAR probe, 0.7 behind the origin. It must be HIDDEN, proving the
  //   raymarch occludes rasterized geometry too.
  //
  // Visible-near AND hidden-far together are only possible with correct
  // per-fragment depth, so this is decisive in both directions — and it is
  // counted in pixels rather than eyeballed.
  const nearProbe = CreateSphere('nearProbe', { diameter: 0.24, segments: 24 }, scene);
  nearProbe.renderingGroupId = 1;
  // Pure yellow and pure magenta: chosen so neither can be confused with the
  // salmon isosurface nor the teal ring under the channel tests below.
  const nearMat = new StandardMaterial('nearMat', scene);
  nearMat.diffuseColor = new Color3(0, 0, 0);
  nearMat.emissiveColor = new Color3(1, 1, 0);
  nearMat.specularColor = new Color3(0, 0, 0);
  nearProbe.material = nearMat;

  const farProbe = CreateSphere('farProbe', { diameter: 0.24, segments: 24 }, scene);
  farProbe.renderingGroupId = 1;
  const farMat = new StandardMaterial('farMat', scene);
  farMat.diffuseColor = new Color3(0, 0, 0);
  farMat.emissiveColor = new Color3(1, 0, 1);
  farMat.specularColor = new Color3(0, 0, 0);
  farProbe.material = farMat;

  scene.onBeforeRenderObservable.add(() => {
    const dir = camera.position.clone().normalize();
    // Offset the two laterally in opposite directions. Placed purely on the
    // view axis they project to the same pixels, so the near one occludes the
    // far one and the far one's "hidden" result proves nothing about the
    // raymarch. Both still land inside the blob's silhouette, so each is
    // genuinely tested against the isosurface.
    const right = Vector3.Cross(Vector3.Up(), dir).normalize();
    nearProbe.position = dir.scale(0.75 * HALF_EXTENT).add(right.scale(0.28 * HALF_EXTENT));
    farProbe.position = dir.scale(-0.55 * HALF_EXTENT).add(right.scale(-0.28 * HALF_EXTENT));
  });

  // ---- S6: compute-filled StorageBuffer bound as a VertexBuffer ----------
  try {
    const vertexCount = RING_SEGMENTS * 6;
    const byteLength = vertexCount * 3 * 4;
    const vertsBuf = new StorageBuffer(
      engine,
      byteLength,
      // READWRITE, not READ. Babylon maps READ -> COPY_SRC only and never adds
      // COPY_DST, so a buffer created with READ alone cannot be cleared or
      // updated — and the resulting validation error poisons the WHOLE frame's
      // command buffer, silently dropping every dispatch recorded alongside it.
      Constants.BUFFER_CREATIONFLAG_STORAGE |
        Constants.BUFFER_CREATIONFLAG_VERTEX |
        Constants.BUFFER_CREATIONFLAG_READWRITE,
      'ringVerts'
    );

    const ringParams = new UniformBuffer(engine, undefined, undefined, 'ringParams');
    ringParams.addUniform('cfg', 4);
    ringParams.updateFloat4('cfg', RING_SEGMENTS, 1.35, 1.62, 0);
    ringParams.update();

    const gen = new ComputeShader(
      'spikeGenVerts',
      engine,
      { computeSource: resolveWgsl('compute/spike_genverts.wgsl') },
      {
        bindingsMapping: {
          verts: { group: 0, binding: 0 },
          params: { group: 0, binding: 1 },
        },
      }
    );
    gen.setStorageBuffer('verts', vertsBuf);
    gen.setUniformBuffer('params', ringParams);
    await gen.dispatchWhenReady(Math.ceil(RING_SEGMENTS / 64));

    const ring = new Mesh('ring', scene);
    const vb = new VertexBuffer(
      engine,
      vertsBuf.getBuffer(),
      VertexBuffer.PositionKind,
      false, // not updatable
      false, // no postponeInternalCreation
      3 // stride in floats
    );
    // totalVertices must be passed explicitly. Babylon normally infers it from
    // the length of the CPU-side data array, which does not exist for a
    // GPU-only DataBuffer — omit it and getTotalVertices() stays 0, the draw
    // is skipped, and the mesh silently renders nothing.
    ring.setVerticesBuffer(vb, false, vertexCount);
    // The compute shader emitted an unindexed triangle list.
    ring.isUnIndexed = true;
    ring.subMeshes = [];
    // Explicit bounds: Babylon cannot derive them from a GPU-only buffer, and
    // a zero-sized bounding box gets the mesh frustum-culled every frame.
    ring.setBoundingInfo(
      new BoundingInfo(new Vector3(-1.7, -1.7, -0.1), new Vector3(1.7, 1.7, 0.1))
    );
    // SubMesh registers itself with the mesh on construction — the instance is
    // intentionally not retained.
    // eslint-disable-next-line no-new
    new SubMesh(0, 0, vertexCount, 0, vertexCount, ring);

    const ringMat = new ShaderMaterial(
      'ringMat',
      scene,
      {
        vertexSource: resolveWgsl('render/spike_ring.vertex.wgsl'),
        fragmentSource: resolveWgsl('render/spike_ring.fragment.wgsl'),
      },
      {
        attributes: ['position'],
        uniformBuffers: ['Scene', 'Mesh'],
        shaderLanguage: ShaderLanguage.WGSL,
      }
    );
    ringMat.backFaceCulling = false;
    ring.material = ringMat;
    ring.renderingGroupId = 1;

    // Don't settle for "no exception thrown" — read the buffer back and check
    // the GPU actually produced the geometry we asked for. Vertex 0 is the
    // inner-radius point at angle 0, i.e. exactly (ri, 0, 0).
    await submitPendingWork(scene);
    const vRaw = await vertsBuf.read(0, 6 * 4, undefined, true);
    const v = new Float32Array(vRaw.buffer, vRaw.byteOffset, 6);
    const okGeom = Math.abs(v[0] - 1.35) < 1e-4 && Math.abs(v[1]) < 1e-4;
    add(
      'S6',
      'StorageBuffer as VertexBuffer',
      okGeom ? 'pass' : 'fail',
      okGeom
        ? `${vertexCount} GPU-built vertices; v0=(${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}) as computed`
        : `readback mismatch: v0=(${v[0]}, ${v[1]}, ${v[2]}), expected (1.35, 0, 0)`
    );
  } catch (e) {
    add('S6', 'StorageBuffer as VertexBuffer', 'fail', String(e));
  }

  // ---- S7: atomicAdd + readback ------------------------------------------
  try {
    const N = 1024;
    // READWRITE is required for any buffer we clear() — see the note on
    // ringVerts above. This is the exact allocate-count-then-read pattern
    // Surface Nets uses in Phase 4, which is why it is worth a gate.
    const counter = new StorageBuffer(
      engine,
      4,
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
      'counter'
    );
    counter.clear();
    const outBuf = new StorageBuffer(
      engine,
      N * 4,
      Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
      'out'
    );

    const atomic = new ComputeShader(
      'spikeAtomic',
      engine,
      { computeSource: resolveWgsl('compute/spike_atomic.wgsl') },
      {
        bindingsMapping: {
          counter: { group: 0, binding: 0 },
          outBuf: { group: 0, binding: 1 },
        },
      }
    );
    atomic.setStorageBuffer('counter', counter);
    atomic.setStorageBuffer('outBuf', outBuf);
    await atomic.dispatchWhenReady(Math.ceil(N / 64));

    // dispatchWhenReady only guarantees the dispatch was *recorded*, not that
    // the command buffer was submitted. Before the render loop starts there is
    // no frame boundary to flush it, so a read here returns zeros. Force a
    // frame first — see submitPendingWork.
    await submitPendingWork(scene);

    // noDelay=true: read back without waiting for the next frame to end.
    const cRaw = await counter.read(0, 4, undefined, true);
    const oRaw = await outBuf.read(0, N * 4, undefined, true);
    const total = new Uint32Array(cRaw.buffer, cRaw.byteOffset, 1)[0];
    const vals = new Uint32Array(oRaw.buffer, oRaw.byteOffset, N);

    let mismatch = -1;
    for (let i = 0; i < N; i++) {
      if (vals[i] !== i * 2 + 1) {
        mismatch = i;
        break;
      }
    }
    const ok = total === N && mismatch === -1;
    add(
      'S7',
      'atomicAdd + StorageBuffer.read(noDelay)',
      ok ? 'pass' : 'fail',
      ok
        ? `counter=${total}, all ${N} values match i*2+1`
        : `counter=${total} (want ${N}), first mismatch at i=${mismatch} (got ${vals[mismatch]})`
    );
  } catch (e) {
    add('S7', 'atomicAdd + StorageBuffer.read(noDelay)', 'fail', String(e));
  }

  // Frame-time tracking for the HUD (rolling median over 30 frames).
  const samples: number[] = [];
  scene.onAfterRenderObservable.add(() => {
    samples.push(engine.getDeltaTime());
    if (samples.length > 30) samples.shift();
  });
  const frameMs = () => {
    if (samples.length === 0) return 0;
    const s = [...samples].sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  const verifyDepth = async (): Promise<DepthProbeResult> => {
    // Hide the ring: it is gate S6's business, and its teal shading would
    // otherwise be counted as probe pixels.
    const ring = scene.getMeshByName('ring');
    const ringWasEnabled = ring?.isEnabled() ?? false;
    ring?.setEnabled(false);

    scene.render();
    const { data, width, height } = await readFrame(engine);

    ring?.setEnabled(ringWasEnabled);

    // The probes are pure-emissive yellow and magenta, so classification is an
    // unambiguous channel test — neither the salmon isosurface nor anything
    // else in the scene can satisfy either predicate.
    let nearVisible = 0;
    let farVisible = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 180 && g > 180 && b < 80) nearVisible++;
      else if (r > 180 && b > 180 && g < 80) farVisible++;
    }

    const total = width * height;
    // The near probe subtends a small but unmistakable area; require enough
    // pixels that a few stray specular highlights cannot pass the test.
    const pass = nearVisible > total * 0.0005 && farVisible === 0;
    const note = pass
      ? `near probe visible (${nearVisible}px) in front of the isosurface, far probe fully occluded — fragDepth correct in both directions`
      : farVisible > 0
        ? `far probe leaked ${farVisible}px: the raymarch is NOT occluding rasterized geometry`
        : `near probe invisible (${nearVisible}px of ${total}): depth is coming from the box geometry, not the isosurface`;

    return { nearVisible, farVisible, pass, note };
  };

  const capture = (name: string): Promise<string> =>
    captureFrame(engine, name, () => scene.render());

  return { gates, scene, frameMs, verifyDepth, capture };
}
