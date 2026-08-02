//!include common/march.wgsl

// GPU picking for the raymarched cortex.
//
// A single thread marches exactly one ray �?" the one under the cursor �?" using
// the SHARED march from common/march.wgsl, so the answer cannot disagree with
// what is on screen. Reading a region back from a colour buffer or from a
// separate CPU-side approximation of the geometry would both be able to drift;
// this cannot.
//
// The ray is supplied by the host (Babylon's createPickingRay) rather than
// reconstructed from an inverse view-projection here: fewer matrices to get
// wrong, and the host already has an exact one.
//
// Output buffer:
//   [0] = (hit.x, hit.y, hit.z, hitFlag)
//   [1] = (labelIndex, tissueClass, distanceAlongRay, materialOffsetMm)
//   [2] = (material.x, material.y, material.z, 0)

struct PickParams {
  origin: vec4<f32>,
  direction: vec4<f32>,
  // x = halfExtent, y = rangeMm, z = voxelMm, w = sdfDim
  cfg0: vec4<f32>,
  // x = opDim, y = opActive, z = stepScale, w = maxSteps
  cfg1: vec4<f32>,
  // x = labelDim, y = propDim, z = clip enabled
  cfg2: vec4<f32>,
  // xyz = clip plane normal, w = offset
  clip: vec4<f32>,
};

@group(0) @binding(0) var sdfSmp: sampler;
@group(0) @binding(1) var sdfTex: texture_3d<f32>;
@group(0) @binding(2) var defSmp: sampler;
@group(0) @binding(3) var defTex: texture_3d<f32>;
@group(0) @binding(4) var offSmp: sampler;
@group(0) @binding(5) var offTex: texture_3d<f32>;
@group(0) @binding(6) var labSmp: sampler;
@group(0) @binding(7) var labTex: texture_3d<f32>;
@group(0) @binding(8) var propSmp: sampler;
@group(0) @binding(9) var propTex: texture_3d<f32>;
@group(0) @binding(10) var<storage, read_write> outBuf: array<vec4<f32>>;
@group(0) @binding(11) var<uniform> params: PickParams;

@compute @workgroup_size(1)
fn main() {
  var cfg: MarchCfg;
  cfg.halfExtent = params.cfg0.x;
  cfg.rangeMm = params.cfg0.y;
  cfg.voxelMm = params.cfg0.z;
  cfg.sdfDim = params.cfg0.w;
  cfg.opDim = params.cfg1.x;
  cfg.opActive = params.cfg1.y;
  cfg.stepScale = params.cfg1.z;
  cfg.maxSteps = params.cfg1.w;
  // Picking honours the cutaway too: clicking a cross-section should name the
  // tissue you can actually see, not something hidden behind the plane.
  cfg.clipNormal = normalize(params.clip.xyz);
  cfg.clipOffset = params.clip.w;
  cfg.clipEnabled = params.cfg2.z;
  // The lens is a screen-space viewing aid; picking asks what the anatomy IS,
  // so it interrogates the undisturbed field.
  cfg.extraOffsetMm = 0.0;
  cfg.startT = 0.0;

  let ro = params.origin.xyz;
  let rd = normalize(params.direction.xyz);

  let h = marchComposed(sdfTex, sdfSmp, defTex, defSmp, offTex, offSmp, ro, rd, cfg);

  if (!h.hit) {
    outBuf[0] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    outBuf[1] = vec4<f32>(-1.0, -1.0, 0.0, 0.0);
    outBuf[2] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    return;
  }

  // Labels are sampled in MATERIAL space. Sampling at the world position would
  // name whatever region happens to sit where the tissue moved TO, rather than
  // the region the tissue actually is.
  //
  // And they are sampled just INSIDE the surface, not on it. The hit sits
  // exactly on the parenchyma boundary, where the nearest label voxel is as
  // likely to be background as tissue �?" picking on the raw hit reports
  // "Unknown" most of the time. Stepping a little way along the ray (which is
  // heading into the tissue at a front-facing hit) asks the question the user
  // actually meant: what is this bit of cortex?
  var labIdx = 0.0;
  var probe = h.material;
  for (var s: i32 = 0; s < 4; s = s + 1) {
    probe = h.material + rd * (1.0 + 1.2 * f32(s));
    let uv = sdfUvw(probe, cfg.halfExtent, params.cfg2.x);
    let v = round(textureSampleLevel(labTex, labSmp, uv, 0.0).r * 255.0);
    if (v > 0.5) {
      labIdx = v;
      break;
    }
  }

  let puv = sdfUvw(probe, cfg.halfExtent, params.cfg2.y);
  let tissue = round(textureSampleLevel(propTex, propSmp, puv, 0.0).g * 15.0);

  outBuf[0] = vec4<f32>(h.pos, 1.0);
  outBuf[1] = vec4<f32>(labIdx, tissue, h.t, length(h.material - h.pos));
  // Report the point the label was actually read at, so the Python check
  // interrogates the same coordinate rather than the bare surface hit.
  outBuf[2] = vec4<f32>(probe, 0.0);
}
