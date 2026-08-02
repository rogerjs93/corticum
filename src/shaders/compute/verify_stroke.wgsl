//!include common/field.wgsl

// Phase 6 gate: does an occlusion produce a deficit shaped like the territory
// it is supposed to starve?
//
// Bins every parenchymal sample four ways:
//   [0] voxels in the occluded territory per the LUT   (ground truth)
//   [1] voxels the perfusion field marks as core
//   [2] the intersection of the two                    (for Dice)
//   [3] core voxels lying OUTSIDE the occluded territory
//
// Plus, indexed from 4 up, per-depth-band counts used to check that good
// collaterals spare the cortical RIM specifically rather than reducing the
// infarct uniformly — a model that just scaled the whole deficit down with
// collateral grade would pass a naive test but be physiologically wrong.

struct VsParams {
  // x = sample dim, y = half extent mm, z = label dim, w = stroke dim
  cfg: vec4<f32>,
  // x = sdf dim, y = sdf range mm, z = core threshold,
  // w = occluded side (-1 left, +1 right, 0 bilateral)
  cfg2: vec4<f32>,
  territoryLut: array<vec4<f32>, 64>,
  occludedLut: array<vec4<f32>, 4>,
};

struct Bins {
  count: array<atomic<u32>, 16>,
};

@group(0) @binding(0) var labSmp: sampler;
@group(0) @binding(1) var labTex: texture_3d<f32>;
@group(0) @binding(2) var strokeSmp: sampler;
@group(0) @binding(3) var strokeTex: texture_3d<f32>;
@group(0) @binding(4) var sdfSmp: sampler;
@group(0) @binding(5) var sdfTex: texture_3d<f32>;
@group(0) @binding(6) var<storage, read_write> bins: Bins;
@group(0) @binding(7) var<uniform> params: VsParams;

fn lane(v: vec4<f32>, i: u32) -> f32 {
  if (i == 1u) { return v.y; }
  if (i == 2u) { return v.z; }
  if (i == 3u) { return v.w; }
  return v.x;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = u32(params.cfg.x);
  if (gid.x >= n || gid.y >= n || gid.z >= n) {
    return;
  }

  let half = params.cfg.y;
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / f32(n);
  let p = uvw * 2.0 * half - vec3<f32>(half, half, half);

  let d = decodeSdf(
    textureSampleLevel(sdfTex, sdfSmp, sdfUvw(p, half, params.cfg2.x), 0.0).r,
    params.cfg2.y
  );
  if (d >= 0.0) {
    return;
  }
  let depthMm = -d;

  let idx = u32(round(
    textureSampleLevel(labTex, labSmp, sdfUvw(p, half, params.cfg.z), 0.0).r * 255.0
  ));
  let terr = u32(round(lane(params.territoryLut[idx >> 2u], idx & 3u)));
  var inTerritory = false;
  if (terr != 0u && terr < 16u) {
    inTerritory = lane(params.occludedLut[terr >> 2u], terr & 3u) > 0.5;
  }
  // The ground truth must be lateralised for the same reason the model is: a
  // territory id is shared between the hemispheres. A side-blind truth cannot
  // tell a correct unilateral infarct from a bilateral one — it scored the
  // bilateral version at Dice 0.948 — so the gate would certify the bug.
  let side = params.cfg2.w;
  let contralateral = side != 0.0 && p.x * side < 0.0;
  let inTerritoryEitherSide = inTerritory;
  if (contralateral) {
    inTerritory = false;
  }

  let sv = textureSampleLevel(strokeTex, strokeSmp, sdfUvw(p, half, params.cfg.w), 0.0);
  let isCore = sv.y > params.cfg2.z;

  // Restrict the shape comparison to tissue that HAS a territory.
  //
  // The ground truth is a parcel-to-artery table, and cerebral white matter is
  // a single label spanning all three cerebral arteries, so it is `none`. But a
  // real MCA infarct plainly involves the white matter underneath the cortex it
  // starves. Scoring core against a cortex-only truth therefore counts correct
  // behaviour as error: the first run reported 54% "spill" that was almost
  // entirely subcortical white matter doing exactly what it should.
  //
  // Comparing over territory-bearing voxels asks the question that is actually
  // falsifiable: does the core cover the right cortex and spare the wrong cortex?
  if (terr == 0u) {
    if (isCore) { atomicAdd(&bins.count[8], 1u); }
    return;
  }

  // Laterality. The MIRROR of the occluded territory — same parcels, other
  // hemisphere — must be almost entirely spared. Without this bin the gate
  // cannot see a bilateral infarct at all: a side-blind truth counts the wrong
  // hemisphere as correctly infarcted and still reports Dice 0.948.
  if (contralateral && inTerritoryEitherSide) {
    atomicAdd(&bins.count[9], 1u);
    if (isCore) { atomicAdd(&bins.count[10], 1u); }
  }

  if (inTerritory) { atomicAdd(&bins.count[0], 1u); }
  if (isCore) { atomicAdd(&bins.count[1], 1u); }
  if (inTerritory && isCore) { atomicAdd(&bins.count[2], 1u); }
  if (isCore && !inTerritory) { atomicAdd(&bins.count[3], 1u); }

  // Rim (within 8 mm of the pial surface) vs deep, restricted to the occluded
  // territory. Good collaterals must spare the RIM preferentially.
  if (inTerritory) {
    if (depthMm < 8.0) {
      atomicAdd(&bins.count[4], 1u);
      if (isCore) { atomicAdd(&bins.count[5], 1u); }
    } else {
      atomicAdd(&bins.count[6], 1u);
      if (isCore) { atomicAdd(&bins.count[7], 1u); }
    }
  }
}
