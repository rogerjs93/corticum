//!include common/field.wgsl

// Ischemic stroke: perfusion deficit, core and penumbra.
//
// Output (rgba8unorm, sampled once per shaded pixel — never per march step):
//   R  perfusion deficit 0..1  (1 = no flow)
//   G  infarct core
//   B  penumbra (hypoperfused but still salvageable)
//   A  chronic cavitation weight
//
// The two ideas worth reading the code for:
//
// WHITE MATTER HAS NO TERRITORY OF ITS OWN. `cerebral WM` is one label covering
// tissue supplied by all three cerebral arteries, so assigning it to any single
// artery would be wrong. Instead every voxel takes a SMOOTHED membership from
// its neighbourhood. Cortex gets a crisp value; subcortical white matter
// inherits from the cortex above it; and deep white matter — far from any
// cortical ribbon — ends up with weak membership from several territories at
// once, which is precisely the internal borderzone. Watershed infarcts are
// therefore derived, not drawn.
//
// COLLATERALS ARRIVE FROM OUTSIDE AND WORK INWARD. Leptomeningeal collaterals
// cross from adjacent territories over the pial surface, so rescue is strongest
// near the territory boundary and near the surface, and decays with depth.
// That is why good collaterals spare the cortical rim while the lenticulostriate
// territory — deep, and with no collateral supply at all — infarcts anyway.

struct StrokeParams {
  // x = dim, y = half extent mm, z = label dim, w = sdf dim
  cfg: vec4<f32>,
  // x = enabled, y = collateral grade 0..3, z = hours since onset, w = SDF range
  clin: vec4<f32>,
  // x = core threshold, y = penumbra threshold, z = recanalisation hour,
  // w = side (-1 left, +1 right, 0 bilateral)
  thr: vec4<f32>,
  // Region index -> territory id, four per vec4.
  territoryLut: array<vec4<f32>, 64>,
  // Territory id -> occlusion severity, four per vec4 (16 territories).
  occludedLut: array<vec4<f32>, 4>,
  // Territory id -> side (-1 left, +1 right, 0 both). Per-territory rather than
  // one global side because a real patient can have lesions in both
  // hemispheres in DIFFERENT territories, and the stroke_qeeg cohort does.
  sideLut: array<vec4<f32>, 4>,
};

@group(0) @binding(0) var labSampler: sampler;
@group(0) @binding(1) var labTex: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params: StrokeParams;
@group(0) @binding(5) var sdfSampler: sampler;
@group(0) @binding(6) var sdfTex: texture_3d<f32>;

fn lane(v: vec4<f32>, i: u32) -> f32 {
  if (i == 1u) { return v.y; }
  if (i == 2u) { return v.z; }
  if (i == 3u) { return v.w; }
  return v.x;
}

fn territoryOfIndex(idx: u32) -> u32 {
  return u32(round(lane(params.territoryLut[idx >> 2u], idx & 3u)));
}

fn occlusionOf(terr: u32) -> f32 {
  if (terr == 0u || terr >= 16u) {
    return 0.0;
  }
  return lane(params.occludedLut[terr >> 2u], terr & 3u);
}

// A territory id carries no side, so laterality is a spatial test at the
// midline. The two hemispheres have separate arterial supply and a real infarct
// genuinely stops there, so the transition is deliberately narrow.
fn sideGate(terr: u32, xmm: f32) -> f32 {
  if (terr == 0u || terr >= 16u) {
    return 0.0;
  }
  let s = lane(params.sideLut[terr >> 2u], terr & 3u);
  if (s == 0.0) {
    return 1.0;
  }
  return smoothstep(-1.0, 1.0, xmm * s);
}

fn labelAt(uvw: vec3<f32>) -> u32 {
  return u32(round(textureSampleLevel(labTex, labSampler, uvw, 0.0).r * 255.0));
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = u32(params.cfg.x);
  if (gid.x >= dim || gid.y >= dim || gid.z >= dim) {
    return;
  }
  let c = vec3<i32>(gid);

  if (params.clin.x < 0.5) {
    textureStore(dst, c, vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }

  let half = params.cfg.y;
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / f32(dim);

  // Two neighbourhood shells. The fine one resolves cortex crisply; the coarse
  // one is what lets deep white matter, tens of millimetres from any ribbon,
  // still learn which arteries surround it.
  var occluded = 0.0;
  var territoried = 0.0;
  let xmm = (f32(gid.x) + 0.5) / f32(dim) * 2.0 * half - half;
  let scales = array<f32, 2>(4.0, 11.0);
  for (var s = 0; s < 2; s = s + 1) {
    let step = scales[s] / (2.0 * half);
    let w = select(1.0, 0.55, s == 1);
    for (var k = -1; k <= 1; k = k + 1) {
      for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
          let o = vec3<f32>(f32(i), f32(j), f32(k)) * step;
          let t = territoryOfIndex(labelAt(clamp(uvw + o, vec3<f32>(0.0), vec3<f32>(1.0))));
          if (t != 0u) {
            territoried = territoried + w;
            // The side test uses THIS voxel's x, not the sample's: the question
            // is which hemisphere the voxel being written belongs to.
            occluded = occluded + occlusionOf(t) * sideGate(t, xmm) * w;
          }
        }
      }
    }
  }

  // Fraction of the surrounding *vascularised* tissue that is downstream of the
  // occlusion. Normalising by territoried rather than by the sample count is
  // what stops ventricles and background from diluting the estimate.
  var membership = 0.0;
  if (territoried > 0.5) {
    membership = clamp(occluded / territoried, 0.0, 1.0);
  }

  // Laterality was applied per-territory during accumulation above, so
  // membership is already sided.

  // Distance inward from the pial surface, used for the collateral gradient.
  let d = decodeSdf(
    textureSampleLevel(sdfTex, sdfSampler, uvw, 0.0).r, params.clin.w
  );
  if (d >= 0.0) {
    textureStore(dst, c, vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }
  let depthMm = -d;

  // Leptomeningeal rescue: strongest at the boundary (where membership is
  // partial) and near the surface, decaying inward over ~14 mm.
  let grade = clamp(params.clin.y / 3.0, 0.0, 1.0);
  let boundary = 1.0 - membership;
  let pial = exp(-depthMm / 14.0);
  // The base term must be strong enough that excellent collaterals actually
  // rescue the rim rather than merely dent it: at grade 3, superficial cortex
  // deep inside the territory should fall below the core threshold. The
  // boundary term then adds further rescue near territory borders, where
  // leptomeningeal supply from the neighbouring artery is richest.
  let rescue = clamp(grade * (0.62 + 0.38 * boundary) * pial, 0.0, 0.96);

  var deficit = clamp(membership * (1.0 - rescue), 0.0, 1.0);

  // Time. The core grows into the penumbra, faster with poor collaterals — the
  // fast-progressor / slow-progressor distinction. Recanalisation halts it.
  let hours = params.clin.z;
  let effectiveHours = min(hours, params.thr.z);
  let growth = clamp(effectiveHours / (3.0 + 9.0 * grade), 0.0, 1.0);

  let coreThr = mix(params.thr.x, params.thr.y, growth);
  let core = smoothstep(coreThr - 0.08, coreThr + 0.08, deficit);
  let hypo = smoothstep(params.thr.y - 0.08, params.thr.y + 0.08, deficit);
  let penumbra = clamp(hypo - core, 0.0, 1.0);

  // Chronic: after roughly three weeks the core cavitates and retracts.
  let chronic = core * smoothstep(340.0, 700.0, hours);

  textureStore(dst, c, vec4<f32>(deficit, core, penumbra, chronic));
}
