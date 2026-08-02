// One squaring step of the scaling-and-squaring exponential.
//
// A displacement field that is merely "small enough not to fold, probably" is
// not good enough: the raymarch pulls back through the inverse, so a
// non-invertible warp shows up as the surface tearing. Instead of storing a
// displacement and hoping, we store a stationary VELOCITY field w and take its
// exponential — the exponential of a smooth velocity field is always a
// diffeomorphism, so invertibility is guaranteed by construction rather than by
// clamping.
//
// The construction (as in ANTs SyN and SPM DARTEL):
//
//     phi_0(x)   = x + w(x) / 2^n          (small enough to be trivially valid)
//     phi_{k+1}  = phi_k o phi_k           (squaring, n times)
//
// In displacement form u(x) = phi(x) - x, one squaring is:
//
//     u_{k+1}(x) = u_k(x) + u_k(x + u_k(x))
//
// The exact inverse is free: run the identical passes on -w.
//
// This shader performs a single squaring; the host dispatches it n times,
// ping-ponging between two textures.

struct SqParams {
  // x = dim, y = half extent mm, z = unused, w = unused
  cfg: vec4<f32>,
};

@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var src: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: SqParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = u32(params.cfg.x);
  if (gid.x >= dim || gid.y >= dim || gid.z >= dim) {
    return;
  }

  let half = params.cfg.y;
  let n = f32(dim);
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / n;
  let p = uvw * 2.0 * half - vec3<f32>(half, half, half);

  let u = textureSampleLevel(src, srcSampler, uvw, 0.0).xyz;

  // Sample the field again at the displaced position. Clamped addressing means
  // a displacement that leaves the cube reads the boundary value, which is the
  // correct behaviour here: the deformation is zero far from any lesion.
  let q = p + u;
  let quvw = (q + vec3<f32>(half, half, half)) / (2.0 * half);
  let u2 = textureSampleLevel(src, srcSampler, clamp(quvw, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0).xyz;

  textureStore(dst, vec3<i32>(gid), vec4<f32>(u + u2, 0.0));
}
