//!include common/field.wgsl

// ASPECTS: bin infarct core into the ten MCA regions.
//
// Bins are pairs — [2*k] total voxels in region k, [2*k + 1] core voxels — so
// the caller reports an involved FRACTION rather than a raw count. A raw count
// would make the big cortical regions dominate the small deep ones, which is
// backwards: the scale weights all ten equally, and losing the caudate costs
// exactly as much as losing a cortical third.
//
// The cortical regions are derived by POSITION, not from named parcels. M1-M6
// are anterior/middle/posterior thirds of the lateral MCA cortex read at two
// axial levels; they are not gyri, and mapping them onto gyri would invent a
// correspondence the scale does not make.

struct AsParams {
  // x = sample dim, y = half extent mm, z = label dim, w = stroke dim
  cfg: vec4<f32>,
  // x = sdf dim, y = sdf range mm, z = core threshold, w = side (-1 L, +1 R)
  cfg2: vec4<f32>,
  // x = ganglionic ceiling mm, y = MCA anterior mm, z = MCA posterior mm
  geom: vec4<f32>,
  // internal-capsule ellipsoid centre (mirrored by side)
  icCentre: vec4<f32>,
  icRadii: vec4<f32>,
  // Region index -> territory id, four per vec4.
  territoryLut: array<vec4<f32>, 64>,
  // Region index -> structure marker (caudate / lentiform / insula / WM).
  structLut: array<vec4<f32>, 64>,
};

struct Bins {
  count: array<atomic<u32>, 32>,
};

@group(0) @binding(0) var labSmp: sampler;
@group(0) @binding(1) var labTex: texture_3d<f32>;
@group(0) @binding(2) var strokeSmp: sampler;
@group(0) @binding(3) var strokeTex: texture_3d<f32>;
@group(0) @binding(4) var sdfSmp: sampler;
@group(0) @binding(5) var sdfTex: texture_3d<f32>;
@group(0) @binding(6) var<storage, read_write> bins: Bins;
@group(0) @binding(7) var<uniform> params: AsParams;

fn lane(v: vec4<f32>, i: u32) -> f32 {
  if (i == 1u) { return v.y; }
  if (i == 2u) { return v.z; }
  if (i == 3u) { return v.w; }
  return v.x;
}

/// Which ASPECTS region a point belongs to, or -1.
fn regionAt(p: vec3<f32>, idx: u32) -> i32 {
  let terr = u32(round(lane(params.territoryLut[idx >> 2u], idx & 3u)));
  let strct = u32(round(lane(params.structLut[idx >> 2u], idx & 3u)));

  // Subcortical structures are named, so they come straight from the label.
  if (strct == 1u) { return 0; }   // caudate
  if (strct == 2u) { return 1; }   // lentiform
  if (strct == 3u) { return 3; }   // insula

  // Internal capsule: no FreeSurfer label exists, so white matter inside an
  // ellipsoid fitted between the lentiform and thalamic centroids stands in.
  if (strct == 4u) {
    // The centre is measured on the LEFT, so mirror by magnitude rather than by
    // multiplying through: `x * sign(side)` flips the already-negative centre
    // into the opposite hemisphere and the ellipsoid then matches nothing.
    let c = vec3<f32>(abs(params.icCentre.x) * params.cfg2.w,
                      params.icCentre.y, params.icCentre.z);
    let d = (p - c) / params.icRadii.xyz;
    if (dot(d, d) <= 1.0) { return 2; }
  }

  // Cortical thirds. Only the two MCA cortical divisions qualify — ACA and PCA
  // territory is not part of the score.
  if (terr == 2u || terr == 3u) {
    let level = select(0, 1, p.y > params.geom.x);   // supraganglionic?
    // Normalised anterior-posterior position within the cortical extent.
    let span = max(params.geom.y - params.geom.z, 1.0);
    let t = clamp((p.z - params.geom.z) / span, 0.0, 0.9999);
    // t = 0 is posterior, 1 is anterior; thirds run anterior -> posterior.
    let third = 2 - i32(floor(t * 3.0));
    return 4 + level * 3 + third;
  }
  return -1;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = u32(params.cfg.x);
  if (gid.x >= n || gid.y >= n || gid.z >= n) {
    return;
  }

  let half = params.cfg.y;
  let p = ((vec3<f32>(gid) + vec3<f32>(0.5)) / f32(n)) * 2.0 * half - vec3<f32>(half);

  // Score only the affected hemisphere: ASPECTS is a one-sided scale.
  if (p.x * params.cfg2.w < 0.0) {
    return;
  }

  let d = decodeSdf(
    textureSampleLevel(sdfTex, sdfSmp, sdfUvw(p, half, params.cfg2.x), 0.0).r,
    params.cfg2.y
  );
  if (d >= 0.0) {
    return;
  }

  let idx = u32(round(
    textureSampleLevel(labTex, labSmp, sdfUvw(p, half, params.cfg.z), 0.0).r * 255.0
  ));
  let region = regionAt(p, idx);
  if (region < 0) {
    return;
  }

  let sv = textureSampleLevel(strokeTex, strokeSmp, sdfUvw(p, half, params.cfg.w), 0.0);
  let k = u32(region);
  atomicAdd(&bins.count[k * 2u], 1u);
  if (sv.y > params.cfg2.z) {
    atomicAdd(&bins.count[k * 2u + 1u], 1u);
  }
}
