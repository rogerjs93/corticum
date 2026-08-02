// Isotropic 3x3x3 blur of a vector field.
//
// This is not cosmetic smoothing — it is what makes the exponential valid.
//
// exp(w) is guaranteed to be a diffeomorphism only while w is Lipschitz with a
// constant the squaring ladder can absorb: the requirement is roughly
// ||w/2^n|| * L < 0.5. The compliance field contains dural sheets whose
// compliance jumps from 0.02 to 0.45 across about one and a half voxels, and
// multiplying the velocity by that produces a near-discontinuity — an
// effectively infinite L, which no practical n can absorb. The result is a few
// points where the forward and inverse deformations stop being inverses, which
// is exactly what the round-trip gate caught (mean error 0.0004 mm, max
// 10.9 mm: a handful of outliers, not a systematic bias).
//
// Blurring bounds L. It is also physically honest: real tissue boundaries are
// not step functions, and the falx has finite thickness and finite stiffness.

struct BlurParams {
  // x = dim, y = centre weight, z/w unused
  cfg: vec4<f32>,
};

@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var src: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: BlurParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = i32(params.cfg.x);
  let c = vec3<i32>(gid);
  if (c.x >= dim || c.y >= dim || c.z >= dim) {
    return;
  }

  let n = f32(dim);
  var sum = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var wsum = 0.0;

  for (var k = -1; k <= 1; k = k + 1) {
    for (var j = -1; j <= 1; j = j + 1) {
      for (var i = -1; i <= 1; i = i + 1) {
        let o = vec3<i32>(i, j, k);
        let q = clamp(c + o, vec3<i32>(0, 0, 0), vec3<i32>(dim - 1, dim - 1, dim - 1));
        // Binomial-ish weights: 4 for the centre, 2 for face neighbours,
        // 1 otherwise. Cheap approximation to a Gaussian.
        let m = abs(i) + abs(j) + abs(k);
        var w = 1.0;
        if (m == 0) { w = params.cfg.y; }
        else if (m == 1) { w = 2.0; }
        let uvw = (vec3<f32>(q) + vec3<f32>(0.5, 0.5, 0.5)) / n;
        sum = sum + textureSampleLevel(src, srcSampler, uvw, 0.0) * w;
        wsum = wsum + w;
      }
    }
  }

  textureStore(dst, c, sum / wsum);
}
