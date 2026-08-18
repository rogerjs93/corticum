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

  var d = decodeSdf(
    textureSampleLevel(sdfTex, sdfSmp, sdfUvw(mat, half, params.cfg.z), 0.0).r,
    params.cfg.w
  );
  if (params.cfg2.y > 0.5) {
    d = d + textureSampleLevel(offTex, offSmp, sdfUvw(mat, half, params.cfg2.x), 0.0).x;
  }
  outSdf[idx] = d;

  // Synthetic T1: myelin bright, CSF dark, background zero. Same mapping the
  // renderer's modality view uses, and equally NOT a pulse-sequence simulation.
  //
  // PARTIAL VOLUME. This used to be `if (d < 0.0)` — a hard binary cutoff, so a
  // voxel was either full tissue or exactly zero and the boundary was a cliff
  // from 0.465 to 0.000. Measured consequence: FSL bet's deformable surface had
  // no gradient to settle on, relaxed into a smooth envelope, and returned a
  // brain-shaped mask 22% TOO LARGE at Dice 0.8907 — a number that reads as
  // fine. See docs/experiment-0.md.
  //
  // The fix needs no invented parameter. `d` is an exact signed distance in mm,
  // so the fraction of a voxel lying inside the surface is a geometric fact:
  // a voxel of side v centred d from the boundary is covered by
  // clamp(0.5 - d/v, 0, 1). At d = -v/2 it is full, at d = +v/2 empty, at the
  // surface exactly half. That is a real partial-volume ramp one voxel wide,
  // derived rather than tuned — and it is available here precisely because the
  // geometry is generated rather than measured.
  let voxMm = 2.0 * half / params.cfg.x;
  let coverage = clamp(0.5 - d / voxMm, 0.0, 1.0);

  var t1 = 0.0;
  if (coverage > 0.0) {
    // Sampled regardless of sign now: the ramp band sits OUTSIDE the surface,
    // where the props texture filters toward zero — which reads as grey matter
    // (wm = 0), and cortex is grey matter at the pial surface, so the ramp runs
    // GM to background exactly as it should.
    let pr = textureSampleLevel(propTex, propSmp, sdfUvw(mat, half, params.cfg2.z), 0.0);
    let wm = smoothstep(0.15, 0.75, pr.r);
    var tissue = mix(0.45, 0.78, wm);
    tissue = mix(tissue, 0.52, pr.a);
    tissue = mix(tissue, 0.04, pr.b);
    t1 = tissue * coverage;
  }
  outT1[idx] = t1;

  outDisp[idx * 3u] = disp.x;
  outDisp[idx * 3u + 1u] = disp.y;
  outDisp[idx * 3u + 2u] = disp.z;
}
