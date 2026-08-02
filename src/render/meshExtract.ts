import { Constants } from '@babylonjs/core/Engines/constants';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { ComputeShader } from '@babylonjs/core/Compute/computeShader';
import { StorageBuffer } from '@babylonjs/core/Buffers/storageBuffer';
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { SubMesh } from '@babylonjs/core/Meshes/subMesh';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo';
import { Vector3 } from '@babylonjs/core/Maths/math';
import type { Scene } from '@babylonjs/core/scene';
import type { RawTexture3D } from '@babylonjs/core/Materials/Textures/rawTexture3D';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader';

import { resolveWgsl } from '../engine/wgsl';

const MAX_VERTS = 260000;
const MAX_INDICES = 1500000;

export interface ExtractedMesh {
  mesh: Mesh;
  vertexCount: number;
  indexCount: number;
  triangleCount: number;
  extractMs: number;
  /** Intermediate counts, for diagnosing which pass produced nothing. */
  diag: Record<string, unknown>;
  extract: (isoMm?: number) => Promise<void>;
  dispose: () => void;
}

/**
 * Extract an isosurface from a 3D field with Surface Nets, entirely on the GPU.
 *
 * Extraction happens in MATERIAL space and the vertex shader applies the
 * forward deformation. That is what keeps the mesh and the raymarch consistent
 * by construction rather than by discipline — and it means changing only the
 * deformation (which is what most disease parameters do) requires no
 * re-extraction at all: the vertices simply move.
 */
