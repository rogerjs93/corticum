//!include common/field.wgsl

// Sample the composed field onto a regular grid for export.
//
// The point of this pass is GROUND TRUTH. Simul@atrophy exists because
// researchers benchmarking segmentation and registration need synthetic images
// whose true deformation is known rather than estimated. corticum already
// computes that deformation exactly — it is the operator, not an inference —
// so emitting it costs one readback.
//
// Three outputs per voxel:
//   sdf   composed signed distance in mm (negative inside). The unambiguous
//         geometric truth: threshold at 0 for a brain mask.
//   t1    synthetic T1-like intensity, 0..1, for algorithms that expect an
//         image rather than a distance field.
//   disp  the displacement in mm that carries material space to world space.
//         This is what a registration algorithm is trying to recover.

struct ExParams {
  // x = output dim, y = half extent mm, z = sdf dim, w = sdf range mm
  cfg: vec4<f32>,
  // x = op dim, y = op active, z = prop dim, w = label dim
  cfg2: vec4<f32>,
  // x = noise sigma (0 = off), y = seed, z/w reserved
  cfg3: vec4<f32>,
};

@group(0) @binding(0) var sdfSmp: sampler;
@group(0) @binding(1) var sdfTex: texture_3d<f32>;
@group(0) @binding(2) var offSmp: sampler;
@group(0) @binding(3) var offTex: texture_3d<f32>;
@group(0) @binding(4) var invSmp: sampler;
@group(0) @binding(5) var invTex: texture_3d<f32>;
@group(0) @binding(6) var fwdSmp: sampler;
@group(0) @binding(7) var fwdTex: texture_3d<f32>;
@group(0) @binding(8) var propSmp: sampler;
@group(0) @binding(9) var propTex: texture_3d<f32>;
@group(0) @binding(10) var<storage, read_write> outSdf: array<f32>;
@group(0) @binding(11) var<storage, read_write> outT1: array<f32>;
@group(0) @binding(12) var<storage, read_write> outDisp: array<f32>;
@group(0) @binding(13) var<uniform> params: ExParams;

// Deterministic per-voxel hash. Phase 0's gate requires that the same spec
// exported twice produces identical SHA-256 digests, so the noise cannot come
// from a clock or a frame counter — it has to be a pure function of position
// and seed. Same reasoning as the seeded lesion engine: reproducible or useless.
fn hash3(v: vec3<u32>, seed: u32) -> u32 {
  var h = v.x * 0x8da6b343u + v.y * 0xd8163841u + v.z * 0xcb1ab31fu + seed * 0x165667b1u;
  h = h ^ (h >> 15u);
  h = h * 0x2c1b3c6du;
  h = h ^ (h >> 12u);
  h = h * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return h;
}

fn unitFloat(h: u32) -> f32 {
  // Open interval: log(0) in Box-Muller is not recoverable.
  return (f32(h & 0x00ffffffu) + 0.5) / 16777216.0;
}

// Box-Muller: two independent standard normals from two uniforms.
fn gauss2(v: vec3<u32>, seed: u32) -> vec2<f32> {
  let u1 = unitFloat(hash3(v, seed));
  let u2 = unitFloat(hash3(v, seed + 0x9e3779b9u));
  let r = sqrt(-2.0 * log(u1));
  let a = 6.2831853 * u2;
  return vec2<f32>(r * cos(a), r * sin(a));
}

// Soft-edged band: 1 inside [lo, hi], ramping over `soft` at each edge. Used to
// stack head layers without reintroducing the hard boundary that started all
// this.
fn band(x: f32, lo: f32, hi: f32, soft: f32) -> f32 {
  return smoothstep(lo - soft, lo + soft, x) * (1.0 - smoothstep(hi - soft, hi + soft, x));
}

/**
 * Intensity at ONE point in space: tissue, then the head shell outside it.
 *
 * Pulled out of main so it can be SUPERSAMPLED. A voxel is not a point — it is
 * a volume, and its intensity is the average of tissue across that volume. That
 * averaging IS partial volume, and sampling only the voxel centre is precisely
 * what a real scanner does not do.
 *
 * Measured motivation: with noise and an outer-surface ramp in place, FAST found
 * 19.3% of voxels "mixed" against 32.0% in a real brain. One voxel of ramp at
 * the pial surface is not the same as graded boundaries everywhere; interior
 * grey/white edges were still sharper than life. See docs/experiment-0.md.
 */
