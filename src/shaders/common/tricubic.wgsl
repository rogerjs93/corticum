// Cubic B-spline sampling of a 3D texture in 8 trilinear fetches.
//
// Why this exists: trilinear filtering gives a C0 field whose gradient is
// piecewise constant within each cell. Sphere-tracing that and taking central
// differences produces visibly faceted normals — the voxel staircase across the
// gyri. A cubic B-spline is C2, so both the surface and its normal are smooth.
//
// The naive implementation costs 64 point fetches per sample. The trick (Sigg &
// Hadwiger, GPU Gems 2) is that along each axis the four cubic weights can be
// folded into TWO linear-filtered fetches at carefully offset positions, so the
// hardware's own interpolator does half the work: 2^3 = 8 fetches total.
//
// Note this is *approximating*, not interpolating: a B-spline does not pass
// through the sample values, it smooths them slightly. For a distance field
// that is exactly what we want — it is the smoothing that removes the
// staircase. Use Catmull-Rom instead if you ever need the samples preserved.

struct BsplineAxis {
  h0: f32,
  h1: f32,
  g0: f32,
};

fn bsplineAxis(coord: f32) -> BsplineAxis {
  let index = floor(coord);
  let f = coord - index;
  let o = 1.0 - f;

  let w0 = (1.0 / 6.0) * o * o * o;
  let w1 = (2.0 / 3.0) - 0.5 * f * f * (2.0 - f);
  let w2 = (2.0 / 3.0) - 0.5 * o * o * (2.0 - o);
  let w3 = (1.0 / 6.0) * f * f * f;

  let g0 = w0 + w1;
  let g1 = w2 + w3;

  var out: BsplineAxis;
  out.g0 = g0;
  out.h0 = (w1 / g0) - 0.5 + index;
  out.h1 = (w3 / g1) + 1.5 + index;
  return out;
}

/// `uvw` is a normalised texture coordinate; `dim` the texture size in texels.
fn sampleTricubic(
  tex: texture_3d<f32>,
  smp: sampler,
  uvw: vec3<f32>,
  dim: f32,
) -> vec4<f32> {
  let coord = uvw * dim - vec3<f32>(0.5, 0.5, 0.5);

  let ax = bsplineAxis(coord.x);
  let ay = bsplineAxis(coord.y);
  let az = bsplineAxis(coord.z);

  let inv = 1.0 / dim;
  let x0 = ax.h0 * inv;
  let x1 = ax.h1 * inv;
  let y0 = ay.h0 * inv;
  let y1 = ay.h1 * inv;
  let z0 = az.h0 * inv;
  let z1 = az.h1 * inv;

  let s000 = textureSampleLevel(tex, smp, vec3<f32>(x0, y0, z0), 0.0);
  let s100 = textureSampleLevel(tex, smp, vec3<f32>(x1, y0, z0), 0.0);
  let s010 = textureSampleLevel(tex, smp, vec3<f32>(x0, y1, z0), 0.0);
  let s110 = textureSampleLevel(tex, smp, vec3<f32>(x1, y1, z0), 0.0);
  let s001 = textureSampleLevel(tex, smp, vec3<f32>(x0, y0, z1), 0.0);
  let s101 = textureSampleLevel(tex, smp, vec3<f32>(x1, y0, z1), 0.0);
  let s011 = textureSampleLevel(tex, smp, vec3<f32>(x0, y1, z1), 0.0);
  let s111 = textureSampleLevel(tex, smp, vec3<f32>(x1, y1, z1), 0.0);

  let a00 = mix(s100, s000, ax.g0);
  let a10 = mix(s110, s010, ax.g0);
  let a01 = mix(s101, s001, ax.g0);
  let a11 = mix(s111, s011, ax.g0);

  let b0 = mix(a10, a00, ay.g0);
  let b1 = mix(a11, a01, ay.g0);

  return mix(b1, b0, az.g0);
}
