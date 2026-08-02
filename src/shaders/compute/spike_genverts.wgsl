// Gate S6: a compute shader fills a StorageBuffer that is then bound directly
// as a VertexBuffer and rasterized — no CPU round-trip.
//
// This is the path Phase 4's Surface Nets extractor uses to hand GPU-built
// geometry to Babylon. Here it emits a flat ring band (two triangles per
// segment) so a failure is obvious on screen rather than subtle.

struct RingParams {
  // x = segment count, y = inner radius, z = outer radius, w = z offset
  cfg: vec4<f32>,
};

@group(0) @binding(0) var<storage, read_write> verts: array<f32>;
@group(0) @binding(1) var<uniform> params: RingParams;

const TAU: f32 = 6.28318530718;

fn ringPoint(seg: f32, segs: f32, radius: f32, z: f32) -> vec3<f32> {
  let a = TAU * seg / segs;
  return vec3<f32>(cos(a) * radius, sin(a) * radius, z);
}

fn writeVert(slot: u32, p: vec3<f32>) {
  verts[slot * 3u + 0u] = p.x;
  verts[slot * 3u + 1u] = p.y;
  verts[slot * 3u + 2u] = p.z;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let segs = u32(params.cfg.x);
  if (i >= segs) {
    return;
  }

  let n = params.cfg.x;
  let ri = params.cfg.y;
  let ro = params.cfg.z;
  let z = params.cfg.w;

  let a0 = f32(i);
  let a1 = f32(i) + 1.0;

  let i0 = ringPoint(a0, n, ri, z);
  let o0 = ringPoint(a0, n, ro, z);
  let i1 = ringPoint(a1, n, ri, z);
  let o1 = ringPoint(a1, n, ro, z);

  // Six vertices (two triangles) per segment.
  let base = i * 6u;
  writeVert(base + 0u, i0);
  writeVert(base + 1u, o0);
  writeVert(base + 2u, o1);
  writeVert(base + 3u, i0);
  writeVert(base + 4u, o1);
  writeVert(base + 5u, i1);
}
