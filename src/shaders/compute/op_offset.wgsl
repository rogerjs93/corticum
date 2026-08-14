//!include common/operators.wgsl
//!include common/field.wgsl

// Accumulate every pathology's contribution to the offset field.
//
// Adding a positive scalar to a signed distance field IS erosion by that
// distance: the isosurface retreats along its own normal everywhere at once.
// That is why atrophy belongs here and not in the warp — both banks of a
// sulcus retreat, so sulcal widening emerges rather than being modelled, and
// the operation cannot fold or self-intersect no matter how large it gets.
//
// A negative offset dilates instead, which is how a tumour mass claims space.
//
// Output rgba16float, all four channels consumed by the raymarch's single
// per-step fetch of this field:
//   x  offset in mm
//   y  lesion membership
//   z  vasogenic edema
//   w  reserved (blood, Phase 3b)

struct OffsetParams {
  // x = dim, y = half extent mm, z = global atrophy mm, w = label texture dim
  cfg: vec4<f32>,
  mass: MassParams,
  // x = MS enabled, y = lesion load, z = periventricular bias, w = finger aspect
  ms: vec4<f32>,
  // x = ventricle texture dim, y = ventricle SDF range mm
  vent: vec4<f32>,
  // Per-region atrophy in mm, four region indices per vec4.
  //
  // All the staging logic lives on the CPU (see disease/braak.ts) and arrives
  // here as a flat lookup. That keeps the citable neuroanatomy readable and
  // reviewable in TypeScript, and leaves the shader doing one texture fetch and
  // one array index — which is also what makes comorbidity free, since several
  // diseases just sum into the same table.
  atrophyLut: array<vec4<f32>, 64>,
};

@group(0) @binding(0) var propSampler: sampler;
@group(0) @binding(1) var propTex: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: OffsetParams;
@group(0) @binding(5) var labSampler: sampler;
@group(0) @binding(6) var labTex: texture_3d<f32>;
@group(0) @binding(7) var ventSampler: sampler;
@group(0) @binding(8) var ventTex: texture_3d<f32>;

fn atrophyAt(idx: u32) -> f32 {
  let v = params.atrophyLut[idx >> 2u];
  let lane = idx & 3u;
  if (lane == 1u) { return v.y; }
  if (lane == 2u) { return v.z; }
  if (lane == 3u) { return v.w; }
  return v.x;
}

fn ventDistAt(uvw: vec3<f32>) -> f32 {
  return decodeSdf(textureSampleLevel(ventTex, ventSampler, uvw, 0.0).r, params.vent.y);
}

fn hash31(p: vec3<f32>) -> f32 {
  var h = dot(p, vec3<f32>(127.1, 311.7, 74.7));
  h = sin(h) * 43758.5453;
  return fract(h);
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    hash31(p + vec3<f32>(0.0, 0.0, 0.0)),
    hash31(p + vec3<f32>(11.3, 5.7, 3.1)),
    hash31(p + vec3<f32>(21.7, 17.3, 9.9))
  );
}

