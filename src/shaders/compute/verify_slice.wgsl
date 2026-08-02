// Phase 1 verification: sample the uploaded SDF exactly as the raymarch does,
// on a regular grid, and hand the results back for comparison against the
// source NIfTI in Python.
//
// Sampling through a compute shader rather than screenshotting a camera slice
// is deliberate: it exercises the real upload -> texture -> sampler -> decode
// path with no camera, viewport, aspect-ratio or tone-mapping confounds in the
// way. A picture of "something brain-shaped" would not catch a flipped axis.
// Dice against ground truth does.

//!include common/field.wgsl

struct SliceParams {
  // x = axis (0=X, 1=Y, 2=Z), y = slice position in mm,
  // z = grid resolution, w = world half-extent in mm
  cfg: vec4<f32>,
  // x = SDF range in mm, y = texture dimension
  enc: vec4<f32>,
};

@group(0) @binding(0) var sdfTexSampler: sampler;
@group(0) @binding(1) var sdfTex: texture_3d<f32>;
@group(0) @binding(2) var<storage, read_write> outBuf: array<f32>;
@group(0) @binding(3) var<uniform> params: SliceParams;

fn sampleSdf(p: vec3<f32>, half: f32, dim: f32, range: f32) -> f32 {
  let u = textureSampleLevel(sdfTex, sdfTexSampler, sdfUvw(p, half, dim), 0.0).r;
  return decodeSdf(u, range);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = u32(params.cfg.z);
  if (gid.x >= res || gid.y >= res) {
    return;
  }

  let half = params.cfg.w;
  let axis = i32(params.cfg.x + 0.5);
  let pos = params.cfg.y;

  // Grid points land on integer millimetres, matching the source voxel centres
  // exactly, so any disagreement is a real error rather than a sampling offset.
  let a = f32(gid.x) - half;
  let b = f32(gid.y) - half;

  var p: vec3<f32>;
  if (axis == 0) {
    p = vec3<f32>(pos, a, b);
  } else if (axis == 1) {
    p = vec3<f32>(a, pos, b);
  } else {
    p = vec3<f32>(a, b, pos);
  }

  outBuf[gid.y * res + gid.x] = sampleSdf(p, half, params.enc.y, params.enc.x);
}
