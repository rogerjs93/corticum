//!include common/field.wgsl

// Surface Nets, shared body. The two passes live in separate files, each with
// its own `main`, rather than as two entry points in one module: Babylon's
// `entryPoint` option did not reliably select the second function, and the
// symptom was subtle — the emit pass silently ran the classify code, which
// showed up only as a vertex count that was exactly double what it should be.
// Two files, two `main`s, no ambiguity.
//
// Surface Nets rather than marching cubes, deliberately: ONE vertex per active
// cell instead of up to fifteen, ~3x fewer triangles, better-shaped quads, and
// no 256-entry case table. Marching cubes' only real edge is sharper thin
// features, which does not matter for the ventricular system.

struct SnParams {
  // x = cell grid dim, y = field dim, z = half extent mm, w = SDF range mm
  cfg: vec4<f32>,
  // x = max vertices, y = max indices, z = iso level mm
  limits: vec4<f32>,
};

struct Counters {
  vertexCount: atomic<u32>,
  indexCount: atomic<u32>,
};

// Only the resources BOTH passes use are declared here. `verts` and `indices`
// belong to sn_emit.wgsl alone.
//
// This is not tidiness. A compute module that declares a binding it never reads
// has that binding stripped from the compiled pipeline layout, and the layout
// then no longer matches the bind group Babylon assembles from bindingsMapping.
// The classify pass simply did not run — no error, no warning; the only visible
// symptom was that cellSlot stayed zero, so every cell looked active and the
// emit pass produced a plausible-looking index count from a degenerate mesh.
// Declare exactly what you use, and give each pass its own bindingsMapping.
@group(0) @binding(0) var fieldSampler: sampler;
@group(0) @binding(1) var field: texture_3d<f32>;
@group(0) @binding(2) var<storage, read_write> counters: Counters;
@group(0) @binding(3) var<storage, read_write> cellSlot: array<u32>;
@group(0) @binding(6) var<uniform> params: SnParams;

const INVALID: u32 = 0xffffffffu;

fn snSample(c: vec3<i32>) -> f32 {
  let dim = params.cfg.y;
  let cl = clamp(vec3<f32>(c), vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(dim - 1.0, dim - 1.0, dim - 1.0));
  let uvw = (cl + vec3<f32>(0.5, 0.5, 0.5)) / dim;
  return decodeSdf(textureSampleLevel(field, fieldSampler, uvw, 0.0).r, params.cfg.w)
       - params.limits.z;
}

fn snCellIndex(c: vec3<i32>) -> u32 {
  let n = i32(params.cfg.x);
  return u32(c.z * n * n + c.y * n + c.x);
}

fn snCorner(i: i32) -> vec3<i32> {
  return vec3<i32>(i & 1, (i >> 1) & 1, (i >> 2) & 1);
}

fn snActive(c: vec3<i32>) -> bool {
  var neg = 0;
  for (var i: i32 = 0; i < 8; i = i + 1) {
    if (snSample(c + snCorner(i)) < 0.0) {
      neg = neg + 1;
    }
  }
  return neg != 0 && neg != 8;
}

fn snInRange(c: vec3<i32>) -> bool {
  let n = i32(params.cfg.x);
  return c.x < n - 1 && c.y < n - 1 && c.z < n - 1;
}

/// Mass point of the twelve edge crossings — the defining move of Surface Nets.
/// It puts the vertex where the surface actually passes through the cell rather
/// than at the cell centre, which is what stops thin structures like the
/// ventricular horns from collapsing.
fn snDualVertex(c: vec3<i32>) -> vec3<f32> {
  var sum = vec3<f32>(0.0, 0.0, 0.0);
  var count = 0.0;

  for (var a: i32 = 0; a < 8; a = a + 1) {
    for (var axis: i32 = 0; axis < 3; axis = axis + 1) {
      let bit = 1 << u32(axis);
      if ((a & bit) != 0) {
        continue;
      }
      let b = a | bit;
      let pa = snCorner(a);
      let pb = snCorner(b);
      let va = snSample(c + pa);
      let vb = snSample(c + pb);
      if ((va < 0.0) == (vb < 0.0)) {
        continue;
      }
      let t = va / (va - vb);
      sum = sum + mix(vec3<f32>(pa), vec3<f32>(pb), t);
      count = count + 1.0;
    }
  }

  if (count < 0.5) {
    return vec3<f32>(0.5, 0.5, 0.5);
  }
  return sum / count;
}

fn snToWorld(c: vec3<i32>, frac: vec3<f32>) -> vec3<f32> {
  let dim = params.cfg.y;
  let half = params.cfg.z;
  let uvw = (vec3<f32>(c) + frac + vec3<f32>(0.5, 0.5, 0.5)) / dim;
  return uvw * 2.0 * half - vec3<f32>(half, half, half);
}

fn snGradient(c: vec3<i32>) -> vec3<f32> {
  let gx = snSample(c + vec3<i32>(1, 0, 0)) - snSample(c - vec3<i32>(1, 0, 0));
  let gy = snSample(c + vec3<i32>(0, 1, 0)) - snSample(c - vec3<i32>(0, 1, 0));
  let gz = snSample(c + vec3<i32>(0, 0, 1)) - snSample(c - vec3<i32>(0, 0, 1));
  let g = vec3<f32>(gx, gy, gz);
  if (length(g) < 1e-6) {
    return vec3<f32>(0.0, 1.0, 0.0);
  }
  return normalize(g);
}

// snEmitQuad lives in sn_emit.wgsl, with the `verts` and `indices` bindings it
// needs — see the note on the binding block above.
