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
