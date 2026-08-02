//!include common/tricubic.wgsl

// Load-time pass 1 of 3: build the working field.
//
// Reads the shipped 208^3 payload and writes a 256^3 working field, smoothing
// the distance with a cubic B-spline on the way. Nothing here is baked into the
// repository — this texture is constructed on the GPU every time the page loads
// from ~2 MB of quantised distances.
//
// Working field channels (rgba8unorm — the only core format that is BOTH
// storage-writable and linearly filterable, which this pass needs to write and
// the raymarch needs to filter):
//   R  signed distance, in the payload's own unorm encoding
//   G  reserved: procedural detail (Phase 2b) and vessels (Phase 6)
//   B  myelin content, 0 = grey matter .. 1 = dense white matter
//   A  tissue class / 15
//
// The distance is copied in its encoded form rather than decoded and
// re-encoded: the encoding is affine, so filtering the encoded value is
// identical to filtering the distance, and skipping the round trip avoids a
// pointless quantisation step.

struct InflateParams {
  // x = source dim, y = destination dim, z = unused, w = unused
  cfg: vec4<f32>,
  // Region index -> tissue class, four indices packed per vec4.
  tissueLut: array<vec4<f32>, 64>,
};

@group(0) @binding(0) var srcSdfSampler: sampler;
@group(0) @binding(1) var srcSdf: texture_3d<f32>;
@group(0) @binding(2) var srcLabSampler: sampler;
@group(0) @binding(3) var srcLab: texture_3d<f32>;
@group(0) @binding(4) var dst: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(5) var<uniform> params: InflateParams;

// Mirrors TISSUE in tools/prep/build_fields.py.
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

  // Both grids cover the same world cube, so a shared normalised coordinate is
  // all the mapping that is needed.
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / f32(dstDim);

  let dEnc = sampleTricubic(srcSdf, srcSdfSampler, uvw, params.cfg.x).r;

  // Region indices must never be filtered — halfway between region 3 and
  // region 7 is not region 5 — so the label texture is NEAREST-sampled.
  let idx = u32(round(textureSampleLevel(srcLab, srcLabSampler, uvw, 0.0).r * 255.0));
  let tissue = tissueAt(idx);

  textureStore(dst, vec3<i32>(gid), vec4<f32>(
    clamp(dEnc, 0.0, 1.0),
    0.0,
    myelinOf(tissue),
    f32(tissue) / 15.0
  ));
}
