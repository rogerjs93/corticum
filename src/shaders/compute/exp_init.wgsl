// Initialise the scaling-and-squaring ladder: u_0 = sign * w / 2^n.
//
// Choosing n so that |w| / 2^n is well under a voxel is what makes the first
// step trivially invertible; every squaring after that preserves invertibility.
// Passing sign = -1 produces the exact inverse deformation from the same
// velocity field, which is the property the raymarch's pull-back depends on.

struct InitParams {
  // x = dim, y = 1 / 2^n, z = sign (+1 forward, -1 inverse), w = unused
  cfg: vec4<f32>,
};

@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var src: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: InitParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = u32(params.cfg.x);
  if (gid.x >= dim || gid.y >= dim || gid.z >= dim) {
    return;
  }
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / f32(dim);
  let w = textureSampleLevel(src, srcSampler, uvw, 0.0).xyz;
  textureStore(dst, vec3<i32>(gid), vec4<f32>(w * params.cfg.y * params.cfg.z, 0.0));
}
