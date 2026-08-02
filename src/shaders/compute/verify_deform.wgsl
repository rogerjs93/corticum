//!include common/march.wgsl

// Phase 3 gate: measure the deformation, don't assume it.
//
// The architecture's central numerical claim is that exp(w) and exp(-w) are
// exact inverses — that is the whole reason for storing a velocity field and
// exponentiating it rather than storing a displacement. If that claim is false
// the raymarch's pull-back is wrong and the surface tears, so it is worth
// measuring directly rather than trusting the construction.
//
// Per sample point this reports:
//   x  round-trip error |exp(w)(exp(-w)(p)) - p| in mm
//   y  forward displacement along X (for the midline-shift measurement)
//   z  composed signed distance at p (so the host can test "inside brain")
//   w  lesion membership at p

struct VerifyParams {
  // x = sample grid dim, y = half extent mm, z = op dim, w = sdf dim
  cfg: vec4<f32>,
  // x = SDF range mm
  enc: vec4<f32>,
};

@group(0) @binding(0) var invSampler: sampler;
@group(0) @binding(1) var invTex: texture_3d<f32>;
@group(0) @binding(2) var fwdSampler: sampler;
@group(0) @binding(3) var fwdTex: texture_3d<f32>;
@group(0) @binding(4) var sdfSampler: sampler;
@group(0) @binding(5) var sdfTex: texture_3d<f32>;
@group(0) @binding(6) var offSampler: sampler;
@group(0) @binding(7) var offTex: texture_3d<f32>;
@group(0) @binding(8) var<storage, read_write> outBuf: array<vec4<f32>>;
@group(0) @binding(9) var<uniform> params: VerifyParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = u32(params.cfg.x);
  if (gid.x >= n || gid.y >= n || gid.z >= n) {
    return;
  }

  let half = params.cfg.y;
  let opDim = params.cfg.z;
  let sdfDim = params.cfg.w;

  // Sample interior points only; the boundary is clamped and uninformative.
  let t = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / f32(n);
  let p = (t * 1.7 - vec3<f32>(0.85, 0.85, 0.85)) * 2.0 * half * 0.5;

  // world -> material
  let uInv = textureSampleLevel(invTex, invSampler, sdfUvw(p, half, opDim), 0.0).xyz;
  let X = p + uInv;
  // material -> world
  let uFwd = textureSampleLevel(fwdTex, fwdSampler, sdfUvw(X, half, opDim), 0.0).xyz;
  let back = X + uFwd;

  let err = length(back - p);

  // Forward displacement of the material point that STARTS at p, which is what
  // "how far did this bit of tissue move" means.
  let uFwdAtP = textureSampleLevel(fwdTex, fwdSampler, sdfUvw(p, half, opDim), 0.0).xyz;

  let off = textureSampleLevel(offTex, offSampler, sdfUvw(X, half, opDim), 0.0);
  let base = decodeSdf(
    textureSampleLevel(sdfTex, sdfSampler, sdfUvw(X, half, sdfDim), 0.0).r,
    params.enc.x
  );

  let idx = gid.z * n * n + gid.y * n + gid.x;
  outBuf[idx] = vec4<f32>(err, uFwdAtP.x, base + off.x, off.y);
}