export async function extractIsosurface(
  engine: WebGPUEngine,
  scene: Scene,
  name: string,
  field: RawTexture3D,
  fieldDim: number,
  halfExtentMm: number,
  rangeMm: number
): Promise<ExtractedMesh> {
  const cellDim = fieldDim;

  const counters = new StorageBuffer(
    engine,
    8,
    Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
    `${name}Counters`
  );
  const cellSlot = new StorageBuffer(
    engine,
    cellDim ** 3 * 4,
    Constants.BUFFER_CREATIONFLAG_STORAGE | Constants.BUFFER_CREATIONFLAG_READWRITE,
    `${name}CellSlot`
  );
  const vertsBuf = new StorageBuffer(
    engine,
    MAX_VERTS * 6 * 4,
    Constants.BUFFER_CREATIONFLAG_STORAGE |
      Constants.BUFFER_CREATIONFLAG_VERTEX |
      Constants.BUFFER_CREATIONFLAG_READWRITE,
    `${name}Verts`
  );
  const idxBuf = new StorageBuffer(
    engine,
    MAX_INDICES * 4,
    Constants.BUFFER_CREATIONFLAG_STORAGE |
      Constants.BUFFER_CREATIONFLAG_INDEX |
      Constants.BUFFER_CREATIONFLAG_READWRITE,
    `${name}Indices`
  );

  const zeroCounters = new Uint32Array(2);

  const params = new UniformBuffer(engine, undefined, undefined, `${name}SnParams`);
  params.addUniform('cfg', 4);
  params.addUniform('limits', 4);

  // Each pass gets exactly the bindings its module declares. Binding a resource
  // the compiled shader stripped leaves the bind group out of step with the
  // pipeline layout and the dispatch silently does nothing.
  const classifyBindings = {
    field: { group: 0, binding: 1 },
    counters: { group: 0, binding: 2 },
    cellSlot: { group: 0, binding: 3 },
    params: { group: 0, binding: 6 },
  };
  const emitBindings = {
    ...classifyBindings,
    verts: { group: 0, binding: 4 },
    indices: { group: 0, binding: 5 },
  };

  // Two separate modules, each with its own `main`. Babylon's `entryPoint`
  // option did not reliably select the second function of a shared module: the
  // emit pass silently ran the classify code, which surfaced only as counts
  // that were exactly double the expected value.
  const mkPass = (file: string, bindingsMapping: Record<string, { group: number; binding: number }>) => {
    const cs = new ComputeShader(
      `${name}_${file}`,
      engine,
      { computeSource: resolveWgsl(`compute/${file}.wgsl`) },
      { bindingsMapping }
    );
    cs.setTexture('field', field);
    cs.setStorageBuffer('counters', counters);
    cs.setStorageBuffer('cellSlot', cellSlot);
    if (bindingsMapping.verts) {
      cs.setStorageBuffer('verts', vertsBuf);
      cs.setStorageBuffer('indices', idxBuf);
    }
    cs.setUniformBuffer('params', params);
    return cs;
  };
  const classifyPass = mkPass('sn_classify', classifyBindings);
  const emitPass = mkPass('sn_emit', emitBindings);

  const mesh = new Mesh(name, scene);
  mesh.isUnIndexed = false;
  // Babylon cannot derive bounds from a GPU-only buffer, and a zero-sized box
  // gets the mesh frustum-culled every frame.
  mesh.setBoundingInfo(
    new BoundingInfo(
      new Vector3(-halfExtentMm, -halfExtentMm, -halfExtentMm),
      new Vector3(halfExtentMm, halfExtentMm, halfExtentMm)
    )
  );
  mesh.alwaysSelectAsActiveMesh = true;

  const result: ExtractedMesh = {
    mesh,
    vertexCount: 0,
    indexCount: 0,
    triangleCount: 0,
    extractMs: 0,
    diag: {},
    extract: async (isoMm = 0) => {
      const t0 = performance.now();
      result.diag = { isoMm, cellDim, fieldDim, halfExtentMm, rangeMm };
      // Explicit zero upload rather than StorageBuffer.clear(). clear() is
      // recorded as a GPU command whose ordering against a subsequent dispatch
      // is not something the caller controls, and it raced: every cell's
      // atomicAdd returned 0, so all vertices landed in slot 0 and the mesh was
      // degenerate while the index count looked plausible. A queue writeBuffer
      // is ordered before the commands that follow it.
      counters.update(zeroCounters);
      params.updateFloat4('cfg', cellDim, fieldDim, halfExtentMm, rangeMm);
      params.updateFloat4('limits', MAX_VERTS, MAX_INDICES, isoMm, 0);
      params.update();

      const g = Math.ceil(cellDim / 4);
      await classifyPass.dispatchWhenReady(g, g, g);
      engine.beginFrame();
      engine.endFrame();

      // Read the vertex count BEFORE emit runs: emit depends on cellSlot, so if
      // classify produced nothing there is no point going further, and knowing
      // which of the two passes failed is most of the diagnosis.
      const rawC = await counters.read(0, 8, undefined, true);
      result.diag.afterClassify = Array.from(
        new Uint32Array(rawC.buffer, rawC.byteOffset, 2)
      );

      await emitPass.dispatchWhenReady(g, g, g);
      engine.beginFrame();
      engine.endFrame();

      // Read the counters back so the draw call knows how much to draw.
      // Extraction is triggered by a parameter change rather than per frame, so
      // one frame of latency here is invisible; the alternative (drawIndirect
      // for meshes) is not exposed by Babylon.
      const raw = await counters.read(0, 8, undefined, true);
      const c = new Uint32Array(raw.buffer, raw.byteOffset, 2);
      result.vertexCount = Math.min(c[0], MAX_VERTS);
      result.indexCount = Math.min(c[1], MAX_INDICES);
      result.triangleCount = Math.floor(result.indexCount / 3);

      if (result.vertexCount === 0 || result.indexCount === 0) {
        mesh.subMeshes = [];
        result.extractMs = performance.now() - t0;
        return;
      }

      // totalVertices must be passed explicitly: Babylon normally infers it
      // from a CPU-side array, which does not exist for a GPU-only buffer.
      const vb = new VertexBuffer(
        engine,
        vertsBuf.getBuffer(),
        VertexBuffer.PositionKind,
        false,
        false,
        6,
        false,
        0,
        3
      );
      const nb = new VertexBuffer(
        engine,
        vertsBuf.getBuffer(),
        VertexBuffer.NormalKind,
        false,
        false,
        6,
        false,
        3,
        3
      );
      mesh.setVerticesBuffer(vb, false, result.vertexCount);
      mesh.setVerticesBuffer(nb, false, result.vertexCount);
      mesh.geometry?.setIndexBuffer(
        idxBuf.getBuffer(),
        result.vertexCount,
        result.indexCount,
        true
      );

      mesh.subMeshes = [];
      // SubMesh registers itself with the mesh on construction.
      // eslint-disable-next-line no-new
      new SubMesh(0, 0, result.vertexCount, 0, result.indexCount, mesh);

      result.extractMs = performance.now() - t0;
    },
    dispose: () => {
      counters.dispose();
      cellSlot.dispose();
      vertsBuf.dispose();
      idxBuf.dispose();
      params.dispose();
      mesh.dispose();
    },
  };

  return result;
}
