//!include common/march.wgsl

// Phase 5 gate: measure regional volumes from the COMPOSED field.
//
// Braak staging makes a quantitative claim �?" hippocampal volume loss of roughly
// 20-25% in established Alzheimer's �?" and the only way to know whether the
// operator stack reproduces it is to integrate the deformed anatomy and count.
// Rendering a picture that "looks atrophied" proves nothing.
//
// One atomic bin per region index. A dispatch over the sample grid adds one
// count to a region's bin for every point that is inside the composed surface
// and carries that region's label, so the readback is 1 KB regardless of how
// dense the sampling is.

struct VolParams {
  // x = sample grid dim, y = half extent mm, z = op dim, w = sdf dim
  cfg0: vec4<f32>,
  // x = range mm, y = op active, z = label dim, w = step scale
  cfg1: vec4<f32>,
};

struct Bins {
  count: array<atomic<u32>, 256>,
};

@group(0) @binding(0) var sdfSmp: sampler;
@group(0) @binding(1) var sdfTex: texture_3d<f32>;
@group(0) @binding(2) var defSmp: sampler;
@group(0) @binding(3) var defTex: texture_3d<f32>;
@group(0) @binding(4) var offSmp: sampler;
@group(0) @binding(5) var offTex: texture_3d<f32>;
@group(0) @binding(6) var labSmp: sampler;
@group(0) @binding(7) var labTex: texture_3d<f32>;
@group(0) @binding(8) var<storage, read_write> bins: Bins;
@group(0) @binding(9) var<uniform> params: VolParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = u32(params.cfg0.x);
  if (gid.x >= n || gid.y >= n || gid.z >= n) {
    return;
  }

  var cfg: MarchCfg;
  cfg.halfExtent = params.cfg0.y;
  cfg.rangeMm = params.cfg1.x;
  cfg.voxelMm = 1.0;
  cfg.sdfDim = params.cfg0.w;
  cfg.opDim = params.cfg0.z;
  cfg.opActive = params.cfg1.y;
  cfg.stepScale = params.cfg1.w;
  cfg.maxSteps = 1.0;
  // Volumetry always measures the WHOLE brain: a cutaway is a viewing aid, not
  // a change to the anatomy, and letting it shrink the measured volume would
  // make the gate depend on the camera.
  cfg.clipNormal = vec3<f32>(0.0, 1.0, 0.0);
  cfg.clipOffset = 0.0;
  cfg.clipEnabled = 0.0;
  cfg.extraOffsetMm = 0.0;
  cfg.startT = 0.0;

  let half = cfg.halfExtent;
  let t = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / f32(n);
  let p = t * 2.0 * half - vec3<f32>(half, half, half);

  let d = composedDist(sdfTex, sdfSmp, defTex, defSmp, offTex, offSmp, p, cfg);
  if (d >= 0.0) {
    return;
  }

  // Label in MATERIAL space: the question is which region this tissue belongs
  // to, not which region currently occupies the place it has been pushed to.
  let X = marchToMaterial(defTex, defSmp, p, cfg);
  let idx = u32(round(
    textureSampleLevel(labTex, labSmp, sdfUvw(X, half, params.cfg1.z), 0.0).r * 255.0
  ));
  atomicAdd(&bins.count[idx], 1u);
}
