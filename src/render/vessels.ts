import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import { Vector3 } from '@babylonjs/core/Maths/math';
import type { Scene } from '@babylonjs/core/scene';
import type { RawTexture3D } from '@babylonjs/core/Materials/Textures/rawTexture3D';

import { resolveWgsl } from '../engine/wgsl';
import type { VesselTree } from '../fields/vessels/graph';
import { occlusionById } from '../disease/territories';

const SIDES = 5;

export interface VesselMesh {
  mesh: Mesh;
  material: ShaderMaterial;
  segmentCount: number;
  triangleCount: number;
  /** Mark the branches downstream of an occlusion so they can be drawn dark. */
  setOcclusion: (siteId: string | null, side?: 'left' | 'right') => void;
  dispose: () => void;
}

/**
 * Build tube geometry for the arterial tree.
 *
 * A pentagonal prism per segment rather than a line: lines cannot be lit, and
 * an unlit tree over a shaded brain reads as an overlay rather than as
 * something inside the head. Five sides is enough at these radii — the vessels
 * are 0.2–2.6 mm across and never fill more than a few pixels.
 *
 * Occlusion state rides in a vertex attribute rather than a uniform, because
 * "downstream of the occlusion" is a per-branch property and pushing it per
 * vertex avoids either a second draw call or a per-fragment tree walk.
 */
export function buildVesselMesh(
  scene: Scene,
  tree: VesselTree,
  deformFwd: RawTexture3D,
  halfExtentMm: number,
  opDim: number
): VesselMesh {
  const segs = tree.nodes.filter((n) => n.parent >= 0);
  const vertexCount = segs.length * SIDES * 2;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  // uv.x carries the segment's trunk index so the shader can dim occluded
  // branches; uv.y carries radius for a subtle shading cue.
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(segs.length * SIDES * 6);

  const up = new Vector3();
  const side = new Vector3();
  const axis = new Vector3();

  let vi = 0;
  let ii = 0;
  for (const n of segs) {
    const p = tree.nodes[n.parent];
    axis.set(n.x - p.x, n.y - p.y, n.z - p.z);
    const len = axis.length();
    if (len < 1e-5) continue;
    axis.scaleInPlace(1 / len);

    // Any vector not parallel to the axis works as a reference.
    const ref = Math.abs(axis.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    Vector3.CrossToRef(ref, axis, side);
    side.normalize();
    Vector3.CrossToRef(axis, side, up);
    up.normalize();

    const r0 = Math.max(p.radius, 0.12);
    const r1 = Math.max(n.radius, 0.12);
    const base = vi;

    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      const cx = Math.cos(a);
      const cy = Math.sin(a);
      const nx = side.x * cx + up.x * cy;
      const ny = side.y * cx + up.y * cy;
      const nz = side.z * cx + up.z * cy;

      positions[vi * 3] = p.x + nx * r0;
      positions[vi * 3 + 1] = p.y + ny * r0;
      positions[vi * 3 + 2] = p.z + nz * r0;
      normals[vi * 3] = nx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = nz;
      uvs[vi * 2] = n.root;
      uvs[vi * 2 + 1] = r0;
      vi++;

      positions[vi * 3] = n.x + nx * r1;
      positions[vi * 3 + 1] = n.y + ny * r1;
      positions[vi * 3 + 2] = n.z + nz * r1;
      normals[vi * 3] = nx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = nz;
      uvs[vi * 2] = n.root;
      uvs[vi * 2 + 1] = r1;
      vi++;
    }

    for (let s = 0; s < SIDES; s++) {
      const a0 = base + s * 2;
      const b0 = base + ((s + 1) % SIDES) * 2;
      indices[ii++] = a0;
      indices[ii++] = a0 + 1;
      indices[ii++] = b0;
      indices[ii++] = b0;
      indices[ii++] = a0 + 1;
      indices[ii++] = b0 + 1;
    }
  }

  const mesh = new Mesh('vessels', scene);
  const vd = new VertexData();
  vd.positions = positions.subarray(0, vi * 3) as unknown as number[];
  vd.normals = normals.subarray(0, vi * 3) as unknown as number[];
  vd.uvs = uvs.subarray(0, vi * 2) as unknown as number[];
  vd.indices = indices.subarray(0, ii) as unknown as number[];
  vd.applyToMesh(mesh);

  const material = new ShaderMaterial(
    'vessels',
    scene,
    {
      vertexSource: resolveWgsl('render/vessels.vertex.wgsl'),
      fragmentSource: resolveWgsl('render/vessels.fragment.wgsl'),
    },
    {
      attributes: ['position', 'normal', 'uv'],
      uniformBuffers: ['Scene', 'Mesh'],
      uniforms: [
        'uHalfExtent',
        'uOpDim',
        'uOpActive',
        'uCamPos',
        'uOccludedTrunks',
      ],
      samplers: ['fwdTex'],
      shaderLanguage: ShaderLanguage.WGSL,
    }
  );
  material.setTexture('fwdTex', deformFwd);
  material.setFloat('uHalfExtent', halfExtentMm);
  material.setFloat('uOpDim', opDim);
  material.setFloat('uOpActive', 0);
  mesh.material = material;
  mesh.renderingGroupId = 1;

  // Trunk index -> occluded flag, four per vec4 (up to 64 trunks).
  const occ = new Float32Array(64);
  const pushOcc = () => material.setArray4('uOccludedTrunks', Array.from(occ));
  pushOcc();

  const setOcclusion = (siteId: string | null, occludedSide: 'left' | 'right' = 'left') => {
    occ.fill(0);
    const site = siteId ? occlusionById(siteId) : undefined;
    if (site) {
      const hit = new Set(site.affects.map((a) => a.territory));
      // Territory alone is not enough: the left and right MCA share one id, so
      // matching on territory darkened both trees for a unilateral occlusion.
      // A trunk's side is the sign of its root's world X (X = Right).
      const want = occludedSide === 'right' ? 1 : -1;
      tree.trunks.forEach((t, i) => {
        if (i >= 64 || !hit.has(t.territory)) return;
        const root = tree.nodes[tree.rootNodes[i]];
        const midline = Math.abs(root.x) < 1;
        if (site.bilateral || midline || Math.sign(root.x) === want) occ[i] = 1;
      });
    }
    pushOcc();
  };

  return {
    mesh,
    material,
    segmentCount: segs.length,
    triangleCount: ii / 3,
    setOcclusion,
    dispose: () => {
      mesh.dispose();
      material.dispose();
    },
  };
}