/// Multiple-sclerosis plaque field.
///
/// Two features make this read as MS rather than as generic white spots:
///
///  * Lesions are PERIVENTRICULAR — seeded in a band a few millimetres out from
///    the ventricular surface, in white matter, sparing cortex.
///  * They are elongated along the medullary veins, which run radially outward
///    from the ventricular wall. The vein direction is exactly the gradient of
///    the ventricular distance field, so orienting each ellipsoid along
///    normalize(grad(SDF_ventricle)) produces Dawson's fingers as a CONSEQUENCE
///    of the anatomy rather than as a drawn-in effect.
fn msLesions(p: vec3<f32>, uvw: vec3<f32>, myelin: f32) -> f32 {
  if (params.ms.x < 0.5) {
    return 0.0;
  }

  let dVent = ventDistAt(uvw);
  // Periventricular band: just outside the ependymal surface.
  let band = smoothstep(0.5, 2.5, dVent) * (1.0 - smoothstep(6.0, 14.0, dVent));
  let wm = smoothstep(0.35, 0.8, myelin);
  let eligible = mix(band * 0.35 + 0.15, band, params.ms.z) * wm;
  if (eligible < 0.02) {
    return 0.0;
  }

  // Medullary-vein direction: the gradient of the ventricular distance field.
  // Offset in normalised texture units corresponding to h millimetres.
  let h = 2.0;
  let e = vec3<f32>(h / (2.0 * params.cfg.y), 0.0, 0.0);
  let gx = ventDistAt(uvw + e.xyy) - ventDistAt(uvw - e.xyy);
  let gy = ventDistAt(uvw + e.yxy) - ventDistAt(uvw - e.yxy);
  let gz = ventDistAt(uvw + e.yyx) - ventDistAt(uvw - e.yyx);
  var axis = vec3<f32>(gx, gy, gz);
  if (length(axis) < 1e-5) {
    axis = vec3<f32>(0.0, 1.0, 0.0);
  } else {
    axis = normalize(axis);
  }

  // Seed lesion centres on a coarse jittered lattice so the pattern is
  // deterministic (no frame-to-frame shimmer) but not visibly regular.
  let cell = 11.0;
  let base = floor(p / cell);
  var acc = 0.0;
  for (var k = -1; k <= 1; k = k + 1) {
    for (var j = -1; j <= 1; j = j + 1) {
      for (var i = -1; i <= 1; i = i + 1) {
        let c = base + vec3<f32>(f32(i), f32(j), f32(k));
        let r = hash33(c);
        // Lesion load thins the population out rather than shrinking every
        // plaque, which is how lesion burden actually varies between patients.
        if (r.x > params.ms.y * 0.55 + 0.12) {
          continue;
        }
        let centre = (c + vec3<f32>(0.15) + r * 0.7) * cell;
        let d = p - centre;
        // Squash across the vein axis: an ellipsoid `aspect` times longer along
        // it than across.
        let along = dot(d, axis);
        let across = d - axis * along;
        let radius = 2.0 + r.y * 2.6;
        let q = length(vec2<f32>(length(across) / radius, along / (radius * params.ms.w)));
        acc = max(acc, 1.0 - smoothstep(0.55, 1.0, q));
      }
    }
  }

  return clamp(acc * eligible, 0.0, 1.0);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = u32(params.cfg.x);
  if (gid.x >= dim || gid.y >= dim || gid.z >= dim) {
    return;
  }

  let half = params.cfg.y;
  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5, 0.5, 0.5)) / f32(dim);
  let p = uvw * 2.0 * half - vec3<f32>(half, half, half);

  var offset = 0.0;
  var lesion = 0.0;
  var edema = 0.0;

  // Uniform thinning, independent of any staging.
  offset = offset + params.cfg.z;

  // Region-weighted atrophy. Erosion of a distance field is unconditionally
  // artifact-free, so a per-region offset produces sulcal widening and ex-vacuo
  // ventricular enlargement without any of them being modelled separately.
  let labIdx = u32(round(
    textureSampleLevel(labTex, labSampler, uvw, 0.0).r * 255.0
  ));
  offset = offset + atrophyAt(labIdx);

  let myelin = textureSampleLevel(propTex, propSampler, uvw, 0.0).r;
  let plaque = msLesions(p, uvw, myelin);

  if (params.mass.shape.w > 0.5) {
    let centre = params.mass.centre.xyz;
    let radius = params.mass.centre.w;

    // Region affinity: 1 inside the targeted structure, 0 outside. Sampled
    // with the SAME label fetch the atrophy lookup already did, so targeting a
    // structure costs no extra texture read.
    //
    // Nearest-value comparison, not interpolation — a region index is a class,
    // and "halfway between putamen and thalamus" is not a structure. The
    // softening that keeps the clot margin from looking cut out comes from the
    // noise and the spill factor, not from blurring the label.
    // Region affinity as a SOFT membership from eight taps, not a single
    // lookup.
    //
    // The label texture is sampled with linear filtering, and a region index is
    // a class — interpolating it produces values that belong to no structure
    // (gotcha #18). A single `labIdx == target` test therefore only succeeds
    // deep inside the structure, and for something as small as the putamen at
    // the operator's 1.6 mm grid that interior is a handful of cells: the clot
    // came out as a faint haze instead of a dense mass.
    //
    // Counting matches over a half-voxel neighbourhood recovers a graded 0..1
    // membership that survives both the filtering and the resolution gap.
    let targetIdx = params.mass.clot.y;
    var affinity = 0.0;
    var targeting = 0.0;
    if (targetIdx >= 0.0) {
      targeting = 1.0;
      let step = 0.5 / params.cfg.w; // half a label voxel, in uv
      var hits = 0.0;
      for (var k = 0; k < 2; k = k + 1) {
        for (var j = 0; j < 2; j = j + 1) {
          for (var i = 0; i < 2; i = i + 1) {
            let o = vec3<f32>(f32(i) - 0.5, f32(j) - 0.5, f32(k) - 0.5) * 2.0 * step;
            let v = u32(round(
              textureSampleLevel(labTex, labSampler, uvw + o, 0.0).r * 255.0
            ));
            hits = hits + select(0.0, 1.0, abs(f32(v) - targetIdx) < 0.5);
          }
        }
      }
      affinity = hits / 8.0;
    }
    lesion = clotMembership(
      p, centre, radius, params.mass.clot.x, targeting, affinity
    ) * params.mass.clot.z;
    // The lesion occupies space: a negative offset dilates the field into the
    // surrounding parenchyma.
    offset = offset - lesion * radius * params.mass.shape.z;

    // Peritumoral vasogenic edema spreads along WHITE MATTER and spares
    // cortex. That selectivity is the visual signature a radiologist actually
    // reads on a FLAIR sequence, so it is worth getting right rather than
    // applying an isotropic halo: fluid tracks along fibre bundles, and grey
    // matter's tighter extracellular space resists it.
    let distOutside = max(length(p - centre) - radius, 0.0);
    let reach = 1.0 - smoothstep(0.0, max(params.mass.shape.x, 1.0), distOutside);
    edema = reach * smoothstep(0.25, 0.75, myelin) * params.mass.shape.y;
  }

  textureStore(dst, vec3<i32>(gid), vec4<f32>(offset, lesion, edema, plaque));
}