fn intensityAt(
  ptWorld: vec3<f32>, matPt: vec3<f32>, half: f32, voxMm: f32,
  sdfDim: f32, sdfRange: f32, opDim: f32, opActive: f32, propDim: f32
) -> f32 {
  let dB = decodeSdf(
    textureSampleLevel(sdfTex, sdfSmp, sdfUvw(matPt, half, sdfDim), 0.0).r, sdfRange
  );
  var dd = dB;
  if (opActive > 0.5) {
    dd = dd + textureSampleLevel(offTex, offSmp, sdfUvw(matPt, half, opDim), 0.0).x;
  }

  // Analytic coverage from the exact distance. Kept alongside supersampling
  // rather than replaced by it: the distance field knows the boundary position
  // to far better precision than a handful of sub-samples could resolve.
  let coverage = clamp(0.5 - dd / voxMm, 0.0, 1.0);

  var v = 0.0;
  if (coverage > 0.0) {
    let pr = textureSampleLevel(propTex, propSmp, sdfUvw(matPt, half, propDim), 0.0);
    // The render uses smoothstep(0.15, 0.75) to keep grey/white crisp on
    // screen. That is a LOOK, and it does not belong in a synthetic scan: the
    // props channel is already a continuous tissue membership, so using it
    // directly is the physical reading and leaves the graded boundary intact.
    let wm = clamp(pr.r, 0.0, 1.0);
    var tissue = mix(0.45, 0.78, wm);
    tissue = mix(tissue, 0.52, pr.a);
    tissue = mix(tissue, 0.04, pr.b);
    v = tissue * coverage;
  }

  // Head shell, from the BASE distance: bone does not atrophy, so the vault
  // stays put while the brain shrinks inside it. That gap widening is the sign.
  var shell = 0.0;
  shell = shell + 0.05 * band(dB, 0.0, 2.5,  0.7);
  shell = shell + 0.08 * band(dB, 2.5, 8.5,  0.7);
  shell = shell + 0.80 * band(dB, 8.5, 12.5, 0.7);

  return v + shell * (1.0 - coverage);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = u32(params.cfg.x);
  if (gid.x >= n || gid.y >= n || gid.z >= n) {
    return;
  }
  let idx = gid.x + n * (gid.y + n * gid.z);

  let half = params.cfg.y;
  let p = ((vec3<f32>(gid) + vec3<f32>(0.5)) / f32(n)) * 2.0 * half - vec3<f32>(half);

  // Pull back into material space exactly as the renderer does, so the exported
  // volume is the SAME field that was on screen and not a second construction
  // of it that could drift.
  var mat = p;
  var disp = vec3<f32>(0.0, 0.0, 0.0);
  if (params.cfg2.y > 0.5) {
    let uvwOp = sdfUvw(p, half, params.cfg2.x);
    mat = p + textureSampleLevel(invTex, invSmp, uvwOp, 0.0).xyz;
    // Report the FORWARD displacement, sampled in material space: that is the
    // map a registration algorithm estimates when it warps the healthy image
    // onto the diseased one.
    disp = textureSampleLevel(fwdTex, fwdSmp, sdfUvw(mat, half, params.cfg2.x), 0.0).xyz;
  }

  // Distance to the BASE parenchyma surface, before any disease operator.
  // Kept separately because the skull is built from it: bone does not atrophy.
  let dBase = decodeSdf(
    textureSampleLevel(sdfTex, sdfSmp, sdfUvw(mat, half, params.cfg.z), 0.0).r,
    params.cfg.w
  );
  var d = dBase;
  if (params.cfg2.y > 0.5) {
    d = d + textureSampleLevel(offTex, offSmp, sdfUvw(mat, half, params.cfg2.x), 0.0).x;
  }
  outSdf[idx] = d;

  let voxMm = 2.0 * half / params.cfg.x;

  // 2x2x2 supersample within the voxel. Eight offsets at the quarter points
  // average the tissue actually present in that volume, which is what makes an
  // interior grey/white boundary graded rather than a step.
  var t1 = 0.0;
  let q = voxMm * 0.25;
  for (var sx = 0; sx < 2; sx = sx + 1) {
    for (var sy = 0; sy < 2; sy = sy + 1) {
      for (var sz = 0; sz < 2; sz = sz + 1) {
        let off = vec3<f32>(
          select(-q, q, sx == 1), select(-q, q, sy == 1), select(-q, q, sz == 1)
        );
        t1 = t1 + intensityAt(
          p + off, mat + off, half, voxMm,
          params.cfg.z, params.cfg.w, params.cfg2.x, params.cfg2.y, params.cfg2.z
        );
      }
    }
  }
  t1 = t1 * 0.125;

  // ---- Rician noise ---------------------------------------------------------
  //
  // WHY, measured: FSL FAST converges on a real T1 and COLLAPSES on this image
  // — `MeaNsK variance nan`, all three tissue classes fused into one. Cause,
  // after two wrong guesses: the top two intensities hold 49.9% of brain voxels
  // here against 13.0% in a real brain. Half the image sits on two exact values,
  // and a Gaussian fitted to a delta spike drives its variance to zero.
  //
  // Noise is therefore not decoration. It is what turns two spikes into two
  // distributions and makes the image fittable at all. See docs/experiment-0.md.
  //
  // RICIAN, not Gaussian: an MR magnitude image is the modulus of a complex
  // signal with Gaussian noise in each channel, so noise adds in quadrature.
  // The practical consequence is that background is NOT zero — it is
  // Rayleigh-distributed with a positive mean — which is also why real
  // skull-strippers expect signal outside the head and this image had none.
  let sigma = params.cfg3.x;
  if (sigma > 0.0) {
    let g = gauss2(gid, u32(params.cfg3.y));
    let re = t1 + g.x * sigma;
    let im = g.y * sigma;
    t1 = sqrt(re * re + im * im);
  }

  outT1[idx] = t1;

  outDisp[idx * 3u] = disp.x;
  outDisp[idx * 3u + 1u] = disp.y;
  outDisp[idx * 3u + 2u] = disp.z;
}
