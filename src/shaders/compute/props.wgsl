// Load-time pass 3: tissue properties at reduced resolution.
//
// Myelin content and tissue class are regional, low-frequency quantities that
// are read exactly once per shaded pixel — nothing like the ~40 distance
// fetches a ray makes. They do not deserve a full-resolution texture, so they
// live at 128^3 (8 MB) rather than riding along in the marching field.
//
//   R  myelin, 0 = grey matter .. 1 = dense white matter
//   G  tissue class / 15 (nearest-valued; for debug and exact tests)
//   B  "ventricle-ness", 0..1
//   A  "deep grey-ness", 0..1 (thalamus, striatum, pallidum, amygdala...)
//
// B and A exist because the x-ray mode needs to integrate emission along a ray,
// and a *class index* cannot be interpolated — halfway between class 1 and
// class 3 is not class 2. Storing continuous memberships instead means linear
// filtering is meaningful and the volumetric integral is smooth.

struct PropsParams {
  // x = source dim, y = destination dim
  cfg: vec4<f32>,
  // Region index -> tissue class, four per vec4.
  tissueLut: array<vec4<f32>, 64>,
};

@group(0) @binding(0) var srcLabSampler: sampler;
@group(0) @binding(1) var srcLab: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params: PropsParams;

const T_CSF: u32 = 1u;
const T_CORTICAL_GM: u32 = 2u;
const T_CEREBRAL_WM: u32 = 3u;
const T_DEEP_GM: u32 = 4u;
const T_CEREBELLAR_GM: u32 = 5u;
const T_CEREBELLAR_WM: u32 = 6u;
const T_BRAINSTEM: u32 = 7u;

fn myelinOf(tissue: u32) -> f32 {
  if (tissue == T_CEREBRAL_WM) { return 1.0; }
  if (tissue == T_CEREBELLAR_WM) { return 0.92; }
  if (tissue == T_BRAINSTEM) { return 0.85; }
  if (tissue == T_DEEP_GM) { return 0.35; }
  if (tissue == T_CEREBELLAR_GM) { return 0.10; }
  if (tissue == T_CORTICAL_GM) { return 0.08; }
  return 0.0;
}

fn tissueAt(idx: u32) -> u32 {
  let v = params.tissueLut[idx >> 2u];
  let lane = idx & 3u;
  var f = v.x;
  if (lane == 1u) { f = v.y; }
  else if (lane == 2u) { f = v.z; }
  else if (lane == 3u) { f = v.w; }
  return u32(round(f));
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dstDim = u32(params.cfg.y);
  if (gid.x >= dstDim || gid.y >= dstDim || gid.z >= dstDim) {
    return;
  }

  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / f32(dstDim);

  // Average myelin over the 2x2x2 source neighbourhood rather than taking a
  // single nearest label. The class itself must not be interpolated, but its
  // *myelin* may be, and a soft grey/white transition is both closer to the
  // real cortical ribbon and less prone to blocky shading seams.
  let srcDim = params.cfg.x;
  let step = 0.5 / srcDim;
  var myelin = 0.0;
  var vent = 0.0;
  var deep = 0.0;
  for (var k = 0; k < 2; k = k + 1) {
    for (var j = 0; j < 2; j = j + 1) {
      for (var i = 0; i < 2; i = i + 1) {
        let o = vec3<f32>(f32(i) - 0.5, f32(j) - 0.5, f32(k) - 0.5) * 2.0 * step;
        let idx = u32(round(textureSampleLevel(srcLab, srcLabSampler, uvw + o, 0.0).r * 255.0));
        let t = tissueAt(idx);
        myelin = myelin + myelinOf(t);
        if (t == T_CSF) { vent = vent + 1.0; }
        if (t == T_DEEP_GM) { deep = deep + 1.0; }
      }
    }
  }
  myelin = myelin / 8.0;
  vent = vent / 8.0;
  deep = deep / 8.0;

  let centre = u32(round(textureSampleLevel(srcLab, srcLabSampler, uvw, 0.0).r * 255.0));

  textureStore(dst, vec3<i32>(gid),
    vec4<f32>(myelin, f32(tissueAt(centre)) / 15.0, vent, deep));
}
