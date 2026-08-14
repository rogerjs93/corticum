//!include common/field.wgsl

// Core and hypoperfusion volumes, for the DEFUSE-3 mismatch readout.
//
// The two numbers that select a patient for thrombectomy are the CORE volume
// and the MISMATCH RATIO, and both are volumes rather than appearances — which
// is why they need integrating rather than rendering. Thresholds follow the
// trial definitions: core at rCBF < 30%, hypoperfusion at Tmax > 6 s, both
// expressed here as thresholds on the same deficit field the renderer draws.
//
// Bins:
//   [0] voxels inside parenchyma
//   [1] core            (rCBF < 30%)
//   [2] hypoperfused    (Tmax > 6 s)
//   [3] penumbra channel above threshold, as a cross-check on [2]-[1]

struct PfParams {
  // x = sample dim, y = half extent mm, z = sdf dim, w = sdf range mm
  cfg: vec4<f32>,
  // x = stroke dim, y = core threshold (rCBF), z = Tmax threshold (deficit)
  cfg2: vec4<f32>,
};

@group(0) @binding(0) var strokeSmp: sampler;
@group(0) @binding(1) var strokeTex: texture_3d<f32>;
@group(0) @binding(2) var sdfSmp: sampler;
@group(0) @binding(3) var sdfTex: texture_3d<f32>;
@group(0) @binding(4) var<storage, read_write> bins: array<atomic<u32>, 8>;
@group(0) @binding(5) var<uniform> params: PfParams;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = u32(params.cfg.x);
  if (gid.x >= n || gid.y >= n || gid.z >= n) {
    return;
  }
  let half = params.cfg.y;
  let p = ((vec3<f32>(gid) + vec3<f32>(0.5)) / f32(n)) * 2.0 * half - vec3<f32>(half);

  let d = decodeSdf(
    textureSampleLevel(sdfTex, sdfSmp, sdfUvw(p, half, params.cfg.z), 0.0).r,
    params.cfg.w
  );
  if (d >= 0.0) {
    return;
  }
  atomicAdd(&bins[0], 1u);

  let sv = textureSampleLevel(strokeTex, strokeSmp, sdfUvw(p, half, params.cfg2.x), 0.0);

  // CORE comes from the model's own core channel, not from a fresh threshold on
  // the deficit.
  //
  // The first version re-derived it as rCBF < 30% of the raw deficit field, and
  // that field is TIME-INDEPENDENT — the operator encodes progression by
  // lowering the core threshold as the hours pass, not by deepening the
  // deficit. So the probe reported byte-identical volumes at 2 h and 24 h while
  // the renderer was plainly drawing a growing infarct. Two definitions of
  // "core" that disagreed, and the gate was measuring the wrong one.
  if (sv.y > params.cfg2.y) {
    atomicAdd(&bins[1], 1u);
  }

  // HYPOPERFUSED (Tmax > 6 s) is a property of the occlusion and the
  // collaterals, so it is correctly time-independent: the territory at risk is
  // fixed at onset, and what changes is how much of it has died. That is
  // exactly why the mismatch shrinks rather than the penumbra moving.
  //
  // Taken as the UNION with core, for two reasons. Clinically, infarcted tissue
  // is hypoperfused by definition, so core must be contained. Numerically, it
  // would not be otherwise: `core` is a SMOOTHSTEP of the deficit, and the
  // trilinear interpolation of a smoothstep is not the smoothstep of the
  // interpolation, so near the boundary the sharp channel crosses 0.5 at points
  // where the smooth one has not yet crossed 0.35. Measured, that put up to
  // 24 mL of core outside the hypoperfused volume and produced a mismatch ratio
  // below 1, which is impossible.
  if (sv.x > params.cfg2.z || sv.y > params.cfg2.y) {
    atomicAdd(&bins[2], 1u);
  }
  if (sv.z > 0.5) {
    atomicAdd(&bins[3], 1u);
  }
  // Diagnostic: core is defined by a STRICTER threshold on the same deficit
  // field than hypoperfusion is, so this must be exactly zero. Anything else
  // means the two are not reading the field the way the operator wrote it.
  if (sv.y > params.cfg2.y && sv.x <= params.cfg2.z) {
    atomicAdd(&bins[4], 1u);
  }
}
