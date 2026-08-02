//!include common/operators.wgsl

// Accumulate every pathology's contribution to the stationary velocity field,
// then modulate by compliance.
//
// The compliance multiply is what turns a generic radial push into anatomy:
// the same lesion produces ventricular collapse, then midline shift, then
// subfalcine herniation, purely because the medium resists differently in
// different places.
//
// Output is rgba16float (xyz = velocity in mm, w unused). Half float rather
// than a unorm encoding because scaling-and-squaring composes this field six
// times, and quantisation error roughly doubles per composition — 8-bit
// displacements would accumulate several millimetres of error, which is larger
// than the effect being measured.

struct VelParams {
  // x = dim, y = half extent mm, z = unused, w = unused
  cfg: vec4<f32>,
  mass: MassParams,
};

@group(0) @binding(0) var compSampler: sampler;
@group(0) @binding(1) var compTex: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: VelParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = u32(params.cfg.x);
  if (gid.x >= dim || gid.y >= dim || gid.z >= dim) {
    return;
  }

  let half = params.cfg.y;
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / f32(dim);
  let p = uvw * 2.0 * half - vec3<f32>(half, half, half);

  var w = vec3<f32>(0.0, 0.0, 0.0);

  if (params.mass.shape.w > 0.5) {
    w = w + massVelocity(p, params.mass.centre.xyz, params.mass.centre.w);
  }

  let compliance = textureSampleLevel(compTex, compSampler, uvw, 0.0).r;
  w = w * compliance;

  textureStore(dst, vec3<i32>(gid), vec4<f32>(w, 0.0));
}
