//!include common/sdf.wgsl
//!include common/encode.wgsl

// Gate S3: does a Babylon ComputeShader actually write into a 3D storage
// texture? Writes an analytic two-sphere smooth-union SDF so gate S4 has
// something with a recognisable silhouette to sphere-trace, and so the Node
// golden test has a closed-form reference to compare against.

struct FillParams {
  // xyz = texture dimensions in voxels, w = world half-extent
  dim: vec4<f32>,
  // x = smooth-union blend radius (fraction of half-extent), yzw unused
  blend: vec4<f32>,
};

@group(0) @binding(0) var dst: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> params: FillParams;

// Shared with tests/node/compute_golden.mjs — keep the two in step.
fn spikeField(p: vec3<f32>, half: f32, blend: f32) -> f32 {
  let a = sdSphere(p, vec3<f32>(-0.30 * half, 0.0, 0.0), 0.46 * half);
  let b = sdSphere(p, vec3<f32>(0.30 * half, 0.12 * half, 0.0), 0.36 * half);
  return opSmoothUnion(a, b, blend * half);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = vec3<i32>(params.dim.xyz);
  let c = vec3<i32>(gid);
  if (c.x >= dim.x || c.y >= dim.y || c.z >= dim.z) {
    return;
  }

  let half = params.dim.w;
  // Voxel centre -> world position in [-half, +half].
  let uvw = (vec3<f32>(c) + vec3<f32>(0.5, 0.5, 0.5)) / vec3<f32>(dim);
  let p = (uvw * 2.0 - vec3<f32>(1.0, 1.0, 1.0)) * half;

  let d = spikeField(p, half, params.blend.x);
  textureStore(dst, c, vec4<f32>(encodeDistance(d, half), 0.0, 0.0, 1.0));
}
