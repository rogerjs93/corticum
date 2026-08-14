// Shared definitions for the parametric disease operators.
//
// Every pathology writes into the same three fields, which is what makes
// comorbidity work without special-casing: a stroke in a Braak-V brain is just
// two sets of contributions summed into the same buffers.
//
//   O  offset   (scalar, mm)  atrophy, cavitation, tumour volume
//   w  velocity (vector)      mass effect, edema, midline shift, herniation
//   P  property (packed)      perfusion, water, blood, gliosis
//
// The offset and the velocity are NOT interchangeable, and the distinction is
// the single most important idea in this file:
//
//   * A warp CONSERVES tissue. It can move material but never remove it.
//     Warping a cortical surface inward drags the white surface with it, which
//     reads as a shrink-wrapped balloon, not atrophy.
//   * Adding a positive scalar to a signed distance field IS erosion by that
//     distance. Both banks of a sulcus retreat, so sulcal widening and
//     ex-vacuo ventricular enlargement fall out for free, and the operation is
//     unconditionally artifact-free: it cannot fold or self-intersect.
//
// So atrophy is an offset, and mass effect — which genuinely IS displacement —
// is a velocity field.

struct MassParams {
  // xyz = lesion centre (mm, world), w = radius (mm)
  centre: vec4<f32>,
  // x = edema extent (mm), y = edema strength, z = necrosis fraction,
  // w = enable (0/1)
  shape: vec4<f32>,
  // x = irregularity 0..1 (0 = sphere), y = target region index (-1 = none),
  // z = density 0..1, w = reserved
  clot: vec4<f32>,
};

/// Exact stationary velocity field of an incompressible growing sphere.
///
/// For w(r) = A/r^2 * r_hat the flow satisfies dr/dt = A/r^2, hence
/// r^3 = r0^3 + 3At. Taking A = R^3/3 and integrating to t = 1 gives
/// r^3 = r0^3 + R^3 — exactly the map that inserts a sphere of radius R while
/// conserving the volume of everything around it.
///
/// That is why this is derived rather than an ad-hoc falloff: volume
/// conservation is a property of the formula, not a parameter to tune.
fn massVelocity(p: vec3<f32>, centre: vec3<f32>, radius: f32) -> vec3<f32> {
  let d = p - centre;
  let r = length(d);
  if (r < 1e-4) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }
  let A = radius * radius * radius / 3.0;

  // Outside the lesion this is A/r^2, the physical incompressible field.
  // Inside, there is no material to transport — the tissue has been replaced —
  // but the grid still has samples there, so the field must be *extended*
  // rather than left to diverge.
  //
  //   mag = A * r / max(r, R)^3
  //
  // For r >= R this is exactly A/r^2; for r < R it decays linearly to zero at
  // the centre. Continuous at r = R, and it caps the magnitude at A/R^2 = R/3
  // instead of the 4R/3 that a naive max(r, R/2) clamp produced.
  //
  // The cap matters: exp() is only guaranteed to be a diffeomorphism while the
  // velocity is Lipschitz with a bound that the number of squarings can
  // absorb. An unbounded spike at the centre breaks that guarantee, and the
  // round-trip error is where it shows up.
  let rc = max(r, radius);
  let mag = A * r / (rc * rc * rc);
  return (d / r) * mag;
}

/// Smooth membership of the lesion body, with a noise-free soft edge.
fn massMembership(p: vec3<f32>, centre: vec3<f32>, radius: f32) -> f32 {
  let r = length(p - centre);
  return 1.0 - smoothstep(radius * 0.75, radius * 1.05, r);
}

/// Cheap value noise, for breaking up shapes that should not look manufactured.
fn opHash3(p: vec3<f32>) -> f32 {
  let q = fract(p * 0.3183099 + vec3<f32>(0.1, 0.2, 0.3));
  let r = q * 17.0;
  return fract(r.x * r.y * r.z * (r.x + r.y + r.z));
}

fn opValueNoise(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let c000 = opHash3(i + vec3<f32>(0.0, 0.0, 0.0));
  let c100 = opHash3(i + vec3<f32>(1.0, 0.0, 0.0));
  let c010 = opHash3(i + vec3<f32>(0.0, 1.0, 0.0));
  let c110 = opHash3(i + vec3<f32>(1.0, 1.0, 0.0));
  let c001 = opHash3(i + vec3<f32>(0.0, 0.0, 1.0));
  let c101 = opHash3(i + vec3<f32>(1.0, 0.0, 1.0));
  let c011 = opHash3(i + vec3<f32>(0.0, 1.0, 1.0));
  let c111 = opHash3(i + vec3<f32>(1.0, 1.0, 1.0));
  let x00 = mix(c000, c100, u.x);
  let x10 = mix(c010, c110, u.x);
  let x01 = mix(c001, c101, u.x);
  let x11 = mix(c011, c111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

/// A haematoma, which is not a sphere.
///
/// Real intracerebral haemorrhage is irregular: blood dissects along white
/// matter and around structures rather than expanding uniformly, and clot
/// shape is one of the things a radiologist reads — an irregular margin
/// predicts expansion. A perfect ball is the one shape it never is.
///
/// Two departures from the sphere, both cheap:
///
///   IRREGULARITY perturbs the effective radius with two octaves of value
///   noise, so the margin is lobulated. `irregularity` 0 recovers the sphere
///   exactly, which keeps the tumour path unchanged.
///
///   REGION AFFINITY lets the clot prefer the anatomy it was placed in. Given
///   a membership in the target structure, blood fills it and only spills
///   beyond with reduced density — which is why a putaminal bleed looks like a
///   putamen and not like a ball that happens to be centred on one.
fn clotMembership(
  p: vec3<f32>,
  centre: vec3<f32>,
  radius: f32,
  irregularity: f32,
  /// 0 = no structure targeted, 1 = confine to the target.
  regionTargeting: f32,
  /// Membership in the target structure at this point, 0..1.
  regionAffinity: f32
) -> f32 {
  let d = p - centre;
  let r = length(d);

  // Perturb in a frame that scales with the clot, so the lobulation looks the
  // same relative to its size rather than getting finer as the bleed grows.
  var wobble = 0.0;
  if (irregularity > 0.001) {
    let q = d / max(radius, 1.0);
    wobble = (opValueNoise(q * 2.3) - 0.5) * 2.0
           + (opValueNoise(q * 5.1) - 0.5) * 0.8;
    wobble = wobble * irregularity * radius * 0.30;
  }
  let effective = max(radius + wobble, radius * 0.25);
  let ball = 1.0 - smoothstep(effective * 0.75, effective * 1.05, r);

  // Outside the target structure the clot THINS rather than stopping dead: a
  // hard edge at a label boundary would be an artefact, not anatomy — real
  // blood does cross boundaries, just with less bulk. Keyed off whether
  // targeting is enabled at all, not off the affinity value, or an untargeted
  // clot would be confined to nothing and vanish.
  // 0.12 outside, not 0.30: at 0.30 the whole ball rendered as a broad faint
  // haze and the structure stopped shaping anything, which is the opposite of
  // the point. The ball is an EXTENT limit; the structure supplies the shape.
  let confine = mix(1.0, 0.12 + 0.88 * regionAffinity, clamp(regionTargeting, 0.0, 1.0));
  return ball * confine;
}
