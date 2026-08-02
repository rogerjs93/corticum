//!include common/field.wgsl

// Load-time pass 2 of 3: bake surface normals and mean curvature.
//
// The raymarch previously took a 6-tap central difference per shaded pixel, and
// then a second one at a wider stencil to hide faceting — twelve texture
// fetches for one normal, every frame, for a quantity that never changes. Bake
// it once at 256^3 and the raymarch reads a normal in ONE filtered fetch. That
// is both a large bandwidth saving on a 112 GB/s card and a quality win, since
// hardware filtering of a baked normal is smoother than differencing a filtered
// field.
//
// Curvature comes almost free here (the neighbourhood is already loaded) and is
// worth caching for its own sake: mean curvature drives the translucency term
// that makes thin gyral crowns glow, which is the single cheapest thing that
// makes tissue read as tissue rather than as putty.
//
// Output (rgba8unorm):
//   RGB  unit normal, encoded n*0.5 + 0.5
//   A    mean curvature, encoded and clamped to a useful range
//
// When Phase 3 starts warping the field, this stays the *material-space* normal
// and gets transformed by the inverse-transpose Jacobian of the deformation —
// which is why baking it is compatible with the disease operators rather than
// something that has to be thrown away later.

struct NormalParams {
  // x = dim, y = SDF range mm, z = voxel size mm, w = curvature scale
  cfg: vec4<f32>,
};

@group(0) @binding(0) var fieldSampler: sampler;
@group(0) @binding(1) var field: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params: NormalParams;

fn distAt(c: vec3<i32>, dim: i32, range: f32) -> f32 {
  let cl = clamp(c, vec3<i32>(0, 0, 0), vec3<i32>(dim - 1, dim - 1, dim - 1));
  let uvw = (vec3<f32>(cl) + vec3<f32>(0.5, 0.5, 0.5)) / f32(dim);
  return decodeSdf(textureSampleLevel(field, fieldSampler, uvw, 0.0).r, range);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = i32(params.cfg.x);
  let c = vec3<i32>(gid);
  if (c.x >= dim || c.y >= dim || c.z >= dim) {
    return;
  }

  let range = params.cfg.y;
  let h = params.cfg.z; // voxel size in mm

  let dxp = distAt(c + vec3<i32>(1, 0, 0), dim, range);
  let dxm = distAt(c - vec3<i32>(1, 0, 0), dim, range);
  let dyp = distAt(c + vec3<i32>(0, 1, 0), dim, range);
  let dym = distAt(c - vec3<i32>(0, 1, 0), dim, range);
  let dzp = distAt(c + vec3<i32>(0, 0, 1), dim, range);
  let dzm = distAt(c - vec3<i32>(0, 0, 1), dim, range);
  let d0 = distAt(c, dim, range);

  let grad = vec3<f32>(dxp - dxm, dyp - dym, dzp - dzm) / (2.0 * h);
  let len = length(grad);
  // Far from the surface the field can be flat (clamped at +-range), where the
  // gradient is meaningless. Fall back to +Y rather than emitting NaN.
  var n = vec3<f32>(0.0, 1.0, 0.0);
  if (len > 1e-4) {
    n = grad / len;
  }

  // For a signed distance field |grad| = 1, so the Laplacian equals the
  // divergence of the unit gradient — i.e. twice the mean curvature. Positive
  // in concavities (sulcal fundi), negative on convexities (gyral crowns).
  //
  // Computed on a WIDE stencil, not the adjacent voxels. The field is quantised
  // to 8 bits (0.125 mm steps) and a second derivative amplifies that
  // quantisation as 1/h^2, so the one-voxel Laplacian is dominated by encoding
  // noise — visible as heavy speckle wherever curvature is used directly.
  // Sampling at +-3 voxels cuts that noise ~9x, and real cortical curvature is
  // a millimetre-scale quantity that survives the wider stencil intact.
  let s = 3;
  let hs = h * f32(s);
  let ex = vec3<i32>(s, 0, 0);
  let ey = vec3<i32>(0, s, 0);
  let ez = vec3<i32>(0, 0, s);
  let lap = (
      distAt(c + ex, dim, range) + distAt(c - ex, dim, range)
    + distAt(c + ey, dim, range) + distAt(c - ey, dim, range)
    + distAt(c + ez, dim, range) + distAt(c - ez, dim, range)
    - 6.0 * d0
  ) / (hs * hs);
  let curv = clamp(lap * params.cfg.w, -1.0, 1.0);

  textureStore(dst, c, vec4<f32>(n * 0.5 + vec3<f32>(0.5, 0.5, 0.5), curv * 0.5 + 0.5));
}
